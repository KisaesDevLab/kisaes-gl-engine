// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-95 (document-drafts-attach-v1) over HTTP against the test database:
//   a. POST /document-drafts/:id/attach: the attach matrix (T9): attachable
//      type from the target (bill, expense, deposit), refusals (void,
//      deleted, draft-status, other company, not attachable, stale, closed,
//      file filed elsewhere), success when already on the target, rollback
//      leaves no audit row, closed period needs no password and is audited,
//      re-claim of the same bytes 409, key replay, the permission pair
//      (before the replay too), a concurrent void in both orders, other files
//      on the key;
//   b. the live-draft file guard (review M2) on every plain draft-key
//      relink (bills create and attach-draft, checks, transactions, vendor
//      credits, daily sales, AJEs, tax entries) and on POST
//      /attachments/:id/link (409 ATTACHMENT_IN_USE); a convert afterwards
//      relinks the file and posts once; claim vs relink and claim vs link in
//      both orders;
//   c. GET /transactions?amount= exact numeric filter.

import 'express-async-errors';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, userPermissions, companies, accounts, contacts, attachments, documentDrafts,
} from '../db/schema/index.js';
import { documentDraftsRouter } from './document-drafts.routes.js';
import { attachmentsRouter } from './attachments.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { checksRouter } from './checks.routes.js';
import { billsRouter } from './bills.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as attachmentService from '../services/attachment.service.js';
import * as billService from '../services/bill.service.js';
import * as expenseService from '../services/expense.service.js';
import * as vendorCreditService from '../services/vendor-credit.service.js';
import * as ledger from '../services/ledger.service.js';
import { __documentDraftTestHooks } from '../services/document-draft.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from '../services/tenant-portability/plan.js';

const CLOSING_PHRASE = 'closing-pass-u95'; // gitleaks:allow (test placeholder)

let server: Server | null = null;
let port = 0;
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function send(method: string, pathname: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        Authorization: `Bearer ${token}`,
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
  tenantId: string; ownerId: string; token: string; companyA: string; companyB: string;
  bank: string; card: string; expense: string; income: string; vendor: string;
}
let c: Ctx;
let plan: PortabilityPlan;

const call = (method: string, pathname: string, body?: unknown, opts: { company?: string; key?: string; token?: string } = {}) =>
  send(method, pathname, opts.token ?? c.token, body, {
    'X-Company-Id': opts.company ?? c.companyA,
    ...(opts.key ? { 'Idempotency-Key': opts.key } : {}),
  });

const key = () => crypto.randomUUID();

async function vendor(name: string, companyId: string | null = null): Promise<string> {
  const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'vendor', displayName: `${name} ${suffix()}`, companyId } as never).returning();
  return v!.id;
}

const docBytes = (label: string) => Buffer.from(`%PDF-1.4\n% ${label} ${crypto.randomUUID()}\n%%EOF\n`);

async function upload(bytes: Buffer, draftKey = crypto.randomUUID(), companyId: string | null = c.companyA) {
  const att = await attachmentService.upload(c.tenantId, {
    originalname: 'receipt.pdf', buffer: bytes, mimetype: 'application/pdf', size: bytes.length,
  }, 'draft', draftKey, { companyId });
  return { attachmentId: att!.id, draftKey };
}

type Draft = { id: string; updatedAt: string; status: string };

/** Uploads a new document, claims it in `company` and stores an empty reading. */
async function readyDraft(label = 'doc', kindHint = 'card_charge', company = c.companyA, bytes = docBytes(label)) {
  const up = await upload(bytes, crypto.randomUUID(), company);
  const r = await call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId, kindHint }, { company });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const d = r.json.draft as Draft;
  const rd = await call('PUT', `/api/v1/document-drafts/${d.id}`, { expectedUpdatedAt: d.updatedAt, status: 'ready' }, { company });
  expect(rd.status, JSON.stringify(rd.json)).toBe(200);
  return { ...up, bytes, draft: rd.json.draft as Draft };
}

async function postedBill(amount = '25.00', companyId = c.companyA, txnDate = '2026-03-14') {
  const bill = await billService.createBill(c.tenantId, {
    contactId: c.vendor, txnDate, vendorInvoiceNumber: `INV-${suffix()}`, lines: [{ accountId: c.expense, amount }],
  } as Parameters<typeof billService.createBill>[1], c.ownerId, companyId);
  return bill.id as string;
}

