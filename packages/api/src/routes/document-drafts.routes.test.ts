// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-92, U-92a, U-92b (document-drafts-v1, idempotency-docs-v1): document
// drafts and vendor layout templates over HTTP against the test database.
// One tenant with two companies, the owner and bookkeepers with narrowed
// permissions. Covers the claim (twice, concurrently, idempotent replay),
// readings (STALE, closed, bounded JSON), discard, attachment delete while a
// draft is live (T1) and after convert (T2), convert of all four kinds
// (exact posting, relink with audit rows, replay, closed draft), the closing
// date (top-level password only), atomicity under a forced failure (T5),
// permission on replay (T6), the duplicate rules (reference, +-60 days,
// numeric totals, void excluded, body vendor, T3 race, T4), company
// isolation, balances / trial balance / A/P aging unchanged by drafts,
// vendor layouts, contact merge (T9) and card last 4.

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
  vendorLayoutTemplates,
} from '../db/schema/index.js';
import { documentDraftsRouter, vendorLayoutTemplatesRouter } from './document-drafts.routes.js';
import { attachmentsRouter } from './attachments.routes.js';
import { accountsRouter } from './accounts.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as attachmentService from '../services/attachment.service.js';
import * as billService from '../services/bill.service.js';
import * as contactsService from '../services/contacts.service.js';
import { buildTrialBalance } from '../services/report.service.js';
import { buildApAgingSummary } from '../services/ap-report.service.js';
import { __documentDraftTestHooks } from '../services/document-draft.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { buildPortabilityPlan, scopeSql, type PortabilityPlan } from '../services/tenant-portability/plan.js';

let server: Server | null = null;
let port = 0;
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

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
  bank: string; card: string; expense: string; vendor: string;
}
let c: Ctx;
let plan: PortabilityPlan;

/** As the owner in company A (or `company`). */
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

/** Uploads `bytes` as a draft attachment on a fresh draft key. */
async function upload(bytes: Buffer, companyId: string | null = c.companyA) {
  const draftKey = crypto.randomUUID();
  const att = await attachmentService.upload(c.tenantId, {
    originalname: 'invoice.pdf', buffer: bytes, mimetype: 'application/pdf', size: bytes.length,
  }, 'draft', draftKey, { companyId });
  return { attachmentId: att!.id, draftKey };
}

const docBytes = (label: string) => Buffer.from(`%PDF-1.4\n% ${label} ${crypto.randomUUID()}\n%%EOF\n`);

/** Uploads a new document and claims it in company A. */
async function newDraft(label = 'doc', kindHint?: string, bytes = docBytes(label)) {
  const up = await upload(bytes);
  const r = await call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId, ...(kindHint ? { kindHint } : {}) });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { ...up, bytes, draft: r.json.draft as { id: string; updatedAt: string; status: string; contentSha256: string } };
}

