// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PORTAL_BILL_PAY_V1 — the mark-for-payment path posts real GL
// transactions from a portal cookie, so this suite covers every gate:
// session → flag → per-contact toggle → preview refusal → company-scope
// IDOR → configured bank account, plus the posting invariants (payment
// per vendor, queue/unnumbered, source attribution, audit row, bill
// status recompute, idempotent re-mark) and the staff notification.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, companies, accounts, contacts, transactions, journalLines,
  billPaymentApplications, portalContacts, portalContactCompanies,
  portalContactSessions, portalSettingsPerCompany, tenantFeatureFlags,
  auditLog as auditLogTable,
} from '../db/schema/index.js';
import { portalBillsPublicRouter } from './portal-bills-public.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as systemEmail from '../services/system-email.service.js';

vi.mock('../services/system-email.service.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/system-email.service.js')>();
  return { ...mod, sendActionEmail: vi.fn(async () => {}) };
});
const sendActionEmailMock = vi.mocked(systemEmail.sendActionEmail);

let server: Server | null = null;
let port = 0;
let tenantId = '';
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

function request(
  method: string,
  pathname: string,
  cookie?: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
          catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sessionCookie = (key: string) => `kisbooks_portal_session=${cookies[key]}`;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/bills', portalBillsPublicRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

async function setFlag(enabled: boolean) {
  await db
    .insert(tenantFeatureFlags)
    .values({ tenantId, flagKey: 'PORTAL_BILL_PAY_V1', enabled, rolloutPercent: enabled ? 100 : 0 })
    .onConflictDoUpdate({
      target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey],
      set: { enabled },
    });
}

async function seed() {
  const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [t] = await db.insert(tenants).values({ name: 'BillPay T', slug: 'pbill-' + suffix() }).returning();
  tenantId = t!.id;

  const [a1] = await db.insert(companies).values({ tenantId, businessName: 'Pay Co' }).returning();
  const [a2] = await db.insert(companies).values({ tenantId, businessName: 'Other Co' }).returning();
  ids['a1'] = a1!.id; ids['a2'] = a2!.id;

  const mkUser = async (key: string, role: string, active = true) => {
    const [u] = await db.insert(users).values({
      tenantId,
      email: `${key}-${suffix()}@ex.com`,
      passwordHash: 'not-a-real-hash',
      displayName: key,
      role,
      isActive: active,
      isSuperAdmin: false,
    }).returning();
    ids[key] = u!.id;
  };
  await mkUser('owner', 'owner');
  await mkUser('staff', 'bookkeeper');

  const mkAccount = async (key: string, v: Partial<typeof accounts.$inferInsert> & { name: string; accountType: string }) => {
    const [row] = await db.insert(accounts).values({ tenantId, ...v }).returning();
    ids[key] = row!.id;
  };
  await mkAccount('ap', { name: 'Accounts Payable', accountType: 'liability', detailType: 'accounts_payable', systemTag: 'accounts_payable' });
  await mkAccount('bank', { name: 'Operating Checking', accountType: 'asset', detailType: 'bank', balance: '10000.0000' });

  const mkVendor = async (key: string, name: string) => {
    const [row] = await db.insert(contacts).values({ tenantId, displayName: name, contactType: 'vendor' }).returning();
    ids[key] = row!.id;
  };
  await mkVendor('v1', 'ACME Supplies');
  await mkVendor('v2', 'Utility Co');

  const mkBill = async (key: string, v: {
    vendor: string; total: string; balanceDue?: string; billStatus?: string;
    status?: string; companyId?: string | null; invoice?: string;
  }) => {
    const [row] = await db.insert(transactions).values({
      tenantId,
      companyId: v.companyId === undefined ? ids['a1'] : v.companyId,
      txnType: 'bill',
      txnDate: '2026-08-01',
      dueDate: '2026-08-15',
      status: v.status ?? 'posted',
      billStatus: v.billStatus ?? 'unpaid',
      total: v.total,
      balanceDue: v.balanceDue ?? v.total,
      amountPaid: '0',
      contactId: ids[v.vendor],
      vendorInvoiceNumber: v.invoice ?? null,
      txnNumber: `BILL-${key}`,
    }).returning();
    ids[key] = row!.id;
  };
  await mkBill('bill1', { vendor: 'v1', total: '100.0000', invoice: 'INV-100' });
  await mkBill('bill2', { vendor: 'v1', total: '50.0000', invoice: 'INV-50' });
  await mkBill('bill3', { vendor: 'v2', total: '75.0000', invoice: 'INV-75' });
  await mkBill('billPaid', { vendor: 'v1', total: '20.0000', balanceDue: '0', billStatus: 'paid' });
  await mkBill('billOtherCo', { vendor: 'v1', total: '30.0000', companyId: ids['a2'] });

  const mkContact = async (key: string, companyId: string, billPayAccess: boolean) => {
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `${key}-${suffix()}@ex.com`, firstName: 'Pat', lastName: 'Client', status: 'active',
    }).returning();
    await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId, billPayAccess });
    ids[key] = c!.id;
    const token = crypto.randomBytes(32).toString('hex');
    await db.insert(portalContactSessions).values({
      tenantId,
      contactId: c!.id,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    cookies[key] = token;
  };
  await mkContact('cGranted', ids['a1']!, true);
  await mkContact('cDenied', ids['a1']!, false);

  await db.insert(portalSettingsPerCompany).values({
    companyId: ids['a1']!,
    billPayBankAccountId: ids['bank'],
    billPayNotifyUserId: ids['staff'],
  });

  await setFlag(true);
}

