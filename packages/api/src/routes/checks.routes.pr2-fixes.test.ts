// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Purchasing fixes (ClientLedger checkpoint PR-2), through the HTTP routes:
//   - U-115: a void check leaves the print queue (both void paths); the
//     queue lists posted checks only; print refuses a void check (CHECK_VOID);
//   - U-116: POST /checks/print is keyed (idempotency-check-print-v1);
//   - U-117: no $0 check queued for a credits-only payment (S1); requeue
//     skips void checks (S2); PUT /checks/settings never rolls the counter
//     back (S3); print and edit of the same check do not deadlock (S4); the
//     bill-payment void audit carries the applications (S5); vendor credit
//     numbers per company inside the posting transaction (N1); the print
//     audit lists each check's number (N2); company scope on bill / credit
//     reads and the check PDFs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, depositLines, transactionTags, tags, vendorCreditApplications, billPaymentApplications, userPermissions,
  idempotencyKeys, spoiledCheckNumbers,
} from '../db/schema/index.js';
import { billsRouter } from './bills.routes.js';
import { vendorCreditsRouter } from './vendor-credits.routes.js';
import { billPaymentsRouter } from './bill-payments.routes.js';
import { checksRouter } from './checks.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders; raw: Buffer }

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
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers, raw });
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
  await db.delete(spoiledCheckNumbers).where(eq(spoiledCheckNumbers.tenantId, tid));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tid));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
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
  bank: string; expense: string; vendor: string;
}

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `pr2-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `PR2 ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const [expense] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1);
  const [v] = await db.insert(contacts).values({
    tenantId, contactType: 'vendor', displayName: 'Ozark Lumber',
    billingLine1: '410 Industrial Pkwy', billingCity: 'Springfield', billingState: 'MO', billingZip: '65803',
  }).returning();
  return {
    tenantId, token: reg.tokens.accessToken, companyId: company!.id, userId: reg.user.id,
    bank: bank!.id, expense: expense!.id, vendor: v!.id,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bills', billsRouter);
  app.use('/api/v1/vendor-credits', vendorCreditsRouter);
  app.use('/api/v1/bill-payments', billPaymentsRouter);
  app.use('/api/v1/checks', checksRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany('a');
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const parse = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)).limit(1))[0]!;
const counter = async () => {
  const [co] = await db.select().from(companies).where(eq(companies.id, c.companyId));
  return (co!.checkSettings as any)?.nextCheckNumbers?.[c.bank];
};

