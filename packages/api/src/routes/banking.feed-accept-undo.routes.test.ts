// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-170 (feed-accept-v1) and U-169 (feed-undo-v1), plan P26 §6:
//   #1  feed-accept.idempotency: one locked row and two open; one commit; the replay is identical
//   #2  feed-accept.skips-matches: Payments Clearing, check and transfer rows → has_match
//   #4  feed-transfer.other-side-later: undo from either side
//   #5  feed-void.linked (accept side): rule accept skips a voided row, Undo unlinks only, Review again restores prior_state
//   #6  feed-undo.stale-group; #7 feed-undo.changed (409, then force)
//   #10/#24 deposit undo puts the payment back at exactly 720.00; PAYMENT_BOUNCED
//   #12 feed-accept.rule-changed; #20 feed-learning.undo; #21 golden 999999999999.99
//   plus: FEED_UNDO_RECONCILED, a match accept and its undo, split failures, accept-groups GET.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, depositLines, bankConnections, bankFeedItems, bankImportBatches, transactionClassificationState,
  idempotencyKeys, userPermissions, conditionalRules, bankFeedAcceptGroups, bankFeedAcceptGroupItems,
  reconciliations, reconciliationLines, categorizationHistory,
} from '../db/schema/index.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as accountsService from '../services/accounts.service.js';
import * as ledger from '../services/ledger.service.js';
import { liveDepositsForSource } from '../services/deposit-links.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const PASSWORD = 'feed-accept-pass-1';
const BASE = '/api/v1/banking/feed';

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

const keyed = (pathname: string, body: unknown, key: string = randomUUID()) =>
  request('POST', pathname, body, { 'Idempotency-Key': key });
const accept = (body: unknown, key?: string) => keyed(`${BASE}/accept`, body, key);
const undo = (body: unknown, key?: string) => keyed(`${BASE}/undo`, body, key);

async function cleanTenant(tid: string) {
  const txnIds = (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tid))).map((r) => r.id);
  if (txnIds.length) await db.delete(depositLines).where(inArray(depositLines.depositId, txnIds));
  const recs = (await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tid))).map((r) => r.id);
  if (recs.length) await db.delete(reconciliationLines).where(inArray(reconciliationLines.reconciliationId, recs));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tid));
  await db.delete(bankFeedAcceptGroupItems).where(eq(bankFeedAcceptGroupItems.tenantId, tid));
  await db.delete(bankFeedAcceptGroups).where(eq(bankFeedAcceptGroups.tenantId, tid));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tid));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tid));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tid));
  await db.delete(bankImportBatches).where(eq(bankImportBatches.tenantId, tid));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tid));
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
  checking: string; savings: string; clearing: string; ar: string; supplies: string; repairs: string; fees: string;
  customer: string; checkingConn: string; savingsConn: string;
}
let c: Co;

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