/** Stores a reading so the draft is ready. */
async function ready(d: { id: string; updatedAt: string }, extra: Record<string, unknown> = {}) {
  const r = await call('PUT', `/api/v1/document-drafts/${d.id}`, { expectedUpdatedAt: d.updatedAt, status: 'ready', ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.draft as { id: string; updatedAt: string };
}

const billBody = (contactId: string, amount: string, extra: Record<string, unknown> = {}) => ({
  contactId, txnDate: '2026-05-10', vendorInvoiceNumber: `INV-${suffix()}`, lines: [{ accountId: c.expense, amount }], ...extra,
});

async function count(text: string, ...params: unknown[]): Promise<number> {
  let i = 0;
  const r = await db.execute(sql.raw(text.replace(/\$\d+/g, () => {
    const v = params[i++];
    return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
  })));
  return (r.rows[0] as { n: number }).n;
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
  app.use('/api/v1/vendor-layout-templates', vendorLayoutTemplatesRouter);
  app.use('/api/v1/attachments', attachmentsRouter);
  app.use('/api/v1/accounts', accountsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `u92-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Ozark Excavating',
  });
  const tenantId = reg.user.tenantId;
  const [companyA] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: 'Table Rock Marina', setupComplete: true }).returning();
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expense = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  const [card] = await db.insert(accounts).values({ tenantId, name: `Visa ${suffix()}`, accountType: 'liability', detailType: 'credit_card' }).returning();
  c = {
    tenantId, ownerId: reg.user.id, token: reg.tokens.accessToken, companyA: companyA!.id, companyB: companyB!.id,
    bank: bank!.id, card: card!.id, expense: expense!.id, vendor: '',
  };
  c.vendor = await vendor('Cosmos Granite');
}, 120_000);

afterEach(() => {
  delete __documentDraftTestHooks.afterPost;
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

describe('capabilities', () => {
  it('advertises document-drafts-v1 and idempotency-docs-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('document-drafts-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-docs-v1');
  });
});

describe('claim (POST /document-drafts)', () => {
  it('hashes the stored file, takes the company, writes an audit row; the same bytes again are 409 with the draft id', async () => {
    const bytes = docBytes('claim');
    const d = await newDraft('claim', undefined, bytes);
    expect(d.draft.status).toBe('new');
    expect(d.draft.contentSha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    const [att] = await db.select().from(attachments).where(eq(attachments.id, d.attachmentId));
    expect(att!.attachableType).toBe('draft');
    expect(att!.attachableId).toBe(d.draftKey);
    expect(att!.companyId).toBe(c.companyA);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'document_draft' AND entity_id = $2 AND action = 'create'`, c.tenantId, d.draft.id)).toBe(1);

    const again = await upload(bytes);
    const r = await call('POST', '/api/v1/document-drafts', { attachmentId: again.attachmentId });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('DOCUMENT_ALREADY_CLAIMED');
    expect(r.json.error.details.draftId).toBe(d.draft.id);
  });

  it('two concurrent claims of one file: exactly one draft', async () => {
    const bytes = docBytes('race');
    const [a, b] = [await upload(bytes), await upload(bytes)];
    const rs = await Promise.all([
      call('POST', '/api/v1/document-drafts', { attachmentId: a.attachmentId }),
      call('POST', '/api/v1/document-drafts', { attachmentId: b.attachmentId }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(await count(`SELECT count(*)::int AS n FROM document_drafts WHERE tenant_id = $1 AND content_sha256 = $2`, c.tenantId, sha)).toBe(1);
  });

  it('is keyed: the same key replays, a new key is the claim conflict', async () => {
    const up = await upload(docBytes('keyed'));
    const k = key();
    const first = await call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId }, { key: k });
    expect(first.status).toBe(201);
    const replay = await call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId }, { key: k });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json.draft.id).toBe(first.json.draft.id);
    const other = await call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId }, { key: key() });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe('DOCUMENT_ALREADY_CLAIMED');
  });

  it('a file filed on a record is 422; another company\'s file is 404; unknown keys are 400', async () => {
    const posted = await upload(docBytes('filed'));
    await db.update(attachments).set({ attachableType: 'contact', attachableId: c.vendor }).where(eq(attachments.id, posted.attachmentId));
    const r1 = await call('POST', '/api/v1/document-drafts', { attachmentId: posted.attachmentId });
    expect(r1.status).toBe(422);
    expect(r1.json.error.code).toBe('ATTACHMENT_NOT_DRAFT');
    const bFile = await upload(docBytes('b'), c.companyB);
    expect((await call('POST', '/api/v1/document-drafts', { attachmentId: bFile.attachmentId })).status).toBe(404);
    expect((await call('POST', '/api/v1/document-drafts', { attachmentId: bFile.attachmentId, extra: 1 })).status).toBe(400);
  });
});

