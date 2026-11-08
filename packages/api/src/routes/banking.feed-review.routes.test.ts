// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// P26 E2 (feed-match-v2, feed-idempotency-v1, feed-review-v1):
//   U-166 line-level matches (B2) and the U-136 sign fix; void of a linked
//         entry is allowed and flags the row "Entry voided" (Q-P26u, B4);
//         Review again;
//   U-172 payroll overlap per bank line, exact;
//   U-173 409 FEED_ITEM_NOT_PENDING, categorize on assigned rows, keys,
//         stuck-row recovery;
//   U-174 duplicate decisions, list fields and filters, /counts parity with
//         the list (S11), import Undo with removed duplicates (S4).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, transactions, journalLines, bankConnections, bankFeedItems,
  categorizationHistory, transactionClassificationState, bankImportBatches, idempotencyKeys, bankRules, conditionalRules,
} from '../db/schema/index.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import * as ledger from '../services/ledger.service.js';
import * as bankFeedService from '../services/bank-feed.service.js';
import * as importBatchService from '../services/bank-import/import-batch.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let userId = '';
let token = '';
let connectionId = '';
let savingsConnectionId = '';
let bankId = '';
let savingsId = '';
let supplies = '';
let wages = '';
let taxes = '';
let sales = '';

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...headers,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const key = () => ({ 'Idempotency-Key': crypto.randomUUID() });

async function feedItem(amount: string, extra: Partial<typeof bankFeedItems.$inferInsert> = {}) {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: connectionId, feedDate: '2026-04-15', amount,
    description: 'ZZQX LINE', originalDescription: 'ZZQX LINE', status: 'pending', ...extra,
  }).returning();
  return row!.id;
}

async function item(id: string) {
  return (await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) }))!;
}

/** A posted entry with the given lines (debit, credit as 4-decimal strings). */
async function entry(txnType: string, date: string, lines: Array<{ accountId: string; debit: string; credit: string }>, source?: string) {
  const total = lines.reduce((s, l) => s + Number(l.debit), 0).toFixed(4);
  const t = await ledger.postTransaction(tenantId, { txnType: txnType as never, txnDate: date, total, lines, ...(source ? { source } : {}) } as never,
    userId, companyId);
  const rows = await db.select().from(journalLines).where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, t.id)));
  return { id: t.id, lines: rows };
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Feed Review', slug: 'feed-review-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Feed Review Co', setupComplete: true }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `feed-review-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x', role: 'owner', displayName: 'Owner',
  }).returning();
  userId = u!.id;
  token = jwt.sign({ userId, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  savingsId = (await accountsService.create(tenantId, { name: 'Savings', accountType: 'asset', detailType: 'bank', accountNumber: '1020' })).id;
  supplies = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;
  wages = (await accountsService.create(tenantId, { name: 'Wages', accountType: 'expense', accountNumber: '6500' })).id;
  taxes = (await accountsService.create(tenantId, { name: 'Payroll taxes', accountType: 'expense', accountNumber: '6510' })).id;
  sales = (await accountsService.create(tenantId, { name: 'Sales', accountType: 'revenue', accountNumber: '4000' })).id;
  const [conn] = await db.insert(bankConnections).values({ tenantId, companyId, accountId: bankId, provider: 'manual' }).returning();
  connectionId = conn!.id;
  const [sav] = await db.insert(bankConnections).values({ tenantId, companyId, accountId: savingsId, provider: 'manual' }).returning();
  savingsConnectionId = sav!.id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/banking', bankingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  await new Promise((r) => setTimeout(r, 50));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tenantId));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankImportBatches).where(eq(bankImportBatches.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(bankRules).where(eq(bankRules.tenantId, tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

const base = '/api/v1/banking/feed';
const cat = (id: string, body: unknown, h: Record<string, string> = {}) => call('PUT', `${base}/${id}/categorize`, body, h);
const match = (id: string, body: unknown, h: Record<string, string> = {}) => call('PUT', `${base}/${id}/match`, body, h);
const candidates = async (id: string) => (await call('GET', `${base}/${id}/match-candidates`)).json.candidates as any[];

describe('P26 E2 capabilities', () => {
  it('advertises feed-match-v2, feed-idempotency-v1 and feed-review-v1', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['feed-match-v2', 'feed-idempotency-v1', 'feed-review-v1']));
  });
});

