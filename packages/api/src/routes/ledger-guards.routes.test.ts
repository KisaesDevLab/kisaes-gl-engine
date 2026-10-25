// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Ledger guards (U-80, U-81 — capability ledger-guards-v1):
//   - PUT /transactions/:id on a deposit refuses an edit that sends a linked
//     line (payment in Payments Clearing, vendor refund) back without its
//     sourceTransactionId while keeping an unlinked line on that account:
//     409 DEPOSIT_LINKS_DROPPED, nothing changes. Keeping the link, or
//     removing the line, still works;
//   - PUT /transactions/:id as an expense on a PRINTED check refuses a change
//     to its printed face: 409 CHECK_PRINTED (as PUT /checks/:id), nothing
//     changes; face-neutral edits keep it printed;
//   - with TAGS_SPLIT_LEVEL_V2 on, a check keeps its own header tags through
//     ledger edits (PUT /transactions/:id and PUT /checks/:id without tagIds);
//   - void reversal lines keep each line's contact, as delete does;
//   - the check print routes (memo, print, requeue, reprint) honour the
//     closing date and the closing-date password.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, depositLines, transactionTags, tags, vendorCreditApplications, userPermissions,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import { checksRouter } from './checks.routes.js';
import { paymentsRouter } from './payments.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as vendorCreditService from '../services/vendor-credit.service.js';
import { env } from '../config/env.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const CLOSING_PHRASE = 'guards-closing-123'; // gitleaks:allow (test placeholder)

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any }

