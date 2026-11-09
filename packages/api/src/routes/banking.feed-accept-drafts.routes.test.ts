// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-181 (feed-accept-draft-v1) and U-180 (document-drafts-reopen-v1) over HTTP
// against the test database:
//   - POST /banking/feed/accept with documentDraft: the row posts (or matches)
//     and the draft's file moves onto the entry in the same transaction, the
//     draft converted onto it; a replay of the key returns the same body;
//   - refusals fail the row with nothing posted: STALE, DOCUMENT_DRAFT_CLOSED
//     (details.transactionId), INVALID_KIND (statement), DOCUMENT_FILE_MISSING;
//     the same draft on two rows is 400;
//   - Undo of the posted entry deletes it and reopens the draft with its file
//     (reopenedDrafts); DELETE /transactions/:id the same; a void keeps the
//     draft converted; a draft whose file was deleted reopens without one;
//     two drafts on one entry both reopen;
//   - U-182: a failure in the attach step after the posting commits nothing
//     (the key is free again); a caller without the draft kind's permission
//     is 403 (the locked recheck fails the row); a closed draft is refused
//     without a lock;
//   - U-183: every file a relink took off the draft key (attachments
//     .source_draft_key) comes back on delete or Undo; hand-filed files stay;
//     rows without a recorded key fall back to the audit row for the own file.

import 'express-async-errors';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, companies, accounts, contacts, attachments, documentDrafts, bankConnections, bankFeedItems,
  transactions, auditLog, bankFeedAcceptGroups, userPermissions,
} from '../db/schema/index.js';
import { bankingRouter } from './banking.routes.js';
import { documentDraftsRouter } from './document-drafts.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as attachmentService from '../services/attachment.service.js';
import * as expenseService from '../services/expense.service.js';
import * as billService from '../services/bill.service.js';
import bcrypt from 'bcrypt';
import * as ledger from '../services/ledger.service.js';
import * as bankFeedAccept from '../services/bank-feed-accept.service.js';
import * as draftService from '../services/document-draft.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from '../services/tenant-portability/plan.js';

let server: Server | null = null;
let port = 0;
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function send(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        'X-Company-Id': c.companyId,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...headers,
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

interface Ctx {
  tenantId: string; ownerId: string; token: string; companyId: string;
  checking: string; supplies: string; card: string; vendor: string; conn: string;
}
let c: Ctx;
let plan: PortabilityPlan;

const keyed = (pathname: string, body: unknown, key: string = crypto.randomUUID()) =>
  send('POST', pathname, body, { 'Idempotency-Key': key });
const accept = (body: unknown, key?: string, token?: string) => send('POST', '/api/v1/banking/feed/accept', body, {
  'Idempotency-Key': key ?? crypto.randomUUID(), ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const undo = (body: unknown, key?: string) => keyed('/api/v1/banking/feed/undo', body, key);

type Draft = { id: string; updatedAt: string; status: string };

async function readyDraft(kindHint = 'card_charge', reading: { suggestedContactId?: string; docReference?: string; docTotal?: string } = {}) {
  const bytes = Buffer.from(`%PDF-1.4\n% receipt ${crypto.randomUUID()}\n%%EOF\n`);
  const draftKey = crypto.randomUUID();
  const att = await attachmentService.upload(c.tenantId, {
    originalname: 'receipt.pdf', buffer: bytes, mimetype: 'application/pdf', size: bytes.length,
  }, 'draft', draftKey, { companyId: c.companyId });
  const r = await send('POST', '/api/v1/document-drafts', { attachmentId: att!.id, kindHint });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const d = r.json.draft as Draft;
  const rd = await send('PUT', `/api/v1/document-drafts/${d.id}`, {
    expectedUpdatedAt: d.updatedAt, status: 'ready', docTotal: '42.17', docDate: '2026-08-14', ...reading,
  });
  expect(rd.status, JSON.stringify(rd.json)).toBe(200);
  return { attachmentId: att!.id as string, draftKey, draft: rd.json.draft as Draft };
}

let seq = 0;
/** A waiting money-out feed row with a staged account. */
async function feed(amount: string) {
  seq++;
  const [row] = await db.insert(bankFeedItems).values({
    tenantId: c.tenantId, companyId: c.companyId, bankConnectionId: c.conn, feedDate: '2026-08-14', amount,
    description: `ZZQD HARBOR HARDWARE ${seq}`, originalDescription: `ZZQD HARBOR HARDWARE ${seq}`, status: 'pending',
    suggestedAccountId: c.supplies, matchType: 'rule', confidenceScore: '1.00',
  }).returning();
  return row!.id;
}

const item = async (id: string) => (await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) }))!;
const fileOf = async (id: string) => (await db.select().from(attachments).where(eq(attachments.id, id)))[0]!;
const draftRow = async (id: string) => (await db.select().from(documentDrafts).where(eq(documentDrafts.id, id)))[0]!;
const txnRow = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0]!;