describe('readings, discard and company scope', () => {
  it('PUT stores a reading; stale is 409 STALE; floats and oversize readings are 400', async () => {
    const d = await newDraft('read');
    const stale = await call('PUT', `/api/v1/document-drafts/${d.draft.id}`, { expectedUpdatedAt: '2020-01-01T00:00:00.000Z', status: 'ready' });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE');
    expect(stale.json.error.details.updatedAt).toBe(d.draft.updatedAt);
    const float = await call('PUT', `/api/v1/document-drafts/${d.draft.id}`, { expectedUpdatedAt: d.draft.updatedAt, status: 'ready', fields: { total: { value: 12.5 } } });
    expect(float.status).toBe(400);
    const huge = await call('PUT', `/api/v1/document-drafts/${d.draft.id}`, { expectedUpdatedAt: d.draft.updatedAt, status: 'ready', lines: Array.from({ length: 501 }, () => ({})) });
    expect(huge.status).toBe(400);
    const badTotal = await call('PUT', `/api/v1/document-drafts/${d.draft.id}`, { expectedUpdatedAt: d.draft.updatedAt, status: 'ready', docTotal: '1e3' });
    expect(badTotal.status).toBe(400);
    const r = await call('PUT', `/api/v1/document-drafts/${d.draft.id}`, {
      expectedUpdatedAt: d.draft.updatedAt, status: 'ready', kind: 'bill', reader: 'text_pdf',
      fields: { total: { value: '1234.50', confidenceBp: 9100, page: 1, bbox: [100, 200, 300, 240] } },
      lines: [{ description: 'Granite', amount: '1234.50' }], checks: [{ code: 'sum_ok' }],
      suggestedContactId: c.vendor, docReference: 'INV-77', docTotal: '1234.5', docDate: '2026-05-01',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.draft).toMatchObject({ status: 'ready', kind: 'bill', reader: 'text_pdf', docTotal: '1234.5000', docDate: '2026-05-01', docReference: 'INV-77' });
    expect(r.json.draft.fields.total.value).toBe('1234.50');
    expect(Date.parse(r.json.draft.updatedAt)).toBeGreaterThan(Date.parse(d.draft.updatedAt));
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'document_draft' AND entity_id = $2 AND action = 'update'`, c.tenantId, d.draft.id)).toBe(1);
    // The audit row carries no reading and no amount.
    const audit = await db.execute(sql`SELECT after_data::text AS a FROM audit_log WHERE tenant_id = ${c.tenantId} AND entity_id = ${d.draft.id} AND action = 'update'`);
    expect((audit.rows[0] as { a: string }).a).not.toContain('1234');
  });

  it('discard frees the claim; twice is 200; a closed draft refuses readings', async () => {
    const d = await newDraft('discard');
    const r1 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/discard`);
    expect(r1.status).toBe(200);
    expect(r1.json.draft.status).toBe('discarded');
    const r2 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/discard`);
    expect(r2.status).toBe(200);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'update'`, c.tenantId, d.draft.id)).toBe(1);
    const put = await call('PUT', `/api/v1/document-drafts/${d.draft.id}`, { expectedUpdatedAt: r1.json.draft.updatedAt, status: 'ready' });
    expect(put.status).toBe(409);
    expect(put.json.error.code).toBe('DOCUMENT_DRAFT_CLOSED');
    // The same file is read again.
    const again = await upload(d.bytes);
    expect((await call('POST', '/api/v1/document-drafts', { attachmentId: again.attachmentId })).status).toBe(201);
  });

  it('another company\'s draft is 404 everywhere and not listed', async () => {
    const d = await newDraft('scope');
    const ready1 = await ready(d.draft);
    const opts = { company: c.companyB };
    expect((await call('GET', `/api/v1/document-drafts/${d.draft.id}`, undefined, opts)).status).toBe(404);
    expect((await call('GET', `/api/v1/document-drafts/${d.draft.id}/duplicates`, undefined, opts)).status).toBe(404);
    expect((await call('PUT', `/api/v1/document-drafts/${d.draft.id}`, { expectedUpdatedAt: ready1.updatedAt, status: 'ready' }, opts)).status).toBe(404);
    expect((await call('POST', `/api/v1/document-drafts/${d.draft.id}/discard`, undefined, opts)).status).toBe(404);
    const conv = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, {
      kind: 'bill', body: billBody(c.vendor, '1.00'), expectedUpdatedAt: ready1.updatedAt,
    }, opts);
    expect(conv.status).toBe(404);
    const listB = await call('GET', '/api/v1/document-drafts?limit=200', undefined, opts);
    expect(listB.status).toBe(200);
    expect(listB.json.drafts.map((x: { id: string }) => x.id)).not.toContain(d.draft.id);
    const listA = await call('GET', '/api/v1/document-drafts?status=ready&limit=200');
    expect(listA.json.drafts.map((x: { id: string }) => x.id)).toContain(d.draft.id);
    expect(listA.json.drafts.every((x: { status: string }) => x.status === 'ready')).toBe(true);
    expect((await call('GET', '/api/v1/document-drafts?status=bogus')).status).toBe(400);
  });

  it('balances, the trial balance and A/P aging are unchanged by 20 drafts', async () => {
    // A posted bill so the reports are not empty.
    await billService.createBill(c.tenantId, billBody(c.vendor, '310.00', { txnDate: '2026-04-01' }) as never, c.ownerId, c.companyA);
    const snapshot = async () => JSON.stringify({
      balances: (await db.execute(sql`SELECT id, balance::text AS b FROM accounts WHERE tenant_id = ${c.tenantId} ORDER BY id`)).rows,
      tb: await buildTrialBalance(c.tenantId, '2000-01-01', '2100-12-31', c.companyA),
      aging: await buildApAgingSummary(c.tenantId, '2026-12-31', c.companyA),
      txns: await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1`, c.tenantId),
      lines: await count(`SELECT count(*)::int AS n FROM journal_lines WHERE tenant_id = $1`, c.tenantId),
    });
    const before = await snapshot();
    for (let i = 0; i < 20; i++) {
      const d = await newDraft(`bal-${i}`, 'bill');
      await ready(d.draft, { suggestedContactId: c.vendor, docTotal: `${100 + i}.25`, docDate: '2026-05-01', docReference: `B-${i}` });
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('attachments of drafts (M1)', () => {
  it('T1: deleting a live draft\'s file is 409 ATTACHMENT_IN_USE; the file and the row stay', async () => {
    const d = await newDraft('t1');
    const r = await call('DELETE', `/api/v1/attachments/${d.attachmentId}`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('ATTACHMENT_IN_USE');
    expect(r.json.error.details.draftId).toBe(d.draft.id);
    const [att] = await db.select().from(attachments).where(eq(attachments.id, d.attachmentId));
    expect(att).toBeDefined();
    expect(await attachmentService.readAttachmentBytes(c.tenantId, att!)).toEqual(d.bytes);
  });

  it('T2: a converted draft\'s file can be deleted; the draft keeps its hash and the file stays claimed', async () => {
    const d = await newDraft('t2', 'bill');
    const rd = await ready(d.draft);
    const conv = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body: billBody(c.vendor, '42.00'), expectedUpdatedAt: rd.updatedAt });
    expect(conv.status, JSON.stringify(conv.json)).toBe(201);
    const del = await call('DELETE', `/api/v1/attachments/${d.attachmentId}`);
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    const [row] = await db.select().from(documentDrafts).where(eq(documentDrafts.id, d.draft.id));
    expect(row!.attachmentId).toBeNull();
    expect(row!.contentSha256).toBe(d.draft.contentSha256);
    const again = await upload(d.bytes);
    const r = await call('POST', '/api/v1/document-drafts', { attachmentId: again.attachmentId });
    expect(r.status).toBe(409);
    expect(r.json.error.details.draftId).toBe(d.draft.id);
  });
});

describe('convert', () => {
  const kinds = [
    { kind: 'bill', body: () => billBody(c.vendor, '120.50'), total: '120.5000', txnType: 'bill', attachType: 'bill' },
    {
      kind: 'card_charge', txnType: 'expense', attachType: 'expense', total: '45.1000',
      body: () => ({ txnDate: '2026-05-11', contactId: c.vendor, payFromAccountId: c.card, txnNumber: `R-${suffix()}`, lines: [{ expenseAccountId: c.expense, amount: '45.10' }] }),
    },
    {
      kind: 'cash_expense', txnType: 'expense', attachType: 'expense', total: '9.9900',
      body: () => ({ txnDate: '2026-05-12', payFromAccountId: c.bank, lines: [{ expenseAccountId: c.expense, amount: '9.99' }] }),
    },
    {
      kind: 'check', txnType: 'expense', attachType: 'expense', total: '75.0000',
      body: () => ({ bankAccountId: c.bank, contactId: c.vendor, payeeNameOnCheck: 'Cosmos Granite', txnDate: '2026-05-13', amount: '75.00', lines: [{ accountId: c.expense, amount: '75.00' }] }),
    },
  ] as const;

  for (const k of kinds) {
    it(`${k.kind}: posts exactly the body, relinks the file with an audit row, replays with the key, a new key is closed`, async () => {
      // A second vendor per kind keeps the duplicate rules out of this test.
      const v = await vendor(`Kind ${k.kind}`);
      const body = JSON.parse(JSON.stringify(k.body()).split(c.vendor).join(v));
      const d = await newDraft(`kind-${k.kind}`);
      const rd = await ready(d.draft);
      const kk = key();
      const r = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: k.kind, body, expectedUpdatedAt: rd.updatedAt }, { key: kk });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      const txnId = r.json.draft.convertedTransactionId as string;
      expect(r.json.draft).toMatchObject({ status: 'converted', kind: k.kind, convertedType: k.txnType });
      expect(r.json.transaction.id).toBe(txnId);
      const t = (await db.execute(sql`SELECT txn_type, total::text AS total, company_id FROM transactions WHERE id = ${txnId}`)).rows[0] as { txn_type: string; total: string; company_id: string };
      expect(t).toEqual({ txn_type: k.txnType, total: k.total, company_id: c.companyA });
      const [att] = await db.select().from(attachments).where(eq(attachments.id, d.attachmentId));
      expect(att).toMatchObject({ attachableType: k.attachType, attachableId: txnId });
      expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'attachment' AND entity_id = $2 AND action = 'update'`, c.tenantId, d.attachmentId)).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'document_draft' AND entity_id = $2 AND (after_data #>> '{}') LIKE '%"converted":true%'`, c.tenantId, d.draft.id)).toBe(1);

      const replay = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: k.kind, body, expectedUpdatedAt: rd.updatedAt }, { key: kk });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json.draft.convertedTransactionId).toBe(txnId);
      const fresh = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: k.kind, body, expectedUpdatedAt: rd.updatedAt }, { key: key() });
      expect(fresh.status).toBe(409);
      expect(fresh.json.error.code).toBe('DOCUMENT_DRAFT_CLOSED');
      expect(fresh.json.error.details.transactionId).toBe(txnId);
      expect(await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1 AND id = $2`, c.tenantId, txnId)).toBe(1);
      // Discard and PUT on a converted draft are refused.
      expect((await call('POST', `/api/v1/document-drafts/${d.draft.id}/discard`)).json.error.code).toBe('DOCUMENT_DRAFT_CLOSED');
    });
  }

  it('a missing or other kind is 400 INVALID_KIND; a bad body 400 with the field path; a stale token 409; nothing posts', async () => {
    const d = await newDraft('bad');
    const rd = await ready(d.draft);
    const before = await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1`, c.tenantId);
    const r1 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { body: billBody(c.vendor, '1.00'), expectedUpdatedAt: rd.updatedAt });
    expect(r1.status).toBe(400);
    expect(r1.json.error.code).toBe('INVALID_KIND');
    const r2 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'invoice', body: {}, expectedUpdatedAt: rd.updatedAt });
    expect(r2.json.error.code).toBe('INVALID_KIND');
    const r3 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body: { contactId: c.vendor }, expectedUpdatedAt: rd.updatedAt });
    expect(r3.status).toBe(400);
    expect(r3.json.error.code).toBe('VALIDATION_ERROR');
    const r4 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body: billBody(c.vendor, '1.00'), expectedUpdatedAt: d.draft.updatedAt });
    expect(r4.status).toBe(409);
    expect(r4.json.error.code).toBe('STALE');
    expect(await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1`, c.tenantId)).toBe(before);
  });

  it('T5: a failure after the posting rolls back everything', async () => {
    const d = await newDraft('t5');
    const rd = await ready(d.draft);
    const v = await vendor('Atomic');
    const counts = async () => ({
      txns: await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1`, c.tenantId),
      lines: await count(`SELECT count(*)::int AS n FROM journal_lines WHERE tenant_id = $1`, c.tenantId),
      audit: await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1`, c.tenantId),
      keys: await count(`SELECT count(*)::int AS n FROM idempotency_keys WHERE tenant_id = $1`, c.tenantId),
    });
    const before = await counts();
    let reached = false;
    __documentDraftTestHooks.afterPost = () => { reached = true; throw new Error('forced failure after posting'); };
    const kk = key();
    const r = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body: billBody(v, '55.00'), expectedUpdatedAt: rd.updatedAt }, { key: kk });
    expect(reached).toBe(true);
    expect(r.status).toBe(500);
    expect(await counts()).toEqual(before);
    const [row] = await db.select().from(documentDrafts).where(eq(documentDrafts.id, d.draft.id));
    expect(row!.status).toBe('ready');
    expect(row!.updatedAt.toISOString()).toBe(rd.updatedAt);
    const [att] = await db.select().from(attachments).where(eq(attachments.id, d.attachmentId));
    expect(att).toMatchObject({ attachableType: 'draft', attachableId: d.draftKey });
    // The same key then runs afresh and posts once.
    delete __documentDraftTestHooks.afterPost;
    const again = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body: billBody(v, '55.00'), expectedUpdatedAt: rd.updatedAt }, { key: kk });
    expect(again.status, JSON.stringify(again.json)).toBe(201);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
  });

  it('closed period: 423 without the password, a password inside body is ignored, the top-level one posts', async () => {
    const hash = await bcrypt.hash('Closing-pass-2026', 4);
    await db.update(companies).set({ lockDate: '2026-01-31', closingPasswordHash: hash } as never).where(eq(companies.id, c.companyA));
    try {
      const d = await newDraft('closed');
      const rd = await ready(d.draft);
      const v = await vendor('Closed');
      const body = billBody(v, '20.00', { txnDate: '2026-01-15' });
      const r1 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body, expectedUpdatedAt: rd.updatedAt });
      expect(r1.status).toBe(423);
      const r2 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body: { ...body, closingPassword: 'Closing-pass-2026' }, expectedUpdatedAt: rd.updatedAt });
      expect(r2.status).toBe(423);
      const [row] = await db.select().from(documentDrafts).where(eq(documentDrafts.id, d.draft.id));
      expect(row!.status).toBe('ready');
      const r3 = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body, expectedUpdatedAt: rd.updatedAt, closingPassword: 'Closing-pass-2026' });
      expect(r3.status, JSON.stringify(r3.json)).toBe(201);
    } finally {
      await db.update(companies).set({ lockDate: null, closingPasswordHash: null } as never).where(eq(companies.id, c.companyA));
    }
  });
});

describe('permissions (by kind, before the replay)', () => {
  it('reading needs any of bills, checks, transactions; creating and converting need the kind\'s', async () => {
    const none = await bookkeeper({ invoices: 'full' });
    expect((await call('GET', '/api/v1/document-drafts', undefined, { token: none.token })).status).toBe(403);
    const checksOnly = await bookkeeper({ checks: 'full' });
    expect((await call('GET', '/api/v1/document-drafts', undefined, { token: checksOnly.token })).status).toBe(200);
    const up = await upload(docBytes('perm'));
    expect((await call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId }, { token: checksOnly.token })).status).toBe(403);
    const created = await call('POST', '/api/v1/document-drafts', { attachmentId: up.attachmentId, kindHint: 'check' }, { token: checksOnly.token });
    expect(created.status).toBe(201);
    const rd = await call('PUT', `/api/v1/document-drafts/${created.json.draft.id}`, { expectedUpdatedAt: created.json.draft.updatedAt, status: 'ready' }, { token: checksOnly.token });
    expect(rd.status).toBe(200);
    // Changing the kind to a bill needs bills too.
    const toBill = await call('PUT', `/api/v1/document-drafts/${created.json.draft.id}`, { expectedUpdatedAt: rd.json.draft.updatedAt, status: 'ready', kind: 'bill' }, { token: checksOnly.token });
    expect(toBill.status).toBe(403);
    const asBill = await call('POST', `/api/v1/document-drafts/${created.json.draft.id}/convert`, {
      kind: 'bill', body: billBody(c.vendor, '3.00'), expectedUpdatedAt: rd.json.draft.updatedAt,
    }, { token: checksOnly.token });
    expect(asBill.status).toBe(403);
  });

  it('T6: a permission removed after the first convert also refuses the replay', async () => {
    const bk = await bookkeeper({ checks: 'full' });
    const d = await newDraft('t6', 'check');
    const rd = await ready(d.draft);
    const v = await vendor('Replay');
    const body = { kind: 'check', body: { bankAccountId: c.bank, contactId: v, payeeNameOnCheck: 'Replay', txnDate: '2026-05-20', amount: '12.00', lines: [{ accountId: c.expense, amount: '12.00' }] }, expectedUpdatedAt: rd.updatedAt };
    const kk = key();
    const first = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, body, { key: kk, token: bk.token });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    await db.update(userPermissions).set({ overrides: { bills: 'full' } as never }).where(eq(userPermissions.userId, bk.id));
    const replay = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, body, { key: kk, token: bk.token });
    expect(replay.status).toBe(403);
    expect(replay.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('duplicates (U-92b)', () => {
  async function convertBill(contactId: string, amount: string, extra: Record<string, unknown> = {}, ack: string[] = []) {
    const d = await newDraft('dup', 'bill');
    const rd = await ready(d.draft);
    return call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, {
      kind: 'bill', body: billBody(contactId, amount, extra), expectedUpdatedAt: rd.updatedAt, acknowledgeDuplicateOf: ack,
    });
  }

  it('same vendor and normalized reference: 409 POSSIBLE_DUPLICATE until acknowledged', async () => {
    const v = await vendor('Ref');
    const posted = await billService.createBill(c.tenantId, billBody(v, '500.00', { vendorInvoiceNumber: 'INV-0042', txnDate: '2026-02-10' }) as never, c.ownerId, c.companyA);
    const r = await convertBill(v, '1.00', { vendorInvoiceNumber: 'inv 0042', txnDate: '2026-09-30' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(r.json.error.details.matches).toEqual([expect.objectContaining({ source: 'transaction', id: posted.id, reason: 'reference', txnType: 'bill' })]);
    const ok = await convertBill(v, '1.00', { vendorInvoiceNumber: 'inv 0042', txnDate: '2026-09-30' }, [posted.id]);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
  });

  it('same vendor and numeric total within 60 days (59 matches, 61 does not; 10.1 = 10.10); void documents never match', async () => {
    const v = await vendor('Amount');
    const posted = await billService.createBill(c.tenantId, billBody(v, '10.10', { txnDate: '2026-03-01' }) as never, c.ownerId, c.companyA);
    const r59 = await convertBill(v, '10.1', { txnDate: '2026-04-29' });
    expect(r59.status).toBe(409);
    expect(r59.json.error.details.matches[0]).toMatchObject({ id: posted.id, reason: 'amount_date', total: '10.1000' });
    const r61 = await convertBill(v, '10.1', { txnDate: '2026-05-01' });
    expect(r61.status, JSON.stringify(r61.json)).toBe(201);
    const other = await convertBill(v, '10.11', { txnDate: '2026-03-02' });
    expect(other.status, JSON.stringify(other.json)).toBe(201);
    // Void documents never count: void all of the vendor's bills, then the same total converts.
    await db.execute(sql`UPDATE transactions SET status = 'void' WHERE tenant_id = ${c.tenantId} AND contact_id = ${v}`);
    const after = await convertBill(v, '10.10', { txnDate: '2026-03-05' });
    expect(after.status, JSON.stringify(after.json)).toBe(201);
  });

  it('T4: the check uses the body\'s vendor, not the draft\'s suggestion', async () => {
    const suggested = await vendor('Suggested');
    const actual = await vendor('Actual');
    await billService.createBill(c.tenantId, billBody(actual, '77.70', { txnDate: '2026-06-01' }) as never, c.ownerId, c.companyA);
    const d = await newDraft('t4', 'bill');
    const rd = await ready(d.draft, { suggestedContactId: suggested });
    const r = await call('POST', `/api/v1/document-drafts/${d.draft.id}/convert`, { kind: 'bill', body: billBody(actual, '77.70', { txnDate: '2026-06-02' }), expectedUpdatedAt: rd.updatedAt });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('POSSIBLE_DUPLICATE');
  });

  it('T3: two drafts of one invoice converted at once: exactly one posts', async () => {
    const v = await vendor('Race');
    const a = await newDraft('t3a', 'bill');
    const b = await newDraft('t3b', 'bill');
    const ra = await ready(a.draft);
    const rb = await ready(b.draft);
    const body = billBody(v, '640.00', { vendorInvoiceNumber: 'R-1001' });
    const rs = await Promise.all([
      call('POST', `/api/v1/document-drafts/${a.draft.id}/convert`, { kind: 'bill', body, expectedUpdatedAt: ra.updatedAt }),
      call('POST', `/api/v1/document-drafts/${b.draft.id}/convert`, { kind: 'bill', body, expectedUpdatedAt: rb.updatedAt }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)!.json.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(await count(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1 AND contact_id = $2 AND status <> 'void'`, c.tenantId, v)).toBe(1);
  });

  it('GET /:id/duplicates lists posted documents and other live drafts', async () => {
    const v = await vendor('Listing');
    const posted = await billService.createBill(c.tenantId, billBody(v, '5.00', { vendorInvoiceNumber: 'A-7', txnDate: '2026-05-01' }) as never, c.ownerId, c.companyA);
    const other = await newDraft('dl-other', 'bill');
    await ready(other.draft, { suggestedContactId: v, docTotal: '33.3', docDate: '2026-06-01' });
    const d = await newDraft('dl', 'bill');
    await ready(d.draft, { suggestedContactId: v, docReference: 'a 7', docTotal: '33.30', docDate: '2026-05-05' });
    const r = await call('GET', `/api/v1/document-drafts/${d.draft.id}/duplicates`);
    expect(r.status).toBe(200);
    expect(r.json.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'transaction', id: posted.id, reason: 'reference' }),
      expect.objectContaining({ source: 'draft', id: other.draft.id, reason: 'amount_date', total: '33.3000' }),
    ]));
    expect(r.json.matches).toHaveLength(2);
    // No vendor: nothing to compare.
    const lone = await newDraft('dl-lone');
    expect((await call('GET', `/api/v1/document-drafts/${lone.draft.id}/duplicates`)).json.matches).toEqual([]);
  });
});

