// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Check edit and line customers (U-48, U-49, U-50 — capabilities
// check-edit-v1, line-billable-v1):
//   - POST/PUT /checks lines must sum EXACTLY to the amount (no tolerance);
//   - PUT /checks/:id replaces lines, payee, date and number / print status
//     through the ledger update path (balances, audit before-image,
//     closing date and closing-date password, void / deleted refusals);
//   - per-line contactId + isBillable on checks and expenses, persisted and
//     returned by GET /transactions/:id; billable needs a customer; another
//     tenant's contacts and checks are out of reach.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, contacts, transactions, journalLines, transactionTags,
} from '../db/schema/index.js';
import { checksRouter } from './checks.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import * as ledger from '../services/ledger.service.js';

const CLOSING_PHRASE = 'closing-pass-123';
const WRONG_PHRASE = ['wrong', 'guess', '42'].join('-');

let server: Server | null = null;
let port = 0;

interface Seeded {
  tenantId: string; companyId: string; userId: string; token: string;
  bankId: string; expenseId: string; otherExpenseId: string; customerId: string; vendorId: string;
}
let t: Seeded;
let other: Seeded;

function call(method: string, path: string, body?: unknown, token = t.token): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seed(label: string): Promise<Seeded> {
  const [tn] = await db.insert(tenants).values({
    name: `Check edit ${label}`, slug: `check-edit-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }).returning();
  const tenantId = tn!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: `Co ${label}`, setupComplete: true }).returning();
  const [u] = await db.insert(users).values({
    tenantId, email: `check-edit-${label}-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x', role: 'owner', displayName: 'Owner',
  }).returning();
  const token = jwt.sign({ userId: u!.id, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  const bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  const expenseId = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;
  const otherExpenseId = (await accountsService.create(tenantId, { name: 'Repairs', accountType: 'expense', accountNumber: '6100' })).id;
  const [cust] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  const [vend] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
  return {
    tenantId, companyId: c!.id, userId: u!.id, token, bankId, expenseId, otherExpenseId,
    customerId: cust!.id, vendorId: vend!.id,
  };
}

async function cleanup(s: Seeded | undefined) {
  if (!s) return;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, s.tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, s.tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, s.tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, s.tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, s.tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, s.tenantId));
  await db.delete(companies).where(eq(companies.tenantId, s.tenantId));
  await db.delete(users).where(inArray(users.tenantId, [s.tenantId]));
  await db.delete(tenants).where(eq(tenants.id, s.tenantId));
}

beforeEach(async () => {
  t = await seed('a');
  other = await seed('b');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/checks', checksRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await cleanup(t);
  await cleanup(other);
});

const body = (over: Record<string, unknown> = {}) => ({
  bankAccountId: t.bankId,
  contactId: t.vendorId,
  payeeNameOnCheck: 'Cosmos Granite',
  txnDate: '2026-08-14',
  amount: '150.00',
  printLater: true,
  lines: [{ accountId: t.expenseId, amount: '150.00' }],
  ...over,
});

async function createCheck(over: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/v1/checks', body(over));
  expect(r.status).toBe(201);
  return r.json.check as { id: string; checkNumber: number | null; printStatus: string };
}

async function balance(accountId: string) {
  const [row] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, accountId));
  return row!.b;
}

async function detail(id: string) {
  const r = await call('GET', `/api/v1/transactions/${id}`);
  expect(r.status).toBe(200);
  return r.json.transaction;
}

