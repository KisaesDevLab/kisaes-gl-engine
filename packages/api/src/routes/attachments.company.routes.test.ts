// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-90 (attachments-company-v1): attachments are scoped by company.
// Two companies in one tenant; a bookkeeper excluded from company A
// (accountant_company_exclusions). They can't list, read, download, delete,
// OCR, link or relink A's files; the owner (in A or B) and the bookkeeper's
// own company B are unaffected. Rows without a company (written before the
// change) stay visible tenant-wide unless filed on another company's
// transaction.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const TMP_UPLOAD_DIR = vi.hoisted(() => {
  const dir = `${process.cwd()}/.tmp-att-company-test-${process.pid}`;
  process.env['UPLOAD_DIR'] = dir;
  return dir;
});

const spies = vi.hoisted(() => ({
  processReceipt: vi.fn(async (..._a: unknown[]) => undefined),
  classifyAndRoute: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
}));

vi.mock('../services/ocr.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ocr.service.js')>();
  return { ...actual, processReceipt: spies.processReceipt };
});
vi.mock('../services/ai-document-classifier.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai-document-classifier.service.js')>();
  return { ...actual, classifyAndRoute: spies.classifyAndRoute };
});

import 'express-async-errors';
import express from 'express';
import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, attachments, userPermissions, accountantCompanyExclusions,
} from '../db/schema/index.js';
import { attachmentsRouter } from './attachments.routes.js';
import { aiRouter } from './ai.routes.js';
import { apiV2Router } from './api-v2.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as attachmentService from '../services/attachment.service.js';
import { issueDownloadToken } from '../utils/download-token.js';
import { invalidateSystemProviderCache } from '../services/storage/storage-provider.factory.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const PDF_A = Buffer.from('%PDF-1.4\n% company A invoice\n');
const PDF_B = Buffer.from('%PDF-1.4\n% company B invoice\n');

interface Res { status: number; json: any; raw: string }

