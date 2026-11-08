// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-171 (feed-match-post-v1) and U-77 (account-balances-v1):
//   - GET /banking/feed/:id/transfer-candidates: exact opposite amounts on
//     another GL account, windowDays 1-10 (default 3), feed sign;
//   - POST /banking/feed/:id/transfer: one transfer for both sides in one
//     database transaction, dated on the money-out side (closing date checked
//     against it), source bank_feed, Idempotency-Key required, replay
//     identical, TRANSFER_MISMATCH, FEED_ITEM_NOT_PENDING, FEED_ITEM_IN_USE;
//   - POST /banking/feed/:id/deposit: live Payments Clearing amounts, fee
//     lines, payments - fees = bank exactly, FEE_ACCOUNT_INVALID,
//     PAYMENT_NOT_PENDING_DEPOSIT, PAYMENT_BOUNCED, void releases payments;
//   - match-apply transfers post through the same atomic path;
//   - golden 999999999999.99 through transfer and deposit;
//   - GET /dashboard/account-balances: latest file by file date, then import
//     time, undone skipped, card sign.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, depositLines, bankConnections, bankFeedItems, bankImportBatches, transactionClassificationState,
  idempotencyKeys, userPermissions,
} from '../db/schema/index.js';
import { bankingRouter } from './banking.routes.js';
import { dashboardRouter } from './dashboard.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as accountsService from '../services/accounts.service.js';
import * as ledger from '../services/ledger.service.js';
import * as matchApply from '../services/match-apply.service.js';
import { liveDepositsForSource } from '../services/deposit-links.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const PASSWORD = 'feed-transfer-pass-1';

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function request(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.token}`,
        ...headers,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = raw;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* raw */ }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** A keyed POST (the posting routes require an Idempotency-Key). */
const keyed = (pathname: string, body: unknown, key: string = randomUUID()) =>
  request('POST', pathname, body, { 'Idempotency-Key': key });

async function cleanTenant(tid: string) {
  const txnIds = (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tid))).map((r) => r.id);
  if (txnIds.length) await db.delete(depositLines).where(inArray(depositLines.depositId, txnIds));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tid));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tid));
  await db.delete(bankImportBatches).where(eq(bankImportBatches.tenantId, tid));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tid));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
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
  checking: string; savings: string; card: string; clearing: string; ar: string; ap: string; fees: string;
  customer: string;
  checkingConn: string; checkingConn2: string; savingsConn: string; cardConn: string;
}
let c: Co;

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

async function makeCompany(): Promise<Co> {
  const reg = await authService.register({
    email: `xfer-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Transfers Co',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const checking = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  const savings = (await accountsService.create(tenantId, { name: 'ZZ Savings', accountType: 'asset', detailType: 'bank', accountNumber: '1090' })).id;
  const card = (await accountsService.create(tenantId, { name: 'ZZ Card', accountType: 'liability', detailType: 'credit_card', accountNumber: '2090' })).id;
  const fees = (await accountsService.create(tenantId, { name: 'ZZ Processing Fees', accountType: 'expense', accountNumber: '6090' })).id;
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  const conn = async (accountId: string) =>
    (await db.insert(bankConnections).values({ tenantId, companyId: company!.id, accountId, provider: 'manual' }).returning())[0]!.id;
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id,
    checking, savings, card, fees, customer: customer!.id,
    clearing: await bySystemTag(tenantId, 'payments_clearing'),
    ar: await bySystemTag(tenantId, 'accounts_receivable'),
    ap: await bySystemTag(tenantId, 'accounts_payable'),
    checkingConn: await conn(checking), checkingConn2: await conn(checking), savingsConn: await conn(savings), cardConn: await conn(card),
  };
}

async function feed(connId: string, amount: string, date = '2026-08-14', extra: Partial<typeof bankFeedItems.$inferInsert> = {}) {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId: c.tenantId, companyId: c.companyId, bankConnectionId: connId, feedDate: date, amount,
    description: 'ZZQX ONLINE TRANSFER', originalDescription: 'ZZQX ONLINE TRANSFER', status: 'pending', ...extra,
  }).returning();
  return row!.id;
}

const item = async (id: string) => (await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) }))!;

