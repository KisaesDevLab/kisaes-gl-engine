// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Request idempotency on the posting and master-data routes (U-18,
// idempotency-v1), through the real routers:
//   E4  first POST /transactions -> 201 and a 'done' row; the replay is the
//       same 201 and body with Idempotent-Replayed, one posting, one audit row
//   E5  same key, another body / params / route / company / If-Match -> 422
//   E6  another user with the same key executes independently
//   E7  refusals are not stored (400, 423, 403, 409); the retry runs again
//   E7b 409 TAG_NUMBER_EXISTS (pre-check and the unique index inside the
//       keyed transaction), CHECK_PRINTED and DEPOSIT_LINKS_DROPPED store
//       nothing and are never replayed
//   E8  423, then the password with the same key -> posts once; a replay
//       after the password changed posts nothing and audits nothing
//   E9  two parallel same-key posts (50 runs) -> one posting, 409
//       IDEMPOTENCY_IN_PROGRESS with Retry-After, the retry replays
//   E10 crash before commit -> nothing stored, the retry posts once
//   E11 settle failure / truncated body -> reader replay, original status
//   E12 reader replay of a record deleted since -> 200 minimal body
//   E13 settlement on error: the second Write Check hits "number used"
//       while the first commits -> replay, not 409
//   E14 every route of the idempotency-v1 set: first + replay -> one effect,
//       no unclaimed 2xx, no second-transaction claim; PUT / void / DELETE
//       replays are 200, not their natural refusal
//   E15 templates enter (with and without a schedule), skip and resolve
//   E16 /batch/save keeps its own mechanism
//   E21 a user who lost the permission gets 403 on a replay

import 'express-async-errors';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts, auditLog, attachments, batchSaveRequests, companies, contacts, dailySalesEntries, dailySalesEntryValues,
  dailySalesTemplateLines, dailySalesTemplates, idempotencyKeys, items, tags, templateOccurrences, transactions,
  userPermissions, userTenantAccess, users,
} from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import { errorHandler } from '../middleware/error-handler.js';
import { transactionsRouter } from './transactions.routes.js';
import { checksRouter } from './checks.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { billsRouter } from './bills.routes.js';
import { dailySalesRouter } from './daily-sales.routes.js';
import { templatesRouter } from './templates.routes.js';
import { accountsRouter } from './accounts.routes.js';
import { contactsRouter } from './contacts.routes.js';
import { itemsRouter } from './items.routes.js';
import { tagsRouter } from './tags.routes.js';
import { batchRouter } from './batch.routes.js';
import * as authService from '../services/auth.service.js';
import * as dailySales from '../services/daily-sales.service.js';
import { hashClosingPassword } from '../services/closing-password.service.js';
import { __idempotencyDiagnostics, __idempotencyTestHooks } from '../services/idempotency.service.js';
import {
  makeCompany, cleanTenant, suffix, transferDraft, monthlyAuto, PINNED_TODAY, type Co,
} from '../services/templates/templates.test-helpers.js';

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

let server: Server;
let port = 0;
let c: Co;
const tenantIds: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/checks', checksRouter);
  app.use('/api/v1/invoices', invoicesRouter);
  app.use('/api/v1/bills', billsRouter);
  app.use('/api/v1/daily-sales', dailySalesRouter);
  app.use('/api/v1/templates', templatesRouter);
  app.use('/api/v1/accounts', accountsRouter);
  app.use('/api/v1/contacts', contactsRouter);
  app.use('/api/v1/items', itemsRouter);
  app.use('/api/v1/tags', tagsRouter);
  app.use('/api/v1/batch', batchRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server.address() as AddressInfo).port; resolve(); }); });
  c = await makeCompany('idem', tenantIds);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const tid of tenantIds) {
    const entries = (await db.select({ id: dailySalesEntries.id }).from(dailySalesEntries).where(eq(dailySalesEntries.tenantId, tid))).map((e) => e.id);
    if (entries.length) await db.delete(dailySalesEntryValues).where(inArray(dailySalesEntryValues.entryId, entries));
    await db.delete(dailySalesEntries).where(eq(dailySalesEntries.tenantId, tid));
    await db.delete(dailySalesTemplateLines).where(eq(dailySalesTemplateLines.tenantId, tid));
    await db.delete(dailySalesTemplates).where(eq(dailySalesTemplates.tenantId, tid));
    await db.delete(attachments).where(eq(attachments.tenantId, tid));
    await db.delete(items).where(eq(items.tenantId, tid));
  }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

afterEach(() => {
  delete __idempotencyTestHooks.afterClaim;
  delete __idempotencyTestHooks.settle;
  delete __idempotencyTestHooks.capBytes;
});

function request(method: string, pathname: string, body: unknown, opts: {
  key?: string; token?: string; company?: string; headers?: Record<string, string>;
} = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1${pathname}`, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token ?? c.token}`,
        'X-Company-Id': opts.company ?? c.companyId,
        ...(opts.key ? { 'Idempotency-Key': opts.key } : {}),
        ...(data ? { 'Content-Length': String(data.length) } : {}),
        ...(opts.headers ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const newKey = () => crypto.randomUUID();
const keyRows = (key: string) => db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, c.tenantId), eq(idempotencyKeys.idempotencyKey, key)));
const txnCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(transactions).where(eq(transactions.tenantId, c.tenantId)))[0]!.n;
const auditCount = async (entityType: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog)
  .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, entityType))))[0]!.n;

