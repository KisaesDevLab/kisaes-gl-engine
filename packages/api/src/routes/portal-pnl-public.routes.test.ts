// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Portal live Profit & Loss — the router must enforce session cookie →
// per-contact profit_loss_access → tenant/company scoping, the P&L must
// equal the staff builder, the drill-down must sum to its P&L row, and
// asking about a transaction must reject a transaction from another company.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, transactions, journalLines,
  portalContacts, portalContactCompanies, portalContactSessions, portalQuestions,
} from '../db/schema/index.js';
import { portalPnlPublicRouter } from './portal-pnl-public.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as reportSvc from '../services/report.service.js';
import * as questionSvc from '../services/portal-question.service.js';

let server: Server | null = null;
let port = 0;
let tenantAId = '';
let tenantBId = '';
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const START = '2026-01-01';
const END = '2026-12-31';
const qs = (companyId: string) => `companyId=${companyId}&start_date=${START}&end_date=${END}`;

function request(method: string, pathname: string, cookie?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: `kisbooks_portal_session=${cookie}` } : {}),
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
    req.end();
  });
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/profit-loss', portalPnlPublicRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

async function mkSession(key: string, tenantId: string, contactId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.insert(portalContactSessions).values({
    tenantId,
    contactId,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  cookies[key] = token;
}

async function seed() {
  const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [tA] = await db.insert(tenants).values({ name: 'PnL T A', slug: 'ppnl-a-' + suffix() }).returning();
  const [tB] = await db.insert(tenants).values({ name: 'PnL T B', slug: 'ppnl-b-' + suffix() }).returning();
  tenantAId = tA!.id;
  tenantBId = tB!.id;

  const [a1] = await db.insert(companies).values({ tenantId: tenantAId, businessName: 'A One' }).returning();
  const [a2] = await db.insert(companies).values({ tenantId: tenantAId, businessName: 'A Two' }).returning();
  const [b1] = await db.insert(companies).values({ tenantId: tenantBId, businessName: 'B One' }).returning();
  ids['a1'] = a1!.id; ids['a2'] = a2!.id; ids['b1'] = b1!.id;

  const [rev] = await db.insert(accounts).values({
    tenantId: tenantAId, name: 'Sales', accountType: 'revenue', detailType: 'service_fee_income',
  }).returning();
  const [asset] = await db.insert(accounts).values({
    tenantId: tenantAId, name: 'Checking', accountType: 'asset', detailType: 'bank',
  }).returning();
  ids['revenue'] = rev!.id; ids['asset'] = asset!.id;

  const mkTxn = async (key: string, companyId: string, status: string, credit: string, date = '2026-03-15') => {
    const [txn] = await db.insert(transactions).values({
      tenantId: tenantAId, companyId, txnType: 'deposit', txnDate: date, status, memo: key,
    }).returning();
    await db.insert(journalLines).values({
      tenantId: tenantAId, transactionId: txn!.id, accountId: ids['revenue']!, debit: '0', credit,
    });
    ids[key] = txn!.id;
  };
  await mkTxn('sale1', ids['a1']!, 'posted', '100.0000');
  await mkTxn('sale2', ids['a1']!, 'posted', '50.0000', '2026-04-02');
  await mkTxn('voided', ids['a1']!, 'void', '999.0000');
  await mkTxn('otherCompany', ids['a2']!, 'posted', '777.0000');
  await mkTxn('outOfRange', ids['a1']!, 'posted', '5.0000', '2025-06-01');

  const mkContact = async (key: string, tenantId: string, companyId: string, flags: { profitLossAccess: boolean; questionsForUsAccess: boolean }) => {
    const [c] = await db.insert(portalContacts).values({
      tenantId, email: `${key}-${suffix()}@ex.com`, status: 'active',
    }).returning();
    await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId, ...flags });
    ids[key] = c!.id;
    await mkSession(key, tenantId, c!.id);
  };
  await mkContact('cGranted', tenantAId, ids['a1']!, { profitLossAccess: true, questionsForUsAccess: true });
  await mkContact('cDenied', tenantAId, ids['a1']!, { profitLossAccess: false, questionsForUsAccess: true });
  await mkContact('cNoQuestions', tenantAId, ids['a1']!, { profitLossAccess: true, questionsForUsAccess: false });
  await mkContact('cTenantB', tenantBId, ids['b1']!, { profitLossAccess: true, questionsForUsAccess: true });
}

async function cleanDb() {
  for (const tenantId of [tenantAId, tenantBId]) {
    if (!tenantId) continue;
    await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId));
    await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
    await db.delete(portalContactSessions).where(eq(portalContactSessions.tenantId, tenantId));
    const contactRows = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    for (const c of contactRows) {
      await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, c.id));
    }
    await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  tenantAId = '';
  tenantBId = '';
}

