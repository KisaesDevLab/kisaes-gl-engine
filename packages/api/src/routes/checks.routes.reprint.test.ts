// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Check printing for clients that print themselves (check-reprint-audit-v1,
// company-logo-v1), through the HTTP routes:
//   - U-106: requeue / reprint clear the number, spoil it on the bank
//     account (GET /checks/spoiled), audit each check, and never void the
//     payment; a spoiled number may be reused (owner decision 2026-10-29);
//     company scope on requeue, reprint, print and the counter; print
//     refuses a check drawn on another account;
//   - U-107: print-queue rows carry txnType, bankAccountId, payeeAddress;
//   - U-108: GET /bill-payments/:id applications carry bill / credit;
//   - U-109: checkSettings.layouts per bank account with company fallback;
//   - U-110: GET /company/logo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
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
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import { env } from '../config/env.js';
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
  bank: string; bank2: string; expense: string; vendor: string;
}

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `reprint-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Reprint ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const [bank2] = await db.insert(accounts).values({
    tenantId, companyId: company!.id, name: 'Payroll Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1015',
  }).returning();
  const [expense] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1);
  const [v] = await db.insert(contacts).values({
    tenantId, contactType: 'vendor', displayName: 'Ozark Lumber',
    billingLine1: '410 Industrial Pkwy', billingLine2: 'Dock 3', billingCity: 'Springfield', billingState: 'MO', billingZip: '65803',
  }).returning();
  return {
    tenantId, token: reg.tokens.accessToken, companyId: company!.id, userId: reg.user.id,
    bank: bank!.id, bank2: bank2!.id, expense: expense!.id, vendor: v!.id,
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
  app.use('/api/v1/company', companyRouter);
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
const balanceOf = async (accountId: string) =>
  (await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, accountId)))[0]!.b;

async function writeCheck(extra: Record<string, unknown> = {}) {
  const r = await request('POST', '/api/v1/checks', c.token, {
    bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Ozark Lumber', txnDate: '2026-11-04',
    amount: '125.40', printLater: true, lines: [{ accountId: c.expense, amount: '125.40' }], ...extra,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.check.id as string;
}

const print = (checkIds: string[], startingCheckNumber: number, bankAccountId = c.bank, headers: Record<string, string> = {}) =>
  request('POST', '/api/v1/checks/print', c.token, { bankAccountId, checkIds, startingCheckNumber, format: 'voucher' }, headers);

describe('check-reprint-audit-v1 / company-logo-v1', () => {
  it('advertises the capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['check-reprint-audit-v1', 'company-logo-v1']));
  });
});

describe('requeue records the spoiled number (U-106)', () => {
  it('clears the number, records it as spoiled with an audit row; the number may be reused', async () => {
    const id = await writeCheck();
    const p = await print([id], 1001);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const batchId = p.json.batchId as string;

    const rq = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [id] });
    expect(rq.status, JSON.stringify(rq.json)).toBe(200);
    expect(rq.json.checks).toEqual([{ id, spoiledCheckNumber: 1001, bankAccountId: c.bank }]);
    const after = await row(id);
    expect(after.checkNumber).toBeNull();
    expect(after.printStatus).toBe('queue');
    expect(after.printBatchId).toBeNull();
    expect(after.status).toBe('posted');

    const audit = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'check'), eq(auditLog.entityId, id)));
    expect(audit).toHaveLength(1);
    expect(parse(audit[0]!.beforeData)).toEqual({ checkNumber: 1001, printStatus: 'printed', printBatchId: batchId });
    expect(parse(audit[0]!.afterData)).toMatchObject({
      checkNumber: null, printStatus: 'queue', spoiledCheckNumber: 1001, bankAccountId: c.bank, reason: 'requeue',
    });
    expect(audit[0]!.userId).toBe(c.userId);

    const spoiled = await request('GET', `/api/v1/checks/spoiled?bank_account_id=${c.bank}`, c.token);
    expect(spoiled.status).toBe(200);
    expect(spoiled.json.data).toEqual([expect.objectContaining({
      checkNumber: 1001, checkId: id, bankAccountId: c.bank, reason: 'requeue', spoiledBy: c.userId,
      spoiledByName: 'Owner a', txnDate: '2026-11-04',
    })]);
    expect(typeof spoiled.json.data[0].spoiledAt).toBe('string');
    // Another bank account has none.
    expect((await request('GET', `/api/v1/checks/spoiled?bank_account_id=${c.bank2}`, c.token)).json.data).toEqual([]);

    // A spoiled number may be used again (owner decision 2026-10-29): the
    // check reprints under its old number; a second spoil is listed again.
    const again = await print([id], 1001);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect((await row(id)).checkNumber).toBe(1001);
    expect((await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [id] })).status).toBe(200);
    const twice = await request('GET', '/api/v1/checks/spoiled', c.token);
    expect(twice.json.data.map((s: any) => s.checkNumber)).toEqual([1001, 1001]);

    // A number another live check holds is still refused on print.
    const holder = await request('POST', '/api/v1/checks', c.token, {
      bankAccountId: c.bank, payeeNameOnCheck: 'Ozark Lumber', txnDate: '2026-11-05', amount: '10.00',
      printLater: false, checkNumber: 1005, lines: [{ accountId: c.expense, amount: '10.00' }],
    });
    expect(holder.status, JSON.stringify(holder.json)).toBe(201);
    const clash = await print([id], 1005);
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe('CHECK_NUMBER_IN_USE');
    expect(clash.json.error.details).toEqual({ checkNumber: '1005' });
    expect((await row(id)).printStatus).toBe('queue');
  });

  it('requeue of a check without a number spoils nothing', async () => {
    const id = await writeCheck();
    const r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [id] });
    expect(r.status).toBe(200);
    expect(r.json.checks).toEqual([{ id, spoiledCheckNumber: null, bankAccountId: c.bank }]);
    expect(await db.select().from(spoiledCheckNumbers).where(eq(spoiledCheckNumbers.tenantId, c.tenantId))).toEqual([]);
  });

  it('PUT /checks/:id with printedCheckChange reprint spoils the printed number', async () => {
    const id = await writeCheck();
    expect((await print([id], 1001)).status).toBe(200);
    const r = await request('PUT', `/api/v1/checks/${id}`, c.token, {
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Ozark Lumber', txnDate: '2026-11-04',
      amount: '130.00', lines: [{ accountId: c.expense, amount: '130.00' }], printedCheckChange: 'reprint',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await row(id)).checkNumber).toBeNull();
    const spoiled = await db.select().from(spoiledCheckNumbers).where(eq(spoiledCheckNumbers.tenantId, c.tenantId));
    expect(spoiled.map((s) => [s.checkNumber, s.bankAccountId, s.reason])).toEqual([[1001, c.bank, 'edit_reprint']]);
  });

  it('a hand-written check is refused (400 CHECK_NOT_PRINTED); its number is not spoiled', async () => {
    const queued = await writeCheck();
    const hw = await request('POST', '/api/v1/checks', c.token, {
      bankAccountId: c.bank, payeeNameOnCheck: 'Ozark Lumber', txnDate: '2026-11-05', amount: '10.00',
      printLater: false, checkNumber: 1200, lines: [{ accountId: c.expense, amount: '10.00' }],
    });
    expect(hw.status, JSON.stringify(hw.json)).toBe(201);
    const id = hw.json.check.id as string;
    expect((await row(id)).printStatus).toBe('hand_written');

    // Alone or with a queued check: the whole request is refused.
    for (const checkIds of [[id], [queued, id]]) {
      const r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('CHECK_NOT_PRINTED');
    }
    expect((await row(id)).checkNumber).toBe(1200);
    expect((await row(id)).printStatus).toBe('hand_written');
    expect(await db.select().from(spoiledCheckNumbers).where(eq(spoiledCheckNumbers.tenantId, c.tenantId))).toEqual([]);
  });

  it('a numbered check whose bank account cannot be resolved is refused (400 CHECK_BANK_ACCOUNT_UNKNOWN)', async () => {
    const id = await writeCheck();
    expect((await print([id], 1001)).status).toBe(200);
    // No bank line left: the check's bank account can't be resolved.
    await db.delete(journalLines).where(eq(journalLines.transactionId, id));
    const r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [id] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('CHECK_BANK_ACCOUNT_UNKNOWN');
    expect((await row(id)).checkNumber).toBe(1001);
    expect((await row(id)).printStatus).toBe('printed');
    expect(await db.select().from(spoiledCheckNumbers).where(eq(spoiledCheckNumbers.tenantId, c.tenantId))).toEqual([]);
  });

  it('a void check is refused (400 CHECK_VOID) and nothing changes', async () => {
    const id = await writeCheck();
    expect((await print([id], 1001)).status).toBe(200);
    await db.update(transactions).set({ status: 'void' }).where(eq(transactions.id, id));
    const r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [id] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('CHECK_VOID');
    expect((await row(id)).checkNumber).toBe(1001);
  });
});

describe('closed periods (U-81, Q-P19ac)', () => {
  const CLOSING_PHRASE = 'reprint-closing-123'; // gitleaks:allow (test placeholder)

  it('requeue and reprint of a single printed check dated on or before the closing date need the closing-date password, and are audited', async () => {
    const lost = await writeCheck({ txnDate: '2026-06-15' });
    const other = await writeCheck({ txnDate: '2026-06-20' });
    const p = await print([lost, other], 1001);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    await db.update(companies).set({
      lockDate: '2026-06-30', closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4),
    }).where(eq(companies.id, c.companyId));
    const overrides = () => db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override'),
    ));

    // One check of the batch (lost in the mail): refused without / with a wrong password, nothing changes.
    let r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [lost] });
    expect(r.status).toBe(423);
    r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [lost], closingPassword: 'wrong-guess' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect((await row(lost)).checkNumber).toBe(1001);
    expect(await db.select().from(spoiledCheckNumbers).where(eq(spoiledCheckNumbers.tenantId, c.tenantId))).toEqual([]);

    r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [lost], closingPassword: CLOSING_PHRASE });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.checks).toEqual([{ id: lost, spoiledCheckNumber: 1001, bankAccountId: c.bank }]);
    expect((await row(lost)).checkNumber).toBeNull();
    // The rest of the batch is untouched.
    expect((await row(other)).checkNumber).toBe(1002);
    expect((await row(other)).printStatus).toBe('printed');
    expect((await overrides()).length).toBeGreaterThanOrEqual(1);
    const checkAudit = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'check'), eq(auditLog.entityId, lost)));
    expect(checkAudit).toHaveLength(1);

    // Reprint of the rest of the batch: same rule.
    expect((await request('POST', `/api/v1/checks/reprint/${p.json.batchId}`, c.token, {})).status).toBe(423);
    expect((await row(other)).checkNumber).toBe(1002);
    const before = (await overrides()).length;
    r = await request('POST', `/api/v1/checks/reprint/${p.json.batchId}`, c.token, { closingPassword: CLOSING_PHRASE });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.checks).toEqual([{ id: other, spoiledCheckNumber: 1002, bankAccountId: c.bank }]);
    expect((await overrides()).length).toBeGreaterThan(before);
  });
});

describe('company scope (U-106)', () => {
  it('requeue, reprint and print of another company\'s check are refused; nothing changes', async () => {
    const mine = await writeCheck();
    const moved = await writeCheck({ amount: '50.00', lines: [{ accountId: c.expense, amount: '50.00' }] });
    const p = await print([moved], 2001);
    expect(p.status).toBe(200);
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    await db.update(transactions).set({ companyId: other!.id }).where(eq(transactions.id, moved));

    // Requeue: one id in another company refuses the whole request.
    const rq = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [mine, moved] });
    expect(rq.status).toBe(404);
    expect((await row(moved)).checkNumber).toBe(2001);
    expect((await row(moved)).printStatus).toBe('printed');

    // Reprint of a batch in another company.
    const rp = await request('POST', `/api/v1/checks/reprint/${p.json.batchId}`, c.token, {});
    expect(rp.status).toBe(404);
    expect((await row(moved)).checkNumber).toBe(2001);
    expect(await db.select().from(spoiledCheckNumbers).where(eq(spoiledCheckNumbers.tenantId, c.tenantId))).toEqual([]);

    // Print: another company's queued check is not found.
    await db.update(transactions).set({ printStatus: 'queue', checkNumber: null }).where(eq(transactions.id, moved));
    const pr = await print([mine, moved], 3001);
    expect(pr.status).toBe(404);
    expect((await row(mine)).printStatus).toBe('queue');

    // A non-UUID batch id is 404, not a database error.
    expect((await request('POST', '/api/v1/checks/reprint/not-a-batch', c.token, {})).status).toBe(404);
  });

  it('the print counter moves only the active company', async () => {
    const [other] = await db.insert(companies).values({
      tenantId: c.tenantId, businessName: 'Second Co', checkSettings: { nextCheckNumbers: { [c.bank]: 500 } },
    }).returning();
    const id = await writeCheck();
    expect((await print([id], 4001)).status).toBe(200);
    const [mine] = await db.select().from(companies).where(eq(companies.id, c.companyId));
    const [theirs] = await db.select().from(companies).where(eq(companies.id, other!.id));
    expect((mine!.checkSettings as any).nextCheckNumbers[c.bank]).toBe(4002);
    expect((theirs!.checkSettings as any).nextCheckNumbers[c.bank]).toBe(500);
  });

  it('two parallel prints of different checks from the same starting number: exactly one is 409 CHECK_NUMBER_IN_USE', async () => {
    const a = await writeCheck();
    const b = await writeCheck();
    // Hold the counter's companies row so both prints are in flight at the
    // same time: without the lock taken before the range query, both pass
    // the query, then queue on the counter UPDATE and both print #1001.
    let both!: Promise<[Res, Res]>;
    await db.transaction(async (holder) => {
      await holder.execute(sql`SELECT 1 FROM companies WHERE id = ${c.companyId} FOR UPDATE`);
      both = Promise.all([print([a], 1001), print([b], 1001)]);
      // Release only once both prints are blocked on a row lock.
      for (let i = 0; i < 250; i++) {
        const waiting = await db.execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
        `);
        if ((waiting.rows[0] as { n: number }).n >= 2) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    });
    const [ra, rb] = await both;
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.json.error.code).toBe('CHECK_NUMBER_IN_USE');
    expect(loser.json.error.details).toEqual({ checkNumber: '1001' });
    const rows = [await row(a), await row(b)];
    expect(rows.map((r) => r.checkNumber).sort()).toEqual([1001, null]);
    expect(rows.map((r) => r.printStatus).sort()).toEqual(['printed', 'queue']);
    const [mine] = await db.select().from(companies).where(eq(companies.id, c.companyId));
    expect((mine!.checkSettings as any).nextCheckNumbers[c.bank]).toBe(1002);
  });

  it('print refuses a check drawn on another bank account', async () => {
    const onBank2 = await writeCheck({ bankAccountId: c.bank2 });
    const r = await print([onBank2], 1001, c.bank);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('CHECK_NOT_ON_BANK_ACCOUNT');
    expect((await row(onBank2)).printStatus).toBe('queue');
    expect((await print([onBank2], 1001, c.bank2)).status).toBe(200);
  });
});