describe('exact line sum', () => {
  it('POST /checks refuses lines that miss the amount by 0.0001 either way', async () => {
    for (const lines of [
      [{ accountId: t.expenseId, amount: '60.00' }, { accountId: t.otherExpenseId, amount: '90.0001' }],
      [{ accountId: t.expenseId, amount: '60.00' }, { accountId: t.otherExpenseId, amount: '89.9999' }],
      // The old float path let anything within a cent through.
      [{ accountId: t.expenseId, amount: '149.995' }],
    ]) {
      const r = await call('POST', '/api/v1/checks', body({ lines }));
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, t.tenantId))).toHaveLength(0);
  });

  it('POST /checks posts exact sums, including ones floats get wrong', async () => {
    const check = await createCheck({
      amount: '0.3',
      lines: [{ accountId: t.expenseId, amount: '0.1' }, { accountId: t.otherExpenseId, amount: '0.2' }],
    });
    const d = await detail(check.id);
    expect(d.lines.map((l: any) => [l.debit, l.credit])).toEqual([
      ['0.1000', '0.0000'], ['0.2000', '0.0000'], ['0.0000', '0.3000'],
    ]);
  });

  it('refuses amounts that are not plain decimals with up to 4 places', async () => {
    for (const amount of ['1e2', '1,000.00', '$5', '10.12345']) {
      const r = await call('POST', '/api/v1/checks', body({ amount, lines: [{ accountId: t.expenseId, amount }] }));
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('expenses post the exact sum of their lines', async () => {
    const r = await call('POST', '/api/v1/transactions', {
      txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: t.bankId,
      lines: [{ expenseAccountId: t.expenseId, amount: '0.1' }, { expenseAccountId: t.otherExpenseId, amount: '0.2' }],
    });
    expect(r.status).toBe(201);
    const d = await detail(r.json.transaction.id);
    expect(d.total).toBe('0.3000');
    expect(d.lines.find((l: any) => l.accountId === t.bankId).credit).toBe('0.3000');
  });
});

describe('PUT /checks/:id', () => {
  it('replaces lines, amount, payee and date; balances follow; audit keeps the before-image', async () => {
    const check = await createCheck();
    expect(await balance(t.bankId)).toBe('-150.0000');

    const r = await call('PUT', `/api/v1/checks/${check.id}`, body({
      payeeNameOnCheck: 'Cosmos Granite LLC',
      payeeAddress: '1 Main St\nSpringfield',
      txnDate: '2026-08-20',
      amount: '210.50',
      memo: 'Countertops',
      printedMemo: 'Inv 77',
      lines: [
        { accountId: t.expenseId, amount: '200.00', description: 'Slab' },
        { accountId: t.otherExpenseId, amount: '10.50', description: 'Delivery' },
      ],
    }));
    expect(r.status).toBe(200);
    expect(r.json.check).toMatchObject({ id: check.id, payeeNameOnCheck: 'Cosmos Granite LLC', printStatus: 'queue', checkNumber: null });

    const d = await detail(check.id);
    expect(d).toMatchObject({
      txnDate: '2026-08-20', total: '210.5000', memo: 'Countertops', status: 'posted',
      printedMemo: 'Inv 77', payeeAddress: '1 Main St\nSpringfield',
    });
    expect(d.lines.map((l: any) => [l.accountId, l.debit, l.credit])).toEqual([
      [t.expenseId, '200.0000', '0.0000'],
      [t.otherExpenseId, '10.5000', '0.0000'],
      [t.bankId, '0.0000', '210.5000'],
    ]);
    expect(await balance(t.bankId)).toBe('-210.5000');
    expect(await balance(t.expenseId)).toBe('200.0000');
    expect(await balance(t.otherExpenseId)).toBe('10.5000');

    const audits = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, t.tenantId), eq(auditLog.entityId, check.id), eq(auditLog.action, 'update'),
    ));
    const txnAudit = audits.find((a) => a.entityType === 'transaction')!;
    const before = (typeof txnAudit.beforeData === 'string' ? JSON.parse(txnAudit.beforeData) : txnAudit.beforeData) as any;
    expect(before.lines.map((l: any) => [l.accountId, l.debit, l.credit])).toEqual(expect.arrayContaining([
      [t.expenseId, '150.0000', '0.0000'], [t.bankId, '0.0000', '150.0000'],
    ]));
    const checkAudit = audits.find((a) => a.entityType === 'check')!;
    const checkBefore = (typeof checkAudit.beforeData === 'string' ? JSON.parse(checkAudit.beforeData) : checkAudit.beforeData) as any;
    expect(checkBefore.payeeNameOnCheck).toBe('Cosmos Granite');
  });

  it('refuses lines that do not sum exactly and changes nothing', async () => {
    const check = await createCheck();
    const r = await call('PUT', `/api/v1/checks/${check.id}`, body({
      amount: '150.00', lines: [{ accountId: t.expenseId, amount: '150.0001' }],
    }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');
    expect(await balance(t.bankId)).toBe('-150.0000');
    expect((await detail(check.id)).lines.find((l: any) => l.accountId === t.expenseId).debit).toBe('150.0000');
  });

  it('moves between the print queue and a check number', async () => {
    const check = await createCheck();
    expect(check).toMatchObject({ printStatus: 'queue', checkNumber: null });

    let r = await call('PUT', `/api/v1/checks/${check.id}`, body({ printLater: false, checkNumber: 5001 }));
    expect(r.status).toBe(200);
    expect(r.json.check).toMatchObject({ printStatus: 'hand_written', checkNumber: 5001 });

    // No number sent: a numbered check keeps its number.
    r = await call('PUT', `/api/v1/checks/${check.id}`, body({ printLater: false, amount: '75.00', lines: [{ accountId: t.expenseId, amount: '75.00' }] }));
    expect(r.json.check).toMatchObject({ printStatus: 'hand_written', checkNumber: 5001 });

    // Back to the queue: number and print stamp cleared.
    r = await call('PUT', `/api/v1/checks/${check.id}`, body({ printLater: true, checkNumber: 5001 }));
    expect(r.json.check).toMatchObject({ printStatus: 'queue', checkNumber: null });
    const queue = await call('GET', '/api/v1/checks/print-queue');
    expect(queue.json.data.map((c: any) => c.id)).toContain(check.id);

    // Queued check saved without a number: the counter assigns the next one.
    r = await call('PUT', `/api/v1/checks/${check.id}`, body({ printLater: false }));
    expect(r.json.check.printStatus).toBe('hand_written');
    expect(r.json.check.checkNumber).toBeGreaterThan(5001);
  });

  it('a printed check that keeps its number stays printed', async () => {
    const check = await createCheck();
    await db.update(transactions).set({ printStatus: 'printed', checkNumber: 7001, printedAt: new Date() })
      .where(eq(transactions.id, check.id));
    const r = await call('PUT', `/api/v1/checks/${check.id}`, body({ printLater: false, checkNumber: 7001, memo: 'fixed' }));
    expect(r.status).toBe(200);
    expect(r.json.check).toMatchObject({ printStatus: 'printed', checkNumber: 7001 });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, check.id));
    expect(row!.printedAt).not.toBeNull();
  });

  it('refuses a check number another check on the bank account holds', async () => {
    await createCheck({ printLater: false, checkNumber: 6001 });
    const second = await createCheck();
    const r = await call('PUT', `/api/v1/checks/${second.id}`, body({ printLater: false, checkNumber: 6001 }));
    expect(r.status).toBe(409);
    // Re-saving a check with its own number is not a clash.
    const own = await createCheck({ printLater: false, checkNumber: 6002 });
    expect((await call('PUT', `/api/v1/checks/${own.id}`, body({ printLater: false, checkNumber: 6002 }))).status).toBe(200);
  });

  it('honours the closing date and the closing-date password like PUT /transactions/:id', async () => {
    const check = await createCheck({ txnDate: '2026-06-15' });
    const open = await createCheck({ txnDate: '2026-08-15' });
    await db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, t.companyId));

    // Closed check, no password set: locked (staff may confirm; an owner gets 423).
    let r = await call('PUT', `/api/v1/checks/${check.id}`, body({ txnDate: '2026-06-15', memo: 'x' }));
    expect(r.status).toBe(423);
    expect(r.json.error.code).toBe('TB_PERIOD_LOCKED');

    // Moving an open check into the closed period is refused too.
    r = await call('PUT', `/api/v1/checks/${open.id}`, body({ txnDate: '2026-06-01' }));
    expect(r.status).toBe(423);

    await db.update(companies).set({ closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) }).where(eq(companies.id, t.companyId));
    r = await call('PUT', `/api/v1/checks/${check.id}`, body({ txnDate: '2026-06-15', memo: 'x' }));
    expect(r.status).toBe(423);
    expect(r.json.error.details.closingPasswordRequired).toBe(true);

    r = await call('PUT', `/api/v1/checks/${check.id}`, body({ txnDate: '2026-06-15', memo: 'x', closingPassword: WRONG_PHRASE }));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect((await detail(check.id)).memo).toBeNull();

    r = await call('PUT', `/api/v1/checks/${check.id}`, body({
      txnDate: '2026-06-15', memo: 'x', closingPassword: CLOSING_PHRASE,
      amount: '99.00', lines: [{ accountId: t.expenseId, amount: '99.00' }],
    }));
    expect(r.status).toBe(200);
    expect((await detail(check.id)).total).toBe('99.0000');
    const overrides = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, t.tenantId), eq(auditLog.entityType, 'closing_date_override'),
    ));
    expect(overrides).toHaveLength(1);
    expect(JSON.stringify(overrides)).not.toContain(CLOSING_PHRASE);
  });

  it('void is 400, deleted / unknown / another tenant\'s check is 404, a bill-payment check 400', async () => {
    const voided = await createCheck();
    await ledger.voidTransaction(t.tenantId, voided.id, 'test', t.userId);
    expect((await call('PUT', `/api/v1/checks/${voided.id}`, body())).status).toBe(400);

    const deleted = await createCheck();
    await db.update(transactions).set({ status: 'deleted' }).where(eq(transactions.id, deleted.id));
    expect((await call('PUT', `/api/v1/checks/${deleted.id}`, body())).status).toBe(404);

    expect((await call('PUT', `/api/v1/checks/${crypto.randomUUID()}`, body())).status).toBe(404);

    const foreign = await call('POST', '/api/v1/checks', {
      bankAccountId: other.bankId, payeeNameOnCheck: 'X', txnDate: '2026-08-14', amount: '5.00', printLater: true,
      lines: [{ accountId: other.expenseId, amount: '5.00' }],
    }, other.token);
    expect(foreign.status).toBe(201);
    expect((await call('PUT', `/api/v1/checks/${foreign.json.check.id}`, body())).status).toBe(404);
    expect((await call('GET', `/api/v1/transactions/${foreign.json.check.id}`)).status).toBe(404);
    expect((await call('GET', `/api/v1/transactions/${foreign.json.check.id}`, undefined, other.token)).json.transaction.memo).toBeNull();

    // An expense posted without a print status is not a check.
    const exp = await call('POST', '/api/v1/transactions', {
      txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: t.bankId, expenseAccountId: t.expenseId, amount: '5.00',
    });
    expect((await call('PUT', `/api/v1/checks/${exp.json.transaction.id}`, body())).status).toBe(404);

    const bp = await createCheck();
    await db.update(transactions).set({ txnType: 'bill_payment' }).where(eq(transactions.id, bp.id));
    const r = await call('PUT', `/api/v1/checks/${bp.id}`, body());
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('CHECK_NOT_EDITABLE');
  });
});