describe('vendor layout templates', () => {
  const regions = (n: number) => ({ total: { box: [7000, 8000, 9500, 8400], anchor: 'TOTAL DUE' }, version: n });

  it('PUT creates (201) and replaces (200) with the token; null on an existing one and a stale token are 409', async () => {
    const v = await vendor('Layout');
    const fp = `fp:${suffix()}`;
    const r1 = await call('PUT', '/api/v1/vendor-layout-templates', { contactId: v, fingerprint: fp, fieldRegions: regions(1), expectedUpdatedAt: null });
    expect(r1.status, JSON.stringify(r1.json)).toBe(201);
    const again = await call('PUT', '/api/v1/vendor-layout-templates', { contactId: v, fingerprint: fp, fieldRegions: regions(2), expectedUpdatedAt: null });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('STALE');
    const r2 = await call('PUT', '/api/v1/vendor-layout-templates', { contactId: v, fingerprint: fp, fieldRegions: regions(2), samples: 2, expectedUpdatedAt: r1.json.template.updatedAt });
    expect(r2.status).toBe(200);
    expect(r2.json.template).toMatchObject({ id: r1.json.template.id, samples: 2, fieldRegions: regions(2) });
    const stale = await call('PUT', '/api/v1/vendor-layout-templates', { contactId: v, fingerprint: fp, fieldRegions: regions(3), expectedUpdatedAt: r1.json.template.updatedAt });
    expect(stale.status).toBe(409);
    const list = await call('GET', `/api/v1/vendor-layout-templates?contactId=${v}`);
    expect(list.json.templates).toHaveLength(1);
    expect((await call('GET', `/api/v1/vendor-layout-templates?contactId=${v}`, undefined, { company: c.companyB })).json.templates).toHaveLength(0);
    expect((await call('DELETE', `/api/v1/vendor-layout-templates/${r1.json.template.id}`, undefined, { company: c.companyB })).status).toBe(404);
    expect((await call('DELETE', `/api/v1/vendor-layout-templates/${r1.json.template.id}?expectedUpdatedAt=${encodeURIComponent(r1.json.template.updatedAt)}`)).status).toBe(409);
    expect((await call('DELETE', `/api/v1/vendor-layout-templates/${r1.json.template.id}`)).status).toBe(204);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_type = 'vendor_layout_template' AND entity_id = $2`, c.tenantId, r1.json.template.id)).toBe(3);
  });

  it('refuses floats, another company\'s vendor and a bad fingerprint', async () => {
    const v = await vendor('Layout2');
    expect((await call('PUT', '/api/v1/vendor-layout-templates', { contactId: v, fingerprint: `fp:${suffix()}`, fieldRegions: { x: 0.5 }, expectedUpdatedAt: null })).status).toBe(400);
    expect((await call('PUT', '/api/v1/vendor-layout-templates', { contactId: v, fingerprint: 'short', fieldRegions: {}, expectedUpdatedAt: null })).status).toBe(400);
    const bVendor = await vendor('Marina vendor', c.companyB);
    expect((await call('PUT', '/api/v1/vendor-layout-templates', { contactId: bVendor, fingerprint: `fp:${suffix()}`, fieldRegions: {}, expectedUpdatedAt: null })).status).toBe(404);
  });

  it('T9: a contact merge moves drafts and layouts; a fingerprint collision keeps the newer layout with both counts', async () => {
    const src = await vendor('Merge source');
    const tgt = await vendor('Merge target');
    const shared = `fp:shared-${suffix()}`;
    const only = `fp:only-${suffix()}`;
    const t1 = await call('PUT', '/api/v1/vendor-layout-templates', { contactId: tgt, fingerprint: shared, fieldRegions: regions(1), samples: 3, expectedUpdatedAt: null });
    const s1 = await call('PUT', '/api/v1/vendor-layout-templates', { contactId: src, fingerprint: shared, fieldRegions: regions(9), samples: 2, expectedUpdatedAt: null });
    await call('PUT', '/api/v1/vendor-layout-templates', { contactId: src, fingerprint: only, fieldRegions: regions(5), expectedUpdatedAt: null });
    expect([t1.status, s1.status]).toEqual([201, 201]);
    const d = await newDraft('merge');
    await ready(d.draft, { suggestedContactId: src });
    await contactsService.merge(c.tenantId, src, tgt, c.ownerId);
    const rows = await db.select().from(vendorLayoutTemplates).where(and(eq(vendorLayoutTemplates.tenantId, c.tenantId), eq(vendorLayoutTemplates.contactId, tgt)));
    expect(rows).toHaveLength(2);
    const merged = rows.find((r) => r.fingerprint === shared)!;
    expect(merged.samples).toBe(5);
    expect(merged.fieldRegions).toEqual(regions(9));
    expect(await count(`SELECT count(*)::int AS n FROM vendor_layout_templates WHERE tenant_id = $1 AND contact_id = $2`, c.tenantId, src)).toBe(0);
    const [draft] = await db.select().from(documentDrafts).where(eq(documentDrafts.id, d.draft.id));
    expect(draft!.suggestedContactId).toBe(tgt);
  });
});

describe('card last 4 (PUT /accounts/:id)', () => {
  it('four digits on a credit card account; refused elsewhere and malformed; cleared when it stops being a card', async () => {
    const r1 = await call('PUT', `/api/v1/accounts/${c.card}`, { cardLast4: '4242' });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect(r1.json.account.cardLast4).toBe('4242');
    expect((await call('PUT', `/api/v1/accounts/${c.card}`, { cardLast4: '42a2' })).status).toBe(400);
    expect((await call('PUT', `/api/v1/accounts/${c.card}`, { cardLast4: '12345' })).status).toBe(400);
    expect((await call('PUT', `/api/v1/accounts/${c.bank}`, { cardLast4: '1234' })).status).toBe(400);
    await expect(db.execute(sql`UPDATE accounts SET card_last4 = 'abcd' WHERE id = ${c.card}`)).rejects.toThrow();
    const [other] = await db.insert(accounts).values({ tenantId: c.tenantId, name: `Amex ${suffix()}`, accountType: 'liability', detailType: 'credit_card', cardLast4: '1005' }).returning();
    const moved = await call('PUT', `/api/v1/accounts/${other!.id}`, { detailType: 'other_current_liability' });
    expect(moved.status).toBe(200);
    expect(moved.json.account.cardLast4).toBeNull();
    const cleared = await call('PUT', `/api/v1/accounts/${c.card}`, { cardLast4: null });
    expect(cleared.json.account.cardLast4).toBeNull();
  });
});