async function writeCheck(extra: Record<string, unknown> = {}) {
  const r = await request('POST', '/api/v1/checks', c.token, {
    bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Ozark Lumber', txnDate: '2026-11-04',
    amount: '125.40', printLater: true, lines: [{ accountId: c.expense, amount: '125.40' }], ...extra,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.check.id as string;
}

async function enterBill(amount: string, extra: Record<string, unknown> = {}) {
  const r = await request('POST', '/api/v1/bills', c.token, {
    contactId: c.vendor, txnDate: '2026-11-01', paymentTerms: 'net_30', lines: [{ accountId: c.expense, amount }], ...extra,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.bill.id as string;
}

async function enterCredit(amount: string, headers: Record<string, string> = {}, expense = c.expense) {
  const r = await request('POST', '/api/v1/vendor-credits', c.token, {
    contactId: c.vendor, txnDate: '2026-11-02', lines: [{ accountId: expense, amount }],
  }, headers);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.credit as { id: string; txnNumber: string };
}

const print = (checkIds: string[], startingCheckNumber: number, headers: Record<string, string> = {}) =>
  request('POST', '/api/v1/checks/print', c.token, { bankAccountId: c.bank, checkIds, startingCheckNumber, format: 'voucher' }, headers);

const queueIds = async () =>
  ((await request('GET', '/api/v1/checks/print-queue', c.token)).json.data as Array<{ id: string }>).map((r) => r.id);

/** Wait until at least n sessions of this database wait on a lock (bounded). */
async function waitForLockWaiters(n: number) {
  for (let i = 0; i < 250; i++) {
    const waiting = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `);
    if ((waiting.rows[0] as { n: number }).n >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('void checks leave the print queue (U-115)', () => {
  it('a To be printed bill payment voided: out of the queue, print refuses it (CHECK_VOID); the void audit carries the applications (S5)', async () => {
    const billId = await enterBill('500.00');
    const credit = await enterCredit('40.00');
    const pay = await request('POST', '/api/v1/bill-payments', c.token, {
      bankAccountId: c.bank, txnDate: '2026-11-04', method: 'check', printLater: true,
      bills: [{ billId, amount: '300.00' }], credits: [{ creditId: credit.id, billId, amount: '40.00' }],
    });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const paymentId = pay.json.payments[0].id as string;
    expect(await queueIds()).toContain(paymentId);

    const v = await request('POST', `/api/v1/bill-payments/${paymentId}/void`, c.token, { reason: 'wrong amount' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    const after = await row(paymentId);
    expect(after.status).toBe('void');
    expect(after.printStatus).toBeNull();
    expect(await queueIds()).not.toContain(paymentId);

    const p = await print([paymentId], 1001);
    expect(p.status).toBe(400);
    expect(p.json.error.code).toBe('CHECK_VOID');
    expect(p.json.error.details).toEqual({ checkId: paymentId });
    expect((await row(paymentId)).checkNumber).toBeNull();

    // S5: the deleted application rows are in the void's before-image.
    const [audit] = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityId, paymentId), eq(auditLog.action, 'void'),
    ));
    const before = parse(audit!.beforeData);
    expect(before.billApplications).toEqual([expect.objectContaining({ billId, paymentId, amount: '260.0000' })]);
    expect(before.creditApplications).toEqual([expect.objectContaining({ creditId: credit.id, billId, paymentId, amount: '40.0000' })]);
  });

  it('a written check voided from the register: out of the queue, print refuses it', async () => {
    const id = await writeCheck();
    expect(await queueIds()).toContain(id);
    const v = await request('POST', `/api/v1/transactions/${id}/void`, c.token, { reason: 'duplicate' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect((await row(id)).printStatus).toBeNull();
    expect(await queueIds()).not.toContain(id);
    // Still a check: listed (as void) and edits get the void refusal, not 404.
    const list = await request('GET', '/api/v1/checks', c.token);
    expect((list.json.data as any[]).find((r) => r.id === id)).toMatchObject({ status: 'void', printStatus: null });
    expect((await request('PATCH', `/api/v1/checks/${id}/memo`, c.token, { printedMemo: 'x' })).status).toBe(400);
    const p = await print([id], 1001);
    expect(p.status).toBe(400);
    expect(p.json.error.code).toBe('CHECK_VOID');
  });

  it('a void check still marked queue (voided before this fix) is not listed and does not print', async () => {
    const id = await writeCheck();
    await db.update(transactions).set({ status: 'void' }).where(eq(transactions.id, id));
    expect(await queueIds()).not.toContain(id);
    const p = await print([id], 1001);
    expect(p.status).toBe(400);
    expect(p.json.error.code).toBe('CHECK_VOID');
    expect(await counter()).toBeUndefined();
  });
});

describe('keyed print (U-116, idempotency-check-print-v1)', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-check-print-v1');
  });

  it('a retry with the same key replays the original batch; nothing is numbered twice', async () => {
    const a = await writeCheck();
    const b = await writeCheck();
    const key = `print-${crypto.randomUUID()}`;
    const first = await print([a, b], 1001, { 'Idempotency-Key': key });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toEqual({ batchId: expect.any(String), checksPrinted: 2, checkNumberRange: '1001–1002' });

    const again = await print([a, b], 1001, { 'Idempotency-Key': key });
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(first.json);
    expect((await row(a)).checkNumber).toBe(1001);
    expect((await row(b)).checkNumber).toBe(1002);
    expect(await counter()).toBe(1003);
    const prints = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'check_print')));
    expect(prints).toHaveLength(1);

    // Without a stored body the reader rebuilds the batch from its checks.
    await db.update(idempotencyKeys).set({ responseBody: null }).where(eq(idempotencyKeys.tenantId, c.tenantId));
    const rebuilt = await print([a, b], 1001, { 'Idempotency-Key': key });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.json).toEqual(first.json);

    // Another request under the key is refused.
    const reused = await print([a], 2001, { 'Idempotency-Key': key });
    expect(reused.status).toBe(422);
    expect(reused.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('the print audit lists each check and its number (N2)', async () => {
    const a = await writeCheck();
    const b = await writeCheck();
    expect((await print([a, b], 3001)).status).toBe(200);
    const [audit] = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'check_print')));
    expect(parse(audit!.afterData).checks).toEqual([{ id: a, checkNumber: 3001 }, { id: b, checkNumber: 3002 }]);
  });
});

describe('purchasing fixes (U-117)', () => {
  it('S1: a credits-only vendor payment marked To be printed queues no $0 check', async () => {
    const billId = await enterBill('100.00');
    const credit = await enterCredit('100.00');
    const pay = await request('POST', '/api/v1/bill-payments', c.token, {
      bankAccountId: c.bank, txnDate: '2026-11-04', method: 'check', printLater: true,
      bills: [{ billId, amount: '100.00' }], credits: [{ creditId: credit.id, billId, amount: '100.00' }],
    });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const paymentId = pay.json.payments[0].id as string;
    expect((await row(paymentId)).printStatus).toBeNull();
    expect(await queueIds()).not.toContain(paymentId);
    expect((await row(billId)).billStatus).toBe('paid');
  });

  it('S2: requeue skips a void check and sends the others back', async () => {
    const a = await writeCheck();
    const b = await writeCheck();
    expect((await print([a, b], 1001)).status).toBe(200);
    expect((await request('POST', `/api/v1/transactions/${b}/void`, c.token, { reason: 'lost' })).status).toBe(200);
    const rq = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [a, b] });
    expect(rq.status, JSON.stringify(rq.json)).toBe(200);
    expect(rq.json.checks).toEqual([{ id: a, spoiledCheckNumber: 1001, bankAccountId: c.bank }]);
    expect(rq.json.skipped).toEqual([{ id: b, reason: 'void' }]);
    expect((await row(a)).printStatus).toBe('queue');
    expect((await row(b)).checkNumber).toBe(1002);
    expect((await row(b)).status).toBe('void');

    // A void check that never printed (its queue status cleared) is skipped too.
    const queuedThenVoid = await writeCheck();
    expect((await request('POST', `/api/v1/transactions/${queuedThenVoid}/void`, c.token, { reason: 'x' })).status).toBe(200);
    const only = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [queuedThenVoid] });
    expect(only.status).toBe(200);
    expect(only.json).toMatchObject({ checks: [], skipped: [{ id: queuedThenVoid, reason: 'void' }] });
  });

  it('S3: PUT /checks/settings during a print never rolls the counter back', async () => {
    const id = await writeCheck();
    let printing!: Promise<Res>;
    let putting!: Promise<Res>;
    await db.transaction(async (holder) => {
      await holder.execute(sql`SELECT 1 FROM companies WHERE id = ${c.companyId} FOR UPDATE`);
      printing = print([id], 5001);
      await waitForLockWaiters(1);
      putting = request('PUT', '/api/v1/checks/settings', c.token, { format: 'check_middle', bankName: 'First Ozark' });
      await waitForLockWaiters(2);
    });
    const [p, s] = await Promise.all([printing, putting]);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(await counter()).toBe(5002);
    const [co] = await db.select().from(companies).where(eq(companies.id, c.companyId));
    expect(co!.checkSettings).toMatchObject({ format: 'check_middle', bankName: 'First Ozark' });

    // A sent nextCheckNumbers map is merged per bank account.
    const other = crypto.randomUUID();
    const put = await request('PUT', '/api/v1/checks/settings', c.token, { nextCheckNumbers: { [other]: 9001 } });
    expect(put.status).toBe(200);
    expect(put.json.settings.nextCheckNumbers).toEqual({ [c.bank]: 5002, [other]: 9001 });
    expect(put.json.settings.format).toBe('check_middle');
  });

  it('S4: print and edit of the same check at the same time do not deadlock', async () => {
    const id = await writeCheck();
    let printing!: Promise<Res>;
    let editing!: Promise<Res>;
    await db.transaction(async (holder) => {
      await holder.execute(sql`SELECT 1 FROM companies WHERE id = ${c.companyId} FOR UPDATE`);
      printing = print([id], 6001);
      await waitForLockWaiters(1);
      editing = request('PUT', `/api/v1/checks/${id}`, c.token, {
        bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Ozark Lumber', txnDate: '2026-11-04',
        // printLater false numbers a queued check from the counter: the edit
        // path that takes the counter lock (after the check row, before S4).
        amount: '125.40', printLater: false, lines: [{ accountId: c.expense, amount: '125.40', description: 'Lumber' }],
      });
      await waitForLockWaiters(2);
    });
    const [p, e] = await Promise.all([printing, editing]);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(e.status, JSON.stringify(e.json)).toBe(200);
    const after = await row(id);
    expect(after.checkNumber).toBe(6001);
    expect(after.printStatus).toBe('printed');
  });

  it('N1: vendor credit numbers are distinct under concurrent saves and counted per company', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => request('POST', '/api/v1/vendor-credits', c.token, {
      contactId: c.vendor, txnDate: '2026-11-02', lines: [{ accountId: c.expense, amount: `${i}.00` }],
    })));
    for (const r of results) expect(r.status, JSON.stringify(r.json)).toBe(201);
    const numbers = results.map((r) => r.json.credit.txnNumber as string).sort();
    expect(numbers).toEqual(['VC-00001', 'VC-00002', 'VC-00003', 'VC-00004', 'VC-00005']);

    // Another company's credits don't count (VC-00050 there), and a
    // refused post takes no number.
    const [second] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    await db.insert(transactions).values({
      tenantId: c.tenantId, companyId: second!.id, txnType: 'vendor_credit', txnNumber: 'VC-00050',
      txnDate: '2026-11-02', status: 'posted', total: '1.0000',
    });
    const refused = await request('POST', '/api/v1/vendor-credits', c.token, {
      contactId: crypto.randomUUID(), txnDate: '2026-11-02', lines: [{ accountId: c.expense, amount: '1.00' }],
    });
    expect(refused.status).toBe(400);
    expect((await enterCredit('3.00')).txnNumber).toBe('VC-00006');
  });
});

describe('company scope (U-117 security note)', () => {
  it('bills, vendor credits and check PDFs of another company are 404', async () => {
    const billId = await enterBill('75.00');
    const credit = await enterCredit('20.00');
    const checkId = await writeCheck();
    const [second] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    const asOther = { 'X-Company-Id': second!.id };

    expect((await request('GET', `/api/v1/bills/${billId}`, c.token)).status).toBe(200);
    expect((await request('GET', `/api/v1/bills/${billId}`, c.token, undefined, asOther)).status).toBe(404);
    expect((await request('GET', `/api/v1/vendor-credits/${credit.id}`, c.token)).status).toBe(200);
    expect((await request('GET', `/api/v1/vendor-credits/${credit.id}`, c.token, undefined, asOther)).status).toBe(404);
    const mine = await request('GET', `/api/v1/vendor-credits/available/${c.vendor}`, c.token);
    expect(mine.json.credits.map((r: any) => r.id)).toEqual([credit.id]);
    const theirs = await request('GET', `/api/v1/vendor-credits/available/${c.vendor}`, c.token, undefined, asOther);
    expect(theirs.status).toBe(200);
    expect(theirs.json.credits).toEqual([]);

    const render = (h: Record<string, string> = {}) =>
      request('POST', '/api/v1/checks/render', c.token, { checkIds: [checkId], format: 'voucher' }, h);
    const envelopes = (h: Record<string, string> = {}) =>
      request('POST', '/api/v1/checks/envelopes', c.token, { checkIds: [checkId] }, h);
    expect((await render()).status).toBe(200);
    expect((await render(asOther)).status).toBe(404);
    expect((await envelopes()).status).toBe(200);
    expect((await envelopes(asOther)).status).toBe(404);

    // The test page prints the request's company settings, never another one's.
    const test = await request('POST', '/api/v1/checks/test-print', c.token, { format: 'voucher' }, asOther);
    expect(test.status).toBe(200);
    expect(test.headers['content-type']).toBe('application/pdf');
  });
});