async function cleanDb() {
  if (tenantId) {
    await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
    await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
    await db.delete(portalContactSessions).where(eq(portalContactSessions.tenantId, tenantId));
    const contactRows = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    if (contactRows.length > 0) {
      await db.delete(portalContactCompanies).where(inArray(portalContactCompanies.contactId, contactRows.map((c) => c.id)));
    }
    await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    const companyRows = await db.select({ id: companies.id }).from(companies).where(eq(companies.tenantId, tenantId));
    if (companyRows.length > 0) {
      await db.delete(portalSettingsPerCompany).where(inArray(portalSettingsPerCompany.companyId, companyRows.map((c) => c.id)));
    }
    await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  tenantId = '';
}

// The notification is fire-and-forget; give its promise chain a tick.
async function flushNotify() {
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  sendActionEmailMock.mockClear();
  await cleanDb();
  await seed();
  await startApp();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('portal bills router', () => {
  it('rejects requests without a session cookie', async () => {
    expect((await request('GET', `/api/portal/bills?companyId=${ids['a1']}`)).status).toBe(401);
    expect((await request('POST', '/api/portal/bills/mark', undefined, { companyId: ids['a1'], billIds: [ids['bill1']] })).status).toBe(401);
  });

  it('flag off: GET featureEnabled:false, POST 403', async () => {
    await setFlag(false);
    const list = await request('GET', `/api/portal/bills?companyId=${ids['a1']}`, sessionCookie('cGranted'));
    expect(list.status).toBe(200);
    expect(list.json.featureEnabled).toBe(false);
    const mark = await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: ids['a1'], billIds: [ids['bill1']],
    });
    expect(mark.status).toBe(403);
  });

  it('permission off: 403 on both endpoints', async () => {
    expect((await request('GET', `/api/portal/bills?companyId=${ids['a1']}`, sessionCookie('cDenied'))).status).toBe(403);
    expect((await request('POST', '/api/portal/bills/mark', sessionCookie('cDenied'), {
      companyId: ids['a1'], billIds: [ids['bill1']],
    })).status).toBe(403);
  });

  it('preview session: POST refused read-only, GET allowed', async () => {
    const previewToken = jwt.sign({
      previewSessionId: crypto.randomUUID(),
      contactId: ids['cGranted'],
      tenantId,
      initiatingUserId: ids['owner'],
      companyId: ids['a1'],
    }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
    const cookie = `kisbooks_portal_preview=${previewToken}`;

    const list = await request('GET', `/api/portal/bills?companyId=${ids['a1']}`, cookie);
    expect(list.status).toBe(200);

    const mark = await request('POST', '/api/portal/bills/mark', cookie, {
      companyId: ids['a1'], billIds: [ids['bill1']],
    });
    expect(mark.status).toBe(403);
    expect(mark.json.error?.code).toBe('PREVIEW_READ_ONLY');
  });

  it('GET lists payable bills for the company only, configured:true', async () => {
    const r = await request('GET', `/api/portal/bills?companyId=${ids['a1']}`, sessionCookie('cGranted'));
    expect(r.status).toBe(200);
    expect(r.json.featureEnabled).toBe(true);
    expect(r.json.configured).toBe(true);
    const billIds = r.json.bills.map((b: any) => b.id);
    expect(billIds).toContain(ids['bill1']);
    expect(billIds).toContain(ids['bill2']);
    expect(billIds).toContain(ids['bill3']);
    expect(billIds).not.toContain(ids['billPaid']);
    expect(billIds).not.toContain(ids['billOtherCo']);
    const b1 = r.json.bills.find((b: any) => b.id === ids['bill1']);
    expect(b1.vendorName).toBe('ACME Supplies');
    expect(b1.vendorInvoiceNumber).toBe('INV-100');
    // No internal fields leak.
    expect(b1).not.toHaveProperty('memo');
    expect(b1).not.toHaveProperty('contactId');
  });

  it('unconfigured company: POST 400 PORTAL_BILL_PAY_UNCONFIGURED, GET configured:false', async () => {
    await db.update(portalSettingsPerCompany)
      .set({ billPayBankAccountId: null })
      .where(eq(portalSettingsPerCompany.companyId, ids['a1']!));

    const list = await request('GET', `/api/portal/bills?companyId=${ids['a1']}`, sessionCookie('cGranted'));
    expect(list.json.configured).toBe(false);

    const mark = await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: ids['a1'], billIds: [ids['bill1']],
    });
    expect(mark.status).toBe(400);
    expect(mark.json.error?.code).toBe('PORTAL_BILL_PAY_UNCONFIGURED');
  });

  it('happy path: posts one queued unnumbered payment per vendor with attribution, audit row, and staff email', async () => {
    const r = await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: ids['a1'], billIds: [ids['bill1'], ids['bill2'], ids['bill3']],
    });
    expect(r.status).toBe(200);
    expect(r.json.skipped).toEqual([]);
    expect(r.json.payments).toHaveLength(2); // v1 combined (100+50), v2 (75)
    const acme = r.json.payments.find((p: any) => p.vendorName === 'ACME Supplies');
    expect(acme.billCount).toBe(2);
    expect(parseFloat(acme.amount)).toBeCloseTo(150);

    // Payment rows: posted, queued, unnumbered, portal-attributed.
    const payments = await db.select().from(transactions).where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'bill_payment'),
    ));
    expect(payments).toHaveLength(2);
    for (const p of payments) {
      expect(p.status).toBe('posted');
      expect(p.printStatus).toBe('queue');
      expect(p.checkNumber).toBeNull();
      expect(p.source).toBe('client_portal');
      expect(p.sourceId).toBe(ids['cGranted']);
      expect(p.companyId).toBe(ids['a1']);
    }

    // Journal: DR AP 225 total / CR bank 225 total across both payments.
    const jls = await db.select().from(journalLines).where(and(
      eq(journalLines.tenantId, tenantId),
      inArray(journalLines.transactionId, payments.map((p) => p.id)),
    ));
    const apDebit = jls.filter((l) => l.accountId === ids['ap']).reduce((s, l) => s + parseFloat(l.debit), 0);
    const bankCredit = jls.filter((l) => l.accountId === ids['bank']).reduce((s, l) => s + parseFloat(l.credit), 0);
    expect(apDebit).toBeCloseTo(225);
    expect(bankCredit).toBeCloseTo(225);

    // Bills recomputed to paid.
    const bills = await db.select().from(transactions).where(inArray(transactions.id, [ids['bill1']!, ids['bill2']!, ids['bill3']!]));
    for (const b of bills) {
      expect(b.billStatus).toBe('paid');
      expect(parseFloat(b.balanceDue ?? '1')).toBeCloseTo(0);
    }

    // Applications written.
    const apps = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
    expect(apps).toHaveLength(3);

    // Audit row for the portal request.
    const audit = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.tenantId, tenantId),
      eq(auditLogTable.entityType, 'portal_payment_request'),
    ));
    expect(audit).toHaveLength(1);
    // auditLog() JSON.stringifies into the jsonb column, so the stored
    // value is a JSON string scalar.
    const rawAfter = audit[0]!.afterData;
    const payload = typeof rawAfter === 'string' ? JSON.parse(rawAfter) : (rawAfter as any);
    expect(payload.contactId).toBe(ids['cGranted']);
    expect(payload.paymentIds).toHaveLength(2);

    // Staff notification to the selected user.
    await flushNotify();
    expect(sendActionEmailMock).toHaveBeenCalledTimes(1);
    const call = sendActionEmailMock.mock.calls[0]![0];
    const staffEmail = (await db.query.users.findFirst({ where: eq(users.id, ids['staff']!) }))!.email;
    expect(call.to).toBe(staffEmail);
    expect(call.subject).toContain('Checks ready to print');
    expect(call.bodyText).toContain('ACME Supplies');
    expect(call.cta?.url).toContain('/checks/print');

    // The GET now shows the queued payments and no payable bills.
    const list = await request('GET', `/api/portal/bills?companyId=${ids['a1']}`, sessionCookie('cGranted'));
    expect(list.json.bills).toHaveLength(0);
    expect(list.json.queuedPayments).toHaveLength(2);
  });

  it('re-marking the same bills is an idempotent no-op (skipped, no new payments)', async () => {
    const first = await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: ids['a1'], billIds: [ids['bill1']],
    });
    expect(first.status).toBe(200);
    expect(first.json.payments).toHaveLength(1);

    const second = await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: ids['a1'], billIds: [ids['bill1']],
    });
    expect(second.status).toBe(200);
    expect(second.json.payments).toHaveLength(0);
    expect(second.json.skipped).toEqual([ids['bill1']]);

    const payments = await db.select().from(transactions).where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'bill_payment'),
    ));
    expect(payments).toHaveLength(1);

    await flushNotify();
    expect(sendActionEmailMock).toHaveBeenCalledTimes(1); // no email for the no-op
  });

  it('IDOR: bill from another company in the tenant → 404, nothing posted', async () => {
    const r = await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: ids['a1'], billIds: [ids['bill1'], ids['billOtherCo']],
    });
    expect(r.status).toBe(404);
    const payments = await db.select().from(transactions).where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, 'bill_payment'),
    ));
    expect(payments).toHaveLength(0);
  });

  it('owners fallback when no notify user is configured', async () => {
    await db.update(portalSettingsPerCompany)
      .set({ billPayNotifyUserId: null })
      .where(eq(portalSettingsPerCompany.companyId, ids['a1']!));

    const r = await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: ids['a1'], billIds: [ids['bill3']],
    });
    expect(r.status).toBe(200);
    await flushNotify();
    expect(sendActionEmailMock).toHaveBeenCalledTimes(1);
    const ownerEmail = (await db.query.users.findFirst({ where: eq(users.id, ids['owner']!) }))!.email;
    expect(sendActionEmailMock.mock.calls[0]![0].to).toBe(ownerEmail);
  });

  it('rejects malformed bodies', async () => {
    expect((await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: ids['a1'], billIds: [],
    })).status).toBe(400);
    expect((await request('POST', '/api/portal/bills/mark', sessionCookie('cGranted'), {
      companyId: 'not-a-uuid', billIds: [ids['bill1']],
    })).status).toBe(400);
  });
});
