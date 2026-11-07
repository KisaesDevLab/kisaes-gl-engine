// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-06 bank-import-batch-v1 over HTTP: dry run vs commit, Idempotency-Key
// rules and replay (also over the 512 KB stored-body cap), re-import adds
// nothing (FITID and row keys), repeated and reused FITIDs, changed rows
// (replace / add), closed-period flag, balance check (bank, both card
// conventions, likelyInBooks), undo, post-processing without AI and
// without posting, concurrency, identities, limits and permissions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, bankConnections, bankFeedItems, bankRules,
  bankImportBatches, bankConnectionIdentities, bankLinkKeys, transactions, journalLines, transactionClassificationState, categorizationHistory,
  idempotencyKeys,
} from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as accountsService from '../services/accounts.service.js';
import * as ledger from '../services/ledger.service.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import * as importBatchService from '../services/bank-import/import-batch.service.js';
import { accountKeyHash, companyLinkKey } from '../services/bank-import/link-key.js';

const aiCalls = vi.hoisted(() => ({ batch: 0, suggest: 0 }));
vi.mock('../services/ai-categorization.service.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../services/ai-categorization.service.js')>();
  return { ...m, categorizeFeedItemsBatch: (...args: Parameters<typeof m.categorizeFeedItemsBatch>) => { aiCalls.batch++; return m.categorizeFeedItemsBatch(...args); } };
});
vi.mock('../services/categorization-ai.service.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../services/categorization-ai.service.js')>();
  return { ...m, suggestForBatch: (...args: Parameters<typeof m.suggestForBatch>) => { aiCalls.suggest++; return m.suggestForBatch(...args); } };
});

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let ownerId = '';
let token = '';
let readonlyToken = '';
let bankId = '';
let cardId = '';
let expenseId = '';

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function call(method: string, path: string, body?: unknown, opts: { key?: string; token?: string; company?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token ?? token}`,
        ...(opts.key ? { 'Idempotency-Key': opts.key } : {}),
        ...(opts.company ? { 'X-Company-Id': opts.company } : {}),
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

type Row = { line: number; date: string; amount: string; description: string; fitid?: string; checkNumber?: number; include?: boolean; changedAction?: 'replace' | 'add'; memo?: string };

function batch(rows: Row[], extra: Record<string, unknown> = {}) {
  return {
    accountId: bankId, format: 'qfx', fileName: 'operating.qfx', sourceFileSha256: 'a'.repeat(64), sectionIndex: 0,
    sectionStart: null, sectionEnd: null, amountsFlipped: false, dryRun: false, rows, ...extra,
  };
}

const commit = (body: unknown, key = randomUUID(), opts: { company?: string; token?: string } = {}) =>
  call('POST', '/api/v1/banking/feed/import-batch', body, { key, ...opts });
const preview = (body: Record<string, unknown>, opts: { company?: string; token?: string } = {}) =>
  call('POST', '/api/v1/banking/feed/import-batch', { ...body, dryRun: true }, opts);
const lookup = (body: Record<string, unknown>, opts: { company?: string; token?: string } = {}) =>
  call('POST', '/api/v1/banking/connections/lookup', body, opts);

async function feedCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM bank_feed_items WHERE tenant_id = ${tenantId}`);
  return (r.rows[0] as { n: number }).n;
}

async function waitPostProcessing(batchId: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const [b] = await db.select({ p: bankImportBatches.postProcessing }).from(bankImportBatches).where(eq(bankImportBatches.id, batchId));
    if (b && b.p !== 'scheduled') return b.p;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('post-processing did not finish');
}