async function postedExpense(amount = '25.00', companyId = c.companyA, txnDate = '2026-03-14') {
  const exp = await expenseService.createExpense(c.tenantId, {
    txnDate, contactId: c.vendor, payFromAccountId: c.card, lines: [{ expenseAccountId: c.expense, amount }],
  } as Parameters<typeof expenseService.createExpense>[1], c.ownerId, companyId);
  return exp.id as string;
}

async function count(text: string, ...params: unknown[]): Promise<number> {
  let i = 0;
  const r = await db.execute(sql.raw(text.replace(/\$\d+/g, () => {
    const v = params[i++];
    return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
  })));
  return (r.rows[0] as { n: number }).n;
}

const attachCall = (d: { id: string; updatedAt: string }, transactionId: string, opts: { company?: string; key?: string; token?: string } = {}) =>
  call('POST', `/api/v1/document-drafts/${d.id}/attach`, { transactionId, expectedUpdatedAt: d.updatedAt }, opts);

async function fileOf(id: string) {
  const [a] = await db.select().from(attachments).where(eq(attachments.id, id));
  return a!;
}

async function draftRow(id: string) {
  const [d] = await db.select().from(documentDrafts).where(eq(documentDrafts.id, id));
  return d!;
}

async function bookkeeper(overrides: Record<string, string>) {
  const [u] = await db.insert(users).values({
    tenantId: c.tenantId, email: `bk-${suffix()}@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper' });
  await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: u!.id, overrides: overrides as never });
  const token = (await authService.issueSession({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
  return { id: u!.id, token };
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/document-drafts', documentDraftsRouter);
  app.use('/api/v1/attachments', attachmentsRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/checks', checksRouter);
  app.use('/api/v1/bills', billsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `u95-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Ozark Excavating',
  });
  const tenantId = reg.user.tenantId;
  const [companyA] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: 'Table Rock Marina', setupComplete: true }).returning();
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expense = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  const income = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const [card] = await db.insert(accounts).values({ tenantId, name: `Visa ${suffix()}`, accountType: 'liability', detailType: 'credit_card' }).returning();
  c = {
    tenantId, ownerId: reg.user.id, token: reg.tokens.accessToken, companyA: companyA!.id, companyB: companyB!.id,
    bank: bank!.id, card: card!.id, expense: expense!.id, income: income!.id, vendor: '',
  };
  c.vendor = await vendor('Cosmos Granite');
}, 120_000);

afterEach(() => {
  delete __documentDraftTestHooks.beforeTargetLock;
  delete __documentDraftTestHooks.afterAttachRelink;
  delete attachmentService.__attachmentTestHooks.afterKeyLock;
  delete attachmentService.__attachmentTestHooks.afterLinkLock;
});

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

describe('capability', () => {
  it('advertises document-drafts-attach-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('document-drafts-attach-v1');
  });
});

// ── a. Attach ────────────────────────────────────────────────────────

