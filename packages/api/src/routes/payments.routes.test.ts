// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Receive Payment (ClientLedger P21 E1, U-132), through the HTTP routes:
//   - receive-payment-v1: preview = post (golden 1, 5, 10), exact amounts
//     (golden 9), expectedBalanceDue, company scope, idempotent replay,
//     concurrency, void through both routes, unapply, PUT, legacy rows;
//   - payment-bounce-v1: bounce on a grouped deposit (golden 7), an
//     undeposited bounce, closed periods, the deposit guards, void bounce,
//     cash-basis tie-out, the transfer round trip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, items, tags, transactionTags, userPermissions, idempotencyKeys, paymentApplications, documentSendEvents,
  depositLines, reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as invoiceService from '../services/invoice.service.js';
import { buildProfitAndLoss } from '../services/report.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const CLOSING_PHRASE = 'closed-books-phrase';
const here = path.dirname(fileURLToPath(import.meta.url));

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function request(method: string, pathname: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanTenant(tid: string) {
  const txnIds = (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tid))).map((r) => r.id);
  if (txnIds.length) await db.delete(depositLines).where(inArray(depositLines.depositId, txnIds));
  const recs = (await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tid))).map((r) => r.id);
  if (recs.length) await db.delete(reconciliationLines).where(inArray(reconciliationLines.reconciliationId, recs));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tid));
  await db.delete(documentSendEvents).where(eq(documentSendEvents.tenantId, tid));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
  await db.delete(paymentApplications).where(eq(paymentApplications.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(items).where(eq(items.tenantId, tid));
  await db.delete(tags).where(eq(tags.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

interface Co {
  tenantId: string; token: string; companyId: string; userId: string;
  bank: string; revenue: string; ar: string; clearing: string; fee: string; customer: string; other: string;
}

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

async function makeCompany(): Promise<Co> {
  const reg = await authService.register({
    email: `rp-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Neosho Supply',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  await db.update(companies).set({ defaultSalesTaxRate: '0', defaultPaymentTerms: 'net_30' }).where(eq(companies.id, company!.id));
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const revenue = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const fee = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Neosho Dental Group' }).returning();
  const [other] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Joplin Vet' }).returning();
  return {
    tenantId, token: reg.tokens.accessToken, companyId: company!.id, userId: reg.user.id,
    bank: bank!.id, revenue: revenue!.id, ar: await bySystemTag(tenantId, 'accounts_receivable'),
    clearing: await bySystemTag(tenantId, 'payments_clearing'), fee: fee!.id, customer: customer!.id, other: other!.id,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/invoices', invoicesRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/company', companyRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const key = () => crypto.randomBytes(12).toString('hex');

async function invoice(total: string, date: string, customer = c.customer, txnNumber?: string) {
  const inv = await invoiceService.createInvoice(c.tenantId, {
    contactId: customer, txnDate: date, ...(txnNumber ? { txnNumber } : {}),
    lines: [{ accountId: c.revenue, description: 'Work', quantity: '1', unitPrice: total, isTaxable: false }],
  } as never, c.userId, c.companyId);
  return inv.id;
}

async function inv(id: string) {
  return (await db.select().from(transactions).where(eq(transactions.id, id)))[0]!;
}

async function balance(accountId: string) {
  return (await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) }))!.balance;
}

async function linesOf(txnId: string) {
  const rows = await db.select().from(journalLines)
    .where(and(eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)))
    .orderBy(journalLines.lineOrder);
  return rows.map((l) => [l.accountId, l.debit, l.credit]);
}

async function contactAR() {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,4)::text AS ar FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id WHERE jl.tenant_id = ${c.tenantId} AND t.status = 'posted'
      AND jl.account_id = ${c.ar} AND COALESCE(jl.contact_id, t.contact_id) = ${c.customer}`);
  return (res.rows as Array<{ ar: string }>)[0]!.ar;
}

/** The mockup's two invoices (golden 1): 1091 = 4,385.00 and 1095 = 1,260.00. */
async function mockup() {
  const i1091 = await invoice('4385.00', '2026-09-15', c.customer, '1091');
  const i1095 = await invoice('1260.00', '2026-10-02', c.customer, '1095');
  return { i1091, i1095 };
}

const previewBody = (extra: Record<string, unknown>) => ({ customerId: c.customer, date: '2026-11-03', depositTo: c.clearing, ...extra });

async function receive(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return request('POST', '/api/v1/payments/receive', c.token, {
    customerId: c.customer, date: '2026-11-03', depositTo: c.clearing, ...body,
  }, headers);
}

/** Preview, then receive the preview's rows byte for byte (the desktop's save plan). */
async function previewThenReceive(extra: Record<string, unknown>, depositTo = c.clearing) {
  const p = await request('POST', '/api/v1/payments/preview', c.token, previewBody({ ...extra, depositTo }));
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const applications = (p.json.invoices as any[]).filter((i) => i.payment !== '0.00')
    .map((i) => ({ invoiceId: i.invoiceId, amount: i.payment, expectedBalanceDue: i.balanceDueExact }));
  const r = await receive({ amount: p.json.amount, depositTo, applications }, { 'Idempotency-Key': key() });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { preview: p.json, payment: r.json.payment };
}

it('advertises the receive payment capabilities', () => {
  for (const cap of ['receive-payment-v1', 'idempotency-receive-payment-v1', 'payment-bounce-v1']) {
    expect(DESKTOP_CAPABILITIES).toContain(cap);
  }
});

describe('receive-payment-v1 (U-132)', () => {
  it('golden 1: the mockup previews and posts exactly (4,000.00 leaves 385.00 open on 1091)', async () => {
    const { i1091, i1095 } = await mockup();
    // Another client's 6,210.00 payment waiting in Payments Clearing.
    const otherInv = await invoice('6210.00', '2026-10-05', c.other);
    const r0 = await request('POST', '/api/v1/payments/receive', c.token, {
      customerId: c.other, date: '2026-11-01', depositTo: c.clearing, amount: '6210.00',
      applications: [{ invoiceId: otherInv, amount: '6210.00' }],
    });
    expect(r0.status, JSON.stringify(r0.json)).toBe(201);

    const { preview, payment } = await previewThenReceive({ amount: '4000.00' });
    expect(preview.invoices.map((i: any) => [i.invoiceNumber, i.payment, i.balanceDue, i.balanceDueExact]))
      .toEqual([['1091', '4000.00', '4385.00', '4385.0000'], ['1095', '0.00', '1260.00', '1260.0000']]);
    expect(preview.totals).toEqual({ amountDue: '5645.00', applied: '4000.00', discountsAndCredits: '0.00', unapplied: '0.00' });
    expect(preview.shortfalls).toEqual([{ invoiceId: i1091, amount: '385.00' }]);
    expect([preview.contactBalanceBefore, preview.contactBalanceAfter]).toEqual(['5645.00', '1645.00']);
    expect(preview.pendingDeposits).toEqual({ count: 2, total: '10210.00' });
    expect(preview.problems).toEqual([]);

    expect(await linesOf(payment.id)).toEqual([[c.clearing, '4000.0000', '0.0000'], [c.ar, '0.0000', '4000.0000']]);
    const a = await inv(i1091);
    expect([a.balanceDue, a.invoiceStatus]).toEqual(['385.0000', 'partial']);
    expect((await inv(i1095)).balanceDue).toBe('1260.0000');
    expect(await contactAR()).toBe('1645.0000');
    expect(payment.applications.map((x: any) => [x.invoiceId, x.amount])).toEqual([[i1091, '4000.00']]);
    expect(payment.unappliedRemaining).toBe('0.00');
    const pending = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token);
    expect(pending.json.paymentsClearingBalance).toBe('10210.0000');
  });

  it('golden 5: explicit fill without an amount previews 1,260.00 from the applications', async () => {
    const { i1091, i1095 } = await mockup();
    const p = await request('POST', '/api/v1/payments/preview', c.token, previewBody({ applications: [{ invoiceId: i1095, amount: null }] }));
    expect(p.json.amount).toBe('1260.00');
    expect(p.json.amountSource).toBe('from_applications');
    expect(p.json.invoices.find((i: any) => i.invoiceId === i1091).payment).toBe('0.00');
  });

  it('golden 9: 3-place amounts are 400; 0.01 over the cent balance is OVERAPPLIED; Σ over the amount is refused', async () => {
    const { i1095 } = await mockup();
    let r = await receive({ amount: '1260.005', applications: [{ invoiceId: i1095, amount: '1260.005' }] });
    expect([r.status, r.json.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    r = await receive({ amount: '1260.01', applications: [{ invoiceId: i1095, amount: '1260.01' }] });
    expect([r.status, r.json.error.code, r.json.error.details]).toEqual([400, 'OVERAPPLIED', { invoiceId: i1095, balanceDue: '1260.00' }]);
    r = await receive({ amount: '100.00', applications: [{ invoiceId: i1095, amount: '100.01' }] });
    expect([r.status, r.json.error.code]).toEqual([400, 'APPLICATIONS_EXCEED_AMOUNT']);
    // A stored amount echoed back with trailing zeros is the same whole cents.
    r = await receive({ amount: '100.0000', applications: [{ invoiceId: i1095, amount: '100.0000' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // Nothing else posted.
    const pays = await db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnType, 'customer_payment')));
    expect(pays).toHaveLength(1);
  });

  it('409 INVOICE_BALANCE_CHANGED when the stored balance moved since the preview', async () => {
    const { i1091 } = await mockup();
    const p = await request('POST', '/api/v1/payments/preview', c.token, previewBody({ amount: '100.00' }));
    await receive({ amount: '50.00', applications: [{ invoiceId: i1091, amount: '50.00' }] });
    const r = await receive({ amount: '100.00', applications: [{ invoiceId: i1091, amount: '100.00', expectedBalanceDue: p.json.invoices[0].balanceDueExact }] });
    expect([r.status, r.json.error.code]).toEqual([409, 'INVOICE_BALANCE_CHANGED']);
    expect(r.json.error.details).toEqual({ invoiceId: i1091, balanceDue: '4335.00', balanceDueExact: '4335.0000' });
  });

  it('company scope: another company sees 404 for the customer, the invoice and the payment', async () => {
    const { i1091 } = await mockup();
    const { payment } = await previewThenReceive({ amount: '10.00' });
    const [b] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Branch B', setupComplete: true }).returning();
    const [bCustomer] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: 'A only' }).returning();
    const asB = { 'X-Company-Id': b!.id };
    expect((await request('GET', `/api/v1/payments/open-invoices/${bCustomer!.id}`, c.token, undefined, asB)).status).toBe(404);
    expect((await request('GET', `/api/v1/payments/for-invoice/${i1091}`, c.token, undefined, asB)).status).toBe(404);
    expect((await request('GET', `/api/v1/payments/${payment.id}`, c.token, undefined, asB)).status).toBe(404);
    expect((await request('POST', `/api/v1/payments/${payment.id}/void`, c.token, {}, asB)).status).toBe(404);
    const r = await request('POST', '/api/v1/payments/receive', c.token, {
      customerId: c.customer, date: '2026-11-03', depositTo: c.clearing, amount: '1.00', applications: [{ invoiceId: i1091, amount: '1.00' }],
    }, asB);
    expect(r.status).toBe(404);
  });

  it('an Idempotency-Key replay posts once and answers with the same payment', async () => {
    const { i1091 } = await mockup();
    const k = { 'Idempotency-Key': key() };
    const body = { amount: '100.00', applications: [{ invoiceId: i1091, amount: '100.00' }] };
    const a = await receive(body, k);
    const b = await receive(body, k);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json.payment.id).toBe(a.json.payment.id);
    expect((await inv(i1091)).balanceDue).toBe('4285.0000');
  });

  it('two concurrent receives for the whole balance: one posts, the other is refused', async () => {
    const { i1095 } = await mockup();
    const body = { amount: '1260.00', applications: [{ invoiceId: i1095, amount: '1260.00' }] };
    const [a, b] = await Promise.all([receive(body), receive(body)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 400]);
    const refused = a.status === 400 ? a : b;
    expect(refused.json.error.code).toBe('OVERAPPLIED');
    const x = await inv(i1095);
    expect([x.balanceDue, x.amountPaid, x.invoiceStatus]).toEqual(['0.0000', '1260.0000', 'paid']);
  });

  it('void reopens the invoices through /payments/:id/void and /transactions/:id/void; then the invoice can be voided', async () => {
    const { i1091, i1095 } = await mockup();
    const { payment: p1 } = await previewThenReceive({ amount: '5000.00' });
    expect((await inv(i1091)).invoiceStatus).toBe('paid');
    let r = await request('POST', `/api/v1/payments/${p1.id}/void`, c.token, { expectedUpdatedAt: p1.updatedAt }, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect([(await inv(i1091)).balanceDue, (await inv(i1091)).invoiceStatus]).toEqual(['4385.0000', 'draft']);
    expect((await inv(i1095)).balanceDue).toBe('1260.0000');
    const p1rec = await request('GET', `/api/v1/payments/${p1.id}`, c.token);
    expect(p1rec.json.payment.applications.every((a: any) => a.voided)).toBe(true);

    const { payment: p2 } = await previewThenReceive({ amount: '1000.00' });
    r = await request('POST', `/api/v1/transactions/${p2.id}/void`, c.token, { reason: 'wrong client' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await inv(i1091)).balanceDue).toBe('4385.0000');
    // Void the payment, then void the invoice: the live-row filter lets it.
    r = await request('POST', `/api/v1/invoices/${i1091}/void`, c.token, { reason: 'dup' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it('a sent invoice reopens to sent; unapply is audited, needs the closing password in a closed period and checks STALE', async () => {
    const { i1091 } = await mockup();
    await db.update(transactions).set({ sentAt: new Date() }).where(eq(transactions.id, i1091));
    const { payment } = await previewThenReceive({ amount: '4385.00' });
    let r = await request('POST', '/api/v1/payments/unapply', c.token, { paymentId: payment.id, invoiceId: i1091, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect([r.status, r.json.error.code]).toEqual([409, 'STALE']);
    await db.update(companies).set({ lockDate: '2026-12-31', closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) }).where(eq(companies.id, c.companyId));
    r = await request('POST', '/api/v1/payments/unapply', c.token, { paymentId: payment.id, invoiceId: i1091 });
    expect(r.status).toBe(423);
    r = await request('POST', '/api/v1/payments/unapply', c.token, { paymentId: payment.id, invoiceId: i1091, closingPassword: CLOSING_PHRASE }, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const x = await inv(i1091);
    expect([x.balanceDue, x.invoiceStatus]).toEqual(['4385.0000', 'sent']);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'payment_applications')));
    expect(audits.some((a) => JSON.stringify(a.afterData).includes('unapply'))).toBe(true);
    // The money stays a credit: remaining 4,385.00.
    const rec = await request('GET', `/api/v1/payments/${payment.id}`, c.token);
    expect(rec.json.payment.unappliedRemaining).toBe('4385.00');
    // Route order: the literal routes are still reachable.
    expect((await request('GET', '/api/v1/payments/pending-deposits', c.token)).status).toBe(200);
  });

  it('/transactions/:id/void on a deposited payment is 409 TXN_DEPOSITED', async () => {
    await mockup();
    const { payment } = await previewThenReceive({ amount: '100.00' });
    const d = await request('POST', '/api/v1/transactions', c.token, {
      txnType: 'deposit', txnDate: '2026-11-04', depositToAccountId: c.bank,
      lines: [{ accountId: c.clearing, amount: '100.00', sourceTransactionId: payment.id }],
    });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const r = await request('POST', `/api/v1/transactions/${payment.id}/void`, c.token, { reason: 'x' });
    expect([r.status, r.json.error.code]).toEqual([409, 'TXN_DEPOSITED']);
  });

  it('a legacy applied_to_invoice_id payment is backfilled and voiding it reopens the invoice', async () => {
    const id = await invoice('300.00', '2026-09-01');
    const legacy = await ledger.postTransaction(c.tenantId, {
      txnType: 'customer_payment', txnDate: '2026-09-10', contactId: c.customer, total: '300.0000', appliedToInvoiceId: id,
      lines: [{ accountId: c.bank, debit: '300.0000', credit: '0' }, { accountId: c.ar, debit: '0', credit: '300.0000' }],
    }, c.userId, c.companyId);
    await db.update(transactions).set({ amountPaid: '300.0000', balanceDue: '0.0000', invoiceStatus: 'paid' }).where(eq(transactions.id, id));
    // The 0247 backfill statement, as the migration runs it.
    const migration = readFileSync(path.resolve(here, '../db/migrations/0247_receive_payment.sql'), 'utf8');
    await db.execute(sql.raw(migration.split('--> statement-breakpoint').pop()!));
    const rows = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, legacy.id));
    expect(rows.map((r) => [r.invoiceId, r.amount])).toEqual([[id, '300.0000']]);
    const r = await request('POST', `/api/v1/transactions/${legacy.id}/void`, c.token, { reason: 'x' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect([(await inv(id)).balanceDue, (await inv(id)).invoiceStatus]).toEqual(['300.0000', 'draft']);
  });

  it('a legacy "paid" invoice with a stored 0.01 stays paid until a restore touches it, then shows the real cent', async () => {
    const id = await invoice('100.00', '2026-09-01');
    const a = await receive({ amount: '50.00', applications: [{ invoiceId: id, amount: '50.00' }] });
    await receive({ amount: '49.99', applications: [{ invoiceId: id, amount: '49.99' }] });
    // The old 0.01 tolerance marked it paid.
    await db.update(transactions).set({ invoiceStatus: 'paid' }).where(eq(transactions.id, id));
    let open = await request('GET', `/api/v1/payments/open-invoices/${c.customer}`, c.token);
    expect(open.json.invoices).toEqual([]);
    const r = await request('POST', `/api/v1/payments/${a.json.payment.id}/void`, c.token, {});
    expect(r.status).toBe(200);
    open = await request('GET', `/api/v1/payments/open-invoices/${c.customer}`, c.token);
    expect(open.json.invoices.map((i: any) => [i.balanceDue, i.balanceDueExact, i.invoiceStatus])).toEqual([['50.01', '50.0100', 'partial']]);
  });

  it('golden 10 (Q-P21t): a legacy sub-cent invoice pays in whole cents; nothing sub-cent posts; a void restores it exactly', async () => {
    const l1 = await invoice('100.00', '2025-01-10');
    const l2 = await invoice('100.00', '2025-01-11');
    // Legacy residues (written before sales-cents-v1).
    await db.update(transactions).set({ total: '100.0049', balanceDue: '100.0049' }).where(eq(transactions.id, l1));
    await db.update(transactions).set({ total: '100.0050', balanceDue: '100.0050' }).where(eq(transactions.id, l2));
    const { preview, payment } = await previewThenReceive({ amount: '200.01' });
    expect(preview.invoices.map((i: any) => [i.balanceDue, i.payment])).toEqual([['100.00', '100.00'], ['100.01', '100.01']]);
    expect(await linesOf(payment.id)).toEqual([[c.clearing, '200.0100', '0.0000'], [c.ar, '0.0000', '200.0100']]);
    expect([(await inv(l1)).balanceDue, (await inv(l1)).invoiceStatus]).toEqual(['0.0049', 'paid']);
    expect([(await inv(l2)).balanceDue, (await inv(l2)).invoiceStatus]).toEqual(['-0.0050', 'paid']);
    expect((await request('GET', `/api/v1/payments/open-invoices/${c.customer}`, c.token)).json.invoices).toEqual([]);
    await request('POST', `/api/v1/payments/${payment.id}/void`, c.token, {});
    expect([(await inv(l1)).balanceDue, (await inv(l2)).balanceDue]).toEqual(['100.0049', '100.0050']);
  });

  it('POST /invoices/:id/payment writes an application, takes at most the cent balance and keeps the rest as a credit', async () => {
    const id = await invoice('80.00', '2026-10-01');
    const r = await request('POST', `/api/v1/invoices/${id}/payment`, c.token, { amount: '100.00', txnDate: '2026-10-05', depositToAccountId: c.bank });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const x = await inv(id);
    expect([x.balanceDue, x.invoiceStatus]).toEqual(['0.0000', 'paid']);
    const rec = await request('GET', `/api/v1/payments/${r.json.payment.id}`, c.token);
    expect(rec.json.payment.applications.map((a: any) => a.amount)).toEqual(['80.00']);
    expect(rec.json.payment.unappliedRemaining).toBe('20.00');
  });

  it('PUT /payments/:id re-applies; expectedBalanceDue includes its own share; a deposited payment takes memo only', async () => {
    const { i1091, i1095 } = await mockup();
    const { payment } = await previewThenReceive({ amount: '4000.00' });
    const p = await request('POST', '/api/v1/payments/preview', c.token, previewBody({
      editingPaymentId: payment.id, amount: '5645.00',
    }));
    expect(p.json.invoices.map((i: any) => i.balanceDueExact)).toEqual(['4385.0000', '1260.0000']);
    expect(p.json.contactBalanceBefore).toBe('5645.00');
    const apps = (p.json.invoices as any[]).map((i) => ({ invoiceId: i.invoiceId, amount: i.payment, expectedBalanceDue: i.balanceDueExact }));
    let r = await request('PUT', `/api/v1/payments/${payment.id}`, c.token, {
      customerId: c.customer, date: '2026-11-04', depositTo: c.clearing, amount: '5645.00', applications: apps,
      expectedUpdatedAt: payment.updatedAt, memo: 'edited',
    }, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect([(await inv(i1091)).invoiceStatus, (await inv(i1095)).invoiceStatus]).toEqual(['paid', 'paid']);
    expect(r.json.payment.applications.filter((a: any) => !a.voided).map((a: any) => a.amount)).toEqual(['4385.00', '1260.00']);
    expect(await linesOf(payment.id)).toEqual([[c.clearing, '5645.0000', '0.0000'], [c.ar, '0.0000', '5645.0000']]);
    const stale = await request('PUT', `/api/v1/payments/${payment.id}`, c.token, {
      customerId: c.customer, date: '2026-11-04', depositTo: c.clearing, amount: '5645.00', applications: apps, expectedUpdatedAt: payment.updatedAt,
    });
    expect([stale.status, stale.json.error.code]).toEqual([409, 'STALE']);

    const d = await request('POST', '/api/v1/transactions', c.token, {
      txnType: 'deposit', txnDate: '2026-11-05', depositToAccountId: c.bank,
      lines: [{ accountId: c.clearing, amount: '5645.00', sourceTransactionId: payment.id }],
    });
    expect(d.status).toBe(201);
    const same = { customerId: c.customer, date: '2026-11-04', depositTo: c.clearing, amount: '5645.00',
      applications: [{ invoiceId: i1091, amount: '4385.00' }, { invoiceId: i1095, amount: '1260.00' }] };
    r = await request('PUT', `/api/v1/payments/${payment.id}`, c.token, { ...same, memo: 'memo only', refNo: '10442' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect([r.json.payment.memo, r.json.payment.refNo]).toEqual(['memo only', '10442']);
    r = await request('PUT', `/api/v1/payments/${payment.id}`, c.token, { ...same, amount: '5600.00',
      applications: [{ invoiceId: i1091, amount: '4340.00' }, { invoiceId: i1095, amount: '1260.00' }] });
    expect([r.status, r.json.error.code]).toEqual([409, 'TXN_DEPOSITED']);
    // A memo edit of a deposited payment in a closed period needs the closing password (review SF4).
    await db.update(companies).set({ lockDate: '2026-11-30', closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) }).where(eq(companies.id, c.companyId));
    r = await request('PUT', `/api/v1/payments/${payment.id}`, c.token, { ...same, memo: 'closed' });
    expect(r.status).toBe(423);
    r = await request('PUT', `/api/v1/payments/${payment.id}`, c.token, { ...same, memo: 'closed', closingPassword: CLOSING_PHRASE });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.payment.memo).toBe('closed');
  });

  it('averageDaysToPay: null below 3 cleared invoices, then the mean days to the payment that cleared each', async () => {
    const a = await invoice('10.00', '2026-08-01');
    const b = await invoice('10.00', '2026-08-01');
    const d = await invoice('10.00', '2026-08-01');
    await request('POST', '/api/v1/payments/receive', c.token, { customerId: c.customer, date: '2026-08-11', depositTo: c.bank, amount: '10.00', applications: [{ invoiceId: a, amount: '10.00' }] });
    await request('POST', '/api/v1/payments/receive', c.token, { customerId: c.customer, date: '2026-08-21', depositTo: c.bank, amount: '10.00', applications: [{ invoiceId: b, amount: '10.00' }] });
    let p = await request('POST', '/api/v1/payments/preview', c.token, previewBody({}));
    expect(p.json.averageDaysToPay).toBeNull();
    await request('POST', '/api/v1/payments/receive', c.token, { customerId: c.customer, date: '2026-08-26', depositTo: c.bank, amount: '10.00', applications: [{ invoiceId: d, amount: '10.00' }] });
    p = await request('POST', '/api/v1/payments/preview', c.token, previewBody({}));
    expect(p.json.averageDaysToPay).toBe(18); // (10 + 20 + 25) / 3 = 18.33
    expect(p.json.problems).toEqual([{ code: 'AMOUNT_REQUIRED' }]);
  });
});

describe('payment-bounce-v1 (U-132)', () => {
  /** Golden 7: case 1 grouped with another client's 6,210.00 into a 10,210.00 deposit to the bank. */
  async function grouped() {
    const { i1091, i1095 } = await mockup();
    const otherInv = await invoice('6210.00', '2026-10-05', c.other);
    const other = await request('POST', '/api/v1/payments/receive', c.token, {
      customerId: c.other, date: '2026-11-01', depositTo: c.clearing, amount: '6210.00', applications: [{ invoiceId: otherInv, amount: '6210.00' }],
    });
    const bankBefore = await balance(c.bank);
    const { payment } = await previewThenReceive({ amount: '4000.00' });
    const d = await request('POST', '/api/v1/transactions', c.token, {
      txnType: 'deposit', txnDate: '2026-11-05', depositToAccountId: c.bank,
      lines: [
        { accountId: c.clearing, amount: '4000.00', sourceTransactionId: payment.id },
        { accountId: c.clearing, amount: '6210.00', sourceTransactionId: other.json.payment.id },
      ],
    });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    return { i1091, i1095, payment, otherPayment: other.json.payment.id, depositId: d.json.transaction.id as string, bankBefore };
  }

  it('golden 7: a bounce on a grouped deposit restores 1091, the client and the bank exactly; the other check stays deposited', async () => {
    const g = await grouped();
    const k = { 'Idempotency-Key': key() };
    const body = { date: '2026-11-12', bankFeeAmount: '35.00', bankFeeAccountId: c.fee, expectedUpdatedAt: g.payment.updatedAt };
    const r = await request('POST', `/api/v1/payments/${g.payment.id}/bounce`, c.token, body, k);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.heldIn).toEqual({ accountId: c.bank, kind: 'bank' });
    expect(r.json.reopened).toEqual([{ invoiceId: g.i1091, balanceDue: '4385.00' }]);
    expect(await linesOf(r.json.returnId)).toEqual([[c.ar, '4000.0000', '0.0000'], [c.bank, '0.0000', '4000.0000']]);
    expect(await linesOf(r.json.feeId)).toEqual([[c.fee, '35.0000', '0.0000'], [c.bank, '0.0000', '35.0000']]);
    const ret = await inv(r.json.returnId);
    expect([ret.txnType, ret.txnDate, ret.sourceTxnId]).toEqual(['returned_payment', '2026-11-12', g.payment.id]);
    expect([(await inv(g.i1091)).balanceDue, (await inv(g.i1091)).invoiceStatus]).toEqual(['4385.0000', 'draft']);
    expect(await contactAR()).toBe('5645.0000');
    const bank = await balance(c.bank);
    expect(bank).toBe((Number(g.bankBefore) + 6210 - 35).toFixed(4));
    const links = await db.select().from(depositLines).where(eq(depositLines.depositId, g.depositId));
    expect(links.map((l) => l.sourceTransactionId).sort()).toEqual([g.payment.id, g.otherPayment].sort());
    // Replay with the same key posts once; a second key is 409 PAYMENT_BOUNCED.
    const replay = await request('POST', `/api/v1/payments/${g.payment.id}/bounce`, c.token, body, k);
    expect([replay.status, replay.json.returnId]).toEqual([201, r.json.returnId]);
    const again = await request('POST', `/api/v1/payments/${g.payment.id}/bounce`, c.token, { date: '2026-11-12' }, { 'Idempotency-Key': key() });
    expect([again.status, again.json.error.code]).toEqual([409, 'PAYMENT_BOUNCED']);
    // After the bounce: no credit left; void / edit / delete of the deposit and re-depositing are refused.
    const rec = await request('GET', `/api/v1/payments/${g.payment.id}`, c.token);
    expect([rec.json.payment.unappliedRemaining, rec.json.payment.bounce.returnId]).toEqual(['0.00', r.json.returnId]);
    expect(rec.json.payment.applications.map((a: any) => a.reversed)).toEqual([true]);
    let x = await request('POST', `/api/v1/transactions/${g.depositId}/void`, c.token, { reason: 'x' });
    expect([x.status, x.json.error.code]).toEqual([409, 'PAYMENT_BOUNCED']);
    x = await request('DELETE', `/api/v1/transactions/${g.depositId}`, c.token, {});
    expect([x.status, x.json.error.code]).toEqual([409, 'PAYMENT_BOUNCED']);
    x = await request('PUT', `/api/v1/transactions/${g.depositId}`, c.token, {
      txnType: 'deposit', txnDate: '2026-11-05', depositToAccountId: c.bank,
      lines: [{ accountId: c.clearing, amount: '4000.00', sourceTransactionId: g.payment.id }, { accountId: c.clearing, amount: '6210.00', sourceTransactionId: g.otherPayment }],
    });
    expect([x.status, x.json.error.code]).toEqual([409, 'PAYMENT_BOUNCED']);
    for (const path of [`/api/v1/payments/${g.payment.id}/void`]) {
      x = await request('POST', path, c.token, {});
      expect(x.status).toBe(409);
    }
    x = await request('POST', '/api/v1/payments/unapply', c.token, { paymentId: g.payment.id, invoiceId: g.i1091 });
    expect([x.status, x.json.error.code]).toEqual([409, 'PAYMENT_BOUNCED']);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'payment_applications')));
    expect(audits.some((a) => JSON.stringify(a.afterData).includes('bounce'))).toBe(true);

    // Cash-basis tie-out: revenue over the period = cash collected net of the bounce.
    const pl = await buildProfitAndLoss(c.tenantId, '2026-01-01', '2026-12-31', 'cash', c.companyId) as any;
    expect(String(pl.totalRevenue ?? pl.totals?.revenue ?? pl.revenue?.total)).toMatch(/^6210(\.0+)?$/);
  });

  it('voiding the bounce re-applies; after the invoice is voided it is 409 INVOICE_VOIDED; a reconciled bounce is refused', async () => {
    const g = await grouped();
    let r = await request('POST', `/api/v1/payments/${g.payment.id}/bounce`, c.token, { date: '2026-11-12' });
    expect(r.status).toBe(201);
    let v = await request('POST', `/api/v1/transactions/${r.json.returnId}/void`, c.token, { reason: 'bank error' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect([(await inv(g.i1091)).balanceDue, (await inv(g.i1091)).invoiceStatus]).toEqual(['385.0000', 'partial']);
    expect((await request('GET', `/api/v1/payments/${g.payment.id}`, c.token)).json.payment.bounce).toBeUndefined();

    r = await request('POST', `/api/v1/payments/${g.payment.id}/bounce`, c.token, { date: '2026-11-13' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // Its bank line cleared in a completed reconciliation: refused.
    const [bankLine] = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, r.json.returnId), eq(journalLines.accountId, c.bank)));
    const [rec] = await db.insert(reconciliations).values({
      tenantId: c.tenantId, companyId: c.companyId, accountId: c.bank, statementDate: '2026-11-30',
      statementEndingBalance: '0', beginningBalance: '0', status: 'complete',
    }).returning();
    await db.insert(reconciliationLines).values({ reconciliationId: rec!.id, journalLineId: bankLine!.id, isCleared: true });
    v = await request('POST', `/api/v1/transactions/${r.json.returnId}/void`, c.token, { reason: 'x' });
    expect(v.status).toBe(400);
    await db.delete(reconciliationLines).where(eq(reconciliationLines.reconciliationId, rec!.id));

    v = await request('POST', `/api/v1/invoices/${g.i1091}/void`, c.token, { reason: 'dup' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    v = await request('POST', `/api/v1/transactions/${r.json.returnId}/void`, c.token, { reason: 'x' });
    expect([v.status, v.json.error.code]).toEqual([409, 'INVOICE_VOIDED']);
  });

  it('an undeposited payment bounces against Payments Clearing and leaves the pending deposits', async () => {
    await mockup();
    const { payment } = await previewThenReceive({ amount: '4000.00' });
    let r = await request('POST', `/api/v1/payments/${payment.id}/bounce`, c.token, { date: '2026-11-10', bankFeeAmount: '35.00', bankFeeAccountId: c.fee });
    expect([r.status, r.json.error?.code]).toEqual([400, 'FEE_BANK_REQUIRED']);
    // The fee account can't be the bank the fee comes out of (Dr X / Cr X).
    r = await request('POST', `/api/v1/payments/${payment.id}/bounce`, c.token, { date: '2026-11-10', bankFeeAmount: '35.00', bankFeeAccountId: c.bank, bankFeeBankAccountId: c.bank });
    expect([r.status, r.json.error?.code]).toEqual([400, 'FEE_ACCOUNT_INVALID']);
    r = await request('POST', `/api/v1/payments/${payment.id}/bounce`, c.token, { date: '2026-11-10', bankFeeAmount: '35.00', bankFeeAccountId: c.fee, bankFeeBankAccountId: c.bank });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.heldIn).toEqual({ accountId: c.clearing, kind: 'payments_clearing' });
    expect(await balance(c.clearing)).toBe('0.0000');
    const pending = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token);
    expect(pending.json.items).toEqual([]);
    const d = await request('POST', '/api/v1/transactions', c.token, {
      txnType: 'deposit', txnDate: '2026-11-11', depositToAccountId: c.bank,
      lines: [{ accountId: c.clearing, amount: '4000.00', sourceTransactionId: payment.id }],
    });
    expect([d.status, d.json.error.code]).toEqual([409, 'PAYMENT_BOUNCED']);
  });

  it('a bounce dated after the closing date needs no password, even with a closed-period deposit; a date before the deposit is 400', async () => {
    const g = await grouped();
    await db.update(companies).set({ lockDate: '2026-11-08', closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) }).where(eq(companies.id, c.companyId));
    let r = await request('POST', `/api/v1/payments/${g.payment.id}/bounce`, c.token, { date: '2026-11-04' });
    expect([r.status, r.json.error.code]).toEqual([400, 'BOUNCE_DATE_INVALID']);
    r = await request('POST', `/api/v1/payments/${g.payment.id}/bounce`, c.token, { date: '2026-11-12' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // Nothing dated in the closed period changed.
    expect(await linesOf(g.payment.id)).toEqual([[c.clearing, '4000.0000', '0.0000'], [c.ar, '0.0000', '4000.0000']]);
    expect((await inv(g.depositId)).status).toBe('posted');
  });

  it('company settings carry the bounced-payment preferences', async () => {
    let r = await request('PUT', '/api/v1/company/settings', c.token, { nsfBankFeeAccountId: c.fee, nsfFeeIncomeAccountId: c.revenue, nsfCustomerFee: '25.00' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await request('GET', '/api/v1/company/settings', c.token);
    expect([r.json.settings.nsfBankFeeAccountId, r.json.settings.nsfFeeIncomeAccountId, r.json.settings.nsfCustomerFee])
      .toEqual([c.fee, c.revenue, '25.00']);
    r = await request('PUT', '/api/v1/company/settings', c.token, { nsfBankFeeAccountId: c.ar });
    expect([r.status, r.json.error.code]).toEqual([400, 'NSF_ACCOUNT_INVALID']);
    // The default fee account is used when the bounce names none.
    await mockup();
    const { payment } = await previewThenReceive({ amount: '100.00' }, c.bank);
    const b = await request('POST', `/api/v1/payments/${payment.id}/bounce`, c.token, { date: '2026-11-12', bankFeeAmount: '35.00' });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    expect(await linesOf(b.json.feeId)).toEqual([[c.fee, '35.0000', '0.0000'], [c.bank, '0.0000', '35.0000']]);
  });
});