function send(method: string, pathname: string, token: string | null, body?: Buffer | unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...(data && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': String(data.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function uploadPdf(token: string, bytes: Buffer, headers: Record<string, string> = {}) {
  const b = '----u90boundary';
  const part = (name: string, value: string) =>
    `--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('attachableType', 'draft') + part('attachableId', crypto.randomUUID())),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return send('POST', '/api/v1/attachments?autoOcr=0', token, body, { 'Content-Type': `multipart/form-data; boundary=${b}`, ...headers });
}

interface Ctx {
  tenantId: string; ownerId: string; ownerToken: string; companyA: string; companyB: string;
  acctId: string; acctToken: string;
}
let c: Ctx;

async function cleanTenant(tid: string) {
  await db.delete(attachments).where(eq(attachments.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) {
    await db.delete(accountantCompanyExclusions).where(inArray(accountantCompanyExclusions.userId, staff.map((u) => u.id)));
    await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  }
  await db.delete(companies).where(eq(companies.tenantId, tid));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

beforeAll(async () => {
  fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
  invalidateSystemProviderCache();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/attachments', attachmentsRouter);
  app.use('/api/v1/ai', aiRouter);
  app.use('/api/v2', apiV2Router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });

  const reg = await authService.register({
    email: `att-co-${suffix()}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: 'Ozark Excavating',
  });
  const tenantId = reg.user.tenantId;
  const [companyA] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: 'Table Rock Marina', setupComplete: true }).returning();
  const [u] = await db.insert(users).values({
    tenantId, email: `bk-${suffix()}@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role: 'bookkeeper' });
  await db.insert(userPermissions).values({ tenantId, userId: u!.id, overrides: { attachments: 'full', transactions: 'full' } as never });
  await db.insert(accountantCompanyExclusions).values({ userId: u!.id, companyId: companyA!.id } as never);
  const acctToken = (await authService.issueSession({ userId: u!.id, tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
  c = {
    tenantId, ownerId: reg.user.id, ownerToken: reg.tokens.accessToken, companyA: companyA!.id, companyB: companyB!.id,
    acctId: u!.id, acctToken,
  };
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (c?.tenantId) await cleanTenant(c.tenantId);
  fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
  invalidateSystemProviderCache();
});

beforeEach(async () => {
  spies.processReceipt.mockClear();
  spies.classifyAndRoute.mockClear();
  await db.delete(attachments).where(eq(attachments.tenantId, c.tenantId));
});

const hdrA = () => ({ 'X-Company-Id': c.companyA });
const hdrB = () => ({ 'X-Company-Id': c.companyB });
const rowOf = async (id: string) => (await db.select().from(attachments).where(eq(attachments.id, id)))[0];

/** A's file (uploaded by the owner in A) and B's file (by the bookkeeper in B). */
async function seed() {
  const a = await uploadPdf(c.ownerToken, PDF_A, hdrA());
  expect(a.status, a.raw).toBe(201);
  const b = await uploadPdf(c.acctToken, PDF_B, hdrB());
  expect(b.status, b.raw).toBe(201);
  return { attA: a.json.attachment.id as string, attB: b.json.attachment.id as string };
}

describe('U-90: uploads record the company', () => {
  it('POST /attachments stamps X-Company-Id, or the first company the user may open', async () => {
    const { attA, attB } = await seed();
    expect((await rowOf(attA))!.companyId).toBe(c.companyA);
    expect((await rowOf(attB))!.companyId).toBe(c.companyB);
    // No header: the owner falls back to A, the excluded bookkeeper to B.
    const o = await uploadPdf(c.ownerToken, PDF_A);
    expect((await rowOf(o.json.attachment.id))!.companyId).toBe(c.companyA);
    const k = await uploadPdf(c.acctToken, PDF_B);
    expect((await rowOf(k.json.attachment.id))!.companyId).toBe(c.companyB);
  });

  it('an excluded user can\'t upload into company A (403)', async () => {
    const r = await uploadPdf(c.acctToken, PDF_A, hdrA());
    expect(r.status).toBe(403);
    expect((await db.select().from(attachments).where(eq(attachments.tenantId, c.tenantId))).length).toBe(0);
  });

  it('advertises attachments-company-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('attachments-company-v1');
  });
});

describe('U-90: a user excluded from company A can\'t reach A\'s files', () => {
  it('lists leave them out: /, /library (rows and total), /unlinked, API v2', async () => {
    const { attA, attB } = await seed();
    for (const headers of [{}, hdrB()]) {
      const unlinked = await send('GET', '/api/v1/attachments/unlinked', c.acctToken, undefined, headers);
      expect(unlinked.status).toBe(200);
      expect(unlinked.json.data.map((x: any) => x.id)).toEqual([attB]);
      const lib = await send('GET', '/api/v1/attachments/library', c.acctToken, undefined, headers);
      expect(lib.status).toBe(200);
      expect(lib.json.data.map((x: any) => x.id)).toEqual([attB]);
      expect(Number(lib.json.total)).toBe(1);
      const list = await send('GET', '/api/v1/attachments?attachable_type=draft', c.acctToken, undefined, headers);
      expect(list.json.data.map((x: any) => x.id)).toEqual([attB]);
      expect(Number(list.json.total)).toBe(1);
      const v2 = await send('GET', '/api/v2/attachments', c.acctToken, undefined, headers);
      expect(v2.status, v2.raw).toBe(200);
      expect(v2.json.data.map((x: any) => x.id)).toEqual([attB]);
    }
  });

  it('get, download (Bearer and ?_dl=), delete, OCR, link, bulk download, v2 get and AI routes are 404; nothing changes', async () => {
    const { attA } = await seed();
    const before = await rowOf(attA);
    expect((await send('GET', `/api/v1/attachments/${attA}`, c.acctToken)).status).toBe(404);
    expect((await send('GET', `/api/v1/attachments/${attA}`, c.acctToken, undefined, hdrB())).status).toBe(404);
    expect((await send('GET', `/api/v1/attachments/${attA}/download`, c.acctToken)).status).toBe(404);
    expect((await send('GET', `/api/v1/attachments/${attA}/download`, c.acctToken, undefined, hdrB())).status).toBe(404);
    const { token: dl } = issueDownloadToken({ userId: c.acctId, tenantId: c.tenantId, userRole: 'bookkeeper', isSuperAdmin: false, companyId: c.companyB });
    expect((await send('GET', `/api/v1/attachments/${attA}/download?_dl=${dl}`, null)).status).toBe(404);
    // A download token naming company A is refused for the excluded user.
    const { token: dlA } = issueDownloadToken({ userId: c.acctId, tenantId: c.tenantId, userRole: 'bookkeeper', isSuperAdmin: false, companyId: c.companyA });
    expect((await send('GET', `/api/v1/attachments/${attA}/download?_dl=${dlA}`, null)).status).toBe(403);
    expect((await send('DELETE', `/api/v1/attachments/${attA}`, c.acctToken)).status).toBe(404);
    expect((await send('POST', `/api/v1/attachments/${attA}/ocr`, c.acctToken)).status).toBe(404);
    expect((await send('POST', `/api/v1/attachments/${attA}/link`, c.acctToken, { attachableType: 'draft', attachableId: crypto.randomUUID() })).status).toBe(404);
    expect((await send('POST', '/api/v1/attachments/bulk-download', c.acctToken, { attachmentIds: [attA] })).status).toBe(404);
    expect((await send('GET', `/api/v2/attachments/${attA}`, c.acctToken)).status).toBe(404);
    for (const path of ['/api/v1/ai/classify', '/api/v1/ai/ocr/receipt', '/api/v1/ai/parse/statement']) {
      const r = await send('POST', path, c.acctToken, { attachmentId: attA });
      expect(r.status, `${path} ${r.raw}`).toBe(404);
    }
    // Asking for company A outright is 403.
    expect((await send('GET', `/api/v1/attachments/${attA}`, c.acctToken, undefined, hdrA())).status).toBe(403);
    expect((await send('DELETE', `/api/v1/attachments/${attA}`, c.acctToken, undefined, hdrA())).status).toBe(403);

    expect(await rowOf(attA)).toEqual(before);
    expect(fs.existsSync(`${TMP_UPLOAD_DIR}/${before!.storageKey}`)).toBe(true);
    expect(spies.processReceipt).not.toHaveBeenCalled();
    expect(spies.classifyAndRoute).not.toHaveBeenCalled();
  });

  it('draft relinks leave A\'s draft files alone', async () => {
    const { attA } = await seed();
    const draftId = (await rowOf(attA))!.attachableId;
    expect(await attachmentService.reassignDraftAttachments(c.tenantId, draftId, 'expense', crypto.randomUUID(), db, c.companyB)).toBe(0);
    expect((await rowOf(attA))!.attachableType).toBe('draft');
    expect(await attachmentService.reassignDraftAttachments(c.tenantId, draftId, 'expense', crypto.randomUUID(), db, c.companyA)).toBe(1);
  });
});

describe('U-90: owners and company B are unaffected', () => {
  it('the bookkeeper works with B\'s file as before', async () => {
    const { attB } = await seed();
    expect((await send('GET', `/api/v1/attachments/${attB}`, c.acctToken)).status).toBe(200);
    const dl = await send('GET', `/api/v1/attachments/${attB}/download`, c.acctToken);
    expect(dl.status).toBe(200);
    expect(dl.raw).toBe(PDF_B.toString('utf8'));
    expect((await send('POST', '/api/v1/attachments/bulk-download', c.acctToken, { attachmentIds: [attB] })).status).toBe(200);
    expect((await send('POST', `/api/v1/attachments/${attB}/ocr`, c.acctToken)).status).toBe(200);
    expect(spies.processReceipt).toHaveBeenCalledTimes(1);
    const r = await send('POST', '/api/v1/ai/classify', c.acctToken, { attachmentId: attB });
    expect(r.status, r.raw).not.toBe(404);
    expect((await send('POST', `/api/v1/attachments/${attB}/link`, c.acctToken, { attachableType: 'draft', attachableId: crypto.randomUUID() })).status).toBe(200);
    expect((await send('DELETE', `/api/v1/attachments/${attB}`, c.acctToken)).status).toBe(200);
    expect(await rowOf(attB)).toBeUndefined();
  });

  it('the owner sees each company\'s files in that company', async () => {
    const { attA, attB } = await seed();
    const inA = await send('GET', '/api/v1/attachments/unlinked', c.ownerToken, undefined, hdrA());
    expect(inA.json.data.map((x: any) => x.id)).toEqual([attA]);
    const inB = await send('GET', '/api/v1/attachments/unlinked', c.ownerToken, undefined, hdrB());
    expect(inB.json.data.map((x: any) => x.id)).toEqual([attB]);
    const dl = await send('GET', `/api/v1/attachments/${attA}/download`, c.ownerToken, undefined, hdrA());
    expect(dl.status).toBe(200);
    expect(dl.raw).toBe(PDF_A.toString('utf8'));
    const { token } = issueDownloadToken({ userId: c.ownerId, tenantId: c.tenantId, userRole: 'owner', isSuperAdmin: false, companyId: c.companyA });
    expect((await send('GET', `/api/v1/attachments/${attA}/download?_dl=${token}`, null)).status).toBe(200);
    // The owner in B doesn't reach A's file either: it is A's.
    expect((await send('GET', `/api/v1/attachments/${attA}`, c.ownerToken, undefined, hdrB())).status).toBe(404);
    expect((await send('DELETE', `/api/v1/attachments/${attA}`, c.ownerToken, undefined, hdrA())).status).toBe(200);
  });
});

describe('U-90: rows from before the change (no company)', () => {
  it('stay visible tenant-wide, unless filed on another company\'s transaction', async () => {
    const legacyDraft = await attachmentService.upload(c.tenantId,
      { originalname: 'old.pdf', buffer: PDF_A, mimetype: 'application/pdf', size: PDF_A.length },
      'draft', crypto.randomUUID(), { skipAutoClassify: true });
    const [txnA] = await db.insert(transactions).values({
      tenantId: c.tenantId, companyId: c.companyA, txnType: 'expense', txnDate: '2026-10-01', total: '42.0000',
    }).returning();
    const legacyOnA = await attachmentService.upload(c.tenantId,
      { originalname: 'filed.pdf', buffer: PDF_A, mimetype: 'application/pdf', size: PDF_A.length },
      'expense', txnA!.id, { skipAutoClassify: true });
    expect(legacyDraft!.companyId).toBeNull();
    expect(legacyOnA!.companyId).toBeNull();

    // The excluded bookkeeper (in B): the unfiled legacy draft yes, the file on A's expense no.
    expect((await send('GET', `/api/v1/attachments/${legacyDraft!.id}`, c.acctToken)).status).toBe(200);
    expect((await send('GET', `/api/v1/attachments/${legacyOnA!.id}`, c.acctToken)).status).toBe(404);
    expect((await send('GET', `/api/v1/attachments/${legacyOnA!.id}/download`, c.acctToken)).status).toBe(404);
    expect((await send('DELETE', `/api/v1/attachments/${legacyOnA!.id}`, c.acctToken)).status).toBe(404);
    const lib = await send('GET', '/api/v1/attachments/library', c.acctToken);
    expect(lib.json.data.map((x: any) => x.id)).toEqual([legacyDraft!.id]);
    const byTxn = await send('GET', `/api/v1/attachments?attachable_type=expense&attachable_id=${txnA!.id}`, c.acctToken);
    expect(byTxn.json.data).toEqual([]);
    // The owner in A sees both.
    const libA = await send('GET', '/api/v1/attachments/library', c.ownerToken, undefined, hdrA());
    expect(libA.json.data.map((x: any) => x.id).sort()).toEqual([legacyDraft!.id, legacyOnA!.id].sort());
    expect((await send('GET', `/api/v1/attachments/${legacyOnA!.id}/download`, c.ownerToken, undefined, hdrA())).status).toBe(200);
  });
});