describe('line-level matches (U-166, B2)', () => {
  it('an expense of 250.00 is offered for money out 250.00, never for money in -250.00 (U-136 sign fix)', async () => {
    const e = await entry('expense', '2026-04-13', [
      { accountId: supplies, debit: '250.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '250.0000' },
    ]);
    const out = await feedItem('250.0000');
    const into = await feedItem('-250.0000');
    const c = await candidates(out);
    expect(c.map((x) => [x.id, x.journalLineId, x.amount])).toEqual([[e.id, e.lines.find((l) => l.accountId === bankId)!.id, '250.00']]);
    expect(await candidates(into)).toEqual([]);
    const list = (await call('GET', `${base}?limit=50`)).json.data as any[];
    expect(list.find((r) => r.id === out).matchCandidateCount).toBe(1);
    expect(list.find((r) => r.id === into).matchCandidateCount).toBe(0);
  });

  it('a deposit matches money in on its debit line; a cash-back deposit matches the bank line, not the total', async () => {
    // Deposit of 500.00 sales with 40.00 cash back: the bank gets 460.00.
    const e = await entry('deposit', '2026-04-14', [
      { accountId: bankId, debit: '460.0000', credit: '0' },
      { accountId: supplies, debit: '40.0000', credit: '0' },
      { accountId: sales, debit: '0', credit: '500.0000' },
    ]);
    const into = await feedItem('-460.0000');
    expect((await candidates(into)).map((x) => x.id)).toEqual([e.id]);
    expect(await candidates(await feedItem('-500.0000'))).toEqual([]);
    const r = await match(into, { transactionId: e.id });
    expect(r.status).toBe(200);
    const it = await item(into);
    expect([it.status, it.matchedTransactionId, it.matchedJournalLineId]).toEqual(['matched', e.id, e.lines.find((l) => l.accountId === bankId)!.id]);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityId, into)));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('feed-match.payroll-line: 7,412.38 and 2,104.55 each match their own line; LINE_REQUIRED when two lines fit', async () => {
    const pr = await entry('journal_entry', '2026-04-15', [
      { accountId: wages, debit: '9000.0000', credit: '0' },
      { accountId: taxes, debit: '516.93', credit: '0' },
      { accountId: bankId, debit: '0', credit: '7412.3800' },
      { accountId: bankId, debit: '0', credit: '2104.5500' },
    ], 'payroll_import');
    const net = await feedItem('7412.3800');
    const tax = await feedItem('2104.5500', { feedDate: '2026-04-16' });
    const overNet = (await call('GET', `${base}/${net}/payroll-overlap`)).json.overlaps;
    expect(overNet).toEqual([expect.objectContaining({ txnId: pr.id, amount: '7412.38',
      journalLineId: pr.lines.find((l) => l.credit === '7412.3800')!.id })]);
    // Money in is never a payroll overlap.
    expect((await call('GET', `${base}/${await feedItem('-7412.3800')}/payroll-overlap`)).json.overlaps).toEqual([]);

    expect((await match(net, { transactionId: pr.id })).status).toBe(200);
    expect((await match(tax, { transactionId: pr.id })).status).toBe(200);
    expect((await item(net)).matchedJournalLineId).toBe(pr.lines.find((l) => l.credit === '7412.3800')!.id);
    expect((await item(tax)).matchedJournalLineId).toBe(pr.lines.find((l) => l.credit === '2104.5500')!.id);
    // Held lines are no longer offered.
    expect((await call('GET', `${base}/${await feedItem('2104.5500')}/payroll-overlap`)).json.overlaps).toEqual([]);

    // Two equal bank lines: the caller must name one.
    const twin = await entry('journal_entry', '2026-04-15', [
      { accountId: wages, debit: '200.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '100.0000' },
      { accountId: bankId, debit: '0', credit: '100.0000' },
    ], 'payroll_import');
    const a = await feedItem('100.0000');
    const r = await match(a, { transactionId: twin.id });
    expect([r.status, r.json.error.code]).toEqual([400, 'LINE_REQUIRED']);
    const lineId = twin.lines.filter((l) => l.accountId === bankId)[1]!.id;
    expect((await match(a, { transactionId: twin.id, journalLineId: lineId })).status).toBe(200);
    const b = await feedItem('100.0000');
    // The other line is inferred now; naming the held one is 409.
    const held = await match(b, { transactionId: twin.id, journalLineId: lineId });
    expect([held.status, held.json.error.code]).toEqual([409, 'LINE_ALREADY_MATCHED']);
    expect((await match(b, { transactionId: twin.id })).status).toBe(200);
  });

  it('MATCH_MISMATCH names the field; a transfer matches the side imported later', async () => {
    const e = await entry('expense', '2026-04-13', [
      { accountId: supplies, debit: '80.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '80.0000' },
    ]);
    const wrongAmount = await feedItem('81.0000');
    let r = await match(wrongAmount, { transactionId: e.id });
    expect([r.status, r.json.error.code, r.json.error.details?.field]).toEqual([400, 'MATCH_MISMATCH', 'amount']);
    const onSavings = await feedItem('80.0000', { bankConnectionId: savingsConnectionId });
    r = await match(onSavings, { transactionId: e.id });
    expect([r.status, r.json.error.details?.field]).toEqual([400, 'account']);
    r = await match(wrongAmount, { transactionId: crypto.randomUUID() });
    expect([r.status, r.json.error.details?.field]).toEqual([400, 'transactionId']);

    // Checking -> savings 500.00, posted before the savings file arrives.
    const tr = await entry('transfer', '2026-04-15', [
      { accountId: savingsId, debit: '500.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '500.0000' },
    ]);
    const out = await feedItem('500.0000');
    const into = await feedItem('-500.0000', { bankConnectionId: savingsConnectionId, feedDate: '2026-04-16' });
    expect((await match(out, { transactionId: tr.id })).status).toBe(200);
    expect((await candidates(into)).map((x) => x.id)).toEqual([tr.id]);
    expect((await match(into, { transactionId: tr.id })).status).toBe(200);
  });

  it('an item matched before migration 0265 (no line) still holds its whole entry', async () => {
    const e = await entry('expense', '2026-04-13', [
      { accountId: supplies, debit: '60.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '60.0000' },
    ]);
    await feedItem('60.0000', { status: 'matched', matchedTransactionId: e.id });
    expect(await candidates(await feedItem('60.0000'))).toEqual([]);
  });

  it('feed-match.delete-race: a matched entry can not be deleted; a deleted or void entry can not be matched', async () => {
    const e = await entry('expense', '2026-04-13', [
      { accountId: supplies, debit: '70.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '70.0000' },
    ]);
    const a = await feedItem('70.0000');
    expect((await match(a, { transactionId: e.id })).status).toBe(200);
    await expect(ledger.deleteTransaction(tenantId, e.id, { companyId, userId } as never)).rejects.toBeTruthy();
    const e2 = await entry('expense', '2026-04-13', [
      { accountId: supplies, debit: '71.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '71.0000' },
    ]);
    await ledger.voidTransaction(tenantId, e2.id, 'test', userId, { companyId });
    const b = await feedItem('71.0000');
    expect(await candidates(b)).toEqual([]);
    const r = await match(b, { transactionId: e2.id });
    expect([r.status, r.json.error.details?.field]).toEqual([400, 'transactionId']);
  });
});

describe('voiding a feed-linked entry (Q-P26u, B4) and Review again', () => {
  it('feed-void.linked: the void succeeds, the rows are flagged, listed, counted and audited; Review again restores', async () => {
    const exp = await feedItem('84.1700');
    expect((await cat(exp, { accountId: supplies })).status).toBe(200);
    const posted = await item(exp);
    expect(posted.matchedJournalLineId).toBeTruthy();

    // A transfer matched from both sides.
    const tr = await entry('transfer', '2026-04-15', [
      { accountId: savingsId, debit: '500.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '500.0000' },
    ]);
    const out = await feedItem('500.0000');
    const into = await feedItem('-500.0000', { bankConnectionId: savingsConnectionId });
    await match(out, { transactionId: tr.id });
    await match(into, { transactionId: tr.id });

    await ledger.voidTransaction(tenantId, posted.matchedTransactionId!, 'owner voided', userId, { companyId });
    await ledger.voidTransaction(tenantId, tr.id, 'owner voided', userId, { companyId });
    for (const id of [exp, out, into]) {
      const it = await item(id);
      expect(it.entryVoidedAt).toBeTruthy();
      expect(['categorized', 'matched']).toContain(it.status);
      expect(it.matchedTransactionId).toBeTruthy();
    }
    const flaggedAudit = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_feed'),
      sql`${auditLog.afterData}::text LIKE '%entry_voided%'`));
    expect(flaggedAudit.map((a) => a.entityId).sort()).toEqual([exp, out, into].sort());

    const listed = (await call('GET', `${base}?entryVoided=true`)).json;
    expect(listed.total).toBe(3);
    expect(listed.data.every((r: any) => r.entryVoided === true && r.bucket === null)).toBe(true);
    const counts = (await call('GET', `${base}/counts`)).json;
    expect(counts).toMatchObject({ entryVoided: 3, accepted: 3, waiting: 0 });

    // Review again on a row that isn't voided: 409.
    const plain = await feedItem('10.0000');
    let r = await call('POST', `${base}/${plain}/review-again`, {}, key());
    expect([r.status, r.json.error.code]).toEqual([409, 'ENTRY_NOT_VOIDED']);
    // A key is required.
    r = await call('POST', `${base}/${exp}/review-again`, {});
    expect([r.status, r.json.error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);

    const k = key();
    r = await call('POST', `${base}/${exp}/review-again`, {}, k);
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({ status: 'pending', matchedTransactionId: null, matchedJournalLineId: null, entryVoidedAt: null });
    const replay = await call('POST', `${base}/${exp}/review-again`, {}, k);
    expect([replay.status, replay.headers['idempotent-replayed']]).toEqual([200, 'true']);
    expect(replay.json).toEqual(r.json);
    // The reviewed row and the plain one wait now.
    expect((await call('GET', `${base}/counts`)).json).toMatchObject({ entryVoided: 2, waiting: 2 });
    // The void entry stays void.
    const voided = await db.query.transactions.findFirst({ where: eq(transactions.id, posted.matchedTransactionId!) });
    expect(voided!.status).toBe('void');
  });

  it('import Undo sees an entry-voided row as used until it is reviewed again', async () => {
    const [batch] = await db.insert(bankImportBatches).values({
      tenantId, companyId, bankConnectionId: connectionId, accountId: bankId, format: 'csv', fileName: 'x.csv',
      sourceFileSha256: 'a'.repeat(64), postProcessing: 'done',
    }).returning();
    const id = await feedItem('33.0000', { importBatchId: batch!.id, sourceLine: 2 });
    expect((await cat(id, { accountId: supplies })).status).toBe(200);
    await ledger.voidTransaction(tenantId, (await item(id)).matchedTransactionId!, 'void', userId, { companyId });
    const actor = { tenantId, companyId, userId };
    await expect(importBatchService.undoBatch(actor, batch!.id, false)).rejects.toMatchObject({ code: 'rows_already_used' });
    expect((await call('POST', `${base}/${id}/review-again`, {}, key())).status).toBe(200);
    const res = await importBatchService.undoBatch(actor, batch!.id, false);
    expect(res.removed).toBe(1);
  });
});

describe('feed states and keys (U-173)', () => {
  it('409 FEED_ITEM_NOT_PENDING {status} on categorize, approve, assign, match, exclude, unexclude', async () => {
    const id = await feedItem('12.0000');
    expect((await cat(id, { accountId: supplies })).status).toBe(200);
    const e = (await item(id)).matchedTransactionId!;
    const checks = [
      await cat(id, { accountId: supplies }),
      await call('POST', `${base}/${id}/approve`, {}),
      await call('PUT', `${base}/${id}/assign`, { accountId: supplies }),
      await match(id, { transactionId: e }),
      await call('PUT', `${base}/${id}/exclude`),
      await call('PUT', `${base}/${id}/unexclude`),
    ];
    for (const r of checks) {
      expect([r.status, r.json.error.code, r.json.error.details?.status]).toEqual([409, 'FEED_ITEM_NOT_PENDING', 'categorized']);
    }
    // A posted row can't be excluded any more (the entry would be stranded).
    expect((await item(id)).status).toBe('categorized');
  });

  it('categorize takes an assigned row and posts the given account', async () => {
    const id = await feedItem('15.0000');
    expect((await call('PUT', `${base}/${id}/assign`, { accountId: sales })).status).toBe(200);
    expect((await cat(id, { accountId: supplies })).status).toBe(200);
    const it = await item(id);
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, it.matchedTransactionId!));
    expect(lines.map((l) => l.accountId).sort()).toEqual([bankId, supplies].sort());
  });

  it('a failed posting leaves the row as it was (the claim is inside the posting transaction)', async () => {
    const id = await feedItem('16.0000');
    const r = await cat(id, { accountId: crypto.randomUUID() });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await item(id)).status).toBe('pending');
  });

  it('Idempotency-Key on categorize: a retry replays the same body and posts once', async () => {
    const id = await feedItem('17.0000');
    const k = key();
    const first = await cat(id, { accountId: supplies }, k);
    const again = await cat(id, { accountId: supplies }, k);
    expect(first.status).toBe(200);
    expect([again.status, again.headers['idempotent-replayed']]).toEqual([200, 'true']);
    expect(again.json).toEqual(first.json);
    const posted = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.sourceId, id)));
    expect(posted).toHaveLength(1);
  });

  it('on engine start, rows stuck in categorizing for more than 5 minutes go back', async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const a = await feedItem('1.0000', { status: 'categorizing', updatedAt: old });
    const b = await feedItem('2.0000', { status: 'categorizing', updatedAt: old, assignedAccountId: supplies, assignedAt: old });
    const fresh = await feedItem('3.0000', { status: 'categorizing' });
    await bankFeedService.recoverStuckCategorizing();
    expect([(await item(a)).status, (await item(b)).status, (await item(fresh)).status]).toEqual(['pending', 'assigned', 'categorizing']);
  });
});