function request(method: string, pathname: string, token: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
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
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
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
  tenantId: string; userId: string; token: string; companyId: string;
  bank: string; clearing: string; ar: string; ap: string; expense: string; otherExpense: string;
  customer: string; vendor: string;
}

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `guards-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Guards ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expenses = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(2);
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id,
    bank: bank!.id, clearing: await bySystemTag(tenantId, 'payments_clearing'),
    ar: await bySystemTag(tenantId, 'accounts_receivable'), ap: await bySystemTag(tenantId, 'accounts_payable'),
    expense: expenses[0]!.id, otherExpense: expenses[1]!.id,
    customer: customer!.id, vendor: vendor!.id,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/checks', checksRouter);
  app.use('/api/v1/payments', paymentsRouter);
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

async function balance(accountId: string) {
  const a = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  return a!.balance;
}

async function row(id: string) {
  const [r] = await db.select().from(transactions).where(eq(transactions.id, id));
  return r!;
}

it('advertises ledger-guards-v1', () => {
  expect(DESKTOP_CAPABILITIES).toContain('ledger-guards-v1');
});

describe('deposit edits keep their links (U-80)', () => {
  async function payment(amount: string) {
    const p = await ledger.postTransaction(c.tenantId, {
      txnType: 'customer_payment', txnDate: '2026-08-10', contactId: c.customer, total: amount,
      lines: [
        { accountId: c.clearing, debit: amount, credit: '0' },
        { accountId: c.ar, debit: '0', credit: amount },
      ],
    }, c.userId, c.companyId);
    return p.id;
  }
  const deposit = (lines: unknown[], extra: Record<string, unknown> = {}) => ({
    txnType: 'deposit', txnDate: '2026-08-12', depositToAccountId: c.bank, lines, ...extra,
  });
  const pendingIds = async () => (await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token))
    .json.items.map((i: any) => i.transactionId);

  it('a one-payment deposit edited without its link is 409 DEPOSIT_LINKS_DROPPED and nothing changes', async () => {
    const p = await payment('1250.0000');
    const made = await request('POST', '/api/v1/transactions', c.token, deposit([
      { accountId: c.clearing, amount: '1250.00', sourceTransactionId: p },
    ]));
    expect(made.status).toBe(201);
    const depId = made.json.transaction.id;

    // The register's memo fix: same line, no link.
    const r = await request('PUT', `/api/v1/transactions/${depId}`, c.token, deposit([
      { accountId: c.clearing, amount: '1250.00' },
    ], { memo: 'fixed memo' }));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('DEPOSIT_LINKS_DROPPED');
    expect(r.json.error.details.sourceTransactionIds).toEqual([p]);

    expect((await row(depId)).memo).toBeNull();
    const links = await db.select().from(depositLines).where(eq(depositLines.depositId, depId));
    expect(links.map((l) => l.sourceTransactionId)).toEqual([p]);
    expect(await pendingIds()).not.toContain(p);
    expect(await balance(c.bank)).toBe('1250.0000');

    // The same edit with the link goes through and keeps it.
    const ok = await request('PUT', `/api/v1/transactions/${depId}`, c.token, deposit([
      { accountId: c.clearing, amount: '1250.00', sourceTransactionId: p },
    ], { memo: 'fixed memo' }));
    expect(ok.status).toBe(200);
    expect((await row(depId)).memo).toBe('fixed memo');
    expect((await db.select().from(depositLines).where(eq(depositLines.depositId, depId))).map((l) => l.sourceTransactionId)).toEqual([p]);
    expect(await pendingIds()).not.toContain(p);
  });

  it('dropping one link of two while keeping its line is refused; removing the line releases it', async () => {
    const p1 = await payment('20.0000');
    const p2 = await payment('30.0000');
    const made = await request('POST', '/api/v1/transactions', c.token, deposit([
      { accountId: c.clearing, amount: '20.0000', sourceTransactionId: p1 },
      { accountId: c.clearing, amount: '30.0000', sourceTransactionId: p2 },
    ]));
    const depId = made.json.transaction.id;

    const dropped = await request('PUT', `/api/v1/transactions/${depId}`, c.token, deposit([
      { accountId: c.clearing, amount: '20.0000', sourceTransactionId: p1 },
      { accountId: c.clearing, amount: '30.0000' },
    ]));
    expect(dropped.status).toBe(409);
    expect(dropped.json.error.code).toBe('DEPOSIT_LINKS_DROPPED');
    expect(dropped.json.error.details.sourceTransactionIds).toEqual([p2]);

    // Taking p2 out of the deposit (its line goes too) is an edit as before.
    const removed = await request('PUT', `/api/v1/transactions/${depId}`, c.token, deposit([
      { accountId: c.clearing, amount: '20.0000', sourceTransactionId: p1 },
    ]));
    expect(removed.status).toBe(200);
    expect(await pendingIds()).toEqual([p2]);
  });

  it('a deposit without links edits as before', async () => {
    const made = await request('POST', '/api/v1/transactions', c.token, deposit([
      { accountId: c.clearing, amount: '60.0000' },
    ]));
    const r = await request('PUT', `/api/v1/transactions/${made.json.transaction.id}`, c.token, deposit([
      { accountId: c.clearing, amount: '60.0000' },
    ], { memo: 'plain' }));
    expect(r.status).toBe(200);
  });

  it('a vendor refund edited without its link is refused and the credit stays refunded', async () => {
    const credit = await vendorCreditService.createVendorCredit(c.tenantId, {
      contactId: c.vendor, txnDate: '2026-08-01', lines: [{ accountId: c.expense, amount: '200.00' }],
    } as any, c.userId, c.companyId);
    const made = await request('POST', '/api/v1/transactions', c.token, deposit([
      { accountId: c.ap, amount: '80.00', sourceTransactionId: credit.id },
    ]));
    expect(made.status).toBe(201);
    expect((await row(credit.id)).balanceDue).toBe('120.0000');

    const r = await request('PUT', `/api/v1/transactions/${made.json.transaction.id}`, c.token, deposit([
      { accountId: c.ap, amount: '80.00', contactId: c.vendor },
    ], { memo: 'refund' }));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('DEPOSIT_LINKS_DROPPED');
    expect(r.json.error.details.sourceTransactionIds).toEqual([credit.id]);
    expect((await row(credit.id)).balanceDue).toBe('120.0000');
  });
});

describe('printed checks on PUT /transactions/:id (U-80)', () => {
  const checkBody = (over: Record<string, unknown> = {}) => ({
    bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite',
    txnDate: '2026-08-14', amount: '150.00', printLater: true,
    lines: [{ accountId: c.expense, amount: '150.00' }],
    ...over,
  });
  const expenseBody = (over: Record<string, unknown> = {}) => ({
    txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: c.bank, contactId: c.vendor,
    lines: [{ expenseAccountId: c.expense, amount: '150.00' }],
    ...over,
  });
  const PRINTED_AT = new Date('2026-08-15T12:00:00.000Z');
  async function printedCheck(over: Record<string, unknown> = {}) {
    const r = await request('POST', '/api/v1/checks', c.token, checkBody(over));
    expect(r.status).toBe(201);
    await db.update(transactions).set({
      printStatus: 'printed', checkNumber: 7001, printedAt: PRINTED_AT, printBatchId: crypto.randomUUID(),
    }).where(eq(transactions.id, r.json.check.id));
    return r.json.check.id as string;
  }

  it('a printed-face change is 409 CHECK_PRINTED with the check service details, and changes nothing', async () => {
    const savings = await db.insert(accounts).values({
      tenantId: c.tenantId, name: 'Savings', accountType: 'asset', detailType: 'bank', accountNumber: '1099',
    }).returning();
    const id = await printedCheck();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['amount', { lines: [{ expenseAccountId: c.expense, amount: '151.00' }] }],
      ['contactId', { contactId: c.customer }],
      // No printed memo: the internal memo is what prints on the memo line.
      ['printedMemo', { memo: 'now on the memo line' }],
      ['bankAccountId', { payFromAccountId: savings[0]!.id }],
      ['txnDate', { txnDate: '2026-08-15' }],
    ];
    for (const [field, over] of cases) {
      const r = await request('PUT', `/api/v1/transactions/${id}`, c.token, expenseBody(over));
      expect(r.status, field).toBe(409);
      expect(r.json.error.code).toBe('CHECK_PRINTED');
      expect(r.json.error.details).toMatchObject({ checkNumber: 7001, printedAt: PRINTED_AT.toISOString(), changedFields: [field] });
    }
    expect(await row(id)).toMatchObject({ printStatus: 'printed', checkNumber: 7001, total: '150.0000', txnDate: '2026-08-14', memo: null });
    expect(await balance(c.bank)).toBe('-150.0000');
  });

  it('face-neutral edits (split, recategorize, describe) go through and keep it printed', async () => {
    const id = await printedCheck();
    const r = await request('PUT', `/api/v1/transactions/${id}`, c.token, expenseBody({
      lines: [
        { expenseAccountId: c.otherExpense, amount: '100.00', description: 'split' },
        { expenseAccountId: c.expense, amount: '50.00' },
      ],
    }));
    expect(r.status).toBe(200);
    expect(await row(id)).toMatchObject({ printStatus: 'printed', checkNumber: 7001, printedAt: PRINTED_AT });
    expect(await balance(c.otherExpense)).toBe('100.0000');
  });

  it('a printed memo stays on paper, so the internal memo may change', async () => {
    const id = await printedCheck({ printedMemo: 'Inv 42' });
    const r = await request('PUT', `/api/v1/transactions/${id}`, c.token, expenseBody({ memo: 'internal note' }));
    expect(r.status).toBe(200);
    expect(await row(id)).toMatchObject({ printStatus: 'printed', memo: 'internal note', printedMemo: 'Inv 42' });
  });

  it('checks that have not printed and plain expenses edit as before', async () => {
    const queued = await request('POST', '/api/v1/checks', c.token, checkBody());
    let r = await request('PUT', `/api/v1/transactions/${queued.json.check.id}`, c.token, expenseBody({
      lines: [{ expenseAccountId: c.expense, amount: '175.00' }],
    }));
    expect(r.status).toBe(200);

    const exp = await request('POST', '/api/v1/transactions', c.token, expenseBody());
    r = await request('PUT', `/api/v1/transactions/${exp.json.transaction.id}`, c.token, expenseBody({
      lines: [{ expenseAccountId: c.expense, amount: '99.00' }],
    }));
    expect(r.status).toBe(200);
  });
});

describe('check header tags survive ledger edits with TAGS_SPLIT_LEVEL_V2 (U-80)', () => {
  const original = env.TAGS_SPLIT_LEVEL_V2;
  const setFlag = (v: boolean) => { (env as unknown as { TAGS_SPLIT_LEVEL_V2: boolean }).TAGS_SPLIT_LEVEL_V2 = v; };
  afterEach(() => setFlag(original));

  const tagSet = async (id: string) => (await db.select({ tagId: transactionTags.tagId }).from(transactionTags)
    .where(eq(transactionTags.transactionId, id))).map((x) => x.tagId).sort();

  it('keeps the check\'s own tags; line tags follow the lines', async () => {
    setFlag(true);
    const [job] = await db.insert(tags).values({ tenantId: c.tenantId, name: 'Job A' }).returning();
    const [lineTag] = await db.insert(tags).values({ tenantId: c.tenantId, name: 'Line B' }).returning();
    const [lineTag2] = await db.insert(tags).values({ tenantId: c.tenantId, name: 'Line C' }).returning();
    const made = await request('POST', '/api/v1/checks', c.token, {
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite',
      txnDate: '2026-08-14', amount: '150.00', printLater: true, tagIds: [job!.id],
      lines: [{ accountId: c.expense, amount: '150.00', tagId: lineTag!.id }],
    });
    expect(made.status).toBe(201);
    const id = made.json.check.id;
    expect(await tagSet(id)).toEqual([job!.id, lineTag!.id].sort());

    // The register's edit: PUT /transactions/:id as an expense, new line tag.
    const r = await request('PUT', `/api/v1/transactions/${id}`, c.token, {
      txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: c.bank, contactId: c.vendor,
      lines: [{ expenseAccountId: c.expense, amount: '150.00', tagId: lineTag2!.id }],
    });
    expect(r.status).toBe(200);
    expect(await tagSet(id)).toEqual([job!.id, lineTag2!.id].sort());

    // PUT /checks/:id without tagIds keeps them too.
    const r2 = await request('PUT', `/api/v1/checks/${id}`, c.token, {
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite',
      txnDate: '2026-08-14', amount: '150.00', memo: 'x',
      lines: [{ accountId: c.expense, amount: '150.00', tagId: lineTag2!.id }],
    });
    expect(r2.status).toBe(200);
    expect(await tagSet(id)).toEqual([job!.id, lineTag2!.id].sort());
  });
});

describe('void reversal lines keep the line contact (U-81)', () => {
  it('copies each line\'s contact onto its reversal, as delete does', async () => {
    const exp = await request('POST', '/api/v1/transactions', c.token, {
      txnType: 'expense', txnDate: '2026-08-14', payFromAccountId: c.bank, contactId: c.vendor,
      lines: [{ expenseAccountId: c.expense, amount: '40.00', contactId: c.customer }],
    });
    expect(exp.status).toBe(201);
    const id = exp.json.transaction.id;
    const v = await request('POST', `/api/v1/transactions/${id}/void`, c.token, { reason: 'test' });
    expect(v.status).toBe(200);
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, id));
    const original = lines.find((l) => !l.isVoidReversal && l.accountId === c.expense)!;
    const reversal = lines.find((l) => l.isVoidReversal && l.accountId === c.expense)!;
    expect(original.contactId).toBe(c.customer);
    expect(reversal.contactId).toBe(c.customer);
    expect(reversal.credit).toBe(original.debit);
  });
});

describe('check print routes honour the closing date (U-81)', () => {
  const queuedCheck = async (txnDate: string) => {
    const r = await request('POST', '/api/v1/checks', c.token, {
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite',
      txnDate, amount: '25.00', printLater: true, lines: [{ accountId: c.expense, amount: '25.00' }],
    });
    expect(r.status).toBe(201);
    return r.json.check.id as string;
  };
  const close = () => db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, c.companyId));
  const setPassword = async () => db.update(companies)
    .set({ closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) }).where(eq(companies.id, c.companyId));
  const overrides = () => db.select().from(auditLog).where(and(
    eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override'),
  ));
  const printBody = (ids: string[], extra: Record<string, unknown> = {}) => ({
    bankAccountId: c.bank, checkIds: ids, startingCheckNumber: 5001, format: 'voucher', ...extra,
  });

  it('memo, print, requeue and reprint on a closed-period check need the closing-date password', async () => {
    const closed = await queuedCheck('2026-06-15');
    await close();

    let r = await request('PATCH', `/api/v1/checks/${closed}/memo`, c.token, { printedMemo: 'Inv 1' });
    expect(r.status).toBe(423);
    expect(r.json.error.code).toBe('TB_PERIOD_LOCKED');
    r = await request('POST', '/api/v1/checks/print', c.token, printBody([closed]));
    expect(r.status).toBe(423);
    expect(await row(closed)).toMatchObject({ printStatus: 'queue', checkNumber: null, printedMemo: null });

    await setPassword();
    r = await request('POST', '/api/v1/checks/print', c.token, printBody([closed], { closingPassword: 'wrong-guess' }));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect((await row(closed)).printStatus).toBe('queue');

    r = await request('PATCH', `/api/v1/checks/${closed}/memo`, c.token, { printedMemo: 'Inv 1', closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(200);
    r = await request('POST', '/api/v1/checks/print', c.token, printBody([closed], { closingPassword: CLOSING_PHRASE }));
    expect(r.status).toBe(200);
    const printed = await row(closed);
    expect(printed).toMatchObject({ printStatus: 'printed', checkNumber: 5001, printedMemo: 'Inv 1' });

    r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [closed] });
    expect(r.status).toBe(423);
    r = await request('POST', `/api/v1/checks/reprint/${printed.printBatchId}`, c.token, {});
    expect(r.status).toBe(423);
    expect((await row(closed)).printStatus).toBe('printed');

    r = await request('POST', `/api/v1/checks/reprint/${printed.printBatchId}`, c.token, { closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(200);
    expect((await row(closed)).printStatus).toBe('queue');
    r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [closed], closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(200);

    const rows = await overrides();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(rows)).not.toContain(CLOSING_PHRASE);
  });

  it('a batch with one closed-period check prints none of them; open-period checks need nothing', async () => {
    const open = await queuedCheck('2026-08-15');
    const closed = await queuedCheck('2026-06-15');
    await close();
    let r = await request('POST', '/api/v1/checks/print', c.token, printBody([open, closed]));
    expect(r.status).toBe(423);
    expect((await row(open)).printStatus).toBe('queue');

    r = await request('PATCH', `/api/v1/checks/${open}/memo`, c.token, { printedMemo: 'ok' });
    expect(r.status).toBe(200);
    r = await request('POST', '/api/v1/checks/print', c.token, printBody([open]));
    expect(r.status).toBe(200);
    r = await request('POST', '/api/v1/checks/requeue', c.token, { checkIds: [open] });
    expect(r.status).toBe(200);
    expect(await overrides()).toHaveLength(0);
  });
});