describe('reprint keeps the payment (U-106, Q-P19b)', () => {
  it('a reprinted bill-payment batch stays posted; applications, bill balances and the bank balance are unchanged', async () => {
    const billRes = await request('POST', '/api/v1/bills', c.token, {
      contactId: c.vendor, txnDate: '2026-11-01', paymentTerms: 'net_30', vendorInvoiceNumber: 'INV-5521',
      lines: [{ accountId: c.expense, amount: '1286.40' }],
    });
    expect(billRes.status, JSON.stringify(billRes.json)).toBe(201);
    const billId = billRes.json.bill.id as string;
    const creditRes = await request('POST', '/api/v1/vendor-credits', c.token, {
      contactId: c.vendor, txnDate: '2026-11-02', vendorInvoiceNumber: 'CM-114', lines: [{ accountId: c.expense, amount: '86.40' }],
    });
    expect(creditRes.status, JSON.stringify(creditRes.json)).toBe(201);
    const creditId = creditRes.json.credit.id as string;
    const pay = await request('POST', '/api/v1/bill-payments', c.token, {
      bankAccountId: c.bank, txnDate: '2026-11-04', method: 'check', printLater: true,
      bills: [{ billId, amount: '1286.40' }], credits: [{ creditId, billId, amount: '86.40' }],
    });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const paymentId = pay.json.payments[0].id as string;

    // U-107: the queue row.
    const queue = await request('GET', `/api/v1/checks/print-queue?bank_account_id=${c.bank}`, c.token);
    expect(queue.status).toBe(200);
    const q = (queue.json.data as any[]).find((r) => r.id === paymentId);
    expect(q).toMatchObject({
      txnType: 'bill_payment', bankAccountId: c.bank,
      payeeAddress: ['410 Industrial Pkwy', 'Dock 3', 'Springfield, MO 65803'],
    });

    // U-108: applications carry the documents.
    const got = await request('GET', `/api/v1/bill-payments/${paymentId}`, c.token);
    expect(got.status).toBe(200);
    expect(got.json.payment.billApplications[0].bill).toEqual({
      txnNumber: (await row(billId)).txnNumber ?? null, vendorInvoiceNumber: 'INV-5521', txnDate: '2026-11-01', total: '1286.4000',
    });
    expect(got.json.payment.creditApplications[0].credit).toEqual({
      txnNumber: (await row(creditId)).txnNumber ?? null, vendorInvoiceNumber: 'CM-114', txnDate: '2026-11-02', total: '86.4000',
    });

    const p = await print([paymentId], 7001);
    expect(p.status, JSON.stringify(p.json)).toBe(200);

    const bankBefore = await balanceOf(c.bank);
    const billBefore = await row(billId);
    const appsBefore = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, paymentId));
    const linesBefore = await db.select().from(journalLines).where(eq(journalLines.transactionId, paymentId));

    const rp = await request('POST', `/api/v1/checks/reprint/${p.json.batchId}`, c.token, {});
    expect(rp.status, JSON.stringify(rp.json)).toBe(200);
    expect(rp.json.checks).toEqual([{ id: paymentId, spoiledCheckNumber: 7001, bankAccountId: c.bank }]);

    const payment = await row(paymentId);
    expect(payment.status).toBe('posted');
    expect(payment.checkNumber).toBeNull();
    expect(payment.printStatus).toBe('queue');
    expect(await balanceOf(c.bank)).toBe(bankBefore);
    const billAfter = await row(billId);
    expect(billAfter.balanceDue).toBe(billBefore.balanceDue);
    expect(billAfter.amountPaid).toBe(billBefore.amountPaid);
    expect(billAfter.billStatus).toBe(billBefore.billStatus);
    expect(await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, paymentId))).toEqual(appsBefore);
    expect(await db.select().from(journalLines).where(eq(journalLines.transactionId, paymentId))).toHaveLength(linesBefore.length);

    const audit = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'check'), eq(auditLog.entityId, paymentId)));
    expect(audit).toHaveLength(1);
    expect(parse(audit[0]!.afterData)).toMatchObject({ reason: 'reprint', spoiledCheckNumber: 7001, batchId: p.json.batchId });
    const spoiled = await request('GET', '/api/v1/checks/spoiled', c.token);
    expect(spoiled.json.data.map((s: any) => [s.checkNumber, s.reason])).toEqual([[7001, 'reprint']]);

    // The batch was sent back: a second reprint finds nothing.
    expect((await request('POST', `/api/v1/checks/reprint/${p.json.batchId}`, c.token, {})).status).toBe(404);
    // Reprinted under a new number; the payment is still the same posted payment.
    expect((await print([paymentId], 7002)).status).toBe(200);
    expect((await row(paymentId)).status).toBe('posted');
    expect(await balanceOf(c.bank)).toBe(bankBefore);
  });

  it('a written check in the queue mails to its typed address, else the payee contact', async () => {
    const typed = await writeCheck({ payeeAddress: 'Attn: AP\n77 Elm St\nBranson, MO 65616' });
    const fallback = await writeCheck();
    const queue = await request('GET', '/api/v1/checks/print-queue', c.token);
    const byId = new Map((queue.json.data as any[]).map((r) => [r.id, r]));
    expect(byId.get(typed)).toMatchObject({
      txnType: 'expense', bankAccountId: c.bank, payeeAddress: ['Attn: AP', '77 Elm St', 'Branson, MO 65616'],
    });
    expect(byId.get(fallback).payeeAddress).toEqual(['410 Industrial Pkwy', 'Dock 3', 'Springfield, MO 65803']);
  });
});