describe('review buckets, duplicates and counts (U-174)', () => {
  it('Keep both / Remove this one; NOT_A_POSSIBLE_DUPLICATE; the list carries duplicateOf', async () => {
    const orig = await feedItem('25.0000', { description: 'COFFEE' });
    const dupA = await feedItem('25.0000', { possibleDuplicate: true, possibleDuplicateOf: orig });
    const dupB = await feedItem('25.0000', { possibleDuplicate: true, possibleDuplicateOf: orig });
    const rows = (await call('GET', `${base}?possibleDuplicate=true`)).json;
    expect(rows.total).toBe(2);
    expect(rows.data[0].duplicateOf).toMatchObject({ id: orig, date: '2026-04-15', amount: '25.0000', description: 'COFFEE', status: 'pending' });
    expect(rows.data.every((r: any) => r.bucket === 'review')).toBe(true);

    let r = await call('POST', `${base}/${dupA}/duplicate`, { decision: 'keep' });
    expect([r.status, r.json.error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    r = await call('POST', `${base}/${dupA}/duplicate`, { decision: 'keep' }, key());
    expect(r.status).toBe(200);
    expect((await item(dupA)).possibleDuplicate).toBe(false);
    r = await call('POST', `${base}/${dupB}/duplicate`, { decision: 'remove' }, key());
    expect(r.status).toBe(200);
    const removed = await item(dupB);
    expect([removed.status, removed.exclusionReason, removed.possibleDuplicate]).toEqual(['excluded', 'duplicate', true]);
    r = await call('POST', `${base}/${dupA}/duplicate`, { decision: 'remove' }, key());
    expect([r.status, r.json.error.code]).toEqual([409, 'NOT_A_POSSIBLE_DUPLICATE']);
    // Restore brings it back undecided.
    expect((await call('PUT', `${base}/${dupB}/unexclude`)).status).toBe(200);
    const back = await item(dupB);
    expect([back.status, back.exclusionReason, back.possibleDuplicate]).toEqual(['pending', null, true]);
  });

  it('import-undo.removed-duplicates: rows removed as duplicates do not block the undo', async () => {
    const [batch] = await db.insert(bankImportBatches).values({
      tenantId, companyId, bankConnectionId: connectionId, accountId: bankId, format: 'csv', fileName: 'twice.csv',
      sourceFileSha256: 'b'.repeat(64), postProcessing: 'done',
    }).returning();
    const orig = await feedItem('40.0000');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await feedItem('40.0000', { importBatchId: batch!.id, sourceLine: i + 2, possibleDuplicate: true, possibleDuplicateOf: orig }));
    }
    for (const id of ids) expect((await call('POST', `${base}/${id}/duplicate`, { decision: 'remove' }, key())).status).toBe(200);
    const res = await importBatchService.undoBatch({ tenantId, companyId, userId }, batch!.id, false);
    expect([res.removed, res.kept]).toEqual([3, 0]);
  });

  it('bucket precedence (S11) and feed-counts.parity: each count equals the list total', async () => {
    // Possible duplicate with a match candidate: review, not matches.
    await entry('expense', '2026-04-14', [
      { accountId: supplies, debit: '90.0000', credit: '0' },
      { accountId: bankId, debit: '0', credit: '90.0000' },
    ]);
    const orig = await feedItem('5.0000');
    const dupWithMatch = await feedItem('90.0000', { possibleDuplicate: true, possibleDuplicateOf: orig });
    const withMatch = await feedItem('90.0000');
    const ruleRow = await feedItem('11.0000', { suggestedAccountId: supplies, matchType: 'rule', confidenceScore: '1.00' });
    const aiHigh = await feedItem('12.0000', { suggestedAccountId: supplies, matchType: 'exact', confidenceScore: '0.85' });
    const aiLow = await feedItem('13.0000', { suggestedAccountId: supplies, matchType: 'fuzzy', confidenceScore: '0.79' });
    const marked = await feedItem('14.0000', { suggestedAccountId: supplies, matchType: null, confidenceScore: '0.00' });
    const noAccount = await feedItem('15.0000');
    const badSplit = await feedItem('84.1700', {
      suggestedAccountId: supplies, matchType: 'rule', confidenceScore: '1.00',
      splitsConfig: { kind: 'fixed', splits: [{ accountId: supplies, amount: '50.00' }, { accountId: wages, amount: '30.00' }] },
    });
    const goodSplit = await feedItem('80.0000', {
      suggestedAccountId: supplies, matchType: 'rule', confidenceScore: '1.00',
      splitsConfig: { kind: 'fixed', splits: [{ accountId: supplies, amount: '50.00' }, { accountId: wages, amount: '30.00' }] },
    });
    const assigned = await feedItem('16.0000', { status: 'assigned', assignedAccountId: supplies, assignedAt: new Date() });
    await feedItem('17.0000', { status: 'excluded' });

    const list = (await call('GET', `${base}?limit=100`)).json.data as any[];
    const bucketOf = (id: string) => list.find((r) => r.id === id).bucket;
    expect(bucketOf(dupWithMatch)).toBe('review');
    expect(bucketOf(withMatch)).toBe('matches');
    expect(bucketOf(ruleRow)).toBe('ready');
    expect(bucketOf(aiHigh)).toBe('ready');
    expect(bucketOf(aiLow)).toBe('review');
    expect(bucketOf(marked)).toBe('review');
    expect(bucketOf(noAccount)).toBe('review');
    expect(bucketOf(badSplit)).toBe('review');
    expect(bucketOf(goodSplit)).toBe('ready');
    expect(bucketOf(assigned)).toBe('ready');

    const counts = (await call('GET', `${base}/counts`)).json;
    for (const b of ['ready', 'review', 'matches'] as const) {
      expect((await call('GET', `${base}?bucket=${b}&limit=1`)).json.total).toBe(counts[b]);
    }
    expect((await call('GET', `${base}?status=excluded&limit=1`)).json.total).toBe(counts.excluded);
    expect((await call('GET', `${base}?possibleDuplicate=true&limit=1`)).json.total).toBe(counts.possibleDuplicate);
    expect(counts.waiting).toBe(counts.ready + counts.review + counts.matches);
    expect(counts).toMatchObject({ matches: 1, excluded: 1, possibleDuplicate: 1 });
  });

  it('feed-counts.parity on 20,000 rows', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({
      tenantId, companyId, bankConnectionId: connectionId, feedDate: '2026-03-01', amount: `${(i % 997) + 1}.${String(i % 100).padStart(2, '0')}`,
      description: 'BULK', status: i % 10 === 0 ? 'excluded' : 'pending',
      suggestedAccountId: i % 3 === 0 ? supplies : null, matchType: i % 6 === 0 ? 'rule' : null,
      confidenceScore: i % 3 === 0 ? (i % 2 === 0 ? '1.00' : '0.50') : null, possibleDuplicate: i % 50 === 0,
    }));
    for (let i = 0; i < rows.length; i += 2000) await db.insert(bankFeedItems).values(rows.slice(i, i + 2000));
    const started = Date.now();
    const counts = (await call('GET', `${base}/counts`)).json;
    const elapsed = Date.now() - started;
    let sum = 0;
    for (const b of ['ready', 'review', 'matches'] as const) {
      const total = (await call('GET', `${base}?bucket=${b}&limit=1`)).json.total;
      expect(total).toBe(counts[b]);
      sum += total;
    }
    expect(sum).toBe(counts.waiting);
    expect(counts.waiting + counts.excluded).toBe(20_000);
    expect(elapsed).toBeLessThan(20_000);
  }, 120_000);

  it('rows carry suggestedRule for the rule that staged the suggestion', async () => {
    const [rule] = await db.insert(bankRules).values({
      tenantId, name: 'ZZQX supplies', descriptionContains: 'ZZQX', assignAccountId: supplies, autoConfirm: true, isActive: true,
    } as never).returning();
    const id = await feedItem('19.0000', { suggestedAccountId: supplies, matchType: 'rule', suggestedRuleId: rule!.id, suggestedRuleKind: 'legacy' });
    const row = (await call('GET', `${base}?limit=50`)).json.data.find((r: any) => r.id === id);
    expect(row.suggestedRule).toMatchObject({ id: rule!.id, kind: 'legacy', name: 'ZZQX supplies', autoAccept: true });
    expect(row.suggestedRule.updatedAt).toBeTruthy();
  });
});