beforeEach(async () => {
  await cleanDb();
  await seed();
  await startApp();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('portal profit & loss router', () => {
  it('rejects requests without a session cookie', async () => {
    const r = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`);
    expect(r.status).toBe(401);
  });

  it('403 without profit_loss_access, for both endpoints', async () => {
    const pl = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cDenied']);
    expect(pl.status).toBe(403);
    const drill = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['revenue']}/transactions?${qs(ids['a1']!)}`, cookies['cDenied'],
    );
    expect(drill.status).toBe(403);
  });

  it('403 for a company the contact is not linked to, and across tenants', async () => {
    const other = await request('GET', `/api/portal/profit-loss?${qs(ids['a2']!)}`, cookies['cGranted']);
    expect(other.status).toBe(403);
    const crossTenant = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cTenantB']);
    expect(crossTenant.status).toBe(403);
  });

  it('validates the date range', async () => {
    const missing = await request('GET', `/api/portal/profit-loss?companyId=${ids['a1']}`, cookies['cGranted']);
    expect(missing.status).toBe(400);
    const reversed = await request(
      'GET', `/api/portal/profit-loss?companyId=${ids['a1']}&start_date=2026-12-31&end_date=2026-01-01`, cookies['cGranted'],
    );
    expect(reversed.status).toBe(400);
    const tooLong = await request(
      'GET', `/api/portal/profit-loss?companyId=${ids['a1']}&start_date=2000-01-01&end_date=2026-01-01`, cookies['cGranted'],
    );
    expect(tooLong.status).toBe(400);
  });

  it('returns the same P&L as the staff builder (posted, this company, in range)', async () => {
    const r = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cGranted']);
    expect(r.status).toBe(200);
    const staff = await reportSvc.buildProfitAndLoss(tenantAId, START, END, 'accrual', ids['a1']!);
    expect(r.json.netIncome).toBe(staff.netIncome);
    expect(r.json.totalRevenue).toBe(150);
    expect(r.json.revenue.find((e: { accountId: string }) => e.accountId === ids['revenue']).amount).toBe(150);
  });

  it('drill-down lists posted lines for the company and sums to the P&L row', async () => {
    const r = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['revenue']}/transactions?${qs(ids['a1']!)}`, cookies['cGranted'],
    );
    expect(r.status).toBe(200);
    const txnIds = r.json.items.map((i: { transactionId: string }) => i.transactionId).sort();
    expect(txnIds).toEqual([ids['sale1'], ids['sale2']].sort());
    expect(r.json.total).toBe(2);
    expect(r.json.sum).toBe(150);
  });

  it('cash-basis company: drill-down sums to the P&L row', async () => {
    await db.update(companies).set({ accountingMethod: 'cash' }).where(eq(companies.id, ids['a1']!));
    const pl = await request('GET', `/api/portal/profit-loss?${qs(ids['a1']!)}`, cookies['cGranted']);
    expect(pl.status).toBe(200);
    expect(pl.json.basis).toBe('cash');
    const row = pl.json.revenue.find((e: { accountId: string }) => e.accountId === ids['revenue']);
    const drill = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['revenue']}/transactions?${qs(ids['a1']!)}`, cookies['cGranted'],
    );
    expect(drill.status).toBe(200);
    expect(drill.json.sum).toBe(row.amount);
    expect(drill.json.total).toBe(2);
  });

  it('drill-down paginates', async () => {
    const r = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['revenue']}/transactions?${qs(ids['a1']!)}&perPage=1&page=2`,
      cookies['cGranted'],
    );
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.total).toBe(2);
  });

  it('drill-down 404s for a non-P&L account', async () => {
    const r = await request(
      'GET', `/api/portal/profit-loss/accounts/${ids['asset']}/transactions?${qs(ids['a1']!)}`, cookies['cGranted'],
    );
    expect(r.status).toBe(404);
  });
});

describe('asking about a transaction (contactAsk)', () => {
  it('links the question to the transaction', async () => {
    const { id } = await questionSvc.contactAsk(tenantAId, ids['cGranted']!, {
      companyId: ids['a1']!, body: 'What is this?', transactionId: ids['sale1']!,
    });
    const [row] = await db.select().from(portalQuestions).where(eq(portalQuestions.id, id));
    expect(row?.transactionId).toBe(ids['sale1']);
  });

  it('rejects a transaction that belongs to another company', async () => {
    await expect(questionSvc.contactAsk(tenantAId, ids['cGranted']!, {
      companyId: ids['a1']!, body: 'What is this?', transactionId: ids['otherCompany']!,
    })).rejects.toThrow(/not found/i);
  });

  it('rejects a contact without questionsForUsAccess', async () => {
    await expect(questionSvc.contactAsk(tenantAId, ids['cNoQuestions']!, {
      companyId: ids['a1']!, body: 'What is this?', transactionId: ids['sale1']!,
    })).rejects.toThrow(/not enabled/i);
  });
});