describe('line customer and billable', () => {
  it('check lines keep their customer and billable mark, returned by GET /transactions/:id', async () => {
    const check = await createCheck({
      lines: [
        { accountId: t.expenseId, amount: '100.00', contactId: t.customerId, isBillable: true },
        { accountId: t.otherExpenseId, amount: '50.00', contactId: t.customerId },
      ],
    });
    let d = await detail(check.id);
    expect(d.lines.map((l: any) => [l.accountId, l.contactId, l.contactName, l.isBillable, l.billedStatus])).toEqual([
      [t.expenseId, t.customerId, 'Rivera Remodel', true, 'unbilled'],
      [t.otherExpenseId, t.customerId, 'Rivera Remodel', false, null],
      [t.bankId, null, null, false, null],
    ]);

    // The edit replaces them.
    const r = await call('PUT', `/api/v1/checks/${check.id}`, body({
      lines: [
        { accountId: t.expenseId, amount: '100.00' },
        { accountId: t.otherExpenseId, amount: '50.00', contactId: t.customerId, isBillable: true },
      ],
    }));
    expect(r.status).toBe(200);
    d = await detail(check.id);
    expect(d.lines.map((l: any) => [l.contactId, l.isBillable, l.billedStatus])).toEqual([
      [null, false, null], [t.customerId, true, 'unbilled'], [null, false, null],
    ]);
  });

  it('a billable line without a customer is 400 on check create, check edit and expenses', async () => {
    let r = await call('POST', '/api/v1/checks', body({ lines: [{ accountId: t.expenseId, amount: '150.00', isBillable: true }] }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');

    const check = await createCheck();
    r = await call('PUT', `/api/v1/checks/${check.id}`, body({ lines: [{ accountId: t.expenseId, amount: '150.00', isBillable: true, contactId: null }] }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');

    r = await call('POST', '/api/v1/transactions', {
      txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: t.bankId,
      lines: [{ expenseAccountId: t.expenseId, amount: '5.00', isBillable: true }],
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');
  });

  it('another tenant\'s contact is refused on a line', async () => {
    let r = await call('POST', '/api/v1/checks', body({ lines: [{ accountId: t.expenseId, amount: '150.00', contactId: other.customerId }] }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');
    r = await call('POST', '/api/v1/transactions', {
      txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: t.bankId,
      lines: [{ expenseAccountId: t.expenseId, amount: '5.00', contactId: other.customerId, isBillable: true }],
    });
    expect(r.status).toBe(400);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, t.tenantId))).toHaveLength(0);
  });

  it('expense lines take a customer and billable mark on create and update', async () => {
    const created = await call('POST', '/api/v1/transactions', {
      txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: t.bankId,
      lines: [
        { expenseAccountId: t.expenseId, amount: '12.34', contactId: t.customerId, isBillable: true },
        { expenseAccountId: t.otherExpenseId, amount: '1.00' },
      ],
    });
    expect(created.status).toBe(201);
    const id = created.json.transaction.id;
    let d = await detail(id);
    expect(d.lines.map((l: any) => [l.contactId, l.isBillable, l.billedStatus])).toEqual([
      [t.customerId, true, 'unbilled'], [null, false, null], [null, false, null],
    ]);

    const updated = await call('PUT', `/api/v1/transactions/${id}`, {
      txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: t.bankId,
      lines: [{ expenseAccountId: t.expenseId, amount: '13.34', contactId: t.customerId, isBillable: false }],
    });
    expect(updated.status).toBe(200);
    d = await detail(id);
    expect(d.lines.map((l: any) => [l.debit, l.credit, l.contactId, l.isBillable, l.billedStatus])).toEqual([
      ['13.3400', '0.0000', t.customerId, false, null], ['0.0000', '13.3400', null, false, null],
    ]);
  });

  it('the database keeps billed_status in step with is_billable', async () => {
    const check = await createCheck();
    const [line] = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, check.id), eq(journalLines.accountId, t.expenseId)));
    await expect(db.update(journalLines).set({ billedStatus: 'unbilled' }).where(eq(journalLines.id, line!.id))).rejects.toThrow();
    await expect(db.update(journalLines).set({ isBillable: true }).where(eq(journalLines.id, line!.id))).rejects.toThrow();
    await db.update(journalLines).set({ isBillable: true, billedStatus: 'billed' }).where(eq(journalLines.id, line!.id));
  });
});