async function linesOf(txnId: string) {
  const rows = await db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, c.tenantId), eq(journalLines.transactionId, txnId)));
  return rows.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.debit.localeCompare(b.debit));
}

const sorted = <T extends { accountId: string; debit: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.accountId.localeCompare(b.accountId) || a.debit.localeCompare(b.debit));

async function txnCount(type: string) {
  const rows = await db.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnType, type)));
  return rows.length;
}

/** A customer payment waiting in Payments Clearing. */
async function payment(amount: string, date = '2026-08-10') {
  const p = await ledger.postTransaction(c.tenantId, {
    txnType: 'customer_payment', txnDate: date, contactId: c.customer, total: amount,
    lines: [
      { accountId: c.clearing, debit: amount, credit: '0' },
      { accountId: c.ar, debit: '0', credit: amount },
    ],
  }, c.userId, c.companyId);
  return p.id;
}

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/banking', bankingRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await new Promise((r) => setTimeout(r, 50));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('capabilities', () => {
  it('advertises feed-match-post-v1 and account-balances-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('feed-match-post-v1');
    expect(DESKTOP_CAPABILITIES).toContain('account-balances-v1');
  });
});

describe('GET /feed/:id/transfer-candidates (U-171)', () => {
  it('lists exact opposite lines on other GL accounts within the window, feed sign, closest first', async () => {
    const out = await feed(c.checkingConn, '500.0000', '2026-08-14');
    const near = await feed(c.savingsConn, '-500.0000', '2026-08-15');
    const far = await feed(c.savingsConn, '-500.0000', '2026-08-22');
    await feed(c.checkingConn2, '-500.0000', '2026-08-14'); // same GL account through another connection
    await feed(c.savingsConn, '-500.0100', '2026-08-14'); // not the exact amount
    await feed(c.savingsConn, '-500.0000', '2026-08-14', { status: 'excluded' });

    const def = await request('GET', `/api/v1/banking/feed/${out}/transfer-candidates`);
    expect(def.status).toBe(200);
    expect(def.json.candidates).toEqual([
      { feedItemId: near, accountId: c.savings, accountName: 'ZZ Savings', date: '2026-08-15', amount: '-500.00' },
    ]);

    const wide = await request('GET', `/api/v1/banking/feed/${out}/transfer-candidates?windowDays=10`);
    expect(wide.json.candidates.map((x: any) => x.feedItemId)).toEqual([near, far]);

    for (const bad of ['0', '11', 'x']) {
      const r = await request('GET', `/api/v1/banking/feed/${out}/transfer-candidates?windowDays=${bad}`);
      expect(r.status).toBe(400);
    }
    const missing = await request('GET', `/api/v1/banking/feed/${randomUUID()}/transfer-candidates`);
    expect(missing.status).toBe(404);
  });
});

