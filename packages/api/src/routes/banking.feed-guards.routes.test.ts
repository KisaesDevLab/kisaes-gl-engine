// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// feed-guards-v1 (U-200, ClientLedger PR-5 S3, N1, N2): guards for callers
// that send straight to the engine (the A11 MCP bookkeeper, MyBooks Online):
//   N1  POST /feed/accept transferWindowDays for the has_match transfer signal
//   N2  categorize / approve / match refuse a possible duplicate until Keep
//   S3  POST /feed/:id/transfer {toAccountId} asks first (FEED_ITEM_HAS_MATCH, force)
// The harness is the one of banking.feed-accept-undo.routes.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
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
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
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
/** A check written in the books: money out of checking. */
async function check(amount: string, date = '2026-08-12') {
  const t = await ledger.postTransaction(c.tenantId, {
    txnType: 'expense', txnDate: date, total: amount,
    lines: [{ accountId: c.repairs, debit: amount, credit: '0' }, { accountId: c.checking, debit: '0', credit: amount }],
  }, c.userId, c.companyId);
  return t.id;
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

describe('feed-guards-v1 (U-200, ClientLedger PR-5)', () => {
  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('feed-guards-v1');
    expect(DESKTOP_CAPABILITIES).toContain('feed-entry-changed-v1');
  });

  it('N1: POST /feed/accept transferWindowDays holds both sides of a transfer 5 days apart; the default 3 does not', async () => {
    // Money out of checking on 08-14, money in to savings on 08-19.
    const out = await feed('500.00');
    await feed('-500.00', { bankConnectionId: c.savingsConn, feedDate: '2026-08-19' });
    const wide = await accept({ items: [{ id: out }], transferWindowDays: 5 });
    expect(wide.status).toBe(200);
    expect(wide.json).toMatchObject({ posted: 0, skipped: [{ id: out, reason: 'has_match' }] });
    expect((await item(out)).status).toBe('pending');
    const bad = await accept({ items: [{ id: out }], transferWindowDays: 11 });
    expect(bad.status).toBe(400);
    const narrow = await accept({ items: [{ id: out }] });
    expect(narrow.json).toMatchObject({ posted: 1, skipped: [] });
  });

  it('N2: categorize, approve and match refuse a possible duplicate (409) until Keep; bulk lists it in failures', async () => {
    const original = await feed('41.17');
    const dup = await feed('41.17', { possibleDuplicate: true, possibleDuplicateOf: original });
    const cat = await request('PUT', `${BASE}/${dup}/categorize`, { accountId: c.supplies });
    expect(cat.status).toBe(409);
    expect(cat.json.error).toMatchObject({ code: 'FEED_ITEM_POSSIBLE_DUPLICATE', details: { id: dup, possibleDuplicateOf: original } });

    const staged = await feed('41.18', { status: 'assigned', assignedAccountId: c.supplies, assignedAt: new Date(), possibleDuplicate: true });
    const appr = await request('POST', `${BASE}/${staged}/approve`);
    expect(appr.status).toBe(409);
    expect(appr.json.error.code).toBe('FEED_ITEM_POSSIBLE_DUPLICATE');

    const entry = await check('41.19', '2026-08-13');
    const lookAlike = await feed('41.19', { possibleDuplicate: true });
    const m = await request('PUT', `${BASE}/${lookAlike}/match`, { transactionId: entry });
    expect(m.status).toBe(409);
    expect(m.json.error.code).toBe('FEED_ITEM_POSSIBLE_DUPLICATE');

    const bulk = await request('POST', `${BASE}/bulk-categorize`, { feedItemIds: [dup], accountId: c.supplies });
    expect(bulk.status).toBe(200);
    expect(bulk.json.failures).toEqual([expect.objectContaining({ id: dup, code: 'FEED_ITEM_POSSIBLE_DUPLICATE' })]);
    // Nothing was posted.
    expect((await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId))).map((t) => t.id)).toEqual([entry]);

    // Keep (the acknowledge the transfer and deposit routes already use) lets each go through.
    for (const id of [dup, staged, lookAlike]) {
      expect((await keyed(`${BASE}/${id}/duplicate`, { decision: 'keep' })).status).toBe(200);
    }
    expect((await request('PUT', `${BASE}/${dup}/categorize`, { accountId: c.supplies })).status).toBe(200);
    expect((await request('POST', `${BASE}/${staged}/approve`)).status).toBe(200);
    expect((await request('PUT', `${BASE}/${lookAlike}/match`, { transactionId: entry })).status).toBe(200);
  });

  it('S3: a transfer to an account of a line that matches an entry already in the books is 409 FEED_ITEM_HAS_MATCH unless force', async () => {
    // The transfer was recorded from the other account's file: 500.00 out of checking is already in the books.
    const recorded = await ledger.postTransaction(c.tenantId, {
      txnType: 'transfer', txnDate: '2026-08-14', total: '500.0000',
      lines: [{ accountId: c.savings, debit: '500.0000', credit: '0' }, { accountId: c.checking, debit: '0', credit: '500.0000' }],
    }, c.userId, c.companyId);
    const line = await feed('500.00');
    const refused = await keyed(`${BASE}/${line}/transfer`, { toAccountId: c.savings });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('FEED_ITEM_HAS_MATCH');
    expect(refused.json.error.details).toMatchObject({
      id: line, candidates: [{ transactionId: recorded.id, txnType: 'transfer', txnDate: '2026-08-14' }],
    });
    expect(refused.json.error.details.candidates[0].journalLineId).toEqual(expect.any(String));
    expect((await item(line)).status).toBe('pending');
    expect((await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId)))).toHaveLength(1);

    const forced = await keyed(`${BASE}/${line}/transfer`, { toAccountId: c.savings, force: true });
    expect(forced.status).toBe(200);
    expect((await item(line)).status).toBe('matched');

    // A line with nothing to match transfers without force, as before.
    const other = await feed('612.34');
    expect((await keyed(`${BASE}/${other}/transfer`, { toAccountId: c.savings })).status).toBe(200);
  });
});