let amountSeq = 0;
/** An expense body with a unique amount, so each test's postings are told apart. */
const expense = (extra: Record<string, unknown> = {}) => ({
  txnType: 'expense', txnDate: '2026-04-10', payFromAccountId: c.bank, contactId: c.vendor,
  lines: [{ expenseAccountId: c.expense, amount: `${10 + ++amountSeq}.25`, description: 'Granite sealer' }],
  memo: 'Shop supplies', ...extra,
});

async function bookkeeper(overrides: Record<string, string>) {
  const [u] = await db.insert(users).values({
    tenantId: c.tenantId, email: `bk-${suffix()}@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper' });
  await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: u!.id, overrides: overrides as never });
  const token = (await authService.issueSession({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
  return { id: u!.id, token };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('E4 replay', () => {
  it('replays the stored 201 once, with one posting and one audit row', async () => {
    const key = newKey();
    const body = expense();
    const txns0 = await txnCount();
    const audits0 = await auditCount('transaction');
    const first = await request('POST', '/transactions', body, { key });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const [row] = await keyRows(key);
    expect(row).toMatchObject({
      state: 'done', route: 'POST /transactions', responseStatus: 201, successStatus: 201,
      entityType: 'transaction', entityId: first.json.transaction.id, companyId: c.companyId, userId: c.userId,
    });
    expect(row!.requestSha256).toMatch(/^[0-9a-f]{64}$/);

    // Same body, keys in another order.
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    const again = await request('POST', '/transactions', reordered, { key });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.headers['content-type']).toMatch(/application\/json/);
    expect(again.json).toEqual(first.json);
    expect(await txnCount()).toBe(txns0 + 1);
    expect(await auditCount('transaction')).toBe(audits0 + 1);
  });
});

describe('E5 reuse', () => {
  it('another body, params, route, company or If-Match with the key is 422 with the first entity', async () => {
    const key = newKey();
    const first = await request('POST', '/transactions', expense(), { key });
    expect(first.status).toBe(201);
    const id = first.json.transaction.id;
    const txns0 = await txnCount();

    const check422 = (r: Res) => {
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      expect(r.json.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', details: { entityType: 'transaction', entityId: id } });
    };
    check422(await request('POST', '/transactions', expense(), { key }));
    check422(await request('POST', '/checks', { bankAccountId: c.bank, payeeNameOnCheck: 'X', txnDate: '2026-04-10', amount: '1.00', lines: [{ accountId: c.expense, amount: '1.00' }] }, { key }));
    expect(await txnCount()).toBe(txns0);

    // Params and If-Match: a PUT keyed for one transaction, then another.
    const a = (await request('POST', '/transactions', expense())).json.transaction.id;
    const b = (await request('POST', '/transactions', expense())).json.transaction.id;
    const putKey = newKey();
    const body = expense();
    expect((await request('PUT', `/transactions/${a}`, body, { key: putKey })).status).toBe(200);
    const p = await request('PUT', `/transactions/${b}`, body, { key: putKey });
    expect(p.status).toBe(422);
    expect(p.json.error.details).toEqual({ entityType: 'transaction', entityId: a });
    const im = await request('PUT', `/transactions/${a}`, body, { key: putKey, headers: { 'If-Match': '"7"' } });
    expect(im.status).toBe(422);
  });

  it('the same body on the same route with another company is a reuse', async () => {
    const key = newKey();
    const body = expense();
    const first = await request('POST', '/transactions', body, { key });
    expect(first.status).toBe(201);
    const r = await request('POST', '/transactions', body, { key, company: c.companyB });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // The record of the other company is not named (L2).
    expect(r.json.error.details).toBeUndefined();
    expect(JSON.stringify(r.json)).not.toContain(first.json.transaction.id);
  });
});

describe('E6 scope', () => {
  it('another user with the same key executes independently', async () => {
    const bk = await bookkeeper({ transactions: 'full' });
    const key = newKey();
    const body = expense();
    const txns0 = await txnCount();
    const a = await request('POST', '/transactions', body, { key });
    const b = await request('POST', '/transactions', body, { key, token: bk.token });
    expect(a.status).toBe(201);
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.json.transaction.id).not.toBe(a.json.transaction.id);
    expect(await txnCount()).toBe(txns0 + 2);
  });
});

describe('E7 refusals are not stored', () => {
  it('400 validation', async () => {
    const key = newKey();
    const bad = { txnType: 'expense', txnDate: '2026-04-10', lines: [] };
    expect((await request('POST', '/transactions', bad, { key })).status).toBe(400);
    expect(await keyRows(key)).toHaveLength(0);
    const again = await request('POST', '/transactions', bad, { key });
    expect(again.status).toBe(400);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
  });

  it('409 TXN_ALREADY_DELETED', async () => {
    const id = (await request('POST', '/transactions', expense())).json.transaction.id;
    expect((await request('DELETE', `/transactions/${id}`, {})).status).toBe(200);
    const key = newKey();
    const r = await request('DELETE', `/transactions/${id}`, {}, { key });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('TXN_ALREADY_DELETED');
    expect(await keyRows(key)).toHaveLength(0);
    expect((await request('DELETE', `/transactions/${id}`, {}, { key })).status).toBe(409);
  });
});

describe('E7b refusals from tag-number-v1 and ledger-guards-v1 are not stored', () => {
  const tagNumbers = () => `T-${suffix()}`;

  it('409 TAG_NUMBER_EXISTS from the pre-check', async () => {
    const number = tagNumbers();
    expect((await request('POST', '/tags', { name: `Crew ${suffix()}`, tagNumber: number })).status).toBe(201);
    const key = newKey();
    const body = { name: `Crew ${suffix()}`, tagNumber: number };
    const r = await request('POST', '/tags', body, { key });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('TAG_NUMBER_EXISTS');
    expect(await keyRows(key)).toHaveLength(0);
  });

  it('409 TAG_NUMBER_EXISTS from the unique index inside the keyed transaction rolls the claim back', async () => {
    const number = tagNumbers();
    const key = newKey();
    const body = { name: `Crew ${suffix()}`, tagNumber: number };
    let racer: string | undefined;
    // A concurrent writer takes the number after the pre-check passed and
    // the key was claimed: the insert hits 23505 on the partial index.
    __idempotencyTestHooks.afterClaim = async () => {
      const [t] = await db.insert(tags).values({ tenantId: c.tenantId, name: `Racer ${suffix()}`, tagNumber: number }).returning();
      racer = t!.id;
    };
    const tags0 = (await db.select().from(tags).where(eq(tags.tenantId, c.tenantId))).length;
    const r = await request('POST', '/tags', body, { key });
    delete __idempotencyTestHooks.afterClaim;
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('TAG_NUMBER_EXISTS');
    expect(await keyRows(key)).toHaveLength(0);
    // Only the racer's tag was added; no audit row for the refused create.
    expect((await db.select().from(tags).where(eq(tags.tenantId, c.tenantId))).length).toBe(tags0 + 1);

    // Once the number is free again the same key and body run (not replayed).
    await db.delete(tags).where(eq(tags.id, racer!));
    const ok = await request('POST', '/tags', body, { key });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
    expect(ok.json.tag.tagNumber).toBe(number);
    const replay = await request('POST', '/tags', body, { key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json).toEqual(ok.json);
  });

  it('409 CHECK_PRINTED on PUT /transactions/:id', async () => {
    const made = await request('POST', '/checks', {
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite',
      txnDate: '2026-04-14', amount: '150.00', printLater: true, lines: [{ accountId: c.expense, amount: '150.00' }],
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = made.json.check.id;
    await db.update(transactions).set({
      printStatus: 'printed', checkNumber: 7001, printedAt: new Date('2026-04-15T12:00:00.000Z'), printBatchId: crypto.randomUUID(),
    }).where(eq(transactions.id, id));
    const key = newKey();
    const body = {
      txnType: 'expense', txnDate: '2026-04-14', payFromAccountId: c.bank, contactId: c.vendor,
      lines: [{ expenseAccountId: c.expense, amount: '151.00' }],
    };
    for (let i = 0; i < 2; i++) {
      const r = await request('PUT', `/transactions/${id}`, body, { key });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('CHECK_PRINTED');
      expect(r.headers['idempotent-replayed']).toBeUndefined();
      expect(await keyRows(key)).toHaveLength(0);
    }
    expect((await db.select().from(transactions).where(eq(transactions.id, id)))[0]!.total).toBe('150.0000');
  });

  it('409 DEPOSIT_LINKS_DROPPED on PUT /transactions/:id', async () => {
    const clearing = (await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'payments_clearing')),
    }))!.id;
    const payment = await ledger.postTransaction(c.tenantId, {
      txnType: 'customer_payment', txnDate: '2026-04-10', contactId: c.customer, total: '125.0000',
      lines: [
        { accountId: clearing, debit: '125.0000', credit: '0' },
        { accountId: c.ar, debit: '0', credit: '125.0000' },
      ],
    }, c.userId, c.companyId);
    const deposit = (line: Record<string, unknown>) => ({
      txnType: 'deposit', txnDate: '2026-04-12', depositToAccountId: c.bank, lines: [{ accountId: clearing, amount: '125.00', ...line }],
    });
    const made = await request('POST', '/transactions', deposit({ sourceTransactionId: payment.id }));
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const key = newKey();
    const dropped = { ...deposit({}), memo: 'fixed memo' };
    for (let i = 0; i < 2; i++) {
      const r = await request('PUT', `/transactions/${made.json.transaction.id}`, dropped, { key });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('DEPOSIT_LINKS_DROPPED');
      expect(r.headers['idempotent-replayed']).toBeUndefined();
      expect(await keyRows(key)).toHaveLength(0);
    }
  });
});

describe('closing date (E7 423/403, E8)', () => {
  const PASSWORD = 'closing-pass-123';
  beforeAll(async () => {
    await db.update(companies).set({ lockDate: '2026-02-28', closingPasswordHash: await hashClosingPassword(PASSWORD) })
      .where(eq(companies.id, c.companyId));
  });
  afterAll(async () => {
    await db.update(companies).set({ lockDate: null, closingPasswordHash: null }).where(eq(companies.id, c.companyId));
  });

  it('423 and 403 store nothing; the password with the same key posts once; a later replay posts and audits nothing', async () => {
    const key = newKey();
    const body = expense({ txnDate: '2026-02-15' });
    const txns0 = await txnCount();
    const overrides0 = await auditCount('closing_date_override');

    const locked = await request('POST', '/transactions', body, { key });
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe('TB_PERIOD_LOCKED');
    expect(await keyRows(key)).toHaveLength(0);
    const wrong = await request('POST', '/transactions', { ...body, closingPassword: 'not-the-password' }, { key });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect(await keyRows(key)).toHaveLength(0);

    const ok = await request('POST', '/transactions', { ...body, closingPassword: PASSWORD }, { key });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(await txnCount()).toBe(txns0 + 1);
    expect(await auditCount('closing_date_override')).toBe(overrides0 + 1);
    const [row] = await keyRows(key);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);

    // The password changes; a replay with the old one returns the stored 201.
    await db.update(companies).set({ closingPasswordHash: await hashClosingPassword('a-new-closing-pass') }).where(eq(companies.id, c.companyId));
    const replay = await request('POST', '/transactions', { ...body, closingPassword: PASSWORD }, { key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json).toEqual(ok.json);
    // Without the password at all: still the same request (the password is not hashed).
    expect((await request('POST', '/transactions', body, { key })).headers['idempotent-replayed']).toBe('true');
    expect(await txnCount()).toBe(txns0 + 1);
    expect(await auditCount('closing_date_override')).toBe(overrides0 + 1);
    await db.update(companies).set({ closingPasswordHash: await hashClosingPassword(PASSWORD) }).where(eq(companies.id, c.companyId));
  });
});

describe('E9 concurrency', () => {
  it('two parallel same-key posts: one posting, 409 IN_PROGRESS with Retry-After, the retry replays (50 runs)', async () => {
    const txns0 = await txnCount();
    for (let run = 0; run < 50; run++) {
      const key = newKey();
      const body = expense();
      const entered = deferred();
      const gate = deferred();
      let paused = false;
      __idempotencyTestHooks.afterClaim = async () => {
        if (paused) return;
        paused = true;
        entered.resolve();
        await gate.promise;
      };
      const first = request('POST', '/transactions', body, { key });
      await entered.promise;
      const second = await request('POST', '/transactions', body, { key });
      expect(second.status, `run ${run}: ${JSON.stringify(second.json)}`).toBe(409);
      expect(second.json.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(second.headers['retry-after']).toBe('1');
      gate.resolve();
      const a = await first;
      expect(a.status).toBe(201);
      const retry = await request('POST', '/transactions', body, { key });
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.json.transaction.id).toBe(a.json.transaction.id);
    }
    expect(await txnCount()).toBe(txns0 + 50);
  });
});

describe('E10 crash before commit', () => {
  it('nothing is stored and the retry posts once', async () => {
    const key = newKey();
    const body = expense();
    const txns0 = await txnCount();
    __idempotencyTestHooks.afterClaim = () => { throw new Error('crash inside the posting transaction'); };
    const crashed = await request('POST', '/transactions', body, { key });
    expect(crashed.status).toBe(500);
    delete __idempotencyTestHooks.afterClaim;
    expect(await keyRows(key)).toHaveLength(0);
    expect(await txnCount()).toBe(txns0);
    const retry = await request('POST', '/transactions', body, { key });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await txnCount()).toBe(txns0 + 1);
  });
});

describe('E11 reader replay', () => {
  it('a failed settle leaves the row committed; the retry reads the record with the original status', async () => {
    const key = newKey();
    const body = expense();
    __idempotencyTestHooks.settle = () => { throw new Error('settle failed'); };
    const first = await request('POST', '/transactions', body, { key });
    expect(first.status).toBe(201);
    delete __idempotencyTestHooks.settle;
    const [row] = await keyRows(key);
    expect(row).toMatchObject({ state: 'committed', responseBody: null, entityId: first.json.transaction.id });
    const txns0 = await txnCount();
    const replay = await request('POST', '/transactions', body, { key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json.transaction).toMatchObject({ id: first.json.transaction.id, txnType: 'expense', total: first.json.transaction.total });
    expect(await txnCount()).toBe(txns0);
  });

  it('a body over the cap is not stored; the reader replays it', async () => {
    __idempotencyTestHooks.capBytes = 64;
    const key = newKey();
    const body = expense();
    const first = await request('POST', '/transactions', body, { key });
    expect(first.status).toBe(201);
    const [row] = await keyRows(key);
    expect(row).toMatchObject({ state: 'done', responseTruncated: true, responseBody: null });
    const replay = await request('POST', '/transactions', body, { key });
    expect(replay.status).toBe(201);
    expect(replay.json.transaction.id).toBe(first.json.transaction.id);
  });
});

describe('E12 record deleted since', () => {
  it('a committed row whose record is gone replays 200 with the minimal idempotency body', async () => {
    const key = newKey();
    const body = { contactType: 'vendor', displayName: `Gone Vendor ${suffix()}` };
    __idempotencyTestHooks.settle = () => { throw new Error('settle failed'); };
    const first = await request('POST', '/contacts', body, { key });
    expect(first.status).toBe(201);
    delete __idempotencyTestHooks.settle;
    await db.delete(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityId, first.json.contact.id)));
    await db.delete(contacts).where(eq(contacts.id, first.json.contact.id));
    const replay = await request('POST', '/contacts', body, { key });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json).toEqual({ idempotency: { state: 'committed', entityType: 'contact', entityId: first.json.contact.id } });
  });
});

async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((r.rows[0] as { n: number }).n > 0) return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('the second request never waited for a lock');
}

describe('E13 settlement on error (PR-1 B2, Write Check)', () => {
  it('the second attempt meets "check number used" while the first commits, and replays instead', async () => {
    const key = newKey();
    const number = 40000 + Math.floor(Math.random() * 9999);
    const body = {
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite', txnDate: '2026-04-12', amount: '312.40',
      checkNumber: number, lines: [{ accountId: c.expense, amount: '312.40' }],
    };
    const entered = deferred();
    const gate = deferred();
    let paused = false;
    __idempotencyTestHooks.afterClaim = async () => {
      if (paused) return;
      paused = true;
      entered.resolve();
      await gate.promise;
    };
    const txns0 = await txnCount();
    const first = request('POST', '/checks', body, { key });
    await entered.promise;
    // The second attempt passes the pre-check (nothing committed yet) and
    // waits on the check counter the first one holds.
    const second = request('POST', '/checks', body, { key });
    await waitForLockWait();
    gate.resolve();
    const a = await first;
    const b = await second;
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json.check.id).toBe(a.json.check.id);
    expect(await txnCount()).toBe(txns0 + 1);
  });
});

// ── E14: the route set ───────────────────────────────────────────────

interface Case {
  name: string;
  method: string;
  path: string | (() => Promise<string>);
  body: () => Promise<unknown> | unknown;
  status: number;
  /** Something that changes exactly once when the request executes. */
  effect: () => Promise<number>;
  /** The natural answer to a second execution, when it is a refusal. */
  natural?: number;
}

async function dsTemplate() {
  const income = c.income;
  const tpl = await dailySales.createTemplate(c.tenantId, { name: `Register ${suffix()}` }, c.userId, c.companyId);
  const withLines = await dailySales.replaceTemplateLines(c.tenantId, tpl.id, [
    { section: 'sales', label: 'Sales', accountId: income, normalSide: 'credit', sortOrder: 0, isRequired: false, allowTag: false, isActive: true },
    { section: 'payment', label: 'Cash', accountId: c.bank, normalSide: 'debit', sortOrder: 1, isRequired: false, allowTag: false, isActive: true },
  ], c.userId, c.companyId);
  return {
    id: tpl.id,
    sales: withLines.lines.find((l: { label: string }) => l.label === 'Sales')!.id,
    cash: withLines.lines.find((l: { label: string }) => l.label === 'Cash')!.id,
  };
}

async function dsEntry(post: boolean) {
  const t = await dsTemplate();
  const entry = await dailySales.createDraft(c.tenantId, {
    templateId: t.id, businessDate: '2026-04-15',
    values: [{ templateLineId: t.sales, amount: '120.00' }, { templateLineId: t.cash, amount: '120.00' }],
  }, c.userId, c.companyId);
  if (post) await dailySales.postEntry(c.tenantId, entry.id, c.userId, c.companyId);
  return entry.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const count = (table: any, cond: ReturnType<typeof eq>) => async () =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(table).where(cond))[0]!.n as number;
const txnStatus = (status: string) => async () => (await db.select({ n: sql<number>`count(*)::int` }).from(transactions)
  .where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.status, status))))[0]!.n;
const occurrences = () => count(templateOccurrences, eq(templateOccurrences.tenantId, c.tenantId))();
const audits = (entityType: string, action: string) => async () => (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog)
  .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, entityType), eq(auditLog.action, action))))[0]!.n;

async function newTemplate(schedule: unknown = null) {
  const r = await request('POST', '/templates', { name: `Sweep ${suffix()}`, kind: 'transfer', draft: transferDraft(c), schedule });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.template.id as string;
}

let shared: Record<string, string> = {};

const CASES: Case[] = [
  { name: 'POST /transactions expense', method: 'POST', path: '/transactions', body: () => expense(), status: 201, effect: () => txnCount() },
  {
    name: 'POST /transactions deposit', method: 'POST', path: '/transactions', status: 201, effect: () => txnCount(),
    body: () => ({ txnType: 'deposit', txnDate: '2026-04-11', depositToAccountId: c.bank, lines: [{ accountId: c.income, amount: '75.10' }] }),
  },
  {
    name: 'POST /transactions transfer', method: 'POST', path: '/transactions', status: 201, effect: () => txnCount(),
    body: () => ({ txnType: 'transfer', txnDate: '2026-04-11', fromAccountId: c.bank, toAccountId: c.savings, amount: '20.00' }),
  },
  {
    name: 'POST /transactions journal entry with a reversal (two postings, one transaction)', method: 'POST', path: '/transactions', status: 201,
    effect: () => txnCount(),
    body: () => ({
      txnType: 'journal_entry', txnDate: '2026-04-30', reverseOn: '2026-05-01',
      lines: [{ accountId: c.expense, debit: '40.00', credit: '0' }, { accountId: c.savings, debit: '0', credit: '40.00' }],
    }),
  },
  {
    name: 'POST /transactions cash sale', method: 'POST', path: '/transactions', status: 201, effect: () => txnCount(),
    body: () => ({ txnType: 'cash_sale', txnDate: '2026-04-11', depositToAccountId: c.bank, lines: [{ accountId: c.income, quantity: '1', unitPrice: '15.00' }] }),
  },
  {
    name: 'PUT /transactions/:id', method: 'PUT', status: 200, effect: audits('transaction', 'update'),
    path: async () => `/transactions/${(await request('POST', '/transactions', expense())).json.transaction.id}`,
    body: () => expense({ memo: 'Edited' }),
  },
  {
    name: 'POST /transactions/:id/void', method: 'POST', status: 200, effect: txnStatus('void'), natural: 400,
    path: async () => `/transactions/${(await request('POST', '/transactions', expense())).json.transaction.id}/void`,
    body: () => ({ reason: 'Entered twice' }),
  },
  {
    name: 'DELETE /transactions/:id', method: 'DELETE', status: 200, effect: txnStatus('deleted'), natural: 409,
    path: async () => `/transactions/${(await request('POST', '/transactions', expense())).json.transaction.id}`,
    body: () => ({ reason: 'Duplicate' }),
  },
  {
    name: 'POST /checks', method: 'POST', path: '/checks', status: 201, effect: () => txnCount(),
    body: () => ({ bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite', txnDate: '2026-04-12', amount: '50.00', lines: [{ accountId: c.expense, amount: '50.00' }] }),
  },
  {
    name: 'PUT /checks/:id', method: 'PUT', status: 200, effect: audits('transaction', 'update'),
    path: async () => {
      const r = await request('POST', '/checks', { bankAccountId: c.bank, payeeNameOnCheck: 'Cosmos Granite', txnDate: '2026-04-12', amount: '51.00', printLater: true, lines: [{ accountId: c.expense, amount: '51.00' }] });
      return `/checks/${r.json.check.id}`;
    },
    body: () => ({ bankAccountId: c.bank, payeeNameOnCheck: 'Cosmos Granite', txnDate: '2026-04-13', amount: '52.00', printLater: true, lines: [{ accountId: c.expense, amount: '52.00' }] }),
  },
  {
    name: 'POST /invoices', method: 'POST', path: '/invoices', status: 201, effect: () => txnCount(),
    body: () => ({ txnDate: '2026-04-14', contactId: c.customer, lines: [{ accountId: c.income, quantity: '2', unitPrice: '30.00' }] }),
  },
  {
    name: 'POST /bills', method: 'POST', path: '/bills', status: 201, effect: () => txnCount(),
    body: () => ({ txnDate: '2026-04-14', contactId: c.vendor, lines: [{ accountId: c.expense, amount: '80.00' }] }),
  },
  {
    name: 'POST /daily-sales/entries', method: 'POST', path: '/daily-sales/entries', status: 201,
    effect: () => count(dailySalesEntries, eq(dailySalesEntries.tenantId, c.tenantId))(),
    body: async () => {
      const t = await dsTemplate();
      return { templateId: t.id, businessDate: '2026-04-16', values: [{ templateLineId: t.sales, amount: '10.00' }, { templateLineId: t.cash, amount: '10.00' }] };
    },
  },
  {
    name: 'POST /daily-sales/entries/:id/post', method: 'POST', status: 200, effect: () => txnCount(), natural: 400,
    path: async () => `/daily-sales/entries/${await dsEntry(false)}/post`, body: () => ({}),
  },
  {
    name: 'POST /daily-sales/entries/:id/void', method: 'POST', status: 200, effect: txnStatus('void'), natural: 400,
    path: async () => `/daily-sales/entries/${await dsEntry(true)}/void`, body: () => ({}),
  },
  {
    name: 'POST /templates', method: 'POST', path: '/templates', status: 201,
    effect: audits('template_transaction', 'create'),
    body: () => ({ name: `Sweep ${suffix()}`, kind: 'transfer', draft: transferDraft(c) }),
  },
  {
    name: 'POST /templates/from-transaction', method: 'POST', path: '/templates/from-transaction', status: 201,
    effect: audits('template_transaction', 'create'),
    body: async () => ({ transactionId: (await request('POST', '/transactions', expense())).json.transaction.id, name: `From ${suffix()}` }),
  },
  {
    name: 'POST /templates/:id/enter (no schedule)', method: 'POST', status: 201, effect: () => txnCount(),
    path: async () => `/templates/${await newTemplate()}/enter`, body: () => ({ occurrenceDate: '2026-04-20' }),
  },
  {
    // Without the key a second enter would post the schedule's next date (early).
    name: 'POST /templates/:id/enter (schedule)', method: 'POST', status: 201, effect: occurrences,
    path: async () => `/templates/${await newTemplate(monthlyAuto(PINNED_TODAY))}/enter`, body: () => ({}),
  },
  {
    name: 'POST /templates/:id/occurrences/:date/skip', method: 'POST', status: 200, effect: occurrences, natural: 409,
    path: async () => `/templates/${await newTemplate(monthlyAuto(PINNED_TODAY))}/occurrences/${PINNED_TODAY}/skip`, body: () => ({}),
  },
  {
    name: 'POST /templates/:id/occurrences/:date/resolve', method: 'POST', status: 200, effect: occurrences, natural: 400,
    path: async () => {
      shared['resolveTxn'] = (await request('POST', '/transactions', { txnType: 'transfer', txnDate: PINNED_TODAY, fromAccountId: c.bank, toAccountId: c.savings, amount: '49.0000' })).json.transaction.id;
      return `/templates/${await newTemplate(monthlyAuto(PINNED_TODAY))}/occurrences/${PINNED_TODAY}/resolve`;
    },
    body: () => ({ transactionId: shared['resolveTxn'] }),
  },
  {
    name: 'POST /accounts', method: 'POST', path: '/accounts', status: 201,
    effect: () => count(accounts, eq(accounts.tenantId, c.tenantId))(),
    body: () => ({ name: `Shop Supplies ${suffix()}`, accountType: 'expense' }),
  },
  {
    name: 'POST /contacts', method: 'POST', path: '/contacts', status: 201,
    effect: () => count(contacts, eq(contacts.tenantId, c.tenantId))(),
    body: () => ({ contactType: 'customer', displayName: `Rivera ${suffix()}` }),
  },
  {
    name: 'POST /items', method: 'POST', path: '/items', status: 201,
    effect: () => count(items, eq(items.tenantId, c.tenantId))(),
    body: () => ({ name: `Install ${suffix()}`, incomeAccountId: c.income, unitPrice: '95.00' }),
  },
  {
    name: 'POST /tags', method: 'POST', path: '/tags', status: 201,
    effect: audits('tag', 'create'),
    body: () => ({ name: `Crew ${suffix()}` }),
  },
];

describe('E14 the idempotency-v1 route set', () => {
  it.each(CASES.map((k) => [k.name, k] as const))('%s: first + replay -> one effect', async (_name, k) => {
    __idempotencyDiagnostics.unclaimed.length = 0;
    const path = typeof k.path === 'function' ? await k.path() : k.path;
    const body = await k.body();
    const key = newKey();
    const before = await k.effect();
    const first = await request(k.method, path, body, { key });
    expect(first.status, JSON.stringify(first.json)).toBe(k.status);
    const after = await k.effect();
    expect(after).toBeGreaterThan(before);
    const [row] = await keyRows(key);
    expect(row?.state).toBe('done');
    expect(row?.entityId).toBeTruthy();

    const replay = await request(k.method, path, body, { key });
    expect(replay.status, JSON.stringify(replay.json)).toBe(k.status);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json).toEqual(first.json);
    expect(await k.effect()).toBe(after);
    expect(__idempotencyDiagnostics.unclaimed).toEqual([]);

    if (k.natural !== undefined) {
      // Without the key the same request meets its natural refusal.
      const plain = await request(k.method, path, body);
      expect(plain.status).toBe(k.natural);
    }
  });
});

describe('E15 templates', () => {
  it('enter with a schedule replays the same transaction and occurrence; no second occurrence or posting', async () => {
    const id = await newTemplate(monthlyAuto(PINNED_TODAY));
    const key = newKey();
    const first = await request('POST', `/templates/${id}/enter`, {}, { key });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.occurrence).toMatchObject({ occurrenceDate: PINNED_TODAY, status: 'entered' });
    const occ0 = await occurrences();
    const txns0 = await txnCount();
    // The settle fails this time, so the replay goes through the reader.
    __idempotencyTestHooks.settle = () => { throw new Error('settle failed'); };
    const key2 = newKey();
    const second = await request('POST', `/templates/${id}/enter`, {}, { key: key2 });
    delete __idempotencyTestHooks.settle;
    expect(second.status).toBe(201);
    const replay2 = await request('POST', `/templates/${id}/enter`, {}, { key: key2 });
    expect(replay2.status).toBe(201);
    expect(replay2.headers['idempotent-replayed']).toBe('true');
    expect(replay2.json.transaction.id).toBe(second.json.transaction.id);
    expect(replay2.json.occurrence).toEqual(second.json.occurrence);
    const replay1 = await request('POST', `/templates/${id}/enter`, {}, { key });
    expect(replay1.json).toEqual(first.json);
    expect(await occurrences()).toBe(occ0 + 1);
    expect(await txnCount()).toBe(txns0 + 1);
  });

  it('a legacy template (an invoice) enters once; its posting claims the key', async () => {
    const inv = await request('POST', '/invoices', { txnDate: '2026-04-14', contactId: c.customer, lines: [{ accountId: c.income, quantity: '1', unitPrice: '300.00' }] });
    const tpl = await request('POST', '/templates/from-transaction', { transactionId: inv.json.invoice.id, name: `Retainer ${suffix()}` });
    expect(tpl.json.template.kind).toBe('legacy');
    const key = newKey();
    const txns0 = await txnCount();
    const first = await request('POST', `/templates/${tpl.json.template.id}/enter`, { occurrenceDate: '2026-05-01' }, { key });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const replay = await request('POST', `/templates/${tpl.json.template.id}/enter`, { occurrenceDate: '2026-05-01' }, { key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json).toEqual(first.json);
    expect(await txnCount()).toBe(txns0 + 1);
    const [row] = await keyRows(key);
    expect(row).toMatchObject({ state: 'done', entityType: 'transaction', entityId: first.json.transaction.id });
  });

  it('skip and resolve replay through the reader too', async () => {
    const id = await newTemplate(monthlyAuto(PINNED_TODAY));
    const key = newKey();
    __idempotencyTestHooks.settle = () => { throw new Error('settle failed'); };
    const skip = await request('POST', `/templates/${id}/occurrences/${PINNED_TODAY}/skip`, {}, { key });
    delete __idempotencyTestHooks.settle;
    expect(skip.status).toBe(200);
    const replay = await request('POST', `/templates/${id}/occurrences/${PINNED_TODAY}/skip`, {}, { key });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(skip.json);
    // The access check runs ahead of idempotent(): a template that is gone
    // (deleted, or not this company's) is 404, not a replay (L1).
    await db.execute(sql`UPDATE template_transactions SET deleted_at = now() WHERE tenant_id = ${c.tenantId} AND id = ${id}`);
    const gone = await request('POST', `/templates/${id}/occurrences/${PINNED_TODAY}/skip`, {}, { key });
    expect(gone.status, JSON.stringify(gone.json)).toBe(404);
    expect(gone.headers['idempotent-replayed']).toBeUndefined();

    const id2 =await newTemplate(monthlyAuto(PINNED_TODAY));
    const txn = (await request('POST', '/transactions', { txnType: 'transfer', txnDate: PINNED_TODAY, fromAccountId: c.bank, toAccountId: c.savings, amount: '49.0000' })).json.transaction.id;
    const key2 = newKey();
    __idempotencyTestHooks.settle = () => { throw new Error('settle failed'); };
    const resolved = await request('POST', `/templates/${id2}/occurrences/${PINNED_TODAY}/resolve`, { transactionId: txn }, { key: key2 });
    delete __idempotencyTestHooks.settle;
    expect(resolved.status).toBe(200);
    const replay2 = await request('POST', `/templates/${id2}/occurrences/${PINNED_TODAY}/resolve`, { transactionId: txn }, { key: key2 });
    expect(replay2.status).toBe(200);
    expect(replay2.json).toEqual(resolved.json);
  });
});

describe('E16 /batch/save keeps its own mechanism', () => {
  it('replays from batch_save_requests and refuses another body with 409, writing no idempotency_keys row', async () => {
    const key = newKey();
    const body = { groups: [{ txn_type: 'deposit', context_account_id: c.bank, rows: [{ rowNumber: 1, date: '2026-04-01', accountId: c.income, amount: '9.99' }] }] };
    const first = await request('POST', '/batch/save', body, { key });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const again = await request('POST', '/batch/save', body, { key });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const other = await request('POST', '/batch/save', { groups: [{ ...body.groups[0]!, rows: [{ ...body.groups[0]!.rows[0]!, amount: '1.00' }] }] }, { key });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await keyRows(key)).toHaveLength(0);
    expect(await db.select().from(batchSaveRequests).where(and(eq(batchSaveRequests.tenantId, c.tenantId), eq(batchSaveRequests.idempotencyKey, key)))).toHaveLength(1);
  });
});

describe('E21 permission', () => {
  it('a user who lost create rights gets 403 on a replay', async () => {
    const bk = await bookkeeper({ transactions: 'full' });
    const key = newKey();
    const body = expense();
    expect((await request('POST', '/transactions', body, { key, token: bk.token })).status).toBe(201);
    await db.update(userPermissions).set({ overrides: { transactions: 'view' } as never })
      .where(and(eq(userPermissions.tenantId, c.tenantId), eq(userPermissions.userId, bk.id)));
    const replay = await request('POST', '/transactions', body, { key, token: bk.token });
    expect(replay.status).toBe(403);
  });
});
