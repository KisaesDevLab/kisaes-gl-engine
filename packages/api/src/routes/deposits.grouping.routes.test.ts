// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Bank deposits for ClientLedger (U-52, U-53, U-54, U-56 — capabilities
// deposit-grouping-v1, deposit-cashback-v1, vendor-refund-v1,
// feed-deposit-groupings-v1):
//   - a deposit line with sourceTransactionId deposits a Payments Clearing
//     item: clearing account, exact amount (0.0001 off is refused), once
//     (409 ALREADY_DEPOSITED, also under a race), same tenant and company;
//     void / delete / edit-removal release it; a deposited item can't be
//     voided or deleted under its deposit;
//   - GET /payments/pending-deposits?exact=1: strings, company-scoped,
//     no void items, no deposited items;
//   - plain clearing lines (the web page) still post;
//   - cash back: bank = lines − cash back, negative lines are debits,
//     total > 0, returned on GET;
//   - vendor refund against an open vendor credit (≤ open balance, void
//     restores it);
//   - deposit suggestions for a bank-feed deposit: exact sums only, ±10
//     days, company-scoped.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, depositLines, bankConnections, bankFeedItems, transactionTags, vendorCreditApplications,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import { paymentsRouter } from './payments.routes.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as vendorCreditService from '../services/vendor-credit.service.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any }

function request(method: string, pathname: string, token: string, body?: unknown, companyId?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(companyId ? { 'X-Company-Id': companyId } : {}),
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
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tid));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tid));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