describe('POST /feed/:id/transfer (U-171)', () => {
  it('posts one transfer for the pair, dated on the money-out side, matched both ways; replay is identical', async () => {
    const out = await feed(c.checkingConn, '500.0000', '2026-08-14');
    const inn = await feed(c.savingsConn, '-500.0000', '2026-08-16');

    // Started from the money-in side: still dated on the money-out side.
    const key = randomUUID();
    const res = await keyed(`/api/v1/banking/feed/${inn}/transfer`, { otherFeedItemId: out }, key);
    expect(res.status).toBe(200);
    const txn = res.json.transaction;
    expect(txn.txnType).toBe('transfer');
    expect(txn.txnDate).toBe('2026-08-14');
    expect(txn.total).toBe('500.0000');
    expect(txn.source).toBe('bank_feed');
    expect(txn.sourceId).toBe(inn);
    expect(await linesOf(txn.id)).toEqual(sorted([
      { accountId: c.savings, debit: '500.0000', credit: '0.0000' },
      { accountId: c.checking, debit: '0.0000', credit: '500.0000' },
    ]));

    for (const id of [out, inn]) {
      const it = await item(id);
      expect(it.status).toBe('matched');
      expect(it.matchedTransactionId).toBe(txn.id);
    }
    // Each item names the transfer line on its own account.
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txn.id));
    const lineOn = (acct: string) => lines.find((l) => l.accountId === acct)!.id;
    expect(res.json.items).toEqual([
      { feedItemId: inn, journalLineId: lineOn(c.savings) },
      { feedItemId: out, journalLineId: lineOn(c.checking) },
    ]);

    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'bank_feed')));
    expect(audits.map((a) => a.entityId).sort()).toEqual([out, inn].sort());

    const replay = await keyed(`/api/v1/banking/feed/${inn}/transfer`, { otherFeedItemId: out }, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json).toEqual(res.json);
    expect(await txnCount('transfer')).toBe(1);

    const again = await keyed(`/api/v1/banking/feed/${out}/transfer`, { otherFeedItemId: inn });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('FEED_ITEM_NOT_PENDING');
    expect(again.json.error.details).toMatchObject({ status: 'matched' });
  });

  it('needs an Idempotency-Key and exactly one of otherFeedItemId / toAccountId', async () => {
    const out = await feed(c.checkingConn, '75.0000');
    const inn = await feed(c.savingsConn, '-75.0000');
    const noKey = await request('POST', `/api/v1/banking/feed/${out}/transfer`, { otherFeedItemId: inn });
    expect(noKey.status).toBe(400);
    expect(noKey.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const both = await keyed(`/api/v1/banking/feed/${out}/transfer`, { otherFeedItemId: inn, toAccountId: c.savings });
    expect(both.status).toBe(400);
    const neither = await keyed(`/api/v1/banking/feed/${out}/transfer`, {});
    expect(neither.status).toBe(400);
    expect((await item(out)).status).toBe('pending');
  });

  it('refuses mismatches with TRANSFER_MISMATCH and posts nothing', async () => {
    const out = await feed(c.checkingConn, '500.0000');
    const off = await feed(c.savingsConn, '-499.9900');
    const sameGl = await feed(c.checkingConn2, '-500.0000');
    const farIn = await feed(c.savingsConn, '-500.0000', '2026-08-30');

    const cases: Array<[unknown, string]> = [
      [{ otherFeedItemId: off }, 'amount'],
      [{ otherFeedItemId: sameGl }, 'account'],
      [{ otherFeedItemId: farIn }, 'date'],
      [{ otherFeedItemId: out }, 'otherFeedItemId'],
      [{ toAccountId: c.checking }, 'toAccountId'],
      [{ toAccountId: c.ar }, 'toAccountId'],
      [{ toAccountId: c.clearing }, 'toAccountId'],
      [{ toAccountId: c.fees }, 'toAccountId'],
      [{ toAccountId: randomUUID() }, 'toAccountId'],
    ];
    for (const [body, field] of cases) {
      const r = await keyed(`/api/v1/banking/feed/${out}/transfer`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe('TRANSFER_MISMATCH');
      expect(r.json.error.details.field).toBe(field);
    }
    expect(await txnCount('transfer')).toBe(0);
    for (const id of [out, off, sameGl, farIn]) expect((await item(id)).status).toBe('pending');
  });

  it('toAccountId: the other side is an account; an assigned row can be used', async () => {
    const inn = await feed(c.savingsConn, '-250.0000', '2026-08-20', { status: 'assigned', assignedAccountId: c.fees });
    const res = await keyed(`/api/v1/banking/feed/${inn}/transfer`, { toAccountId: c.checking });
    expect(res.status).toBe(200);
    expect(res.json.transaction.txnDate).toBe('2026-08-20');
    expect(await linesOf(res.json.transaction.id)).toEqual(sorted([
      { accountId: c.savings, debit: '250.0000', credit: '0.0000' },
      { accountId: c.checking, debit: '0.0000', credit: '250.0000' },
    ]));
    expect(res.json.items).toHaveLength(1);
    expect((await item(inn)).status).toBe('matched');

    // A card payment from checking is a transfer to the card (a liability).
    const out = await feed(c.checkingConn, '120.0000');
    const card = await keyed(`/api/v1/banking/feed/${out}/transfer`, { toAccountId: c.card });
    expect(card.status).toBe(200);
    expect(await linesOf(card.json.transaction.id)).toEqual(sorted([
      { accountId: c.card, debit: '120.0000', credit: '0.0000' },
      { accountId: c.checking, debit: '0.0000', credit: '120.0000' },
    ]));
  });

  it('a busy row is 409 FEED_ITEM_IN_USE, never a wait', async () => {
    const out = await feed(c.checkingConn, '60.0000');
    const inn = await feed(c.savingsConn, '-60.0000');
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM bank_feed_items WHERE id = ${inn} FOR UPDATE`);
      const r = await keyed(`/api/v1/banking/feed/${out}/transfer`, { otherFeedItemId: inn });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('FEED_ITEM_IN_USE');
      expect(r.json.error.details).toEqual({ id: inn });
    });
    expect((await item(out)).status).toBe('pending');
    expect(await txnCount('transfer')).toBe(0);
  });

  it('closing date: checked against the money-out date, whichever side is clicked (#15)', async () => {
    await db.update(companies).set({ lockDate: '2026-03-31', closingPasswordHash: await bcrypt.hash(PASSWORD, 4) })
      .where(eq(companies.id, c.companyId));
    // Money out on 3/31 (closed), money in on 4/1 (open): the transfer is dated 3/31.
    const out = await feed(c.checkingConn, '500.0000', '2026-03-31');
    const inn = await feed(c.savingsConn, '-500.0000', '2026-04-01');
    const locked = await keyed(`/api/v1/banking/feed/${inn}/transfer`, { otherFeedItemId: out });
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe('TB_PERIOD_LOCKED');
    expect((await item(inn)).status).toBe('pending');
    const ok = await keyed(`/api/v1/banking/feed/${inn}/transfer`, { otherFeedItemId: out, closingPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.json.transaction.txnDate).toBe('2026-03-31');

    // Money out on 4/1, money in on 3/31: dated 4/1, no password needed.
    const out2 = await feed(c.checkingConn, '80.0000', '2026-04-01');
    const in2 = await feed(c.savingsConn, '-80.0000', '2026-03-31');
    const open = await keyed(`/api/v1/banking/feed/${in2}/transfer`, { otherFeedItemId: out2 });
    expect(open.status).toBe(200);
    expect(open.json.transaction.txnDate).toBe('2026-04-01');
  });

  it('golden 999999999999.99 posts exactly', async () => {
    const out = await feed(c.checkingConn, '999999999999.9900');
    const inn = await feed(c.savingsConn, '-999999999999.9900');
    const cand = await request('GET', `/api/v1/banking/feed/${out}/transfer-candidates`);
    expect(cand.json.candidates[0].amount).toBe('-999999999999.99');
    const res = await keyed(`/api/v1/banking/feed/${out}/transfer`, { otherFeedItemId: inn });
    expect(res.status).toBe(200);
    expect(res.json.transaction.total).toBe('999999999999.9900');
    expect(await linesOf(res.json.transaction.id)).toEqual(sorted([
      { accountId: c.savings, debit: '999999999999.9900', credit: '0.0000' },
      { accountId: c.checking, debit: '0.0000', credit: '999999999999.9900' },
    ]));
  });
});

describe('match-apply transfer (practice path) posts atomically (U-171)', () => {
  async function stateFor(feedItemId: string, targetId: string) {
    const [s] = await db.insert(transactionClassificationState).values({
      tenantId: c.tenantId, companyId: c.companyId, bankFeedItemId: feedItemId, bucket: 'potential_match',
      matchCandidates: [{
        kind: 'transfer', targetId, amount: '0', date: '2026-08-14', contactName: null, score: 1,
        amountScore: 1, dateScore: 1, nameScore: 0, reason: 'test',
      }],
    } as typeof transactionClassificationState.$inferInsert).returning();
    return s!.id;
  }

  it('a used pair posts nothing; a good pair posts one transfer matched both ways', async () => {
    const out = await feed(c.checkingConn, '42.4200');
    const used = await feed(c.savingsConn, '-42.4200', '2026-08-14', { status: 'excluded' });
    const bad = await stateFor(out, used);
    await expect(matchApply.applyMatch(c.tenantId, bad, 0, c.userId)).rejects.toMatchObject({ code: 'FEED_ITEM_NOT_PENDING' });
    expect(await txnCount('transfer')).toBe(0);
    expect((await item(out)).status).toBe('pending');

    const inn = await feed(c.savingsConn, '-42.4200', '2026-08-15');
    await db.delete(transactionClassificationState).where(eq(transactionClassificationState.id, bad));
    const good = await stateFor(out, inn);
    const r = await matchApply.applyMatch(c.tenantId, good, 0, c.userId);
    expect(r).toMatchObject({ kind: 'transfer', appliedAmount: '42.4200', partial: false });
    expect((await item(out)).matchedTransactionId).toBe(r.appliedTransactionId);
    expect((await item(inn)).matchedTransactionId).toBe(r.appliedTransactionId);
    const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, r.appliedTransactionId) });
    expect(txn!.txnDate).toBe('2026-08-14');
  });
});

describe('POST /feed/:id/deposit (U-171, Q-P26t)', () => {
  it('two waiting payments → one deposit matched to the bank line (#10); 0.01 short is refused', async () => {
    const p1 = await payment('413.2700');
    const p2 = await payment('286.1900');
    const short = await feed(c.checkingConn, '-699.4500', '2026-08-12', { description: 'ZZQX DEPOSIT' });
    const bad = await keyed(`/api/v1/banking/feed/${short}/deposit`, { sourceTransactionIds: [p1, p2] });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('FEED_ITEM_MISMATCH');
    expect(bad.json.error.details).toMatchObject({ difference: '-0.01', paymentsTotal: '699.46', feesTotal: '0.00', amount: '699.45' });
    expect(await txnCount('deposit')).toBe(0);

    const line = await feed(c.checkingConn, '-699.4600', '2026-08-12', { description: 'ZZQX DEPOSIT' });
    const res = await keyed(`/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [p1, p2] });
    expect(res.status).toBe(200);
    const dep = res.json.transaction;
    expect(dep.txnType).toBe('deposit');
    expect(dep.txnDate).toBe('2026-08-12');
    expect(dep.total).toBe('699.4600');
    expect(dep.source).toBe('bank_feed');
    expect(dep.sourceId).toBe(line);
    expect(await linesOf(dep.id)).toEqual(sorted([
      { accountId: c.checking, debit: '699.4600', credit: '0.0000' },
      { accountId: c.clearing, debit: '0.0000', credit: '413.2700' },
      { accountId: c.clearing, debit: '0.0000', credit: '286.1900' },
    ]));
    expect(res.json.payments).toEqual([{ id: p1, amount: '413.27' }, { id: p2, amount: '286.19' }]);
    const links = await db.select().from(depositLines).where(eq(depositLines.depositId, dep.id));
    expect(links.map((l) => [l.sourceTransactionId, l.amount]).sort()).toEqual([[p1, '413.2700'], [p2, '286.1900']].sort());
    expect((await item(line)).status).toBe('matched');
    expect((await item(line)).matchedTransactionId).toBe(dep.id);
    const bankLine = (await db.select().from(journalLines).where(eq(journalLines.transactionId, dep.id)))
      .find((l) => l.accountId === c.checking)!;
    expect(res.json.items).toEqual([{ feedItemId: line, journalLineId: bankLine.id }]);

    // Already deposited: not waiting any more.
    const other = await feed(c.checkingConn, '-413.2700');
    const twice = await keyed(`/api/v1/banking/feed/${other}/deposit`, { sourceTransactionIds: [p1] });
    expect(twice.status).toBe(400);
    expect(twice.json.error.code).toBe('PAYMENT_NOT_PENDING_DEPOSIT');
    expect(twice.json.error.details).toEqual({ id: p1 });
  });

  it('net of fees (#24): 720.00 − 20.54 = 699.46; one deposit with the fee line; void puts the payment back', async () => {
    const p = await payment('720.0000');
    const line = await feed(c.checkingConn, '-699.4600', '2026-08-12');

    const off = await keyed(`/api/v1/banking/feed/${line}/deposit`, {
      sourceTransactionIds: [p], feeLines: [{ accountId: c.fees, amount: '20.53' }],
    });
    expect(off.status).toBe(400);
    expect(off.json.error.code).toBe('FEED_ITEM_MISMATCH');
    expect(off.json.error.details.difference).toBe('-0.01');

    for (const acct of [c.checking, c.savings, c.card, c.clearing, c.ar, c.ap, randomUUID()]) {
      const r = await keyed(`/api/v1/banking/feed/${line}/deposit`, {
        sourceTransactionIds: [p], feeLines: [{ accountId: acct, amount: '20.54' }],
      });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('FEE_ACCOUNT_INVALID');
      expect(r.json.error.details).toEqual({ accountId: acct });
    }

    const eleven = Array.from({ length: 11 }, () => ({ accountId: c.fees, amount: '1.00' }));
    const tooMany = await keyed(`/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [p], feeLines: eleven });
    expect(tooMany.status).toBe(400);
    for (const amount of ['0', '0.00', '-1.00', '1.234', '1e2', '1234567890123.00']) {
      const r = await keyed(`/api/v1/banking/feed/${line}/deposit`, {
        sourceTransactionIds: [p], feeLines: [{ accountId: c.fees, amount }],
      });
      expect(r.status, amount).toBe(400);
    }
    expect(await txnCount('deposit')).toBe(0);

    const res = await keyed(`/api/v1/banking/feed/${line}/deposit`, {
      sourceTransactionIds: [p], feeLines: [{ accountId: c.fees, amount: '20.54', memo: 'Processor fee' }],
    });
    expect(res.status).toBe(200);
    const dep = res.json.transaction;
    expect(dep.total).toBe('699.4600');
    expect(await linesOf(dep.id)).toEqual(sorted([
      { accountId: c.checking, debit: '699.4600', credit: '0.0000' },
      { accountId: c.fees, debit: '20.5400', credit: '0.0000' },
      { accountId: c.clearing, debit: '0.0000', credit: '720.0000' },
    ]));
    const feeLine = (await db.select().from(journalLines).where(eq(journalLines.transactionId, dep.id)))
      .find((l) => l.accountId === c.fees)!;
    expect(feeLine.description).toBe('Processor fee');
    expect(await liveDepositsForSource(db, c.tenantId, p)).toHaveLength(1);

    // Voiding the deposit (allowed, Q-P26u) puts the payment back in Payments Clearing at exactly 720.00.
    await ledger.voidTransaction(c.tenantId, dep.id, 'test', c.userId);
    expect(await liveDepositsForSource(db, c.tenantId, p)).toHaveLength(0);
    const again = await feed(c.checkingConn, '-720.0000');
    const redo = await keyed(`/api/v1/banking/feed/${again}/deposit`, { sourceTransactionIds: [p] });
    expect(redo.status).toBe(200);
    expect(redo.json.payments).toEqual([{ id: p, amount: '720.00' }]);
  });

  it('refuses money out, unknown and bounced payments, repeats, and needs a key', async () => {
    const p = await payment('50.0000');
    const out = await feed(c.checkingConn, '50.0000');
    const r1 = await keyed(`/api/v1/banking/feed/${out}/deposit`, { sourceTransactionIds: [p] });
    expect(r1.status).toBe(400);
    expect(r1.json.error.code).toBe('FEED_ITEM_MISMATCH');
    expect(r1.json.error.details).toEqual({ reason: 'not_money_in' });

    const line = await feed(c.checkingConn, '-50.0000');
    const ghost = randomUUID();
    const r2 = await keyed(`/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [ghost] });
    expect(r2.status).toBe(400);
    expect(r2.json.error.code).toBe('PAYMENT_NOT_PENDING_DEPOSIT');
    expect(r2.json.error.details).toEqual({ id: ghost });

    const dup = await keyed(`/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [p, p] });
    expect(dup.status).toBe(400);
    const none = await keyed(`/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [] });
    expect(none.status).toBe(400);
    const noKey = await request('POST', `/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [p] });
    expect(noKey.status).toBe(400);
    expect(noKey.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    await db.insert(transactions).values({
      tenantId: c.tenantId, companyId: c.companyId, txnType: 'returned_payment', txnDate: '2026-08-11', status: 'posted',
      total: '50.0000', sourceTxnId: p,
    } as typeof transactions.$inferInsert);
    const bounced = await keyed(`/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [p] });
    expect(bounced.status).toBe(409);
    expect(bounced.json.error.code).toBe('PAYMENT_BOUNCED');
    expect((await item(line)).status).toBe('pending');
    expect(await txnCount('deposit')).toBe(0);
  });

  it('golden 999999999999.99 through a deposit with a fee', async () => {
    const p = await payment('999999999999.9900');
    const line = await feed(c.checkingConn, '-999999999998.9900');
    const res = await keyed(`/api/v1/banking/feed/${line}/deposit`, {
      sourceTransactionIds: [p], feeLines: [{ accountId: c.fees, amount: '1.00' }],
    });
    expect(res.status).toBe(200);
    expect(await linesOf(res.json.transaction.id)).toEqual(sorted([
      { accountId: c.checking, debit: '999999999998.9900', credit: '0.0000' },
      { accountId: c.fees, debit: '1.0000', credit: '0.0000' },
      { accountId: c.clearing, debit: '0.0000', credit: '999999999999.9900' },
    ]));
  });

  it('closing date: the deposit is dated on the bank line; 423 without the password', async () => {
    const p = await payment('30.0000', '2026-03-20');
    await db.update(companies).set({ lockDate: '2026-03-31', closingPasswordHash: await bcrypt.hash(PASSWORD, 4) })
      .where(eq(companies.id, c.companyId));
    const line = await feed(c.checkingConn, '-30.0000', '2026-03-30');
    const locked = await keyed(`/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [p] });
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe('TB_PERIOD_LOCKED');
    const ok = await keyed(`/api/v1/banking/feed/${line}/deposit`, { sourceTransactionIds: [p], closingPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.json.transaction.txnDate).toBe('2026-03-30');
  });
});

describe('GET /dashboard/account-balances (U-77, #18)', () => {
  async function batch(connId: string, accountId: string, balance: string | null, date: string | null, extra: Partial<typeof bankImportBatches.$inferInsert> = {}) {
    await db.insert(bankImportBatches).values({
      tenantId: c.tenantId, companyId: c.companyId, bankConnectionId: connId, accountId, format: 'ofx', fileName: 'zz.ofx',
      sourceFileSha256: 'a'.repeat(64), fileEndingBalance: balance, fileEndingDate: date, ...extra,
    });
  }

  it('books and the latest bank file per account, card in the owed sign', async () => {
    const post = (accountId: string, other: string, amount: string, date: string, debitBank: boolean) =>
      ledger.postTransaction(c.tenantId, {
        txnType: 'journal_entry', txnDate: date, total: amount,
        lines: [
          { accountId, debit: debitBank ? amount : '0', credit: debitBank ? '0' : amount },
          { accountId: other, debit: debitBank ? '0' : amount, credit: debitBank ? amount : '0' },
        ],
      }, c.userId, c.companyId);
    await post(c.checking, c.fees, '1500.0000', '2026-05-15', true);
    await post(c.checking, c.fees, '300.2500', '2026-06-10', true);
    await post(c.card, c.fees, '100.0000', '2026-05-01', false); // a 100.00 charge: owed

    // The later file date wins even though it was imported first; an undone batch is skipped.
    await batch(c.checkingConn, c.checking, '1200.0000', '2026-05-31', { createdAt: new Date('2026-06-01T00:00:00Z') });
    await batch(c.checkingConn, c.checking, '1000.0000', '2026-04-30', { createdAt: new Date('2026-06-05T00:00:00Z') });
    await batch(c.checkingConn, c.checking, '9999.0000', '2026-06-30', { undoneAt: new Date() });
    await batch(c.checkingConn, c.checking, null, null);
    // OFX reports what is owed on a card as negative (the holder's sign).
    await batch(c.cardConn, c.card, '-429.1200', '2026-05-31');

    const res = await request('GET', '/api/v1/dashboard/account-balances');
    expect(res.status).toBe(200);
    const by = new Map(res.json.map((r: any) => [r.accountId, r]));
    expect(by.get(c.checking)).toMatchObject({
      kind: 'bank', booksBalance: '1800.25', bankFileBalance: '1200.00', bankFileDate: '2026-05-31', booksBalanceAtFileDate: '1500.00',
    });
    expect(by.get(c.card)).toMatchObject({
      kind: 'card', name: 'ZZ Card', booksBalance: '100.00', bankFileBalance: '429.12', bankFileDate: '2026-05-31', booksBalanceAtFileDate: '100.00',
    });
    expect(by.get(c.savings)).toMatchObject({
      kind: 'bank', booksBalance: '0.00', bankFileBalance: null, bankFileDate: null, booksBalanceAtFileDate: null,
    });
    // Expense and system accounts are not listed.
    expect(by.has(c.fees)).toBe(false);
    expect(by.has(c.clearing)).toBe(false);
  });
});