describe('check layouts per bank account (U-109)', () => {
  it('stores a format per bank account, falls back to the company format, and validates', async () => {
    expect((await request('PUT', '/api/v1/checks/settings', c.token, { format: 'check_middle' })).status).toBe(200);
    const put = await request('PUT', '/api/v1/checks/settings', c.token, {
      layouts: { [c.bank]: { format: 'z_fold', printCompanyBlock: true }, [c.bank2]: { format: 'standard' } },
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    // printCompanyBlock defaults to false.
    expect(put.json.settings.layouts).toEqual({
      [c.bank]: { format: 'z_fold', printCompanyBlock: true }, [c.bank2]: { format: 'standard', printCompanyBlock: false },
    });
    expect(put.json.settings.format).toBe('check_middle');

    const own = await request('GET', `/api/v1/checks/settings?bank_account_id=${c.bank}`, c.token);
    expect(own.json.layout).toEqual({ format: 'z_fold', printCompanyBlock: true, source: 'bank_account' });
    const std = await request('GET', `/api/v1/checks/settings?bank_account_id=${c.bank2}`, c.token);
    expect(std.json.layout).toEqual({ format: 'standard', printCompanyBlock: false, source: 'bank_account' });
    expect((await request('PUT', '/api/v1/checks/settings', c.token, { layouts: { [c.bank]: { format: 'voucher' } } })).status).toBe(200);
    const fallback = await request('GET', `/api/v1/checks/settings?bank_account_id=${c.bank2}`, c.token);
    expect(fallback.json.layout).toEqual({ format: 'check_middle', printCompanyBlock: false, source: 'company' });
    expect((await request('GET', '/api/v1/checks/settings', c.token)).json.layout).toBeUndefined();

    // Offsets are not per bank account (kept per printer by the client).
    const withOffset = await request('PUT', '/api/v1/checks/settings', c.token, {
      layouts: { [c.bank]: { format: 'voucher', offsetX: 1 } },
    });
    expect(withOffset.status).toBe(400);
    const badFormat = await request('PUT', '/api/v1/checks/settings', c.token, { layouts: { [c.bank]: { format: 'wallet' } } });
    expect(badFormat.status).toBe(400);
    const notBank = await request('PUT', '/api/v1/checks/settings', c.token, { layouts: { [c.expense]: { format: 'voucher' } } });
    expect(notBank.status).toBe(400);
    const stranger = await makeCompany('b');
    const foreign = await request('PUT', '/api/v1/checks/settings', c.token, { layouts: { [stranger.bank]: { format: 'voucher' } } });
    expect(foreign.status).toBe(400);
    // The stored map is unchanged by the refusals.
    const now = await request('GET', '/api/v1/checks/settings', c.token);
    expect(now.json.settings.layouts).toEqual({ [c.bank]: { format: 'voucher', printCompanyBlock: false } });
  });
});

describe('GET /company/logo (U-110)', () => {
  it('404 without a logo; streams an uploaded logo; refuses a logoUrl outside the logo store', async () => {
    expect((await request('GET', '/api/v1/company/logo', c.token)).status).toBe(404);

    const dir = path.join(env.UPLOAD_DIR, 'logos');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.png`;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(32)]);
    fs.writeFileSync(path.join(dir, name), png);
    try {
      await db.update(companies).set({ logoUrl: `/uploads/logos/${name}` }).where(eq(companies.id, c.companyId));
      const r = await request('GET', '/api/v1/company/logo', c.token);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('image/png');
      expect(r.raw.equals(png)).toBe(true);

      // Another company of the tenant without a logo.
      const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
      expect((await request('GET', '/api/v1/company/logo', c.token, undefined, { 'X-Company-Id': other!.id })).status).toBe(404);

      for (const bad of ['/uploads/logos/../../secret.png', '/etc/passwd', 'https://example.com/logo.png', `/uploads/logos/${name}.svg`]) {
        await db.update(companies).set({ logoUrl: bad }).where(eq(companies.id, c.companyId));
        expect((await request('GET', '/api/v1/company/logo', c.token)).status, bad).toBe(404);
      }
      // A stored URL whose file is gone.
      await db.update(companies).set({ logoUrl: `/uploads/logos/${crypto.randomUUID()}.jpg` }).where(eq(companies.id, c.companyId));
      expect((await request('GET', '/api/v1/company/logo', c.token)).status).toBe(404);
    } finally {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  });
});