async function makeCompany(): Promise<Co> {
  const reg = await authService.register({
    email: `accept-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Accept Co',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const checking = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  const savings = (await accountsService.create(tenantId, { name: 'ZZ Savings', accountType: 'asset', detailType: 'bank', accountNumber: '1091' })).id;
  const supplies = (await accountsService.create(tenantId, { name: 'ZZ Supplies', accountType: 'expense', accountNumber: '6091' })).id;
  const repairs = (await accountsService.create(tenantId, { name: 'ZZ Repairs', accountType: 'expense', accountNumber: '6092' })).id;
  const fees = (await accountsService.create(tenantId, { name: 'ZZ Processing Fees', accountType: 'expense', accountNumber: '6093' })).id;
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  const conn = async (accountId: string) =>
    (await db.insert(bankConnections).values({ tenantId, companyId: company!.id, accountId, provider: 'manual' }).returning())[0]!.id;
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id,
    checking, savings, supplies, repairs, fees, customer: customer!.id,
    clearing: await bySystemTag(tenantId, 'payments_clearing'),
    ar: await bySystemTag(tenantId, 'accounts_receivable'),
    checkingConn: await conn(checking), savingsConn: await conn(savings),
  };
}

let seq = 0;
/** A waiting feed row; by default a money-out line with a staged suggestion and a unique amount (no match signals). */
async function feed(amount: string, extra: Partial<typeof bankFeedItems.$inferInsert> = {}) {
  seq++;
  const [row] = await db.insert(bankFeedItems).values({
    tenantId: c.tenantId, companyId: c.companyId, bankConnectionId: c.checkingConn, feedDate: '2026-08-14', amount,
    description: `ZZQX BLUE BOTTLE COFFEE ${seq}`, originalDescription: `ZZQX BLUE BOTTLE COFFEE ${seq}`, status: 'pending',
    suggestedAccountId: c.supplies, matchType: 'rule', confidenceScore: '1.00', ...extra,
  }).returning();
  return row!.id;
}

const item = async (id: string) => (await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) }))!;
const txn = async (id: string) => (await db.query.transactions.findFirst({ where: eq(transactions.id, id) }))!;
const balanceOf = async (accountId: string) => (await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) }))!.balance;

async function linesOf(txnId: string) {
  const rows = await db.select().from(journalLines)
    .where(and(eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)));
  return rows.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.debit.localeCompare(b.debit));
}

/** A customer payment waiting in Payments Clearing. */
async function payment(amount: string, date = '2026-08-10') {
  const p = await ledger.postTransaction(c.tenantId, {
    txnType: 'customer_payment', txnDate: date, contactId: c.customer, total: amount,
    lines: [{ accountId: c.clearing, debit: amount, credit: '0' }, { accountId: c.ar, debit: '0', credit: amount }],
  }, c.userId, c.companyId);
  return p.id;
}

/** A check written in the books: money out of checking. */
async function check(amount: string, date = '2026-08-12') {
  const t = await ledger.postTransaction(c.tenantId, {
    txnType: 'expense', txnDate: date, total: amount,
    lines: [{ accountId: c.repairs, debit: amount, credit: '0' }, { accountId: c.checking, debit: '0', credit: amount }],
  }, c.userId, c.companyId);
  return t.id;
}

async function closePeriod(lockDate: string) {
  await db.update(companies).set({ lockDate, closingPasswordHash: await bcrypt.hash(PASSWORD, 4) })
    .where(eq(companies.id, c.companyId));
}

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/banking', bankingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await new Promise((r) => setTimeout(r, 100));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('capabilities', () => {
  it('advertises feed-accept-v1 and feed-undo-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('feed-accept-v1');
    expect(DESKTOP_CAPABILITIES).toContain('feed-undo-v1');
  });
});

describe('POST /banking/feed/accept (U-170)', () => {
  it('#1 one locked row and two open: one commit, the replay is identical, the locked row posts with the password', async () => {
    await closePeriod('2026-08-10');
    const locked = await feed('11.0000', { feedDate: '2026-08-09' });
    const a = await feed('12.0000');
    const b = await feed('13.0000');
    const key = randomUUID();
    const res = await accept({ items: [{ id: locked }, { id: a }, { id: b }] }, key);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ posted: 2, matched: 0, skipped: [], remaining: 0, nextAfterId: null });
    expect(res.json.failures).toHaveLength(1);
    expect(res.json.failures[0]).toMatchObject({ id: locked, code: 'TB_PERIOD_LOCKED' });
    expect(res.json.failures[0].details).toMatchObject({ lockDate: '2026-08-10', closingPasswordRequired: true });
    for (const id of [a, b]) {
      const it = await item(id);
      expect(it.status).toBe('categorized');
      expect(it.matchedJournalLineId).toBeTruthy();
    }
    expect((await item(locked)).status).toBe('pending');

    const replay = await accept({ items: [{ id: locked }, { id: a }, { id: b }] }, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json).toEqual(res.json);
    const posts = await db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnType, 'expense')));
    expect(posts).toHaveLength(2);

    // The stored group answers the same.
    const group = await request('GET', `${BASE}/accept-groups/${res.json.undoGroupId}`);
    expect(group.status).toBe(200);
    expect(group.json).toEqual(res.json);

    const wrong = await accept({ items: [{ id: locked }], closingPassword: 'nope-nope-nope' });
    expect(wrong.status).toBe(403);
    const ok = await accept({ items: [{ id: locked }], closingPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.json.posted).toBe(1);
    expect((await item(locked)).status).toBe('categorized');

    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'bank_feed'), eq(auditLog.entityId, a)));
    expect(audits.some((x) => (x.afterData as any)?.action === 'accept')).toBe(true);
  });

  it('needs a key and exactly one mode', async () => {
    const a = await feed('14.0000');
    const noKey = await request('POST', `${BASE}/accept`, { items: [{ id: a }] });
    expect(noKey.status).toBe(400);
    expect(noKey.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    for (const body of [{}, { items: [] }, { items: [{ id: a }], ruleId: randomUUID(), ruleKind: 'legacy', ruleUpdatedAt: '2026-01-01' },
      { ruleId: randomUUID() }, { items: [{ id: a }, { id: a }] }, { items: [{ id: a, journalLineId: randomUUID() }] }]) {
      const r = await accept(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await item(a)).status).toBe('pending');
  });

  it('#2 rows with a match signal are skipped as has_match unless the owner sends values', async () => {
    await payment('413.2700');
    const deposit = await feed('-413.2700', { description: 'ZZQX DEPOSIT', originalDescription: 'ZZQX DEPOSIT' });
    await check('250.0000');
    const chk = await feed('250.0000', { description: 'ZZQX CHECK 1043', originalDescription: 'ZZQX CHECK 1043' });
    const out = await feed('500.0000', { description: 'ZZQX ONLINE TRANSFER' });
    const inn = await feed('-500.0000', { bankConnectionId: c.savingsConn, feedDate: '2026-08-15', description: 'ZZQX ONLINE TRANSFER' });
    const plain = await feed('15.0000');
    const dup = await feed('16.0000', { possibleDuplicate: true });
    const bare = await feed('17.0000', { suggestedAccountId: null, matchType: null });

    const res = await accept({ items: [deposit, chk, out, inn, plain, dup, bare].map((id) => ({ id })) });
    expect(res.status).toBe(200);
    expect(res.json.posted).toBe(1);
    const reasons = Object.fromEntries(res.json.skipped.map((s: any) => [s.id, s.reason]));
    expect(reasons).toEqual({
      [deposit]: 'has_match', [chk]: 'has_match', [out]: 'has_match', [inn]: 'has_match',
      [dup]: 'possible_duplicate', [bare]: 'incomplete',
    });
    expect((await item(plain)).status).toBe('categorized');

    // The owner's explicit values post over a match signal (B3: only suggestions are held back).
    const own = await accept({ items: [{ id: chk, accountId: c.repairs }] });
    expect(own.json.posted).toBe(1);
  });

  it('matches a row to an existing entry; Undo unlinks it and keeps the entry', async () => {
    const e = await check('260.0000');
    const row = await feed('260.0000');
    const res = await accept({ items: [{ id: row, matchTransactionId: e }] });
    expect(res.json).toMatchObject({ posted: 0, matched: 1, failures: [] });
    expect(await item(row)).toMatchObject({ status: 'matched', matchedTransactionId: e });

    const bad = await feed('261.0000');
    const r2 = await accept({ items: [{ id: bad, matchTransactionId: e }] });
    expect(r2.json.failures[0]).toMatchObject({ id: bad, code: 'MATCH_MISMATCH' });

    const u = await undo({ feedItemIds: [row] });
    expect(u.status).toBe(200);
    expect(u.json.undone).toEqual([{ id: row, kind: 'match', transactionId: e, entry: 'kept', undoGroupId: res.json.undoGroupId }]);
    expect((await txn(e)).status).toBe('posted');
    expect(await item(row)).toMatchObject({ status: 'pending', matchedTransactionId: null, matchedJournalLineId: null });
  });

  it('an owner split that does not add up is a failure; nothing else in the call is held back', async () => {
    const a = await feed('20.0000');
    const b = await feed('21.0000');
    const res = await accept({ items: [
      { id: a, splits: [{ accountId: c.supplies, amount: '10.00' }, { accountId: c.repairs, amount: '9.99' }] },
      { id: b, splits: [{ accountId: c.supplies, amount: '11.00' }, { accountId: c.repairs, amount: '10.00' }] },
    ] });
    expect(res.json.posted).toBe(1);
    expect(res.json.failures).toEqual([expect.objectContaining({ id: a, code: 'SPLITS_DONT_BALANCE' })]);
    const posted = (await item(b)).matchedTransactionId!;
    expect(await linesOf(posted)).toHaveLength(3);
  });

  it('#21 golden 999999999999.99 through accept and undo', async () => {
    const a = await feed('999999999999.9900');
    const res = await accept({ items: [{ id: a }] });
    const t = (await item(a)).matchedTransactionId!;
    expect((await txn(t)).total).toBe('999999999999.9900');
    expect(await linesOf(t)).toEqual([
      { accountId: c.supplies, debit: '999999999999.9900', credit: '0.0000' },
      { accountId: c.checking, debit: '0.0000', credit: '999999999999.9900' },
    ].sort((x, y) => x.accountId.localeCompare(y.accountId)));
    const u = await undo({ undoGroupId: res.json.undoGroupId });
    expect(u.json.undone).toHaveLength(1);
    expect(await balanceOf(c.supplies)).toBe('0.0000');
  });
});

describe('Accept all from this rule (U-170)', () => {
  async function rule(autoAccept: boolean) {
    const [r] = await db.insert(conditionalRules).values({
      tenantId: c.tenantId, scope: 'tenant_user', ownerUserId: c.userId, name: 'ZZQX coffee', priority: 1, autoAccept,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'blue bottle' },
      actions: [{ type: 'set_account', accountId: c.supplies }], active: true,
    }).returning();
    return r!;
  }
  /** The rule's updatedAt exactly as the list shows it (suggestedRule.updatedAt). */
  async function listedUpdatedAt(rowId: string) {
    const list = await request('GET', `${BASE}?limit=100`);
    return list.json.data.find((r: any) => r.id === rowId).suggestedRule.updatedAt as string;
  }

  it('#12 posts only the rule\'s pending rows whose staging still matches; RULE_CHANGED; RULE_NOT_AUTO_ACCEPT; Undo the group', async () => {
    const r = await rule(true);
    const staged = { suggestedRuleId: r.id, suggestedRuleKind: 'conditional' };
    const a = await feed('30.0000', staged);
    const b = await feed('31.0000', staged);
    const differs = await feed('32.0000', { ...staged, suggestedAccountId: c.repairs });
    const assigned = await feed('33.0000', { ...staged, status: 'assigned', assignedAccountId: c.repairs });
    const otherRule = await feed('34.0000');
    const updatedAt = await listedUpdatedAt(a);
    expect((await request('GET', `${BASE}?limit=100`)).json.data.find((x: any) => x.id === a).suggestedRule.autoAccept).toBe(true);

    const stale = await accept({ ruleId: r.id, ruleKind: 'conditional', ruleUpdatedAt: '2020-01-01T00:00:00Z' });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('RULE_CHANGED');

    const res = await accept({ ruleId: r.id, ruleKind: 'conditional', ruleUpdatedAt: updatedAt });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ posted: 2, remaining: 0, nextAfterId: null, failures: [] });
    expect(res.json.skipped).toEqual([{ id: differs, reason: 'staging_differs' }]);
    for (const id of [a, b]) expect((await item(id)).status).toBe('categorized');
    for (const id of [differs, otherRule]) expect((await item(id)).status).toBe('pending');
    expect((await item(assigned)).status).toBe('assigned');

    // Undo the group: reports back to before.
    const u = await undo({ undoGroupId: res.json.undoGroupId });
    expect(u.status).toBe(200);
    expect(u.json.undone.map((x: any) => x.id).sort()).toEqual([a, b].sort());
    expect(u.json.undone.every((x: any) => x.entry === 'deleted')).toBe(true);
    expect(await balanceOf(c.supplies)).toBe('0.0000');
    for (const id of [a, b]) {
      expect(await item(id)).toMatchObject({
        status: 'pending', suggestedAccountId: c.supplies, suggestedRuleId: r.id, matchType: 'rule', matchedTransactionId: null,
      });
    }

    await db.update(conditionalRules).set({ autoAccept: false }).where(eq(conditionalRules.id, r.id));
    const off = await accept({ ruleId: r.id, ruleKind: 'conditional', ruleUpdatedAt: await listedUpdatedAt(a) });
    expect(off.status).toBe(409);
    expect(off.json.error.code).toBe('RULE_NOT_AUTO_ACCEPT');
    const missing = await accept({ ruleId: randomUUID(), ruleKind: 'legacy', ruleUpdatedAt: updatedAt });
    expect(missing.status).toBe(404);
  });

  it('#5 rule accept never takes a row whose entry was voided; Undo on it unlinks only; Review again restores its prior state', async () => {
    const r = await rule(true);
    await closePeriod('2026-08-20');
    const a = await feed('40.0000', { suggestedRuleId: r.id, suggestedRuleKind: 'conditional', status: 'assigned', assignedAccountId: c.repairs });
    const res = await accept({ items: [{ id: a }], closingPassword: PASSWORD });
    expect(res.json.posted).toBe(1);
    const t = (await item(a)).matchedTransactionId!;
    expect(await linesOf(t)).toContainEqual({ accountId: c.repairs, debit: '40.0000', credit: '0.0000' });

    await ledger.voidTransaction(c.tenantId, t, 'test', c.userId, { companyId: c.companyId, closingPassword: PASSWORD } as never)
      .catch(async () => {
        // Void through the lock: open the period for the void only.
        await db.update(companies).set({ lockDate: null }).where(eq(companies.id, c.companyId));
        await ledger.voidTransaction(c.tenantId, t, 'test', c.userId, { companyId: c.companyId });
        await closePeriod('2026-08-20');
      });
    expect((await item(a)).entryVoidedAt).toBeTruthy();
    const ruleRes = await accept({ items: [{ id: a }] });
    expect(ruleRes.json.skipped).toEqual([{ id: a, reason: 'not_pending' }]);

    // Undo on a voided entry: unlink only, no password, the void stays.
    const u = await undo({ feedItemIds: [a] });
    expect(u.status).toBe(200);
    expect(u.json.undone).toEqual([expect.objectContaining({ id: a, entry: 'kept' })]);
    expect((await txn(t)).status).toBe('void');
    expect(await item(a)).toMatchObject({ status: 'assigned', assignedAccountId: c.repairs, entryVoidedAt: null, matchedTransactionId: null });
  });

  it('Review again restores the prior state from the accept record', async () => {
    const a = await feed('41.0000', { status: 'assigned', assignedAccountId: c.repairs, assignedMemo: 'Owner memo' });
    await accept({ items: [{ id: a }] });
    const t = (await item(a)).matchedTransactionId!;
    await ledger.voidTransaction(c.tenantId, t, 'test', c.userId, { companyId: c.companyId });
    const again = await keyed(`${BASE}/${a}/review-again`, {});
    expect(again.status).toBe(200);
    expect(await item(a)).toMatchObject({ status: 'assigned', assignedAccountId: c.repairs, assignedMemo: 'Owner memo', entryVoidedAt: null });
    // The record is used up: Undo has nothing left.
    const u = await undo({ feedItemIds: [a] });
    expect(u.json.failures).toEqual([expect.objectContaining({ id: a, code: 'FEED_ITEM_NOT_ACCEPTED' })]);
  });
});

describe('POST /banking/feed/undo (U-169)', () => {
  it('#6 a stale group does nothing: undone once, accepted again, the old group can\'t touch the new entry', async () => {
    const a = await feed('50.0000');
    const g1 = (await accept({ items: [{ id: a }] })).json.undoGroupId;
    const t1 = (await item(a)).matchedTransactionId!;
    expect((await undo({ undoGroupId: g1 })).json.undone).toHaveLength(1);
    expect((await txn(t1)).status).toBe('deleted');
    await accept({ items: [{ id: a }] });
    const t2 = (await item(a)).matchedTransactionId!;
    const stale = await undo({ undoGroupId: g1 });
    expect(stale.status).toBe(200);
    expect(stale.json.undone).toEqual([]);
    expect(stale.json.failures).toEqual([expect.objectContaining({ id: a, code: 'FEED_ITEM_NOT_ACCEPTED' })]);
    expect((await txn(t2)).status).toBe('posted');
    expect((await item(a)).matchedTransactionId).toBe(t2);
    expect((await undo({ undoGroupId: randomUUID() })).status).toBe(404);
  });

  it('#7 a changed entry is 409 FEED_UNDO_CHANGED (nothing undone), then force deletes it', async () => {
    const a = await feed('60.0000');
    const b = await feed('61.0000');
    const g = (await accept({ items: [{ id: a }, { id: b }] })).json.undoGroupId;
    const ta = (await item(a)).matchedTransactionId!;
    await db.update(transactions).set({ memo: 'Edited in the register' }).where(eq(transactions.id, ta));
    // Other processes touching updated_at only don't count as a change.
    await db.update(transactions).set({ updatedAt: new Date() }).where(eq(transactions.id, (await item(b)).matchedTransactionId!));

    const r = await undo({ undoGroupId: g });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('FEED_UNDO_CHANGED');
    expect(r.json.error.details).toEqual({ ids: [a] });
    expect((await item(a)).status).toBe('categorized');
    expect((await item(b)).status).toBe('categorized');

    const forced = await undo({ undoGroupId: g, force: true });
    expect(forced.status).toBe(200);
    expect(forced.json.undone).toHaveLength(2);
    expect((await txn(ta)).status).toBe('deleted');
  });

  it('closed period: deleting needs the password; a reconciled entry is refused', async () => {
    const a = await feed('70.0000', { feedDate: '2026-08-01' });
    const b = await feed('71.0000');
    await accept({ items: [{ id: a }, { id: b }] });
    await closePeriod('2026-08-05');
    const r = await undo({ feedItemIds: [a, b] });
    expect(r.json.undone.map((x: any) => x.id)).toEqual([b]);
    expect(r.json.failures).toEqual([expect.objectContaining({ id: a, code: 'TB_PERIOD_LOCKED' })]);
    const ok = await undo({ feedItemIds: [a], closingPassword: PASSWORD });
    expect(ok.json.undone).toHaveLength(1);

    const d = await feed('72.0000');
    await accept({ items: [{ id: d }] });
    const line = (await item(d)).matchedJournalLineId!;
    const [rec] = await db.insert(reconciliations).values({
      tenantId: c.tenantId, accountId: c.checking, statementDate: '2026-08-31', statementEndingBalance: '0', beginningBalance: '0',
      status: 'complete',
    } as typeof reconciliations.$inferInsert).returning();
    await db.insert(reconciliationLines).values({ reconciliationId: rec!.id, journalLineId: line, isCleared: true } as typeof reconciliationLines.$inferInsert);
    const rr = await undo({ feedItemIds: [d] });
    expect(rr.json.failures).toEqual([expect.objectContaining({ id: d, code: 'FEED_UNDO_RECONCILED' })]);
    expect((await item(d)).status).toBe('categorized');
  });

  it('#4 a transfer undoes from either side; a side matched later is unlinked with it', async () => {
    const out = await feed('500.0000', { description: 'ZZQX ONLINE TRANSFER' });
    const inn = await feed('-500.0000', { bankConnectionId: c.savingsConn, feedDate: '2026-08-15', description: 'ZZQX ONLINE TRANSFER' });
    const t = await keyed(`${BASE}/${out}/transfer`, { otherFeedItemId: inn });
    expect(t.status).toBe(200);
    expect(t.json.undoGroupId).toBeTruthy();
    const u = await undo({ feedItemIds: [inn] });
    expect(u.json.undone.map((x: any) => x.id).sort()).toEqual([out, inn].sort());
    expect((await txn(t.json.transaction.id)).status).toBe('deleted');
    for (const id of [out, inn]) expect(await item(id)).toMatchObject({ status: 'pending', matchedTransactionId: null });

    // To an account, the other side's bank line matched later: Undo from the first side removes both links.
    const t2 = await keyed(`${BASE}/${out}/transfer`, { toAccountId: c.savings });
    const transferLine = (await db.select().from(journalLines).where(eq(journalLines.transactionId, t2.json.transaction.id)))
      .find((l) => l.accountId === c.savings)!;
    const m = await request('PUT', `${BASE}/${inn}/match`, { transactionId: t2.json.transaction.id, journalLineId: transferLine.id });
    expect(m.status).toBe(200);
    expect(m.json.undoGroupId).toBeTruthy();
    const u2 = await undo({ undoGroupId: t2.json.undoGroupId });
    expect(u2.json.undone.map((x: any) => x.id).sort()).toEqual([out, inn].sort());
    expect((await txn(t2.json.transaction.id)).status).toBe('deleted');
    expect((await item(inn)).status).toBe('pending');
  });

  it('#10/#24 a fee deposit undoes exactly: the payment is back in Payments Clearing at 720.00; a bounced one stays', async () => {
    const p = await payment('720.0000');
    const line = await feed('-699.4600', { feedDate: '2026-08-12', suggestedAccountId: null, matchType: null });
    const dep = await keyed(`${BASE}/${line}/deposit`, { sourceTransactionIds: [p], feeLines: [{ accountId: c.fees, amount: '20.54' }] });
    expect(dep.status).toBe(200);
    const u = await undo({ undoGroupId: dep.json.undoGroupId });
    expect(u.json.undone).toEqual([expect.objectContaining({ id: line, kind: 'deposit', entry: 'deleted' })]);
    expect(await liveDepositsForSource(db, c.tenantId, p)).toHaveLength(0);
    expect(await balanceOf(c.fees)).toBe('0.0000');
    const again = await feed('-720.0000', { suggestedAccountId: null, matchType: null });
    const redo = await keyed(`${BASE}/${again}/deposit`, { sourceTransactionIds: [p] });
    expect(redo.json.payments).toEqual([{ id: p, amount: '720.00' }]);

    await db.insert(transactions).values({
      tenantId: c.tenantId, companyId: c.companyId, txnType: 'returned_payment', txnDate: '2026-08-13', status: 'posted',
      total: '720.0000', sourceTxnId: p,
    } as typeof transactions.$inferInsert);
    const bounced = await undo({ undoGroupId: redo.json.undoGroupId });
    expect(bounced.json.failures).toEqual([expect.objectContaining({ id: again, code: 'PAYMENT_BOUNCED' })]);
    expect((await item(again)).status).toBe('matched');
  });

  it('#20 an undone accept counts as an override in the categorization history', async () => {
    const a = await feed('80.0000', { description: 'ZZQX HARBOR LUMBER', originalDescription: 'ZZQX HARBOR LUMBER' });
    await accept({ items: [{ id: a }] });
    const hist = async () => (await db.select().from(categorizationHistory).where(eq(categorizationHistory.tenantId, c.tenantId)))[0];
    for (let i = 0; i < 40 && !(await hist()); i++) await new Promise((r) => setTimeout(r, 50));
    expect((await hist())?.timesConfirmed).toBe(1);
    await undo({ feedItemIds: [a] });
    for (let i = 0; i < 40 && (await hist())?.timesOverridden !== 1; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await hist())).toMatchObject({ accountId: c.supplies, timesConfirmed: 1, timesOverridden: 1 });
  });

  it('a row categorized through PUT /categorize undoes too (every link path writes a record)', async () => {
    const a = await feed('90.0000');
    const r = await request('PUT', `${BASE}/${a}/categorize`, { accountId: c.repairs });
    expect(r.status).toBe(200);
    const u = await undo({ feedItemIds: [a] });
    expect(u.json.undone).toEqual([expect.objectContaining({ id: a, kind: 'post', entry: 'deleted' })]);
    expect((await item(a)).status).toBe('pending');
    expect((await undo({ feedItemIds: [randomUUID()] })).json.failures[0].code).toBe('FEED_ITEM_NOT_ACCEPTED');
  });
});

describe('GET /banking/feed: status=accepted and transferCandidate (Q-P26y)', () => {
  const list = async (query: string) => {
    const r = await request('GET', `${BASE}?${query}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json as { data: any[]; total: number };
  };
  const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

  it('status=accepted lists every categorized and matched row (entry voided included), paged, = /counts accepted', async () => {
    // A long history: 620 accepted rows (more than one 500-row page) among waiting and excluded ones.
    const base = { tenantId: c.tenantId, companyId: c.companyId, bankConnectionId: c.checkingConn, feedDate: '2026-07-01' };
    const rows = Array.from({ length: 620 }, (_, i) => ({
      ...base, amount: `${1000 + i}.00`, description: `ZZQX HIST ${i}`,
      status: (i % 2 === 0 ? 'categorized' : 'matched') as 'categorized' | 'matched',
      entryVoidedAt: i === 7 ? new Date() : null,
    }));
    await db.insert(bankFeedItems).values(rows);
    const waiting = await feed('21.0000');
    const assigned = await feed('22.0000', { status: 'assigned', assignedAccountId: c.supplies });
    const excluded = await feed('23.0000', { status: 'excluded' });

    const first = await list('status=accepted&limit=500&offset=0');
    const second = await list('status=accepted&limit=500&offset=500');
    expect(first.total).toBe(620);
    expect(second.total).toBe(620);
    expect(first.data).toHaveLength(500);
    expect(second.data).toHaveLength(120);
    const ids = new Set([...first.data, ...second.data].map((r) => r.id));
    expect(ids.size).toBe(620);
    for (const id of [waiting, assigned, excluded]) expect(ids.has(id)).toBe(false);
    expect([...first.data, ...second.data].every((r) => r.status === 'categorized' || r.status === 'matched')).toBe(true);
    expect([...first.data, ...second.data].filter((r) => r.entryVoided)).toHaveLength(1);

    const counts = await request('GET', `${BASE}/counts`);
    expect(counts.json.accepted).toBe(620);
    // Combines with the other filters as any status does.
    expect((await list('status=accepted&entryVoided=true')).total).toBe(1);
    // A stored status still lists only itself; an unknown one is refused.
    expect((await list('status=matched&limit=1')).total).toBe(310);
    expect((await request('GET', `${BASE}?status=done`)).status).toBe(400);
  });

  it('transferCandidate names the other side when exactly one waits; null for two, the same account, out of window, or not waiting', async () => {
    const checkingName = (await db.query.accounts.findFirst({ where: eq(accounts.id, c.checking) }))!.name;
    // One pair: out of checking, into savings a day later.
    const out = await feed('500.0000', { description: 'ZZQX ONLINE TRANSFER' });
    const inn = await feed('-500.0000', { bankConnectionId: c.savingsConn, feedDate: '2026-08-15' });
    // Two possible other sides: ambiguous on the out row, each in-row still has exactly one.
    const out2 = await feed('700.0000');
    const in2a = await feed('-700.0000', { bankConnectionId: c.savingsConn, feedDate: '2026-08-13' });
    const in2b = await feed('-700.0000', { bankConnectionId: c.savingsConn, feedDate: '2026-08-16' });
    // Same GL account (a refund on checking) and outside the 3-day window: no transfer.
    const same = await feed('300.0000');
    const sameBack = await feed('-300.0000');
    const far = await feed('400.0000');
    const farIn = await feed('-400.0000', { bankConnectionId: c.savingsConn, feedDate: '2026-08-18' });
    // An accepted row is never a transfer candidate, nor shows one.
    const done = await feed('900.0000', { status: 'categorized' });
    const doneTwin = await feed('-900.0000', { bankConnectionId: c.savingsConn });

    const rows = byId((await list('limit=500')).data);
    expect(rows[out].transferCandidate).toEqual({ feedItemId: inn, accountId: c.savings, accountName: 'ZZ Savings' });
    expect(rows[inn].transferCandidate).toEqual({ feedItemId: out, accountId: c.checking, accountName: checkingName });
    expect(rows[out].bucket).toBe('matches');
    expect(rows[out2].transferCandidate).toBeNull();
    expect(rows[out2].bucket).toBe('matches');
    expect(rows[in2a].transferCandidate).toMatchObject({ feedItemId: out2 });
    expect(rows[in2b].transferCandidate).toMatchObject({ feedItemId: out2 });
    for (const id of [same, sameBack, far, farIn, done, doneTwin]) expect(rows[id].transferCandidate, id).toBeNull();
    expect(rows[far].bucket).not.toBe('matches');

    // Once the other side stops waiting (here: excluded), no candidate is left.
    await db.update(bankFeedItems).set({ status: 'excluded' }).where(eq(bankFeedItems.id, inn));
    expect(byId((await list('limit=500')).data)[out].transferCandidate).toBeNull();
  });
});