beforeEach(async () => {
  const reg = await authService.register({
    email: `import-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Owner', companyName: 'Import Batch Co',
  });
  tenantId = reg.user.tenantId;
  ownerId = reg.user.id;
  token = reg.tokens.accessToken;
  const [co] = await db.select().from(companies).where(eq(companies.tenantId, tenantId));
  companyId = co!.id;
  await db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, companyId));
  bankId = (await accountsService.create(tenantId, { name: 'Import Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1091' })).id;
  cardId = (await accountsService.create(tenantId, { name: 'Import Card', accountType: 'liability', detailType: 'credit_card', accountNumber: '2091' })).id;
  expenseId = (await accountsService.create(tenantId, { name: 'Import Supplies', accountType: 'expense', accountNumber: '6091' })).id;

  const [ro] = await db.insert(users).values({
    tenantId, email: `ro-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x', displayName: 'Readonly', role: 'readonly',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: ro!.id, tenantId, role: 'readonly' });
  readonlyToken = (await authService.issueSession({ userId: ro!.id, tenantId, role: 'readonly', email: ro!.email } as never)).accessToken;

  aiCalls.batch = 0;
  aiCalls.suggest = 0;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/banking', bankingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  // Let detached post-processing finish before the rows go.
  const scheduled = await db.select({ id: bankImportBatches.id }).from(bankImportBatches)
    .where(and(eq(bankImportBatches.tenantId, tenantId), eq(bankImportBatches.postProcessing, 'scheduled')));
  for (const b of scheduled) await waitPostProcessing(b.id).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnectionIdentities).where(eq(bankConnectionIdentities.tenantId, tenantId));
  await db.delete(bankLinkKeys).where(eq(bankLinkKeys.tenantId, tenantId));
  await db.delete(bankImportBatches).where(eq(bankImportBatches.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(bankRules).where(eq(bankRules.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId));
  for (const u of staff) await db.delete(sessions).where(eq(sessions.userId, u.id));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

const OFX: Row[] = [
  { line: 10, date: '2026-11-01', amount: '45.10', description: 'COFFEE CO', fitid: 'T-1' },
  { line: 20, date: '2026-11-02', amount: '-2500.00', description: 'PAYROLL DEPOSIT', fitid: 'T-2' },
  { line: 30, date: '2026-11-03', amount: '0.01', description: 'INTEREST ADJ', fitid: 'T-3' },
];
const CSV: Row[] = [
  { line: 2, date: '2026-11-05', amount: '12.00', description: 'Parking Garage' },
  { line: 3, date: '2026-11-05', amount: '12.00', description: 'Parking Garage' },
  { line: 4, date: '2026-11-06', amount: '-999999999999.99', description: 'BIG DEPOSIT' },
];

describe('bank-import-batch-v1', () => {
  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('bank-import-batch-v1');
  });

  it('a dry run changes nothing and takes no Idempotency-Key', async () => {
    const counts = async () => {
      const r = await db.execute(sql`SELECT
        (SELECT count(*) FROM bank_import_batches WHERE tenant_id = ${tenantId})::int AS b,
        (SELECT count(*) FROM bank_feed_items WHERE tenant_id = ${tenantId})::int AS i,
        (SELECT count(*) FROM bank_connections WHERE tenant_id = ${tenantId})::int AS c,
        (SELECT count(*) FROM bank_connection_identities WHERE tenant_id = ${tenantId})::int AS d,
        (SELECT count(*) FROM bank_link_keys WHERE tenant_id = ${tenantId})::int AS k,
        (SELECT count(*) FROM audit_log WHERE tenant_id = ${tenantId})::int AS a`);
      return r.rows[0];
    };
    const before = await counts();
    const r = await preview(batch(OFX, { bankIdentity: { bankId: '021000021', acctId: '000123456789' } }));
    expect(r.status).toBe(200);
    expect(r.json.batchId).toBeUndefined();
    expect(r.json.rows.map((x: any) => x.status)).toEqual(['new', 'new', 'new']);
    expect(r.json.counts).toMatchObject({ inFile: 3, new: 3, inserted: 0 });
    expect(r.json.insertedTotal).toBe('0.00');
    expect(await counts()).toEqual(before);
    const keyed = await call('POST', '/api/v1/banking/feed/import-batch', batch(OFX, { dryRun: true }), { key: randomUUID() });
    expect(keyed.status).toBe(400);
    expect(keyed.json.error.code).toBe('IDEMPOTENCY_KEY_NOT_ALLOWED');
  });

  it('a commit needs a key, inserts, records and audits; re-importing adds 0 (FITID and row keys)', async () => {
    const noKey = await call('POST', '/api/v1/banking/feed/import-batch', batch(OFX));
    expect(noKey.status).toBe(400);
    expect(noKey.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const first = await commit(batch(OFX));
    expect(first.status).toBe(200);
    expect(first.json.batchId).toBeTruthy();
    expect(first.json.counts).toMatchObject({ inFile: 3, new: 3, inserted: 3 });
    expect(first.json.insertedTotal).toBe('-2454.89');
    expect(first.json.insertedItemIds).toHaveLength(3);
    expect(await waitPostProcessing(first.json.batchId)).toBe('done');
    const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    expect(items.map((i) => i.amount).sort()).toEqual(['-2500.0000', '0.0100', '45.1000']);
    expect(items.every((i) => i.status === 'pending' && i.dedupeVersion === 1 && i.rowKey && i.dedupeKey)).toBe(true);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_import_batch')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.afterData).not.toContain('COFFEE');

    const again = await commit(batch(OFX));
    expect(again.json.counts).toMatchObject({ duplicate: 3, inserted: 0 });
    expect(again.json.rows.every((r: any) => r.reason === 'same_bank_id')).toBe(true);
    expect(again.json.sameFileImportedAt).toBeTruthy();
    expect(again.json.postProcessing).toBe('done');
    expect(await feedCount()).toBe(3);
    // A commit that inserts nothing still records a batch and an audit row.
    expect(await db.select().from(bankImportBatches).where(eq(bankImportBatches.tenantId, tenantId))).toHaveLength(2);

    const csv = batch(CSV, { format: 'csv', fileName: 'export.csv', sourceFileSha256: 'c'.repeat(64) });
    const c1 = await commit(csv);
    expect(c1.json.counts).toMatchObject({ new: 3, inserted: 3 });
    const c2 = await commit(csv);
    expect(c2.json.rows.map((r: any) => [r.status, r.reason])).toEqual([['duplicate', 'same_row'], ['duplicate', 'same_row'], ['duplicate', 'same_row']]);
    expect(await feedCount()).toBe(6);
  });

  it('a retry with the key replays the stored result; over 512 KB it replays from the batch, identical', async () => {
    const key = randomUUID();
    const body = batch(OFX);
    const a = await commit(body, key);
    const b = await commit(body, key);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    // Identical apart from the live post-processing state.
    expect({ ...b.json, postProcessing: 'x' }).toEqual({ ...a.json, postProcessing: 'x' });
    expect(['scheduled', 'done']).toContain(b.json.postProcessing);

    const big: Row[] = Array.from({ length: 5600 }, (_, i) => ({
      line: i + 1, date: '2026-10-01', amount: `${(i % 97) + 1}.${String(i % 100).padStart(2, '0')}`, description: `ROW ${i}`, fitid: `BIG-${i}`,
    }));
    const bigBody = batch(big, { sourceFileSha256: 'd'.repeat(64) });
    const bigKey = randomUUID();
    const c = await commit(bigBody, bigKey);
    expect(c.status).toBe(200);
    expect(JSON.stringify(c.json).length).toBeGreaterThan(512 * 1024);
    const d = await commit(bigBody, bigKey);
    expect(d.headers['idempotent-replayed']).toBe('true');
    expect({ ...d.json, postProcessing: 'x' }).toEqual({ ...c.json, postProcessing: 'x' });
    // The batch reader path shows the live state too.
    expect(await waitPostProcessing(c.json.batchId)).toBe('done');
    expect((await commit(bigBody, bigKey)).json.postProcessing).toBe('done');
    expect(await feedCount()).toBe(5603);
  });

  it('repeated FITIDs (22, 22r, 22b) and a renumbering bank (23) never give changed rows; a date moved 2 days is a duplicate (24)', async () => {
    const f22: Row[] = [
      { line: 1, date: '2026-11-10', amount: '15.00', description: 'LUNCH SPOT', fitid: 'DUP' },
      { line: 2, date: '2026-11-11', amount: '30.00', description: 'BOOK STORE', fitid: 'DUP' },
    ];
    expect((await commit(batch(f22))).json.counts).toMatchObject({ new: 2, inserted: 2 });
    for (const rows of [f22, [...f22].reverse(), [f22[1]!]]) {
      const r = await commit(batch(rows));
      expect(r.json.counts).toMatchObject({ inserted: 0, changed: 0 });
    }

    const nov: Row[] = [1, 2, 3].map((i) => ({ line: i, date: `2026-11-1${i}`, amount: `${i}0.00`, description: `NOV ${i}`, fitid: String(i) }));
    const dec: Row[] = [1, 2, 3].map((i) => ({ line: i, date: `2026-12-1${i}`, amount: `${i}1.00`, description: `DEC ${i}`, fitid: String(i) }));
    await commit(batch(nov, { sourceFileSha256: 'e'.repeat(64) }));
    const d = await commit(batch(dec, { sourceFileSha256: 'f'.repeat(64) }));
    expect(d.json.counts).toMatchObject({ new: 3, changed: 0, inserted: 3 });
    expect(d.json.rows.every((r: any) => r.reason === 'bank_id_reused')).toBe(true);
    expect((await commit(batch(nov))).json.counts.inserted).toBe(0);
    expect((await commit(batch(dec))).json.counts.inserted).toBe(0);

    await commit(batch(OFX));
    const shifted = await commit(batch([{ ...OFX[0]!, date: '2026-11-03' }]));
    expect(shifted.json.rows[0]).toMatchObject({ status: 'duplicate', reason: 'same_bank_id' });
  });

  it('changed rows: replace updates an untouched pending item (audited) and is refused once touched; add inserts with no FITID', async () => {
    await commit(batch([{ line: 1, date: '2026-11-20', amount: '80.00', description: 'HARDWARE STORE 12', fitid: 'CH-1' }]));
    const [item] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    const changed = { line: 1, date: '2026-11-21', amount: '85.00', description: 'HARDWARE STORE 12', fitid: 'CH-1' };

    const prev = await preview(batch([changed]));
    expect(prev.json.rows[0]).toMatchObject({ status: 'changed', existingItemId: item!.id, existingPending: true });

    const rep = await commit(batch([{ ...changed, changedAction: 'replace' }]));
    expect(rep.json.rows[0]).toMatchObject({ status: 'changed', replaced: true, inserted: false });
    const [after] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, item!.id));
    expect(after!.amount).toBe('85.0000');
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_feed')));
    expect(audits).toHaveLength(1);

    await db.update(bankFeedItems).set({ status: 'assigned', assignedAt: new Date(), assignedAccountId: expenseId }).where(eq(bankFeedItems.id, item!.id));
    const again = { ...changed, amount: '90.00' };
    const refused = await commit(batch([{ ...again, changedAction: 'replace' }]));
    expect(refused.json.rows[0]).toMatchObject({ status: 'changed', replaced: false, inserted: false });
    const add = await commit(batch([{ ...again, changedAction: 'add' }]));
    expect(add.json.rows[0]).toMatchObject({ status: 'changed', inserted: true });
    const [added] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, add.json.insertedItemIds[0]));
    expect(added!.providerTransactionId).toBeNull();
  });

  it('flags closed-period rows and checks the file balance (bank)', async () => {
    const rows: Row[] = [
      { line: 1, date: '2026-06-29', amount: '10.00', description: 'OLD FEE', fitid: 'OLD-1' },
      { line: 2, date: '2026-07-02', amount: '-100.00', description: 'DEPOSIT', fitid: 'NEW-1' },
    ];
    // Books: an opening deposit of 1,000.00 into the bank account.
    await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-07-01', total: '1000.0000',
      lines: [{ accountId: bankId, debit: '1000.0000', credit: '0' }, { accountId: expenseId, debit: '0', credit: '1000.0000' }],
    } as never, ownerId, companyId);
    // File: 1,000 - 10 + 100 = 1,090.00.
    const r = await preview(batch(rows, { fileEndingBalance: '1090.00', fileEndingDate: '2026-07-31' }));
    expect(r.json.rows.map((x: any) => x.closedPeriod)).toEqual([true, false]);
    expect(r.json.counts.closedPeriod).toBe(1);
    expect(r.json.balanceCheck).toMatchObject({
      fileBalance: '1090.00', booksAtDate: '1000.00', pendingTotal: '0.00', newTotal: '-90.00', projected: '1090.00', difference: '0.00',
    });
  });

  it('balance check for a card in both sign conventions, assigned items counted, a hand-entered check likely in the books', async () => {
    // Card owes 200.00 in the books (a charge posted by hand).
    await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-08-01', total: '200.0000',
      lines: [{ accountId: expenseId, debit: '200.0000', credit: '0' }, { accountId: cardId, debit: '0', credit: '200.0000' }],
    } as never, ownerId, companyId);
    const conn = await db.insert(bankConnections).values({ tenantId, companyId, accountId: cardId, provider: 'manual' }).returning();
    await db.insert(bankFeedItems).values({
      tenantId, companyId, bankConnectionId: conn[0]!.id, feedDate: '2026-08-02', amount: '20.0000', status: 'assigned',
      description: 'GAS', originalDescription: 'GAS', assignedAccountId: expenseId, assignedAt: new Date(),
    });
    const charge: Row = { line: 1, date: '2026-08-03', amount: '30.00', description: 'DINER', fitid: 'CC-1' };
    // Owed after the file: 200 + 20 + 30 = 250. The holder's sign of a card balance owed is negative.
    for (const flipped of [false, true]) {
      const r = await preview(batch([charge], { accountId: cardId, amountsFlipped: flipped, fileEndingBalance: '-250.00', fileEndingDate: '2026-08-31' }));
      expect(r.json.balanceCheck).toMatchObject({ booksAtDate: '200.00', pendingTotal: '20.00', newTotal: '30.00', projected: '250.00', difference: '0.00' });
    }

    // A check entered by hand in the bank register is likely already in the books.
    const t = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-09-02', total: '75.0000',
      lines: [{ accountId: expenseId, debit: '75.0000', credit: '0' }, { accountId: bankId, debit: '0', credit: '75.0000' }],
    } as never, ownerId, companyId);
    await db.update(transactions).set({ checkNumber: 1201 }).where(eq(transactions.id, t.id));
    const r2 = await preview(batch([{ line: 1, date: '2026-09-05', amount: '75.00', description: 'CHECK 1201', checkNumber: 1201 }],
      { fileEndingBalance: '-75.00', fileEndingDate: '2026-09-30' }));
    expect(r2.json.balanceCheck.likelyInBooks).toEqual({ count: 1, total: '75.00' });
  });

  it('undo removes untouched pending rows, refuses used rows unless pendingOnly, is audited, and a re-import brings rows back', async () => {
    const c = await commit(batch(OFX));
    expect(await waitPostProcessing(c.json.batchId)).toBe('done');
    const [one] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, c.json.insertedItemIds[0]));
    await db.update(bankFeedItems).set({ status: 'assigned', assignedAt: new Date(), assignedAccountId: expenseId }).where(eq(bankFeedItems.id, one!.id));

    const refused = await call('DELETE', `/api/v1/banking/feed/import-batches/${c.json.batchId}`);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('rows_already_used');
    expect(refused.json.error.details.lines).toEqual([one!.sourceLine]);

    const ok = await call('DELETE', `/api/v1/banking/feed/import-batches/${c.json.batchId}?pendingOnly=true`);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ removed: 2, kept: 1 });
    expect(await feedCount()).toBe(1);
    expect((await call('DELETE', `/api/v1/banking/feed/import-batches/${c.json.batchId}`)).json.error.code).toBe('already_undone');
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_import_batch'), eq(auditLog.action, 'delete')));
    expect(audits).toHaveLength(1);

    const back = await commit(batch(OFX));
    expect(back.json.counts).toMatchObject({ inserted: 2, duplicate: 1 });

    const list = await call('GET', `/api/v1/banking/feed/import-batches?accountId=${bankId}&format=qfx`);
    expect(list.json.batches).toHaveLength(2);
    expect(list.json.batches[1]).toMatchObject({ amountsFlipped: false, undoneAt: expect.any(String) });

    await db.update(bankImportBatches).set({ postProcessing: 'scheduled' }).where(eq(bankImportBatches.id, back.json.batchId));
    const preparing = await call('DELETE', `/api/v1/banking/feed/import-batches/${back.json.batchId}`);
    expect(preparing.json.error.code).toBe('still_preparing');
    await db.update(bankImportBatches).set({ postProcessing: 'done' }).where(eq(bankImportBatches.id, back.json.batchId));
  });

  it('post-processing never posts and never calls AI: an auto-accept rule gives 0 journal lines', async () => {
    await db.insert(bankRules).values({
      tenantId, name: 'Auto coffee', isActive: true, isGlobal: false, applyTo: 'both', descriptionContains: 'COFFEE',
      assignAccountId: expenseId, autoConfirm: true, priority: 1,
    });
    const c = await commit(batch(OFX));
    expect(await waitPostProcessing(c.json.batchId)).toBe('done');
    const lines = await db.select().from(journalLines).where(eq(journalLines.tenantId, tenantId));
    expect(lines).toHaveLength(0);
    const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    expect(items.every((i) => i.status === 'pending')).toBe(true);
    // Q-P25j: the rule's account is staged as a suggestion only.
    const coffee = items.find((i) => i.originalDescription === 'COFFEE CO')!;
    expect(coffee).toMatchObject({ suggestedAccountId: expenseId, matchType: 'rule', status: 'pending' });
    expect(items.filter((i) => i.suggestedAccountId === expenseId)).toHaveLength(1);
    expect(aiCalls).toEqual({ batch: 0, suggest: 0 });
  });

  it('look-alikes (Q-P25c) are inserted and flagged with the item they resemble; exact duplicates are not; csvMapping is kept', async () => {
    const mapping = { date: 0, description: 2, amount: 3, dateFormat: 'MM/DD/YYYY' };
    const csv = await commit(batch([{ line: 2, date: '2026-11-02', amount: '120.00', description: 'AMAZON MKTPLACE' }],
      { format: 'csv', fileName: 'card.csv', sourceFileSha256: '7'.repeat(64), csvMapping: mapping }));
    const original = csv.json.insertedItemIds[0];
    const ofxRows: Row[] = [
      { line: 1, date: '2026-11-03', amount: '120.00', description: 'AMAZON MKTPLACE PMTS WA', fitid: 'AMZ-1' },
      { line: 2, date: '2026-11-04', amount: '9.99', description: 'NEW THING', fitid: 'AMZ-2' },
    ];
    const r = await commit(batch(ofxRows));
    expect(r.json.rows.map((x: any) => [x.status, x.inserted, x.existingItemId ?? null]))
      .toEqual([['possible_duplicate', true, original], ['new', true, null]]);
    expect(r.json.counts).toMatchObject({ possibleDuplicate: 1, inserted: 2 });
    const [flagged] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, r.json.insertedItemIds[0]));
    expect(flagged).toMatchObject({ possibleDuplicate: true, possibleDuplicateOf: original });
    const feed = await call('GET', '/api/v1/banking/feed?limit=50');
    expect(feed.json.data.find((i: any) => i.id === flagged!.id)).toMatchObject({ possibleDuplicate: true, possibleDuplicateOf: original });
    // Re-importing: both rows are now exact duplicates and are skipped.
    expect((await commit(batch(ofxRows))).json.counts).toMatchObject({ duplicate: 2, inserted: 0 });
    // include:false skips a look-alike.
    const skip = await commit(batch([{ line: 1, date: '2026-11-02', amount: '120.00', description: 'AMAZON MKTPLACE STORE', include: false }],
      { sourceFileSha256: '6'.repeat(64) }));
    expect(skip.json.rows[0]).toMatchObject({ inserted: false });
    // csvMapping comes back with the batch (Q-P25f).
    const list = await call('GET', `/api/v1/banking/feed/import-batches?accountId=${bankId}&format=csv`);
    expect(list.json.batches[0].csvMapping).toEqual(mapping);
    // Undoing the original clears the reference, keeps the flag.
    await waitPostProcessing(csv.json.batchId);
    expect((await call('DELETE', `/api/v1/banking/feed/import-batches/${csv.json.batchId}`)).status).toBe(200);
    const [after] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, flagged!.id));
    expect(after).toMatchObject({ possibleDuplicate: true, possibleDuplicateOf: null });
  });

  it('two concurrent first commits make one connection and insert each key once', async () => {
    const [a, b] = await Promise.all([commit(batch(OFX)), commit(batch(OFX))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.json.counts.inserted + b.json.counts.inserted).toBe(3);
    const conns = await db.select().from(bankConnections).where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.accountId, bankId)));
    expect(conns).toHaveLength(1);
    expect(await feedCount()).toBe(3);
  });

  it('identities (Q-P25u): raw BANKID/ACCTID hashed under the company link key; link on commit, elsewhere on a dry run, 409 unless relink, lookup', async () => {
    const ident = { bankId: '021000021', acctId: '0012346789' };
    await commit(batch(OFX, { bankIdentity: ident }));
    const [saved] = await db.select().from(bankConnectionIdentities).where(eq(bankConnectionIdentities.tenantId, tenantId));
    expect(saved!.mask).toBe('6789');
    // The engine's hash: HMAC-SHA256 under the company key of "v1|" + bankId + "|" + acctId (trimmed).
    const key = await companyLinkKey(db, tenantId, companyId, false);
    expect(saved!.accountKeyHash.trim()).toBe(accountKeyHash(key!, { bankId: ' 021000021 ', acctId: '0012346789\t' }));
    expect(saved!.accountKeyHash.trim()).not.toBe(accountKeyHash(key!, { bankId: null, acctId: '0012346789' }));

    const hit = await lookup(ident);
    expect(hit.status).toBe(200);
    expect(hit.json.matches).toEqual([expect.objectContaining({ accountId: bankId, mask: '6789', via: 'hash' })]);
    // Another bank's account with the same number: no hash match; the mask still finds it.
    expect((await lookup({ bankId: '999999999', acctId: '0012346789' })).json.matches[0]).toMatchObject({ accountId: bankId, via: 'mask' });
    expect((await lookup({ mask: '6789' })).json.matches[0]).toMatchObject({ accountId: bankId, via: 'mask' });
    expect((await lookup({ mask: '123456789' })).status).toBe(400);
    expect((await lookup({})).status).toBe(400);

    const toCard = batch(OFX, { accountId: cardId, bankIdentity: ident });
    const p = await preview(toCard);
    expect(p.json.identityLinkedElsewhere).toEqual({ accountName: 'Import Checking', mask: '6789' });
    const conflict = await commit(toCard);
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('identity_linked_elsewhere');
    const relinked = await commit({ ...toCard, relinkIdentity: true });
    expect(relinked.status).toBe(200);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_connection_identity')));
    expect(audits.map((x) => x.action).sort()).toEqual(['create', 'update']);
    expect(JSON.stringify(audits)).not.toContain(saved!.accountKeyHash.trim());

    const bad = await commit(batch(OFX, { bankIdentity: { acctId: '   ' } }));
    expect([bad.status, bad.json.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(JSON.stringify(bad.json)).not.toContain('acctId":');
  });

  it('the raw ACCTID and BANKID are nowhere in the database or the logs after a commit (Q-P25u)', async () => {
    const acctId = '7319028846551';
    const bankIdRaw = '064108972';
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { logged.push(String(chunk)); return true; }) as never);
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { logged.push(String(chunk)); return true; }) as never);
    let c: Res;
    try {
      const key = randomUUID();
      c = await commit(batch(OFX, { bankIdentity: { bankId: bankIdRaw, acctId } }), key);
      // A replay and a bad request with the same values too.
      await commit(batch(OFX, { bankIdentity: { bankId: bankIdRaw, acctId } }), key);
      await commit(batch(OFX, { bankIdentity: { bankId: bankIdRaw, acctId, extra: 1 } }));
      await preview(batch(OFX, { bankIdentity: { bankId: bankIdRaw, acctId } }));
      await lookup({ bankId: bankIdRaw, acctId });
      expect(await waitPostProcessing(c.json.batchId)).toBe('done');
    } finally {
      for (const s of [...spies, out, errOut]) s.mockRestore();
    }
    expect(c!.status).toBe(200);
    expect(JSON.stringify(c!.json)).not.toContain(acctId);
    for (const line of logged) {
      expect(line).not.toContain(acctId);
      expect(line).not.toContain(bankIdRaw);
    }
    // Every table with a tenant_id, every column as text.
    const tables = await db.execute(sql`SELECT table_name FROM information_schema.columns
      WHERE column_name = 'tenant_id' AND table_schema = 'public' ORDER BY table_name`);
    for (const { table_name: name } of tables.rows as Array<{ table_name: string }>) {
      const r = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${name}" t WHERE t.tenant_id = '${tenantId}'
        AND (t::text LIKE '%${acctId}%' OR t::text LIKE '%${bankIdRaw}%')`));
      expect({ name, n: (r.rows[0] as { n: number }).n }).toEqual({ name, n: 0 });
    }
    const [k] = await db.select().from(bankLinkKeys).where(eq(bankLinkKeys.tenantId, tenantId));
    expect(k!.keyEncrypted).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });

  it('identities are per company (ES2): another company of the tenant sees no link, no account name, links its own', async () => {
    await db.update(accounts).set({ companyId }).where(eq(accounts.id, bankId));
    const [coB] = await db.insert(companies).values({ tenantId, businessName: 'Second Co', setupComplete: true }).returning();
    const bankB = (await accountsService.create(tenantId, { name: 'Second Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1092' })).id;
    await db.update(accounts).set({ companyId: coB!.id }).where(eq(accounts.id, bankB));
    const ident = { bankId: '021000021', acctId: '5550001234' };
    expect((await commit(batch(OFX, { bankIdentity: ident }))).status).toBe(200);

    const asB = { company: coB!.id };
    const p = await preview(batch(OFX, { accountId: bankB, bankIdentity: ident }), asB);
    expect(p.status).toBe(200);
    expect(p.json.identityLinkedElsewhere).toBeUndefined();
    expect((await lookup(ident, asB)).json.matches).toEqual([]);
    expect((await lookup({ mask: '1234' }, asB)).json.matches).toEqual([]);
    const c = await commit(batch(OFX, { accountId: bankB, bankIdentity: ident }), randomUUID(), asB);
    expect(c.status).toBe(200);
    const idents = await db.select().from(bankConnectionIdentities).where(eq(bankConnectionIdentities.tenantId, tenantId));
    expect(idents).toHaveLength(2);
    expect(new Set(idents.map((i) => i.accountKeyHash)).size).toBe(2);
    expect(await db.select().from(bankLinkKeys).where(eq(bankLinkKeys.tenantId, tenantId))).toHaveLength(2);
    // Company A still finds its own.
    expect((await lookup(ident)).json.matches).toEqual([expect.objectContaining({ accountId: bankId, via: 'hash' })]);
  });

  it('permissions (Q-P25ab): read-only may preview and look up; commit and undo need write', async () => {
    const ro = { token: readonlyToken };
    const p = await preview(batch(OFX), ro);
    expect(p.status).toBe(200);
    expect(p.json.counts.new).toBe(3);
    expect((await lookup({ mask: '6789' }, ro)).status).toBe(200);
    // dryRun must be exactly true; anything else is a commit (write).
    expect((await call('POST', '/api/v1/banking/feed/import-batch', batch(OFX, { dryRun: 'true' }), ro)).status).toBe(403);
    expect((await commit(batch(OFX), randomUUID(), ro)).status).toBe(403);
    const c = await commit(batch(OFX));
    expect(await waitPostProcessing(c.json.batchId)).toBe('done');
    expect((await call('DELETE', `/api/v1/banking/feed/import-batches/${c.json.batchId}`, undefined, ro)).status).toBe(403);
    expect(await feedCount()).toBe(3);
  });

  it('422s: not a bank or card account, invalid rows with their line, too large; 403 for a role without access', async () => {
    const notBank = await commit(batch(OFX, { accountId: expenseId }));
    expect([notBank.status, notBank.json.error.code]).toEqual([422, 'account_not_bank_or_card']);
    const missing = await commit(batch(OFX, { accountId: randomUUID() }));
    expect([missing.status, missing.json.error.code]).toEqual([422, 'account_not_in_company']);
    const bad = await commit(batch([{ ...OFX[0]!, line: 41, amount: '12.345' }]));
    expect([bad.status, bad.json.error.code, bad.json.error.details]).toEqual([422, 'invalid_row', { line: 41, field: 'amount' }]);
    const thirteen = await commit(batch([{ ...OFX[0]!, line: 42, amount: '1234567890123' }]));
    expect(thirteen.json.error.details).toEqual({ line: 42, field: 'amount' });
    const ro = await call('POST', '/api/v1/banking/feed/import-batch', batch(OFX), { key: randomUUID(), token: readonlyToken });
    expect(ro.status).toBe(403);
  });

  it('EB1: a newest-first download keeps a real transaction that has its own FITID (order-independent)', async () => {
    const a = { line: 1, date: '2026-11-02', amount: '4.50', description: 'COFFEE', fitid: 'X' };
    expect((await commit(batch([a]))).json.counts.inserted).toBe(1);
    // Download 2, newest first: B (FITID Y, same date, amount and description), then A again.
    const b = { line: 1, date: '2026-11-02', amount: '4.50', description: 'COFFEE', fitid: 'Y' };
    for (const rows of [[b, { ...a, line: 2 }], [{ ...a, line: 1 }, { ...b, line: 2 }]]) {
      const p = await preview(batch(rows, { sourceFileSha256: '3'.repeat(64) }));
      const byFitid = Object.fromEntries(rows.map((r, i) => [r.fitid, p.json.rows[i]]));
      expect(byFitid['X']).toMatchObject({ status: 'duplicate', reason: 'same_bank_id' });
      expect(byFitid['Y']).toMatchObject({ status: 'new' });
    }
    const c = await commit(batch([b, { ...a, line: 2 }], { sourceFileSha256: '3'.repeat(64) }));
    expect(c.json.counts).toMatchObject({ inserted: 1, duplicate: 1 });
    const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    expect(items.map((i) => i.providerTransactionId).sort()).toEqual(['X', 'Y']);
    // B alone (A not in the file): a look-alike (identical date, amount, description), flagged and inserted.
    await db.delete(bankFeedItems).where(eq(bankFeedItems.providerTransactionId, 'Y'));
    const alone = await commit(batch([b], { sourceFileSha256: '4'.repeat(64) }));
    expect(alone.json.rows[0]).toMatchObject({ status: 'possible_duplicate', inserted: true });
  });

  it('EB2: undoing a batch that replaced an item restores the item; the item stays with its own batch', async () => {
    const first = await commit(batch([{ line: 1, date: '2026-11-20', amount: '80.00', description: 'HARDWARE STORE 12', fitid: 'CH-1' }]));
    const itemId = first.json.insertedItemIds[0];
    const rep = await commit(batch([{ line: 7, date: '2026-11-21', amount: '85.00', description: 'HARDWARE STORE 12', fitid: 'CH-1', changedAction: 'replace' }],
      { sourceFileSha256: '5'.repeat(64) }));
    expect(rep.json.rows[0]).toMatchObject({ status: 'changed', replaced: true });
    const [mid] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, itemId));
    expect(mid).toMatchObject({ amount: '85.0000', feedDate: '2026-11-21', importBatchId: first.json.batchId, sourceLine: 1 });
    await waitPostProcessing(first.json.batchId);
    const undo = await call('DELETE', `/api/v1/banking/feed/import-batches/${rep.json.batchId}`);
    expect(undo.status).toBe(200);
    expect(undo.json).toMatchObject({ removed: 0, restored: 1, kept: 0 });
    const [back] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, itemId));
    expect(back).toMatchObject({ amount: '80.0000', feedDate: '2026-11-20', importBatchId: first.json.batchId });
    // The file of batch 1 is a duplicate again (row key restored too).
    expect((await commit(batch([{ line: 1, date: '2026-11-20', amount: '80.00', description: 'HARDWARE STORE 12', fitid: 'CH-1' }]))).json.counts.duplicate).toBe(1);

    // A replaced item used since: 409 with the replacing row's line, unless pendingOnly (then kept as it is).
    const rep2 = await commit(batch([{ line: 9, date: '2026-11-21', amount: '86.00', description: 'HARDWARE STORE 12', fitid: 'CH-1', changedAction: 'replace' }],
      { sourceFileSha256: '6'.repeat(64) }));
    await db.update(bankFeedItems).set({ status: 'assigned', assignedAt: new Date(), assignedAccountId: expenseId }).where(eq(bankFeedItems.id, itemId));
    const refused = await call('DELETE', `/api/v1/banking/feed/import-batches/${rep2.json.batchId}`);
    expect([refused.status, refused.json.error.code, refused.json.error.details.lines]).toEqual([409, 'rows_already_used', [9]]);
    const partial = await call('DELETE', `/api/v1/banking/feed/import-batches/${rep2.json.batchId}?pendingOnly=true`);
    expect(partial.json).toMatchObject({ restored: 0, kept: 1 });
    expect((await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, itemId)))[0]!.amount).toBe('86.0000');
  });

  it('ES1: re-importing after "add" is a duplicate, not changed again; replace updates the row key', async () => {
    await commit(batch([{ line: 1, date: '2026-11-20', amount: '80.00', description: 'HARDWARE STORE 12', fitid: 'CH-2' }]));
    const changed = { line: 1, date: '2026-11-21', amount: '85.00', description: 'HARDWARE STORE 12', fitid: 'CH-2' };
    const add = await commit(batch([{ ...changed, changedAction: 'add' }], { sourceFileSha256: '5'.repeat(64) }));
    expect(add.json.rows[0]).toMatchObject({ status: 'changed', inserted: true });
    const again = await preview(batch([changed], { sourceFileSha256: '5'.repeat(64) }));
    expect(again.json.rows[0]).toMatchObject({ status: 'duplicate', reason: 'same_row', existingItemId: add.json.insertedItemIds[0] });
    const rep = await commit(batch([{ ...changed, changedAction: 'replace' }], { sourceFileSha256: '5'.repeat(64) }));
    expect(rep.json.rows[0]).toMatchObject({ status: 'duplicate', inserted: false });
    const amounts = (await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId))).map((i) => i.amount).sort();
    expect(amounts).toEqual(['80.0000', '85.0000']);

    // Replace: the item's row key follows the new values, so the replacing file is a duplicate afterwards.
    await commit(batch([{ line: 1, date: '2026-11-25', amount: '10.00', description: 'PAINT SHOP 4', fitid: 'CH-3' }]));
    const r = { line: 1, date: '2026-11-26', amount: '12.00', description: 'PAINT SHOP 4', fitid: 'CH-3' };
    expect((await commit(batch([{ ...r, changedAction: 'replace' }]))).json.rows[0].replaced).toBe(true);
    const [k] = await (await import('../services/bank-import/keys.js')).keyRows([r]);
    const [item] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.providerTransactionId, 'CH-3'));
    expect(item!.rowKey!.trim()).toBe(k!.rowKey);
    expect((await commit(batch([r]))).json.rows[0]).toMatchObject({ status: 'duplicate', reason: 'same_bank_id' });
  });

  it('400s: fileEndingBalance, csvMapping over 16 KB (ES4, notes)', async () => {
    const bal = await commit(batch(OFX, { fileEndingBalance: '12.345', fileEndingDate: '2026-11-30' }));
    expect([bal.status, bal.json.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    const prev = await preview(batch(OFX, { fileEndingBalance: '1e5', fileEndingDate: '2026-11-30' }));
    expect([prev.status, prev.json.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(() => importBatchService.validateBatch(batch(OFX, { fileEndingBalance: '1.234' }) as importBatchService.BatchInput))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'VALIDATION_ERROR' }));
    const big = await commit(batch(CSV, { format: 'csv', csvMapping: { note: 'x'.repeat(16_400) } }));
    expect([big.status, big.json.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect((await commit(batch(CSV, { format: 'csv', csvMapping: { note: 'x'.repeat(16_000) } }))).status).toBe(200);
  });

  it('a replay of a stored body shows the live postProcessing; the first connection is audited', async () => {
    const key = randomUUID();
    const body = batch(OFX);
    const a = await commit(body, key);
    expect(a.json.postProcessing).toBe('scheduled');
    expect(await waitPostProcessing(a.json.batchId)).toBe('done');
    const b = await commit(body, key);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json).toEqual({ ...a.json, postProcessing: 'done' });
    const conn = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_connection')));
    expect(conn).toHaveLength(1);
    expect(conn[0]!.action).toBe('create');
    // A second import into the same account makes no new connection, no new audit row.
    await commit(batch(CSV, { format: 'csv', sourceFileSha256: 'c'.repeat(64) }));
    expect(await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_connection')))).toHaveLength(1);
  });

  it('likelyInBooks: a check number match needs the same amount too', async () => {
    const t = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-09-02', total: '75.0000',
      lines: [{ accountId: expenseId, debit: '75.0000', credit: '0' }, { accountId: bankId, debit: '0', credit: '75.0000' }],
    } as never, ownerId, companyId);
    await db.update(transactions).set({ checkNumber: 1301 }).where(eq(transactions.id, t.id));
    const r = await preview(batch([{ line: 1, date: '2026-09-05', amount: '57.00', description: 'CHECK 1301', checkNumber: 1301 }],
      { fileEndingBalance: '-132.00', fileEndingDate: '2026-09-30' }));
    expect(r.json.balanceCheck.likelyInBooks).toEqual({ count: 0, total: '0.00' });
  });

  it('post-processing runs once per batch when two engines start it together', async () => {
    const r = await importBatchService.commitBatch({ tenantId, companyId, userId: ownerId }, batch(OFX) as importBatchService.BatchInput);
    const states = await Promise.all([
      importBatchService.runImportPostProcessing(tenantId, r.batchId!),
      importBatchService.runImportPostProcessing(tenantId, r.batchId!),
    ]);
    expect(states.slice().sort()).toEqual(['done', 'skipped']);
    expect(await importBatchService.runImportPostProcessing(tenantId, r.batchId!)).toBe('skipped');
  });

  it('a 20,000-row commit against 20,000 look-alike Plaid items on the same days stays fast (ES3)', async () => {
    await db.update(companies).set({ lockDate: null }).where(eq(companies.id, companyId));
    const [plaid] = await db.insert(bankConnections).values({ tenantId, companyId, accountId: bankId, provider: 'plaid' }).returning();
    const N = 20_000;
    for (let s = 0; s < N; s += 1000) {
      await db.insert(bankFeedItems).values(Array.from({ length: 1000 }, (_, j) => {
        const i = s + j;
        return {
          tenantId, companyId, bankConnectionId: plaid!.id, providerTransactionId: `plaid-${i}`, status: 'pending',
          feedDate: `2026-10-${String((i % 7) + 10).padStart(2, '0')}`, amount: '1.2500',
          description: `SQUARE COFFEE ${i % 50}`, originalDescription: `SQUARE COFFEE ${i % 50}`,
        };
      }));
    }
    // Uncleared register lines of the same amount for likelyInBooks.
    for (let i = 0; i < 300; i++) {
      const t = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-10-12', total: '1.2500',
        lines: [{ accountId: expenseId, debit: '1.2500', credit: '0' }, { accountId: bankId, debit: '0', credit: '1.2500' }],
      } as never, ownerId, companyId);
      expect(t.id).toBeTruthy();
    }
    const rows: Row[] = Array.from({ length: N }, (_, i) => ({
      line: i + 1, date: `2026-10-${String((i % 7) + 10).padStart(2, '0')}`, amount: '1.25', description: `SQUARE COFFEE ${i % 50} STORE`,
      fitid: `file-${i}`,
    }));
    const started = Date.now();
    const r = await importBatchService.commitBatch({ tenantId, companyId, userId: ownerId },
      batch(rows, { sourceFileSha256: '8'.repeat(64), fileEndingBalance: '0.00', fileEndingDate: '2026-10-31' }) as importBatchService.BatchInput);
    const took = Date.now() - started;
    await db.update(bankImportBatches).set({ postProcessing: 'done' }).where(eq(bankImportBatches.id, r.batchId!));
    // Different trusted bank ids never match unless identical, so all are new; every one was a candidate.
    expect(r.counts.inserted).toBe(N);
    expect(r.balanceCheck!.likelyInBooks.count).toBe(300);
    expect(took).toBeLessThan(60_000);
  }, 240_000);

  it('a 20,000-row commit finishes in time and a posting to the account is not blocked meanwhile', async () => {
    const rows: Row[] = Array.from({ length: 20_000 }, (_, i) => ({
      line: i + 1, date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`, amount: `${(i % 500) + 1}.25`, description: `VENDOR ${i}`,
    }));
    const started = Date.now();
    // The service directly (no detached post-processing of 20,000 rows in a test).
    const importing = importBatchService.commitBatch({ tenantId, companyId, userId: ownerId },
      batch(rows, { format: 'csv', sourceFileSha256: '9'.repeat(64) }) as importBatchService.BatchInput);
    await new Promise((r) => setTimeout(r, 300));
    const posted = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-11-01', total: '5.0000',
      lines: [{ accountId: bankId, debit: '5.0000', credit: '0' }, { accountId: expenseId, debit: '0', credit: '5.0000' }],
    } as never, ownerId, companyId);
    expect(posted.id).toBeTruthy();
    const r = await importing;
    expect(r.counts.inserted).toBe(20_000);
    await db.update(bankImportBatches).set({ postProcessing: 'done' }).where(eq(bankImportBatches.id, r.batchId!));
    expect(Date.now() - started).toBeLessThan(120_000);
  }, 180_000);
});