/** A bookkeeper of the tenant with these permission overrides. */
async function bookkeeper(overrides: Record<string, string>) {
  const [u] = await db.insert(users).values({
    tenantId: c.tenantId, email: `bk-${suffix()}@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  } as never).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper' });
  await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: u!.id, overrides: overrides as never });
  const token = (await authService.issueSession({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
  return { id: u!.id, token };
}

/** Another file uploaded onto (`type`, `id`): a draft key or an entry. */
async function uploadOn(type: string, id: string) {
  const bytes = Buffer.from(`%PDF-1.4\n% page ${crypto.randomUUID()}\n%%EOF\n`);
  const att = await attachmentService.upload(c.tenantId, {
    originalname: 'page.pdf', buffer: bytes, mimetype: 'application/pdf', size: bytes.length,
  }, type, id, { companyId: c.companyId });
  return att!.id as string;
}

async function postedExpense(amount: string) {
  const exp = await expenseService.createExpense(c.tenantId, {
    txnDate: '2026-08-12', contactId: c.vendor, payFromAccountId: c.card, lines: [{ expenseAccountId: c.supplies, amount }],
  } as Parameters<typeof expenseService.createExpense>[1], c.ownerId, c.companyId);
  return exp.id as string;
}

/** An entry paid from checking (a feed row of the same amount can match it). */
async function checkingExpense(amount: string) {
  const t = await ledger.postTransaction(c.tenantId, {
    txnType: 'expense', txnDate: '2026-08-13', total: amount,
    lines: [{ accountId: c.supplies, debit: amount, credit: '0' }, { accountId: c.checking, debit: '0', credit: amount }],
  }, c.ownerId, c.companyId);
  return t.id;
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/banking', bankingRouter);
  app.use('/api/v1/document-drafts', documentDraftsRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `u181-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Harbor Kayak Rentals',
  });
  const tenantId = reg.user.tenantId;
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const checking = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  const supplies = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) }))!.id;
  const [card] = await db.insert(accounts).values({ tenantId, name: `Visa ${suffix()}`, accountType: 'liability', detailType: 'credit_card' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: `Harbor Hardware ${suffix()}` } as never).returning();
  const [conn] = await db.insert(bankConnections).values({ tenantId, companyId: company!.id, accountId: checking, provider: 'manual' }).returning();
  c = {
    tenantId, ownerId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id,
    checking, supplies, card: card!.id, vendor: vendor!.id, conn: conn!.id,
  };
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (!c?.tenantId) return;
  for (const t of [...plan.scoped].reverse()) {
    const where = scopeSql(plan, t, 'a').replace('$1', `'${c.tenantId}'::uuid`);
    await db.execute(sql.raw(`DELETE FROM "${t}" a WHERE ${where}`)).catch(() => undefined);
  }
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, c.tenantId));
  await db.delete(users).where(eq(users.tenantId, c.tenantId)).catch(() => undefined);
  await db.delete(tenants).where(eq(tenants.id, c.tenantId)).catch(() => undefined);
});

describe('capabilities', () => {
  it('advertises feed-accept-draft-v1 and document-drafts-reopen-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('feed-accept-draft-v1');
    expect(DESKTOP_CAPABILITIES).toContain('document-drafts-reopen-v1');
  });
});