describe('attach (POST /document-drafts/:id/attach)', () => {
  it('files the document on a posted expense: attachable type from the target, audited, keyed replay, a new key is closed', async () => {
    const target = await postedExpense('25.00');
    const d = await readyDraft('attach-expense', 'card_charge');
    const txnsBefore = await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1`, c.tenantId);
    const kk = key();
    const r = await attachCall(d.draft, target, { key: kk });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.draft).toMatchObject({ status: 'converted', kind: 'card_charge', convertedTransactionId: target, convertedType: 'expense' });
    expect(r.json.transaction.id).toBe(target);
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'expense', attachableId: target, companyId: c.companyA });
    // Nothing posted.
    expect(await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1`, c.tenantId)).toBe(txnsBefore);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'attachment' AND entity_id = $2 AND action = 'update'`, c.tenantId, d.attachmentId)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'document_draft' AND entity_id = $2 AND (after_data #>> '{}') LIKE '%"attached":true%'`, c.tenantId, d.draft.id)).toBe(1);

    const replay = await attachCall(d.draft, target, { key: kk });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json.draft.convertedTransactionId).toBe(target);
    const fresh = await attachCall(d.draft, target, { key: key() });
    expect(fresh.status).toBe(409);
    expect(fresh.json.error.code).toBe('DOCUMENT_DRAFT_CLOSED');
    expect(fresh.json.error.details.transactionId).toBe(target);
    // The converted draft keeps its claim: the same bytes again are 409.
    const again = await upload(d.bytes);
    const reclaim = await call('POST', '/api/v1/document-drafts', { attachmentId: again.attachmentId });
    expect(reclaim.status).toBe(409);
    expect(reclaim.json.error.code).toBe('DOCUMENT_ALREADY_CLAIMED');
    expect(reclaim.json.error.details.draftId).toBe(d.draft.id);
  });

  it('a bill target files as bill; a deposit target as deposit', async () => {
    const bill = await postedBill('40.00');
    const d1 = await readyDraft('attach-bill', 'bill');
    const r1 = await attachCall(d1.draft, bill);
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect(r1.json.draft.convertedType).toBe('bill');
    expect(await fileOf(d1.attachmentId)).toMatchObject({ attachableType: 'bill', attachableId: bill });

    const dep = await call('POST', '/api/v1/transactions', {
      txnType: 'deposit', txnDate: '2026-03-15', depositToAccountId: c.bank, lines: [{ accountId: c.income, amount: '310.00' }],
    });
    expect(dep.status, JSON.stringify(dep.json)).toBe(201);
    const d2 = await readyDraft('attach-deposit', 'cash_expense');
    const r2 = await attachCall(d2.draft, dep.json.transaction.id);
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect(r2.json.draft).toMatchObject({ convertedType: 'deposit', kind: 'cash_expense' });
    expect(await fileOf(d2.attachmentId)).toMatchObject({ attachableType: 'deposit', attachableId: dep.json.transaction.id });
  });

  it('void, deleted and draft-status targets are refused; another company\'s target and draft are 404; nothing is written', async () => {
    const d = await readyDraft('refusals');
    // Audit rows of this draft and its file only (the setup below writes others).
    const audit = () => count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_id IN ($2, $3)`, c.tenantId, d.draft.id, d.attachmentId);
    const before = await audit();

    const voided = await postedExpense('11.00');
    await ledger.voidTransaction(c.tenantId, voided, 'test', c.ownerId, { companyId: c.companyA } as never);
    const rv = await attachCall(d.draft, voided);
    expect(rv.status).toBe(409);
    expect(rv.json.error).toMatchObject({ code: 'TRANSACTION_NOT_POSTED', details: { status: 'void' } });

    const drafted = await postedExpense('12.00');
    await db.execute(sql`UPDATE transactions SET status = 'draft' WHERE id = ${drafted}`);
    const rd = await attachCall(d.draft, drafted);
    expect(rd.status).toBe(409);
    expect(rd.json.error).toMatchObject({ code: 'TRANSACTION_NOT_POSTED', details: { status: 'draft' } });

    const deleted = await postedExpense('13.00');
    await db.execute(sql`UPDATE transactions SET status = 'deleted' WHERE id = ${deleted}`);
    expect((await attachCall(d.draft, deleted)).status).toBe(404);
    expect((await attachCall(d.draft, crypto.randomUUID())).status).toBe(404);

    const otherCompany = await postedExpense('14.00', c.companyB);
    expect((await attachCall(d.draft, otherCompany)).status).toBe(404);
    const dB = await readyDraft('company-b', 'card_charge', c.companyB);
    const target = await postedExpense('15.00');
    expect((await attachCall(dB.draft, target)).status).toBe(404);

    expect((await call('POST', `/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: target })).status).toBe(400);
    expect((await call('POST', `/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: 'nope', expectedUpdatedAt: d.draft.updatedAt })).status).toBe(400);
    const stale = await call('POST', `/api/v1/document-drafts/${d.draft.id}/attach`, { transactionId: target, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE');

    expect(await audit()).toBe(before);
    expect((await draftRow(d.draft.id)).status).toBe('ready');
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
    expect(await count(`SELECT count(*)::int AS n FROM idempotency_keys WHERE tenant_id = $1 AND entity_id = $2`, c.tenantId, d.draft.id)).toBe(0);
    // A discarded draft is closed.
    const dd = await readyDraft('discarded');
    const disc = await call('POST', `/api/v1/document-drafts/${dd.draft.id}/discard`);
    const rc = await attachCall(disc.json.draft, target);
    expect(rc.status).toBe(409);
    expect(rc.json.error.code).toBe('DOCUMENT_DRAFT_CLOSED');
  });

  it('a file already filed elsewhere is 422 ATTACHMENT_NOT_DRAFT; already on the target succeeds', async () => {
    const t1 = await postedExpense('16.00');
    const t2 = await postedExpense('17.00');
    const d = await readyDraft('elsewhere');
    await db.execute(sql`UPDATE attachments SET attachable_type = 'expense', attachable_id = ${t1} WHERE id = ${d.attachmentId}`);
    const r = await attachCall(d.draft, t2);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('ATTACHMENT_NOT_DRAFT');
    expect((await draftRow(d.draft.id)).status).toBe('ready');
    const ok = await attachCall(d.draft, t1);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.draft).toMatchObject({ status: 'converted', convertedTransactionId: t1 });
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'expense', attachableId: t1 });
  });

  it('a failure after the relink rolls back everything: no audit row, no key, the file on its key', async () => {
    const target = await postedExpense('18.00');
    const d = await readyDraft('rollback');
    const counts = async () => ({
      audit: await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1`, c.tenantId),
      keys: await count(`SELECT count(*)::int AS n FROM idempotency_keys WHERE tenant_id = $1`, c.tenantId),
    });
    const before = await counts();
    let reached = false;
    __documentDraftTestHooks.afterAttachRelink = () => { reached = true; throw new Error('forced failure after relink'); };
    const kk = key();
    const r = await attachCall(d.draft, target, { key: kk });
    expect(reached).toBe(true);
    expect(r.status).toBe(500);
    expect(await counts()).toEqual(before);
    expect((await draftRow(d.draft.id)).status).toBe('ready');
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
    delete __documentDraftTestHooks.afterAttachRelink;
    const again = await attachCall(d.draft, target, { key: kk });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
  });

  it('a target in a closed period needs no password; the audit row is written', async () => {
    const target = await postedExpense('19.00', c.companyA, '2026-01-10');
    const hash = await bcrypt.hash(CLOSING_PHRASE, 4);
    await db.update(companies).set({ lockDate: '2026-01-31', closingPasswordHash: hash } as never).where(eq(companies.id, c.companyA));
    try {
      const d = await readyDraft('closed');
      const r = await attachCall(d.draft, target);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'document_draft' AND entity_id = $2 AND (after_data #>> '{}') LIKE '%"attached":true%'`, c.tenantId, d.draft.id)).toBe(1);
    } finally {
      await db.update(companies).set({ lockDate: null, closingPasswordHash: null } as never).where(eq(companies.id, c.companyA));
    }
  });

  it('moves the other files on the key, except one another live draft reads', async () => {
    const draftKey = crypto.randomUUID();
    const a1 = (await upload(docBytes('k1'), draftKey)).attachmentId;
    const a2 = (await upload(docBytes('k2'), draftKey)).attachmentId;
    const a3 = (await upload(docBytes('k3'), draftKey)).attachmentId;
    const d1 = await call('POST', '/api/v1/document-drafts', { attachmentId: a1, kindHint: 'card_charge' });
    const d2 = await call('POST', '/api/v1/document-drafts', { attachmentId: a2 });
    expect([d1.status, d2.status]).toEqual([201, 201]);
    const target = await postedExpense('20.00');
    const r = await attachCall(d1.json.draft, target);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await db.select().from(attachments).where(eq(attachments.attachableId, draftKey))).map((x) => x.id)).toEqual([a2]);
    expect((await db.select().from(attachments).where(eq(attachments.attachableId, target))).map((x) => x.id).sort()).toEqual([a1, a3].sort());
  });

  it('the permission pair: the draft kind\'s and the target\'s, checked before a replay', async () => {
    const target = await postedExpense('21.00');
    const billTarget = await postedBill('22.00');
    const transactionsOnly = await bookkeeper({ transactions: 'full' });
    const billsOnly = await bookkeeper({ bills: 'full' });
    const both = await bookkeeper({ bills: 'full', transactions: 'full' });

    const dBill = await readyDraft('perm-bill', 'bill');
    // Draft kind bill needs bills; the expense target needs transactions.
    expect((await attachCall(dBill.draft, target, { token: transactionsOnly.token })).status).toBe(403);
    expect((await attachCall(dBill.draft, target, { token: billsOnly.token })).status).toBe(403);
    // A bill target needs bills only.
    const dBill2 = await readyDraft('perm-bill2', 'bill');
    const okBill = await attachCall(dBill2.draft, billTarget, { token: billsOnly.token });
    expect(okBill.status, JSON.stringify(okBill.json)).toBe(200);
    // A card charge onto an expense needs transactions only.
    const dCard = await readyDraft('perm-card', 'card_charge');
    expect((await attachCall(dCard.draft, billTarget, { token: transactionsOnly.token })).status).toBe(403);
    const kk = key();
    const ok = await attachCall(dBill.draft, target, { token: both.token, key: kk });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // Permission removed: the replay is refused too.
    await db.update(userPermissions).set({ overrides: { bills: 'full' } as never }).where(eq(userPermissions.userId, both.id));
    const replay = await attachCall(dBill.draft, target, { token: both.token, key: kk });
    expect(replay.status).toBe(403);
    expect(replay.headers['idempotent-replayed']).toBeUndefined();
  });

  it('concurrent void: a void that locked the target first wins (409); one that comes after the attach waits for it', async () => {
    // Void first: the void holds the row, the attach waits, then sees it void.
    const t1 = await postedExpense('23.00');
    const d1 = await readyDraft('void-first');
    let attachP: Promise<Res> | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM transactions WHERE id = ${t1} FOR UPDATE`);
      await tx.execute(sql`UPDATE transactions SET status = 'void' WHERE id = ${t1}`);
      attachP = attachCall(d1.draft, t1);
      await pause(300);
    });
    const r1 = await attachP!;
    expect(r1.status).toBe(409);
    expect(r1.json.error.code).toBe('TRANSACTION_NOT_POSTED');
    expect((await draftRow(d1.draft.id)).status).toBe('ready');

    // Attach first: a void started while the attach holds the target waits, then voids.
    const t2 = await postedExpense('24.00');
    const d2 = await readyDraft('attach-first');
    let voidP: Promise<unknown> | null = null;
    let voidDone = false;
    __documentDraftTestHooks.afterAttachRelink = async () => {
      voidP = ledger.voidTransaction(c.tenantId, t2, 'race', c.ownerId, { companyId: c.companyA } as never).then(() => { voidDone = true; });
      await pause(300);
      expect(voidDone).toBe(false);
    };
    const r2 = await attachCall(d2.draft, t2);
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    await voidP;
    expect(voidDone).toBe(true);
    const st = (await db.execute(sql`SELECT status FROM transactions WHERE id = ${t2}`)).rows[0] as { status: string };
    expect(st.status).toBe('void');
    expect(await fileOf(d2.attachmentId)).toMatchObject({ attachableType: 'expense', attachableId: t2 });
  });
});

// ── b. The live-draft file guard ─────────────────────────────────────

describe('live-draft file guard (review M2)', () => {
  /** A claimed (live) draft whose file is on its draft key, plus an unclaimed file on the same key. */
  async function claimedKey(kindHint = 'bill') {
    const d = await readyDraft(`guard-${kindHint}`, kindHint);
    const spare = (await upload(docBytes('spare'), d.draftKey)).attachmentId;
    return { ...d, spare };
  }

  async function expectGuarded(d: { attachmentId: string; draftKey: string; draft: Draft; spare: string }, newId: string) {
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
    expect((await fileOf(d.spare)).attachableId).toBe(newId);
    expect((await draftRow(d.draft.id)).status).toBe('ready');
  }

  it('POST /bills with draftAttachmentId leaves the live draft\'s file; the convert later relinks it and posts once', async () => {
    const d = await claimedKey('bill');
    const v = await vendor('Guard bill');
    const r = await call('POST', '/api/v1/bills', {
      contactId: v, txnDate: '2026-04-01', vendorInvoiceNumber: `G-${suffix()}`, lines: [{ accountId: c.expense, amount: '50.00' }], draftAttachmentId: d.draftKey,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const billId = (r.json.bill ?? r.json).id as string;
    await expectGuarded(d, billId);
    const v2 = await vendor('Guard convert');
    const conv = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, {
      kind: 'bill', expectedUpdatedAt: d.draft.updatedAt,
      body: { contactId: v2, txnDate: '2026-04-02', vendorInvoiceNumber: `GC-${suffix()}`, lines: [{ accountId: c.expense, amount: '51.00' }] },
    });
    expect(conv.status, JSON.stringify(conv.json)).toBe(201);
    const txnId = conv.json.draft.convertedTransactionId as string;
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'bill', attachableId: txnId });
    expect(await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1 AND contact_id = $2`, c.tenantId, v2)).toBe(1);
  });

  it('POST /bills/:id/attach-draft', async () => {
    const d = await claimedKey('bill');
    const bill = await postedBill('52.00');
    const r = await call('POST', `/api/v1/bills/${bill}/attach-draft`, { draftId: d.draftKey });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.reassigned).toBe(1);
    await expectGuarded(d, bill);
  });

  it('POST /checks with draftAttachmentId', async () => {
    const d = await claimedKey('check');
    const r = await call('POST', '/api/v1/checks', {
      bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos', txnDate: '2026-04-03', amount: '53.00',
      lines: [{ accountId: c.expense, amount: '53.00' }], draftAttachmentId: d.draftKey,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    await expectGuarded(d, r.json.check.id);
  });

  it('POST /transactions (expense) with draftAttachmentId', async () => {
    const d = await claimedKey('card_charge');
    const r = await call('POST', '/api/v1/transactions', {
      txnType: 'expense', txnDate: '2026-04-04', payFromAccountId: c.card, lines: [{ expenseAccountId: c.expense, amount: '54.00' }], draftAttachmentId: d.draftKey,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    await expectGuarded(d, r.json.transaction.id);
  });

  it('vendor credits (relink in the posting transaction)', async () => {
    const d = await claimedKey('bill');
    const credit = await vendorCreditService.createVendorCredit(c.tenantId, {
      contactId: c.vendor, txnDate: '2026-04-05', lines: [{ accountId: c.expense, amount: '5.00' }], draftAttachmentId: d.draftKey,
    } as Parameters<typeof vendorCreditService.createVendorCredit>[1], c.ownerId, c.companyA);
    await expectGuarded(d, credit.id);
  });

  it('daily sales (reassign on the caller\'s transaction) and AJEs / tax entries (reassign on db)', async () => {
    const d1 = await claimedKey('bill');
    const entryId = crypto.randomUUID();
    const n1 = await db.transaction((tx) => attachmentService.reassignDraftAttachments(c.tenantId, d1.draftKey, 'daily_sales_entry', entryId, tx, c.companyA));
    expect(n1).toBe(1);
    await expectGuarded(d1, entryId);
    const d2 = await claimedKey('bill');
    const ajeId = crypto.randomUUID();
    expect(await attachmentService.reassignDraftAttachments(c.tenantId, d2.draftKey, 'journal_entry', ajeId, undefined, c.companyA)).toBe(1);
    await expectGuarded(d2, ajeId);
    const d3 = await claimedKey('bill');
    const taxId = crypto.randomUUID();
    expect(await attachmentService.reassignDraftAttachments(c.tenantId, d3.draftKey, 'tb_tax_entry', taxId, undefined, c.companyA)).toBe(1);
    await expectGuarded(d3, taxId);
  });

  it('POST /attachments/:id/link of a live draft\'s file is 409 ATTACHMENT_IN_USE; after a discard it links', async () => {
    const d = await readyDraft('link');
    const target = await postedExpense('55.00');
    const r = await call('POST', `/api/v1/attachments/${d.attachmentId}/link`, { attachableType: 'expense', attachableId: target });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'ATTACHMENT_IN_USE', details: { draftId: d.draft.id } });
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
    await call('POST', `/api/v1/document-drafts/${d.draft.id}/discard`);
    const ok = await call('POST', `/api/v1/attachments/${d.attachmentId}/link`, { attachableType: 'expense', attachableId: target });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await fileOf(d.attachmentId)).toMatchObject({ attachableType: 'expense', attachableId: target });
  });

  it('claim vs relink: a relink holding the key\'s rows makes the claim wait and then 422', async () => {
    const up = await upload(docBytes('race-1'));
    let claimP: Promise<Res> | null = null;
    let settled = false;
    attachmentService.__attachmentTestHooks.afterKeyLock = async () => {
      claimP = call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId }).then((r) => { settled = true; return r; });
      await pause(300);
      expect(settled).toBe(false);
    };
    const target = crypto.randomUUID();
    expect(await attachmentService.reassignDraftAttachments(c.tenantId, up.draftKey, 'journal_entry', target, undefined, c.companyA)).toBe(1);
    const claim = await claimP!;
    expect(claim.status).toBe(422);
    expect(claim.json.error.code).toBe('ATTACHMENT_NOT_DRAFT');
    expect(await fileOf(up.attachmentId)).toMatchObject({ attachableType: 'journal_entry', attachableId: target });
  });

  it('claim vs relink: a claim holding the row makes the relink wait and then leave the file', async () => {
    const up = await upload(docBytes('race-2'));
    const sha = crypto.createHash('sha256').update(docBytes('unused')).digest('hex');
    let relinkP: Promise<number> | null = null;
    let settled = false;
    const target = crypto.randomUUID();
    await db.transaction(async (tx) => {
      // What a claim does: lock the row, insert the draft.
      await tx.execute(sql`SELECT 1 FROM attachments WHERE id = ${up.attachmentId} FOR UPDATE`);
      await tx.insert(documentDrafts).values({
        tenantId: c.tenantId, companyId: c.companyA, attachmentId: up.attachmentId, contentSha256: sha, kind: 'bill', createdBy: c.ownerId,
      } as never);
      relinkP = attachmentService.reassignDraftAttachments(c.tenantId, up.draftKey, 'journal_entry', target, undefined, c.companyA)
        .then((n) => { settled = true; return n; });
      await pause(300);
      expect(settled).toBe(false);
    });
    expect(await relinkP!).toBe(0);
    expect(await fileOf(up.attachmentId)).toMatchObject({ attachableType: 'draft', attachableId: up.draftKey });
  });

  it('claim vs link: a link holding the row makes the claim wait and then 422; a claim first makes the link 409', async () => {
    const target = await postedExpense('56.00');
    const up = await upload(docBytes('race-3'));
    let claimP: Promise<Res> | null = null;
    attachmentService.__attachmentTestHooks.afterLinkLock = async () => {
      claimP = call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId });
      await pause(300);
    };
    const r = await call('POST', `/api/v1/attachments/${up.attachmentId}/link`, { attachableType: 'expense', attachableId: target });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await claimP!).status).toBe(422);
    delete attachmentService.__attachmentTestHooks.afterLinkLock;

    const up2 = await upload(docBytes('race-4'));
    const sha = crypto.createHash('sha256').update(docBytes('unused-2')).digest('hex');
    let linkP: Promise<Res> | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM attachments WHERE id = ${up2.attachmentId} FOR UPDATE`);
      await tx.insert(documentDrafts).values({
        tenantId: c.tenantId, companyId: c.companyA, attachmentId: up2.attachmentId, contentSha256: sha, kind: 'bill', createdBy: c.ownerId,
      } as never);
      linkP = call('POST', `/api/v1/attachments/${up2.attachmentId}/link`, { attachableType: 'expense', attachableId: target });
      await pause(300);
    });
    const l = await linkP!;
    expect(l.status).toBe(409);
    expect(l.json.error.code).toBe('ATTACHMENT_IN_USE');
  });
});

// ── c. Exact amount filter ───────────────────────────────────────────

describe('GET /transactions?amount= (exact, numeric)', () => {
  it('10.1 matches 10.10, not 10.01; a malformed amount is 400', async () => {
    const v = await vendor('Amount filter');
    const mk = async (amount: string) => (await expenseService.createExpense(c.tenantId, {
      txnDate: '2026-06-01', contactId: v, payFromAccountId: c.card, lines: [{ expenseAccountId: c.expense, amount }],
    } as Parameters<typeof expenseService.createExpense>[1], c.ownerId, c.companyA)).id as string;
    const e1 = await mk('10.10');
    const e2 = await mk('10.01');
    const q = async (amount: string) => {
      const r = await call('GET', `/api/v1/transactions?contactId=${v}&amount=${encodeURIComponent(amount)}&limit=200`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return (r.json.data as Array<{ id: string }>).map((x) => x.id);
    };
    expect(await q('10.1')).toEqual([e1]);
    expect(await q('10.10')).toEqual([e1]);
    expect(await q('10.1000')).toEqual([e1]);
    expect(await q('10.01')).toEqual([e2]);
    expect(await q('10')).toEqual([]);
    for (const bad of ['1e1', '10.10001', 'abc', '10,10']) {
      const r = await call('GET', `/api/v1/transactions?amount=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(400);
    }
  });
});