interface Co {
  tenantId: string; userId: string; token: string; companyId: string; companyB: string;
  bank: string; clearing: string; ar: string; ap: string; fee: string; draw: string;
  customer: string; vendor: string;
}

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `dep-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Deposits ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [companyA] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: `Deposits ${label} B`, setupComplete: true }).returning();
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const fee = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: companyA!.id, companyB: companyB!.id,
    bank: bank!.id, clearing: await bySystemTag(tenantId, 'payments_clearing'),
    ar: await bySystemTag(tenantId, 'accounts_receivable'), ap: await bySystemTag(tenantId, 'accounts_payable'),
    fee: fee!.id, draw: await bySystemTag(tenantId, 'owner_draw'),
    customer: customer!.id, vendor: vendor!.id,
  };
}

/** A customer payment sitting in Payments Clearing. */
async function payment(c: Co, amount: string, date = '2026-08-10', companyId = c.companyId) {
  const p = await ledger.postTransaction(c.tenantId, {
    txnType: 'customer_payment', txnDate: date, contactId: c.customer, total: amount,
    lines: [
      { accountId: c.clearing, debit: amount, credit: '0' },
      { accountId: c.ar, debit: '0', credit: amount },
    ],
  }, c.userId, companyId);
  return p.id;
}

const deposit = (c: Co, lines: unknown[], extra: Record<string, unknown> = {}) => ({
  txnType: 'deposit', txnDate: '2026-08-12', depositToAccountId: c.bank, lines, ...extra,
});

async function balance(accountId: string) {
  const a = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  return a!.balance;
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/banking', bankingRouter);
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

describe('deposit grouping (U-52)', () => {
  it('deposits clearing items exactly once and lists the rest as pending (strings)', async () => {
    const p1 = await payment(c, '100.0000');
    const p2 = await payment(c, '50.2500');
    const p3 = await payment(c, '19.9900');

    const pending = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token);
    expect(pending.status).toBe(200);
    expect(pending.json.paymentsClearingBalance).toBe('170.2400');
    expect(pending.json.items.map((i: any) => i.amount)).toEqual(['100.0000', '50.2500', '19.9900']);
    expect(typeof pending.json.items[0].date).toBe('string');

    const res = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '100.0000', sourceTransactionId: p1 },
      { accountId: c.clearing, amount: '50.25', sourceTransactionId: p2 },
    ]));
    expect(res.status).toBe(201);
    const depId = res.json.transaction.id;
    expect(res.json.transaction.total).toBe('150.2500');

    const links = await db.select().from(depositLines).where(eq(depositLines.depositId, depId));
    expect(links.map((l) => [l.sourceTransactionId, l.amount]).sort()).toEqual([[p1, '100.0000'], [p2, '50.2500']].sort());

    const after = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token);
    expect(after.json.items.map((i: any) => i.transactionId)).toEqual([p3]);
    expect(after.json.paymentsClearingBalance).toBe('19.9900');
    // Default (web) shape keeps numbers.
    const web = await request('GET', '/api/v1/payments/pending-deposits', c.token);
    expect(web.json.items[0].amount).toBe(19.99);

    const got = await request('GET', `/api/v1/transactions/${depId}`, c.token);
    const srcLines = got.json.transaction.lines.filter((l: any) => l.sourceTransactionId);
    expect(srcLines.map((l: any) => l.sourceTransactionId).sort()).toEqual([p1, p2].sort());
    expect(got.json.transaction.cashBack).toBeNull();
    expect(await balance(c.clearing)).toBe('19.9900');
  });

  it('refuses an amount 0.0001 off the undeposited amount, and more than 4 places', async () => {
    const p1 = await payment(c, '100.0000');
    for (const amount of ['100.0001', '99.9999']) {
      const res = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
        { accountId: c.clearing, amount, sourceTransactionId: p1 },
      ]));
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('DEPOSIT_SOURCE_AMOUNT_MISMATCH');
      expect(res.json.error.details.expected).toBe('100.0000');
    }
    const fifth = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '100.00001', sourceTransactionId: p1 },
    ]));
    expect(fifth.status).toBe(400);
    expect(fifth.json.error.code).toBe('VALIDATION_ERROR');
    const none = await db.select().from(depositLines).where(eq(depositLines.sourceTransactionId, p1));
    expect(none).toHaveLength(0);
  });

  it('refuses a second deposit of the same item (409 ALREADY_DEPOSITED) and a non-clearing line', async () => {
    const p1 = await payment(c, '75.0000');
    const first = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '75.0000', sourceTransactionId: p1 },
    ]));
    expect(first.status).toBe(201);
    const second = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '75.0000', sourceTransactionId: p1 },
    ]));
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('ALREADY_DEPOSITED');

    const p2 = await payment(c, '10.0000');
    const wrongAcct = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.fee, amount: '10.0000', sourceTransactionId: p2 },
    ]));
    expect(wrongAcct.status).toBe(400);
    expect(wrongAcct.json.error.code).toBe('DEPOSIT_SOURCE_ACCOUNT');

    const dup = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '10.0000', sourceTransactionId: p2 },
      { accountId: c.clearing, amount: '10.0000', sourceTransactionId: p2 },
    ]));
    expect(dup.status).toBe(400);
    expect(dup.json.error.code).toBe('DEPOSIT_SOURCE_DUPLICATE');
  });

  it('two concurrent deposits of the same payment: one 201, one 409', async () => {
    for (let run = 0; run < 3; run++) {
      const p = await payment(c, '42.4200');
      const body = deposit(c, [{ accountId: c.clearing, amount: '42.4200', sourceTransactionId: p }]);
      const results = await Promise.all([
        request('POST', '/api/v1/transactions', c.token, body),
        request('POST', '/api/v1/transactions', c.token, body),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.json.error.code).toBe('ALREADY_DEPOSITED');
      const links = await db.select().from(depositLines).where(eq(depositLines.sourceTransactionId, p));
      expect(links).toHaveLength(1);
    }
  });

  it('isolates companies and tenants', async () => {
    const pB = await payment(c, '30.0000', '2026-08-10', c.companyB);
    const asA = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token, undefined, c.companyId);
    expect(asA.json.items.map((i: any) => i.transactionId)).not.toContain(pB);
    const asB = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token, undefined, c.companyB);
    expect(asB.json.items.map((i: any) => i.transactionId)).toContain(pB);

    const cross = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '30.0000', sourceTransactionId: pB },
    ]), c.companyId);
    expect(cross.status).toBe(400);
    expect(cross.json.error.code).toBe('DEPOSIT_SOURCE_INVALID');

    const other = await makeCompany('other');
    const pOther = await payment(other, '30.0000');
    const foreign = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '30.0000', sourceTransactionId: pOther },
    ]));
    expect(foreign.status).toBe(400);
    expect(foreign.json.error.code).toBe('DEPOSIT_SOURCE_INVALID');
    const otherPending = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token);
    expect(otherPending.json.items.map((i: any) => i.transactionId)).not.toContain(pOther);
  });

  it('void and delete release the items; edit-removal releases one; void items are not pending', async () => {
    const p1 = await payment(c, '20.0000');
    const p2 = await payment(c, '30.0000');
    const make = () => request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '20.0000', sourceTransactionId: p1 },
      { accountId: c.clearing, amount: '30.0000', sourceTransactionId: p2 },
    ]));
    const pendingIds = async () => (await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token))
      .json.items.map((i: any) => i.transactionId);

    const d1 = await make();
    expect(d1.status).toBe(201);
    // A deposited payment can't be voided under its deposit.
    const voidSrc = await request('POST', `/api/v1/transactions/${p1}/void`, c.token, { reason: 'x' });
    expect(voidSrc.status).toBe(409);
    expect(voidSrc.json.error.code).toBe('TXN_DEPOSITED');

    const v = await request('POST', `/api/v1/transactions/${d1.json.transaction.id}/void`, c.token, { reason: 'wrong bank' });
    expect(v.status).toBe(200);
    expect((await pendingIds()).sort()).toEqual([p1, p2].sort());
    const voidAudit = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityId, d1.json.transaction.id), eq(auditLog.action, 'void'),
    ));
    expect(JSON.stringify(voidAudit[0]!.afterData)).toContain('releasedDepositLinks');

    const d2 = await make();
    expect(d2.status).toBe(201);
    const del = await request('DELETE', `/api/v1/transactions/${d2.json.transaction.id}`, c.token, {});
    expect(del.status).toBe(200);
    expect((await pendingIds()).sort()).toEqual([p1, p2].sort());

    const d3 = await make();
    const edit = await request('PUT', `/api/v1/transactions/${d3.json.transaction.id}`, c.token, deposit(c, [
      { accountId: c.clearing, amount: '20.0000', sourceTransactionId: p1 },
    ]));
    expect(edit.status).toBe(200);
    expect(await pendingIds()).toEqual([p2]);
    const links = await db.select().from(depositLines).where(eq(depositLines.depositId, d3.json.transaction.id));
    expect(links.map((l) => l.sourceTransactionId)).toEqual([p1]);

    // A void payment is never pending.
    const p4 = await payment(c, '5.0000');
    await ledger.voidTransaction(c.tenantId, p4, 'test', c.userId);
    expect(await pendingIds()).not.toContain(p4);
  });

  it('a deposited journal entry cannot be deleted or have its clearing amount edited', async () => {
    const je = await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2026-08-10',
      lines: [
        { accountId: c.clearing, debit: '12.0000', credit: '0' },
        { accountId: c.ar, debit: '0', credit: '12.0000' },
      ],
    }, c.userId, c.companyId);
    const d = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '12.0000', sourceTransactionId: je.id },
    ]));
    expect(d.status).toBe(201);
    const del = await request('DELETE', `/api/v1/transactions/${je.id}`, c.token, {});
    expect(del.status).toBe(409);
    expect(del.json.error.code).toBe('TXN_DELETE_LINKED');
    const editAmount = await request('PUT', `/api/v1/transactions/${je.id}`, c.token, {
      txnType: 'journal_entry', txnDate: '2026-08-10',
      lines: [
        { accountId: c.clearing, debit: '13.0000', credit: '0' },
        { accountId: c.ar, debit: '0', credit: '13.0000' },
      ],
    });
    expect(editAmount.status).toBe(409);
    expect(editAmount.json.error.code).toBe('TXN_DEPOSITED');
    const editMemo = await request('PUT', `/api/v1/transactions/${je.id}`, c.token, {
      txnType: 'journal_entry', txnDate: '2026-08-10', memo: 'keeps the amount',
      lines: [
        { accountId: c.clearing, debit: '12.0000', credit: '0' },
        { accountId: c.ar, debit: '0', credit: '12.0000' },
      ],
    });
    expect(editMemo.status).toBe(200);
  });

  it('plain clearing lines (no source) still post as before', async () => {
    const p1 = await payment(c, '60.0000');
    const res = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '60.0000' },
    ]));
    expect(res.status).toBe(201);
    expect(res.json.transaction.total).toBe('60.0000');
    const links = await db.select().from(depositLines).where(eq(depositLines.depositId, res.json.transaction.id));
    expect(links).toHaveLength(0);
    // Not linked, so the item still reads as pending (unchanged behaviour).
    const pending = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token);
    expect(pending.json.items.map((i: any) => i.transactionId)).toContain(p1);
  });
});

describe('deposit cash back (U-53)', () => {
  it('bank gets lines − cash back; fee lines are debits; returned on GET', async () => {
    const p1 = await payment(c, '300.0000');
    const bankBefore = await balance(c.bank);
    const res = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '300.0000', sourceTransactionId: p1 },
      { accountId: c.fee, amount: '-5.0000', description: 'Card fee' },
    ], { cashBack: { accountId: c.draw, amount: '50.00', memo: 'Pocket cash' } }));
    expect(res.status).toBe(201);
    const id = res.json.transaction.id;
    expect(res.json.transaction.total).toBe('245.0000');

    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, id));
    const bankLine = lines.find((l) => l.accountId === c.bank)!;
    const feeLine = lines.find((l) => l.accountId === c.fee)!;
    const cbLine = lines.find((l) => l.lineRole === 'cash_back')!;
    expect([bankLine.debit, bankLine.credit]).toEqual(['245.0000', '0.0000']);
    expect([feeLine.debit, feeLine.credit]).toEqual(['5.0000', '0.0000']);
    expect([cbLine.accountId, cbLine.debit, cbLine.credit]).toEqual([c.draw, '50.0000', '0.0000']);
    expect(await balance(c.bank)).toBe(
      (await db.execute(sql`SELECT (${bankBefore}::numeric + 245)::numeric(19,4)::text AS v`)).rows[0]!['v'],
    );

    const got = await request('GET', `/api/v1/transactions/${id}`, c.token);
    expect(got.json.transaction.cashBack).toEqual({ accountId: c.draw, amount: '50.0000', memo: 'Pocket cash' });

    // Edit keeps the shape; removing cashBack removes the line.
    const edit = await request('PUT', `/api/v1/transactions/${id}`, c.token, deposit(c, [
      { accountId: c.clearing, amount: '300.0000', sourceTransactionId: p1 },
    ]));
    expect(edit.status).toBe(200);
    const again = await request('GET', `/api/v1/transactions/${id}`, c.token);
    expect(again.json.transaction.cashBack).toBeNull();
    expect(again.json.transaction.total).toBe('300.0000');
  });

  it('refuses a cash back that is not positive and a total that is not positive', async () => {
    const zero = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.fee, amount: '50.00' },
    ], { cashBack: { accountId: c.draw, amount: '0' } }));
    expect(zero.status).toBe(400);
    expect(zero.json.error.code).toBe('VALIDATION_ERROR');

    const allBack = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.fee, amount: '50.00' },
    ], { cashBack: { accountId: c.draw, amount: '50.00' } }));
    expect(allBack.status).toBe(400);
    expect(allBack.json.error.code).toBe('DEPOSIT_TOTAL_NOT_POSITIVE');

    const negative = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.fee, amount: '-10.00' },
    ]));
    expect(negative.status).toBe(400);
    expect(negative.json.error.code).toBe('DEPOSIT_TOTAL_NOT_POSITIVE');
  });
});

describe('vendor refunds (U-54)', () => {
  it('applies against the open vendor credit and never past it; void restores it', async () => {
    const credit = await vendorCreditService.createVendorCredit(c.tenantId, {
      contactId: c.vendor, txnDate: '2026-08-01', lines: [{ accountId: c.fee, amount: '200.00' }],
    } as any, c.userId, c.companyId);

    const r1 = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.ap, amount: '80.00', sourceTransactionId: credit.id },
    ]));
    expect(r1.status).toBe(201);
    let row = await db.query.transactions.findFirst({ where: eq(transactions.id, credit.id) });
    expect(row!.balanceDue).toBe('120.0000');
    const apLine = (await db.select().from(journalLines).where(eq(journalLines.transactionId, r1.json.transaction.id)))
      .find((l) => l.accountId === c.ap)!;
    expect(apLine.contactId).toBe(c.vendor);
    expect(apLine.credit).toBe('80.0000');

    const over = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.ap, amount: '120.0001', sourceTransactionId: credit.id },
    ]));
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe('VENDOR_CREDIT_EXCEEDED');
    expect(over.json.error.details.openBalance).toBe('120.0000');

    const wrongAcct = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.clearing, amount: '10.00', sourceTransactionId: credit.id },
    ]));
    expect(wrongAcct.status).toBe(400);
    expect(wrongAcct.json.error.code).toBe('VENDOR_REFUND_ACCOUNT');

    const wrongVendor = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.ap, amount: '10.00', sourceTransactionId: credit.id, contactId: c.customer },
    ]));
    expect(wrongVendor.status).toBe(400);
    expect(wrongVendor.json.error.code).toBe('VENDOR_REFUND_CONTACT');

    const r2 = await request('POST', '/api/v1/transactions', c.token, deposit(c, [
      { accountId: c.ap, amount: '120.00', sourceTransactionId: credit.id },
    ]));
    expect(r2.status).toBe(201);
    row = await db.query.transactions.findFirst({ where: eq(transactions.id, credit.id) });
    expect(row!.balanceDue).toBe('0.0000');
    expect(row!.billStatus).toBe('paid');

    // The credit can't be voided while refunds stand.
    await expect(vendorCreditService.voidVendorCredit(c.tenantId, credit.id, 'x', c.userId))
      .rejects.toMatchObject({ code: 'TXN_DEPOSITED' });

    const v = await request('POST', `/api/v1/transactions/${r1.json.transaction.id}/void`, c.token, { reason: 'bounced' });
    expect(v.status).toBe(200);
    row = await db.query.transactions.findFirst({ where: eq(transactions.id, credit.id) });
    expect(row!.balanceDue).toBe('80.0000');
    expect(row!.billStatus).toBe('unpaid');
  });
});

describe('deposit suggestions for a feed item (U-56)', () => {
  async function feedItem(co: Co, amount: string, date: string, companyId = co.companyId) {
    const [conn] = await db.insert(bankConnections).values({
      tenantId: co.tenantId, companyId, accountId: co.bank, provider: 'manual',
    }).returning();
    const [item] = await db.insert(bankFeedItems).values({
      tenantId: co.tenantId, companyId, bankConnectionId: conn!.id, feedDate: date, amount, description: 'DEPOSIT',
    }).returning();
    return item!.id;
  }

  it('returns exact-sum sets within ±10 days, fewest items first', async () => {
    const p150 = await payment(c, '150.0000', '2026-08-10');
    const p100 = await payment(c, '100.0000', '2026-08-08');
    const p50 = await payment(c, '50.0000', '2026-08-09');
    const p75 = await payment(c, '75.0000', '2026-08-11');
    const p25 = await payment(c, '25.0000', '2026-08-12');
    await payment(c, '50.0000', '2026-08-24'); // 11 days after the feed date: outside the window
    const id = await feedItem(c, '-150.0000', '2026-08-13');

    const res = await request('GET', `/api/v1/banking/feed/${id}/deposit-groupings`, c.token);
    expect(res.status).toBe(200);
    expect(res.json.targetAmount).toBe('150.0000');
    const sets = res.json.candidates.map((s: any) => s.items.map((i: any) => i.transactionId).sort());
    expect(sets[0]).toEqual([p150]);
    expect(sets).toContainEqual([p100, p50].sort());
    expect(sets).toContainEqual([p75, p50, p25].sort());
    for (const s of res.json.candidates) {
      expect(s.total).toBe('150.0000');
      expect(typeof s.items[0].amount).toBe('string');
    }
    expect(res.json.candidates.every((s: any) => s.items.every((i: any) => i.date <= '2026-08-23'))).toBe(true);
  });

  it('never offers a set that is 0.0001 off', async () => {
    await payment(c, '100.0000', '2026-08-10');
    await payment(c, '50.0001', '2026-08-10');
    const id = await feedItem(c, '-150.0000', '2026-08-10');
    const res = await request('GET', `/api/v1/banking/feed/${id}/deposit-groupings`, c.token);
    expect(res.status).toBe(200);
    expect(res.json.candidates).toEqual([]);
  });

  it('is company-scoped and ignores money-out items', async () => {
    await payment(c, '40.0000', '2026-08-10', c.companyB);
    const idA = await feedItem(c, '-40.0000', '2026-08-10');
    const resA = await request('GET', `/api/v1/banking/feed/${idA}/deposit-groupings`, c.token, undefined, c.companyId);
    expect(resA.json.candidates).toEqual([]);
    const idB = await feedItem(c, '-40.0000', '2026-08-10', c.companyB);
    const crossItem = await request('GET', `/api/v1/banking/feed/${idB}/deposit-groupings`, c.token, undefined, c.companyId);
    expect(crossItem.status).toBe(404);
    const resB = await request('GET', `/api/v1/banking/feed/${idB}/deposit-groupings`, c.token, undefined, c.companyB);
    expect(resB.json.candidates).toHaveLength(1);

    const out = await feedItem(c, '40.0000', '2026-08-10');
    const resOut = await request('GET', `/api/v1/banking/feed/${out}/deposit-groupings`, c.token);
    expect(resOut.status).toBe(200);
    expect(resOut.json.candidates).toEqual([]);
  });
});