describe('POST /banking/feed/accept with documentDraft (U-181)', () => {
  it('posts the row, files the document on the entry and converts the draft, in one transaction; a replay is identical', async () => {
    const d = await readyDraft();
    const row = await feed('42.17');
    const key = crypto.randomUUID();
    const body = { items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] };
    const r = await accept(body, key);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.posted).toBe(1);
    expect(r.json.failures).toEqual([]);
    const txnId = (await item(row)).matchedTransactionId!;
    expect(txnId).toBeTruthy();
    const t = await txnRow(txnId);
    expect(t.status).toBe('posted');
    expect(t.total).toBe('42.1700');
    const f = await fileOf(d.attachmentId);
    expect(f.attachableType).toBe('expense');
    expect(f.attachableId).toBe(txnId);
    const dr = await draftRow(d.draft.id);
    expect(dr.status).toBe('converted');
    expect(dr.convertedTransactionId).toBe(txnId);
    expect(dr.convertedType).toBe('expense');
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId),
      eq(auditLog.entityType, 'document_draft'), eq(auditLog.entityId, d.draft.id)));
    const attached = audits.map((a) => a.afterData as Record<string, unknown>).find((a) => a['attached'] === true);
    expect(attached?.['feedItemId']).toBe(row);
    expect(attached?.['undoGroupId']).toBe(r.json.undoGroupId);

    const again = await accept(body, key);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(r.json);
    const n = await db.execute(sql`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = ${c.tenantId} AND id IN
      (SELECT matched_transaction_id FROM bank_feed_items WHERE id = ${row})`);
    expect((n.rows[0] as { n: number }).n).toBe(1);
  });

  it('matches the row to an existing entry and files the document on it', async () => {
    const d = await readyDraft();
    const entry = await checkingExpense('57.31');
    const row = await feed('57.31');
    const r = await accept({ items: [{ id: row, matchTransactionId: entry, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.matched).toBe(1);
    expect(r.json.failures).toEqual([]);
    expect((await fileOf(d.attachmentId)).attachableId).toBe(entry);
    expect((await draftRow(d.draft.id)).convertedTransactionId).toBe(entry);
  });

  it('a stale draft fails the row and nothing is posted', async () => {
    const d = await readyDraft();
    const row = await feed('13.05');
    const r = await accept({ items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' } }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.posted).toBe(0);
    expect(r.json.failures).toHaveLength(1);
    expect(r.json.failures[0]).toMatchObject({ id: row, code: 'STALE', details: { updatedAt: d.draft.updatedAt } });
    const it2 = await item(row);
    expect(it2.status).toBe('pending');
    expect(it2.matchedTransactionId).toBeNull();
    expect((await draftRow(d.draft.id)).status).toBe('ready');
    expect((await fileOf(d.attachmentId)).attachableType).toBe('draft');
  });

  it('a draft already entered is DOCUMENT_DRAFT_CLOSED with its transactionId; nothing is posted', async () => {
    const d = await readyDraft();
    const first = await feed('19.99');
    expect((await accept({ items: [{ id: first, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] })).json.posted).toBe(1);
    const txnId = (await item(first)).matchedTransactionId;
    const second = await feed('19.98');
    const r = await accept({ items: [{ id: second, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] });
    expect(r.json.posted).toBe(0);
    expect(r.json.failures[0]).toMatchObject({ id: second, code: 'DOCUMENT_DRAFT_CLOSED', details: { transactionId: txnId } });
    expect((await item(second)).status).toBe('pending');
  });

  it('a statement draft is INVALID_KIND; a draft without its file is DOCUMENT_FILE_MISSING; other rows still post', async () => {
    const st = await readyDraft('statement');
    const gone = await readyDraft();
    await db.update(documentDrafts).set({ attachmentId: null }).where(eq(documentDrafts.id, gone.draft.id));
    const a = await feed('21.10');
    const b = await feed('21.11');
    const ok = await feed('21.12');
    const r = await accept({ items: [
      { id: a, documentDraft: { id: st.draft.id, expectedUpdatedAt: st.draft.updatedAt } },
      { id: b, documentDraft: { id: gone.draft.id, expectedUpdatedAt: gone.draft.updatedAt } },
      { id: ok },
    ] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.posted).toBe(1);
    const codes = Object.fromEntries((r.json.failures as Array<{ id: string; code: string }>).map((f) => [f.id, f.code]));
    expect(codes[a]).toBe('INVALID_KIND');
    expect(codes[b]).toBe('DOCUMENT_FILE_MISSING');
    expect((await item(a)).status).toBe('pending');
    expect((await item(b)).status).toBe('pending');
    expect((await item(ok)).matchedTransactionId).toBeTruthy();
  });

  it('a failure in the attach step after the posting commits nothing; the same key then posts (U-182)', async () => {
    const d = await readyDraft();
    const row = await feed('47.23');
    const key = crypto.randomUUID();
    const body = { items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] };
    const groups = async () => (await db.select().from(bankFeedAcceptGroups).where(eq(bankFeedAcceptGroups.tenantId, c.tenantId))).length;
    const entries = async () => (await db.execute(sql`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = ${c.tenantId}`)).rows[0] as { n: number };
    const before = { groups: await groups(), entries: await entries() };
    let reached: string | null = null;
    draftService.__documentDraftTestHooks.afterAttachRelink = (info) => { reached = info.transactionId; throw new Error('forced failure after relink'); };
    try {
      const r = await accept(body, key);
      expect(r.status).toBe(500);
    } finally {
      delete draftService.__documentDraftTestHooks.afterAttachRelink;
    }
    // The posting ran (the hook saw its entry) and was rolled back with the rest.
    expect(reached).toBeTruthy();
    expect((await db.select().from(transactions).where(eq(transactions.id, reached!))).length).toBe(0);
    expect({ groups: await groups(), entries: await entries() }).toEqual(before);
    const it2 = await item(row);
    expect(it2.status).toBe('pending');
    expect(it2.matchedTransactionId).toBeNull();
    const dr = await draftRow(d.draft.id);
    expect(dr.status).toBe('ready');
    expect(dr.updatedAt.toISOString()).toBe(d.draft.updatedAt);
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey, sourceDraftKey: null });

    // The key was not kept either: the same request now posts, not a replay.
    const again = await accept(body, key);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
    expect(again.json.posted).toBe(1);
    expect((await draftRow(d.draft.id)).status).toBe('converted');
  });

  it('403: a caller without the draft kind\'s permission is refused before anything posts; the locked recheck fails the row (U-182)', async () => {
    const d = await readyDraft('bill');
    expect((await draftRow(d.draft.id)).kind).toBe('bill');
    const row = await feed('52.61');
    const bk = await bookkeeper({ banking: 'full', transactions: 'full', bills: 'none' });
    const body = { items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] };
    const r = await accept(body, undefined, bk.token);
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.error.code).toBe('PERMISSION_DENIED');
    expect((await item(row)).status).toBe('pending');
    expect((await draftRow(d.draft.id)).status).toBe('ready');

    // The service's recheck on the locked draft (the kind changed after the
    // route's check): the row fails PERMISSION_DENIED, nothing posts.
    const res = await bankFeedAccept.acceptFeedItems(c.tenantId, c.companyId, c.ownerId, body as never, {
      canKind: async (k) => k !== 'bill', canTarget: async () => true, canAttachType: async () => true,
    });
    expect(res.posted).toBe(0);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ id: row, code: 'PERMISSION_DENIED' });
    expect((await item(row)).status).toBe('pending');
    expect((await draftRow(d.draft.id)).status).toBe('ready');
    expect((await fileOf(d.attachmentId)).attachableType).toBe('draft');
  });

  it('a draft already entered is refused without a lock, so a delete of its entry is never blocked (U-182)', async () => {
    const d = await readyDraft();
    const exp = await postedExpense('58.08');
    expect((await keyed(`/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: exp, expectedUpdatedAt: d.draft.updatedAt })).status).toBe(200);
    await db.transaction(async (tx) => {
      await expect(draftService.lockDraftForAttach(tx, c.tenantId, c.companyId, d.draft.id, d.draft.updatedAt, async () => true))
        .rejects.toMatchObject({ code: 'DOCUMENT_DRAFT_CLOSED', details: { transactionId: exp } });
      // Another connection can lock the draft at once (a delete of the entry does).
      const other = await db.execute(sql`SELECT id FROM document_drafts WHERE id = ${d.draft.id} FOR UPDATE NOWAIT`);
      expect(other.rows).toHaveLength(1);
    });
    // A live draft is still locked (and checked again under the lock).
    const live = await readyDraft();
    await db.transaction(async (tx) => {
      const row = await draftService.lockDraftForAttach(tx, c.tenantId, c.companyId, live.draft.id, live.draft.updatedAt, async () => true);
      expect(row.id).toBe(live.draft.id);
      await expect(db.execute(sql`SELECT id FROM document_drafts WHERE id = ${live.draft.id} FOR UPDATE NOWAIT`)).rejects.toThrow();
    });
  });

  it('the same draft on two rows is 400', async () => {
    const d = await readyDraft();
    const a = await feed('31.00');
    const b = await feed('31.01');
    const dd = { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt };
    const r = await accept({ items: [{ id: a, documentDraft: dd }, { id: b, documentDraft: dd }] });
    expect(r.status).toBe(400);
    expect((await item(a)).status).toBe('pending');
  });
});

describe('feed accept with a document runs convert\'s duplicate check (U-185, feed-accept-draft-duplicates-v1)', () => {
  /** A vendor of its own per test, so other tests' entries never match. */
  async function newVendor() {
    const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'vendor', displayName: `Ozark Valley Electric ${suffix()}` } as never).returning();
    return v!.id as string;
  }
  async function bill(vendor: string, amount: string, vendorInvoiceNumber: string) {
    const b = await billService.createBill(c.tenantId, {
      contactId: vendor, txnDate: '2026-08-02', vendorInvoiceNumber, lines: [{ accountId: c.supplies, amount }],
    } as Parameters<typeof billService.createBill>[1], c.ownerId, c.companyId);
    return b.id as string;
  }
  async function vendorExpense(vendor: string, amount: string, txnDate: string) {
    const exp = await expenseService.createExpense(c.tenantId, {
      txnDate, contactId: vendor, payFromAccountId: c.card, lines: [{ expenseAccountId: c.supplies, amount }],
    } as Parameters<typeof expenseService.createExpense>[1], c.ownerId, c.companyId);
    return exp.id as string;
  }
  /** Live (not deleted or void) bills and expenses of the vendor. */
  const entriesOf = async (vendor: string) => ((await db.execute(sql`SELECT count(*)::int AS n FROM transactions
    WHERE tenant_id = ${c.tenantId} AND contact_id = ${vendor} AND status = 'posted'`)).rows[0] as { n: number }).n;
  const draftAudits = async (id: string) => (await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId),
    eq(auditLog.entityType, 'document_draft'), eq(auditLog.entityId, id)))).length;

  it('advertises feed-accept-draft-duplicates-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('feed-accept-draft-duplicates-v1');
  });

  it('T1: a document whose bill is already entered (same reference) fails the row DOCUMENT_POSSIBLE_DUPLICATE; nothing posts; a replay is the same refusal', async () => {
    const vendor = await newVendor();
    const billId = await bill(vendor, '685.55', 'INV-33994105');
    // The read reference differs only in spacing, case and leading zeros.
    const d = await readyDraft('bill', { suggestedContactId: vendor, docReference: 'inv 033994105', docTotal: '685.55' });
    const row = await feed('685.55');
    const auditsBefore = await draftAudits(d.draft.id);
    const key = crypto.randomUUID();
    const body = { items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] };
    const r = await accept(body, key);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ posted: 0, matched: 0, skipped: [] });
    expect(r.json.failures).toHaveLength(1);
    const f = r.json.failures[0];
    expect(f).toMatchObject({ id: row, code: 'DOCUMENT_POSSIBLE_DUPLICATE', details: { draftId: d.draft.id } });
    expect(f.code).not.toBe('POSSIBLE_DUPLICATE');
    expect(f.details.matches).toEqual([{
      source: 'transaction', id: billId, reason: 'reference', noVendor: false, txnType: 'bill', kind: null,
      date: '2026-08-02', total: '685.5500', reference: 'INV-33994105',
    }]);
    // Nothing posted, nothing moved.
    const it2 = await item(row);
    expect(it2.status).toBe('pending');
    expect(it2.matchedTransactionId).toBeNull();
    expect(await entriesOf(vendor)).toBe(1);
    const dr = await draftRow(d.draft.id);
    expect(dr.status).toBe('ready');
    expect(dr.updatedAt.toISOString()).toBe(d.draft.updatedAt);
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
    expect(await draftAudits(d.draft.id)).toBe(auditsBefore);

    const again = await accept(body, key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(r.json);
    expect(await entriesOf(vendor)).toBe(1);
  });

  it('T1: acknowledged matches post exactly once (audited); a replay of that key posts nothing more', async () => {
    const vendor = await newVendor();
    const billId = await bill(vendor, '685.55', 'INV-33994106');
    // Same vendor and total, no reference, 30 days before the bank line: the amount rule.
    const expId = await vendorExpense(vendor, '685.55', '2026-07-15');
    const d = await readyDraft('bill', { suggestedContactId: vendor, docReference: 'INV-33994106', docTotal: '685.55' });
    const row = await feed('685.55');
    const dd = { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt };

    const first = await accept({ items: [{ id: row, documentDraft: dd }] });
    const reasons = Object.fromEntries((first.json.failures[0].details.matches as Array<{ id: string; reason: string }>).map((m) => [m.id, m.reason]));
    expect(reasons).toEqual({ [billId]: 'reference', [expId]: 'amount_date' });

    // Only one acknowledged: the other still refuses.
    const half = await accept({ items: [{ id: row, documentDraft: { ...dd, acknowledgeDuplicateOf: [billId] } }] });
    expect(half.json.posted).toBe(0);
    expect(half.json.failures[0].code).toBe('DOCUMENT_POSSIBLE_DUPLICATE');
    expect(half.json.failures[0].details.matches.map((m: { id: string }) => m.id)).toEqual([expId]);
    expect(await entriesOf(vendor)).toBe(2);

    const key = crypto.randomUUID();
    const body = { items: [{ id: row, documentDraft: { ...dd, acknowledgeDuplicateOf: [billId.toUpperCase(), expId] } }] };
    const ok = await accept(body, key);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.posted).toBe(1);
    expect(ok.json.failures).toEqual([]);
    const txnId = (await item(row)).matchedTransactionId!;
    expect((await draftRow(d.draft.id))).toMatchObject({ status: 'converted', convertedTransactionId: txnId });
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'expense', attachableId: txnId });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId),
      eq(auditLog.entityType, 'document_draft'), eq(auditLog.entityId, d.draft.id)));
    const attached = audits.map((a) => a.afterData as Record<string, unknown>).find((a) => a['attached'] === true);
    expect(attached?.['acknowledgedDuplicates']).toEqual([billId.toUpperCase(), expId]);

    const again = await accept(body, key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(ok.json);
    // The bank line posted once: the bill, the expense and the one new entry.
    const posted = await db.execute(sql`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = ${c.tenantId}
      AND source = 'bank_feed' AND source_id = ${row} AND status = 'posted'`);
    expect((posted.rows[0] as { n: number }).n).toBe(1);
  });

  it('T1: the row\'s own contact is the vendor when the draft names none; other rows in the request still post', async () => {
    const vendor = await newVendor();
    const billId = await bill(vendor, '120.00', 'R-77');
    const d = await readyDraft('card_charge', { docReference: 'R-77', docTotal: '120.00' });
    const dup = await feed('120.00');
    const plain = await feed('120.01');
    const r = await accept({ items: [
      { id: dup, accountId: c.supplies, contactId: vendor, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } },
      { id: plain },
    ] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.posted).toBe(1);
    expect(r.json.failures).toEqual([expect.objectContaining({ id: dup, code: 'DOCUMENT_POSSIBLE_DUPLICATE' })]);
    expect(r.json.failures[0].details.matches.map((m: { id: string }) => m.id)).toEqual([billId]);
    expect((await item(dup)).status).toBe('pending');
    expect((await item(plain)).matchedTransactionId).toBeTruthy();
  });

  it('a document with no matching entry posts as before', async () => {
    const vendor = await newVendor();
    await bill(vendor, '300.00', 'OTHER-1');
    const d = await readyDraft('bill', { suggestedContactId: vendor, docReference: 'NEW-2', docTotal: '42.17' });
    const row = await feed('42.17');
    const r = await accept({ items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] });
    expect(r.json.posted, JSON.stringify(r.json)).toBe(1);
  });
});

describe('feed accept with a document and no vendor still checks for duplicates (U-99, document-duplicates-no-vendor-v1)', () => {
  async function newVendor(name: string) {
    const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'vendor', displayName: `${name} ${suffix()}` } as never).returning();
    return v!.id as string;
  }
  async function datedBill(vendor: string, amount: string, txnDate: string, vendorInvoiceNumber: string) {
    const b = await billService.createBill(c.tenantId, {
      contactId: vendor, txnDate, vendorInvoiceNumber, lines: [{ accountId: c.supplies, amount }],
    } as Parameters<typeof billService.createBill>[1], c.ownerId, c.companyId);
    return b.id as string;
  }
  async function datedFeed(amount: string, feedDate: string) {
    const row = await feed(amount);
    await db.update(bankFeedItems).set({ feedDate }).where(eq(bankFeedItems.id, row));
    return row;
  }
  const postedFrom = async (row: string) => ((await db.execute(sql`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = ${c.tenantId}
    AND source = 'bank_feed' AND source_id = ${row} AND status = 'posted'`)).rows[0] as { n: number }).n;

  it('advertises document-duplicates-no-vendor-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('document-duplicates-no-vendor-v1');
  });

  it('QA-1: a bill entered by hand, its document read with no vendor, the autopay line accepted with an account only: refused; acknowledged, it posts once', async () => {
    const whitfield = await newVendor('Whitfield & Moore CPAs, PLLC');
    const billId = await datedBill(whitfield, '1892.30', '2026-01-23', '26095');
    const d = await readyDraft('card_charge', { docReference: '26095', docTotal: '1892.30' });
    const row = await datedFeed('1892.30', '2026-01-26');
    const dd = { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt };

    const r = await accept({ items: [{ id: row, accountId: c.supplies, documentDraft: dd }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.posted).toBe(0);
    expect(r.json.failures).toHaveLength(1);
    expect(r.json.failures[0]).toMatchObject({ id: row, code: 'DOCUMENT_POSSIBLE_DUPLICATE', details: { draftId: d.draft.id } });
    expect(r.json.failures[0].details.matches).toEqual([{
      source: 'transaction', id: billId, reason: 'reference', noVendor: true, txnType: 'bill', kind: null,
      date: '2026-01-23', total: '1892.3000', reference: '26095',
    }]);
    // Nothing posted; the bill is still open and the draft untouched.
    expect(await postedFrom(row)).toBe(0);
    expect((await item(row)).status).toBe('pending');
    expect(await txnRow(billId)).toMatchObject({ status: 'posted', balanceDue: '1892.3000' });
    expect((await draftRow(d.draft.id)).status).toBe('ready');

    const key = crypto.randomUUID();
    const body = { items: [{ id: row, accountId: c.supplies, documentDraft: { ...dd, acknowledgeDuplicateOf: [billId] } }] };
    const ok = await accept(body, key);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.posted).toBe(1);
    expect(ok.json.failures).toEqual([]);
    const again = await accept(body, key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await postedFrom(row)).toBe(1);
    expect((await draftRow(d.draft.id)).status).toBe('converted');
  });

  it('no vendor and no reference: the same total within 7 days matches (noVendor); 8 days away does not', async () => {
    const v = await newVendor('Window');
    const near = await datedBill(v, '2207.07', '2026-03-03', `W-${suffix()}`);
    const nearDraft = await readyDraft('card_charge', { docTotal: '2207.07' });
    const nearRow = await datedFeed('2207.07', '2026-03-10');
    const r = await accept({ items: [{ id: nearRow, documentDraft: { id: nearDraft.draft.id, expectedUpdatedAt: nearDraft.draft.updatedAt } }] });
    expect(r.json.failures, JSON.stringify(r.json)).toEqual([expect.objectContaining({ id: nearRow, code: 'DOCUMENT_POSSIBLE_DUPLICATE' })]);
    expect(r.json.failures[0].details.matches).toEqual([expect.objectContaining({ id: near, reason: 'amount_date', noVendor: true })]);

    await datedBill(v, '2208.08', '2026-03-02', `W-${suffix()}`);
    const farDraft = await readyDraft('card_charge', { docTotal: '2208.08' });
    const farRow = await datedFeed('2208.08', '2026-03-10');
    const far = await accept({ items: [{ id: farRow, documentDraft: { id: farDraft.draft.id, expectedUpdatedAt: farDraft.draft.updatedAt } }] });
    expect(far.json.failures, JSON.stringify(far.json)).toEqual([]);
    expect(far.json.posted).toBe(1);
  });
});

describe('feed accept with a document in a closed period (PR-A1 T3)', () => {
  const PASSWORD = 'feed-accept-drafts-pass-1';
  it('without the password the row fails closed and nothing changes; with it the row posts, the draft is filed and the override audited', async () => {
    const d = await readyDraft();
    const row = await feed('44.44');
    const auditCount = async (entityType: string, entityId?: string) => (await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, entityType), entityId ? eq(auditLog.entityId, entityId) : undefined))).length;
    const draftAuditsBefore = await auditCount('document_draft', d.draft.id);
    const overridesBefore = await auditCount('closing_date_override');
    await db.update(companies).set({ lockDate: '2026-08-31', closingPasswordHash: await bcrypt.hash(PASSWORD, 4) })
      .where(eq(companies.id, c.companyId));
    try {
      const body = { items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] };
      const locked = await accept(body);
      expect(locked.status, JSON.stringify(locked.json)).toBe(200);
      expect(locked.json.posted).toBe(0);
      expect(locked.json.failures).toEqual([expect.objectContaining({ id: row, code: 'TB_PERIOD_LOCKED' })]);
      expect(locked.json.failures[0].details).toMatchObject({ closingPasswordRequired: true });
      expect((await item(row))).toMatchObject({ status: 'pending', matchedTransactionId: null });
      const dr = await draftRow(d.draft.id);
      expect(dr.status).toBe('ready');
      expect(dr.updatedAt.toISOString()).toBe(d.draft.updatedAt);
      expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
      expect(await auditCount('document_draft', d.draft.id)).toBe(draftAuditsBefore);
      expect(await auditCount('closing_date_override')).toBe(overridesBefore);

      const ok = await accept({ ...body, closingPassword: PASSWORD });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json.posted).toBe(1);
      expect(ok.json.failures).toEqual([]);
      const txnId = (await item(row)).matchedTransactionId!;
      expect(await draftRow(d.draft.id)).toMatchObject({ status: 'converted', convertedTransactionId: txnId });
      expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'expense', attachableId: txnId });
      expect(await auditCount('closing_date_override')).toBe(overridesBefore + 1);
      const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.tenantId, c.tenantId)));
      expect(all).not.toContain(PASSWORD);
    } finally {
      await db.update(companies).set({ lockDate: null, closingPasswordHash: null }).where(eq(companies.id, c.companyId));
    }
  });
});

describe('deleting an entry reopens its drafts (U-180)', () => {
  it('Undo deletes the posted entry and puts the draft back with its file (reopenedDrafts)', async () => {
    const d = await readyDraft();
    const row = await feed('64.40');
    const r = await accept({ items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] });
    expect(r.json.posted).toBe(1);
    const txnId = (await item(row)).matchedTransactionId!;
    const u = await undo({ feedItemIds: [row] });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.undone[0]).toMatchObject({ id: row, entry: 'deleted' });
    expect(u.json.reopenedDrafts).toEqual([d.draft.id]);
    expect((await txnRow(txnId)).status).toBe('deleted');
    const dr = await draftRow(d.draft.id);
    expect(dr.status).toBe('ready');
    expect(dr.convertedTransactionId).toBeNull();
    expect(dr.convertedType).toBeNull();
    expect(dr.convertedAt).toBeNull();
    const f = await fileOf(d.attachmentId);
    expect(f.attachableType).toBe('draft');
    expect(f.attachableId).toBe(d.draftKey);
    expect((await item(row)).status).toBe('pending');

    // The reopened draft is live again: accept it with its new token.
    const fresh = await send('GET', `/api/v1/document-drafts/${d.draft.id}`);
    const again = await accept({ items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: fresh.json.draft.updatedAt } }] });
    expect(again.json.posted, JSON.stringify(again.json)).toBe(1);
    expect((await draftRow(d.draft.id)).status).toBe('converted');
  });

  it('Undo of a match keeps the entry and its document', async () => {
    const d = await readyDraft();
    const entry = await checkingExpense('71.03');
    const row = await feed('71.03');
    expect((await accept({ items: [{ id: row, matchTransactionId: entry, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] })).json.matched).toBe(1);
    const u = await undo({ feedItemIds: [row] });
    expect(u.json.undone[0]).toMatchObject({ entry: 'kept' });
    expect(u.json.reopenedDrafts).toEqual([]);
    expect((await draftRow(d.draft.id)).status).toBe('converted');
  });

  it('DELETE /transactions/:id reopens every draft on the entry; one whose file was deleted reopens without it', async () => {
    const a = await readyDraft();
    const b = await readyDraft();
    const gone = await readyDraft();
    const exp = await postedExpense('88.20');
    for (const d of [a, b, gone]) {
      const r = await keyed(`/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: exp, expectedUpdatedAt: d.draft.updatedAt });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    await attachmentService.remove(c.tenantId, gone.attachmentId, c.companyId);
    expect((await draftRow(gone.draft.id)).attachmentId).toBeNull();

    const del = await send('DELETE', `/api/v1/transactions/${exp}`, {});
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect(del.json.transaction.status).toBe('deleted');
    expect(del.json.reopenedDrafts).toEqual([a.draft.id, b.draft.id, gone.draft.id].sort());
    for (const d of [a, b]) {
      expect((await draftRow(d.draft.id)).status).toBe('ready');
      const f = await fileOf(d.attachmentId);
      expect(f.attachableType).toBe('draft');
      expect(f.attachableId).toBe(d.draftKey);
    }
    const g = await draftRow(gone.draft.id);
    expect(g.status).toBe('ready');
    expect(g.attachmentId).toBeNull();
    const reopenAudit = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId),
      eq(auditLog.entityType, 'document_draft'), eq(auditLog.entityId, a.draft.id)));
    expect(reopenAudit.some((x) => (x.afterData as Record<string, unknown>)['reopened'] === true)).toBe(true);
  });

  it('every file the attach took off the draft key comes back; a file filed by hand stays; another live draft\'s file never left (U-183)', async () => {
    const d = await readyDraft();
    const second = await uploadOn('draft', d.draftKey);
    const othersFile = await uploadOn('draft', d.draftKey);
    const claim = await send('POST', '/api/v1/document-drafts', { attachmentId: othersFile, kindHint: 'card_charge' });
    expect(claim.status, JSON.stringify(claim.json)).toBe(201);
    const exp = await postedExpense('61.19');
    const byHand = await uploadOn('expense', exp);
    const r = await keyed(`/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: exp, expectedUpdatedAt: d.draft.updatedAt });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (const id of [d.attachmentId, second]) {
      expect(await fileOf(id)).toMatchObject({ attachableType: 'expense', attachableId: exp, sourceDraftKey: d.draftKey });
    }
    expect(await fileOf(othersFile)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
    expect((await fileOf(byHand)).sourceDraftKey).toBeNull();

    const del = await send('DELETE', `/api/v1/transactions/${exp}`, {});
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect(del.json.reopenedDrafts).toEqual([d.draft.id]);
    for (const id of [d.attachmentId, second, othersFile]) {
      expect(await fileOf(id)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey, sourceDraftKey: null });
    }
    expect(await fileOf(byHand)).toMatchObject({ attachableType: 'expense', attachableId: exp });
    const moved = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId),
      eq(auditLog.entityType, 'attachment'), eq(auditLog.entityId, second)));
    expect(moved.some((x) => (x.afterData as Record<string, unknown>)['reopenedDraftId'] === d.draft.id)).toBe(true);
  });

  it('a feed accept\'s relink records the key too; Undo brings back every file of it (U-183)', async () => {
    const d = await readyDraft();
    const second = await uploadOn('draft', d.draftKey);
    const row = await feed('66.02');
    const r = await accept({ items: [{ id: row, documentDraft: { id: d.draft.id, expectedUpdatedAt: d.draft.updatedAt } }] });
    expect(r.json.posted, JSON.stringify(r.json)).toBe(1);
    const txnId = (await item(row)).matchedTransactionId!;
    expect(await fileOf(second)).toMatchObject({ attachableId: txnId, sourceDraftKey: d.draftKey });
    const u = await undo({ feedItemIds: [row] });
    expect(u.json.reopenedDrafts).toEqual([d.draft.id]);
    for (const id of [d.attachmentId, second]) {
      expect(await fileOf(id)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey, sourceDraftKey: null });
    }
  });

  it('a file relinked before migration 0270 (no recorded key): the own file comes back by the audit row, as before', async () => {
    const d = await readyDraft();
    const second = await uploadOn('draft', d.draftKey);
    const exp = await postedExpense('63.47');
    expect((await keyed(`/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: exp, expectedUpdatedAt: d.draft.updatedAt })).status).toBe(200);
    await db.update(attachments).set({ sourceDraftKey: null }).where(eq(attachments.attachableId, exp));
    const del = await send('DELETE', `/api/v1/transactions/${exp}`, {});
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
    expect(await fileOf(second)).toMatchObject({ attachableType: 'expense', attachableId: exp });
  });

  it('a hand link clears the recorded key', async () => {
    const d = await readyDraft();
    const exp = await postedExpense('67.70');
    const other = await postedExpense('67.71');
    const second = await uploadOn('draft', d.draftKey);
    expect((await keyed(`/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: exp, expectedUpdatedAt: d.draft.updatedAt })).status).toBe(200);
    expect((await fileOf(second)).sourceDraftKey).toBe(d.draftKey);
    await attachmentService.linkAttachment(c.tenantId, second, 'expense', other, c.companyId);
    expect(await fileOf(second)).toMatchObject({ attachableId: other, sourceDraftKey: null });
  });

  it('a void keeps the entry, so its draft stays converted', async () => {
    const d = await readyDraft();
    const exp = await postedExpense('90.01');
    expect((await keyed(`/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: exp, expectedUpdatedAt: d.draft.updatedAt })).status).toBe(200);
    await ledger.voidTransaction(c.tenantId, exp, 'test void', c.ownerId);
    const dr = await draftRow(d.draft.id);
    expect(dr.status).toBe('converted');
    expect(dr.convertedTransactionId).toBe(exp);
  });
});
