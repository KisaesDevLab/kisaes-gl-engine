// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-90 security-review fixes (attachments-company-v1). Two companies in one
// tenant, a bookkeeper excluded from company A (accountant_company_
// exclusions), and the owner in both:
//   H1  W-9 PDFs carry the vendor's company; the scope rule resolves the
//       company of contacts and other non-transaction parents.
//   M2  bill OCR uses the full scope rule.
//   M3  uploads check their target like /:id/link; /library joins only the
//       request company's records.
//   M4  links fill an empty company; migration 0231 backfills old rows.
//   M5  the download route checks permission and session shape first.
//   M6  statement-parse jobs are scoped by company.
//   L1  download tokens: company checked at issue, wins at redemption.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const TMP_UPLOAD_DIR = vi.hoisted(() => {
  const dir = `${process.cwd()}/.tmp-att-review-test-${process.pid}`;
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
// The W-9 PDF renderer needs a browser; any PDF bytes do here.
vi.mock('../services/portal-pdf.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/portal-pdf.service.js')>();
  return { ...actual, htmlToPdf: vi.fn(async () => Buffer.from('%PDF-1.4\n% W-9\n')) };
});

import 'express-async-errors';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, attachments, userPermissions, accountantCompanyExclusions, aiJobs, tbGroupings,
  w9Requests, vendor1099Profile,
} from '../db/schema/index.js';
import { attachmentsRouter } from './attachments.routes.js';
import { aiRouter } from './ai.routes.js';
import { downloadsRouter } from './downloads.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { env } from '../config/env.js';
import * as authService from '../services/auth.service.js';
import * as attachmentService from '../services/attachment.service.js';
import { extractBillFromAttachment } from '../services/ai-bill-ocr.service.js';
import { completeW9, getW9Document } from '../services/portal-1099.service.js';
import { issueDownloadToken, consumeDownloadToken } from '../utils/download-token.js';
import { invalidateSystemProviderCache } from '../services/storage/storage-provider.factory.js';

let server: Server | null = null;
let port = 0;
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const PDF = Buffer.from('%PDF-1.4\n% statement\n');

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

function uploadPdf(token: string, attachableType: string, attachableId: string, headers: Record<string, string> = {}) {
  const b = '----u90review';
  const part = (name: string, value: string) =>
    `--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('attachableType', attachableType) + part('attachableId', attachableId)),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    PDF,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return send('POST', '/api/v1/attachments?autoOcr=0', token, body, { 'Content-Type': `multipart/form-data; boundary=${b}`, ...headers });
}

interface Ctx {
  tenantId: string; ownerId: string; ownerToken: string; companyA: string; companyB: string;
  acctId: string; acctToken: string; noPermToken: string;
  txnA: string; contactA: string; groupingA: string;
}
let c: Ctx;

/** A file with no company (as before U-90) filed on `attachableId`. */
async function legacy(attachableType: string, attachableId: string) {
  const row = await attachmentService.upload(c.tenantId,
    { originalname: 'old.pdf', buffer: PDF, mimetype: 'application/pdf', size: PDF.length },
    attachableType, attachableId, { skipAutoClassify: true });
  expect(row!.companyId).toBeNull();
  return row!;
}
const rowOf = async (id: string) => (await db.select().from(attachments).where(eq(attachments.id, id)))[0];
const hdrA = () => ({ 'X-Company-Id': c.companyA });
const hdrB = () => ({ 'X-Company-Id': c.companyB });

async function cleanTenant(tid: string) {
  await db.delete(aiJobs).where(eq(aiJobs.tenantId, tid));
  await db.delete(attachments).where(eq(attachments.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(vendor1099Profile).where(eq(vendor1099Profile.tenantId, tid));
  await db.delete(w9Requests).where(eq(w9Requests.tenantId, tid));
  await db.delete(tbGroupings).where(eq(tbGroupings.tenantId, tid));
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
  app.use('/api/v1/downloads', downloadsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });

  const reg = await authService.register({
    email: `att-rv-${suffix()}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: 'Ozark Excavating',
  });
  const tenantId = reg.user.tenantId;
  const [companyA] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: 'Table Rock Marina', setupComplete: true }).returning();
  const mkUser = async (name: string, overrides: Record<string, string>) => {
    const [u] = await db.insert(users).values({
      tenantId, email: `${name}-${suffix()}@example.com`, passwordHash: 'x', displayName: name, role: 'bookkeeper',
    }).returning();
    await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role: 'bookkeeper' });
    await db.insert(userPermissions).values({ tenantId, userId: u!.id, overrides: overrides as never });
    await db.insert(accountantCompanyExclusions).values({ userId: u!.id, companyId: companyA!.id } as never);
    const token = (await authService.issueSession({ userId: u!.id, tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
    return { id: u!.id, token };
  };
  const acct = await mkUser('bk', { attachments: 'full', transactions: 'full' });
  const noPerm = await mkUser('np', { attachments: 'none' });
  const [txnA] = await db.insert(transactions).values({
    tenantId, companyId: companyA!.id, txnType: 'expense', txnDate: '2026-10-01', total: '42.0000', memo: 'A secret memo',
  }).returning();
  const [contactA] = await db.insert(contacts).values({
    tenantId, companyId: companyA!.id, contactType: 'vendor', displayName: 'A Vendor LLC',
  } as never).returning();
  const [groupingA] = await db.insert(tbGroupings).values({ tenantId, companyId: companyA!.id, name: 'Cash' }).returning();
  c = {
    tenantId, ownerId: reg.user.id, ownerToken: reg.tokens.accessToken, companyA: companyA!.id, companyB: companyB!.id,
    acctId: acct.id, acctToken: acct.token, noPermToken: noPerm.token,
    txnA: txnA!.id, contactA: (contactA as { id: string }).id, groupingA: groupingA!.id,
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
  await db.delete(aiJobs).where(eq(aiJobs.tenantId, c.tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, c.tenantId));
});

describe('H1: W-9 PDFs and other non-transaction parents', () => {
  it('a completed W-9 stores the vendor\'s company; the excluded user can\'t reach it', async () => {
    const token = crypto.randomBytes(24).toString('hex');
    await db.insert(w9Requests).values({
      tenantId: c.tenantId, contactId: c.contactA, requestedContactEmail: 'v@example.com',
      magicLinkTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 86_400_000), createdBy: c.ownerId,
    } as never);
    await completeW9({
      token, legalName: 'A Vendor LLC', taxClassification: 'llc',
      address: { line1: '1 Main', city: 'Branson', state: 'MO', zip: '65616' },
      tin: '12-3456789', tinType: 'EIN', backupWithholding: false, signatureName: 'A Vendor', consent: true,
    });
    const [w9] = await db.select().from(attachments)
      .where(eq(attachments.attachableId, c.contactA));
    expect(w9).toBeDefined();
    expect(w9!.attachableType).toBe('vendor_1099_profile');
    expect(w9!.companyId).toBe(c.companyA);

    expect((await send('GET', `/api/v1/attachments/${w9!.id}`, c.acctToken)).status).toBe(404);
    expect((await send('GET', `/api/v1/attachments/${w9!.id}/download`, c.acctToken)).status).toBe(404);
    const list = await send('GET', '/api/v1/attachments', c.acctToken);
    expect(list.json.data).toEqual([]);
    await expect(getW9Document(c.tenantId, c.contactA, { userId: c.acctId })).rejects.toMatchObject({ statusCode: 404 });
    // The owner (not excluded) gets it, in A and from the 1099 screen.
    expect((await send('GET', `/api/v1/attachments/${w9!.id}`, c.ownerToken, undefined, hdrA())).status).toBe(200);
    await expect(getW9Document(c.tenantId, c.contactA, { userId: c.ownerId })).resolves.toMatchObject({ mimeType: 'application/pdf' });
  });

  it('a file with no company on A\'s contact or TB lead sheet is A\'s', async () => {
    const onContact = await legacy('vendor_1099_profile', c.contactA);
    const onGrouping = await legacy('tb_leadsheet', c.groupingA);
    const tenantWide = await legacy('draft', crypto.randomUUID());
    for (const id of [onContact.id, onGrouping.id]) {
      expect((await send('GET', `/api/v1/attachments/${id}`, c.acctToken)).status).toBe(404);
      expect((await send('GET', `/api/v1/attachments/${id}`, c.ownerToken, undefined, hdrB())).status).toBe(404);
      expect((await send('GET', `/api/v1/attachments/${id}`, c.ownerToken, undefined, hdrA())).status).toBe(200);
    }
    const lib = await send('GET', '/api/v1/attachments/library', c.acctToken);
    expect(lib.json.data.map((x: any) => x.id)).toEqual([tenantWide.id]);
  });
});

describe('M2: bill OCR uses the full scope rule', () => {
  it('a file with no company on A\'s transaction is 404 from company B, before any AI', async () => {
    const onA = await legacy('expense', c.txnA);
    await expect(extractBillFromAttachment(c.tenantId, onA.id, c.companyB)).rejects.toMatchObject({ statusCode: 404 });
    expect((await rowOf(onA.id))!.ocrStatus).toBeNull();
  });
});

describe('M3: upload targets and the library join', () => {
  it('uploading onto A\'s transaction or contact from company B is 404 and stores nothing', async () => {
    for (const [type, id] of [['expense', c.txnA], ['contact', c.contactA], ['tb_leadsheet', c.groupingA]] as const) {
      const r = await uploadPdf(c.acctToken, type, id);
      expect(r.status, `${type} ${r.raw}`).toBe(404);
    }
    // A transaction type with an id that is no transaction: 404 too.
    expect((await uploadPdf(c.acctToken, 'expense', crypto.randomUUID())).status).toBe(404);
    expect(await db.select().from(attachments).where(eq(attachments.tenantId, c.tenantId))).toEqual([]);
    // The owner in A may.
    const ok = await uploadPdf(c.ownerToken, 'expense', c.txnA, hdrA());
    expect(ok.status, ok.raw).toBe(201);
    expect(ok.json.attachment.companyId).toBe(c.companyA);
  });

  it('/library never joins another company\'s transaction', async () => {
    // A B row pointing at A's transaction id (e.g. written by an older client).
    const [row] = await db.insert(attachments).values({
      tenantId: c.tenantId, companyId: c.companyB, fileName: 'x.pdf', filePath: '/uploads/x.pdf',
      attachableType: 'expense', attachableId: c.txnA,
    }).returning();
    const lib = await send('GET', '/api/v1/attachments/library', c.acctToken);
    const got = lib.json.data.find((x: any) => x.id === row!.id);
    expect(got).toBeDefined();
    expect(got.txnMemo).toBeNull();
    expect(got.txnDate).toBeNull();
  });
});

describe('M4: links fill an empty company; the backfill', () => {
  it('link and draft relinks fill in the request\'s company only when the row has none', async () => {
    const draft = await legacy('draft', crypto.randomUUID());
    const r = await send('POST', `/api/v1/attachments/${draft.id}/link`, c.acctToken, { attachableType: 'receipt', attachableId: crypto.randomUUID() });
    expect(r.status, r.raw).toBe(200);
    expect((await rowOf(draft.id))!.companyId).toBe(c.companyB);

    const d2 = await legacy('draft', crypto.randomUUID());
    expect(await attachmentService.reassignDraftAttachments(c.tenantId, d2.attachableId, 'expense', crypto.randomUUID(), db, c.companyB)).toBe(1);
    expect((await rowOf(d2.id))!.companyId).toBe(c.companyB);
    const d3 = await legacy('draft', crypto.randomUUID());
    const ids = await attachmentService.relinkDraftAttachments(db, c.tenantId, d3.attachableId, 'bill', crypto.randomUUID(), c.ownerId, c.companyA);
    expect(ids).toEqual([d3.id]);
    expect((await rowOf(d3.id))!.companyId).toBe(c.companyA);
    // A company already on the row is kept.
    const own = await uploadPdf(c.acctToken, 'draft', crypto.randomUUID());
    await send('POST', `/api/v1/attachments/${own.json.attachment.id}/link`, c.acctToken, { attachableType: 'receipt', attachableId: crypto.randomUUID() });
    expect((await rowOf(own.json.attachment.id))!.companyId).toBe(c.companyB);
  });

  it('migration 0231 copies the parent\'s company onto rows without one, and a re-run changes nothing', async () => {
    const onTxn = await legacy('expense', c.txnA);
    const onContact = await legacy('vendor_1099_profile', c.contactA);
    const onGrouping = await legacy('tb_leadsheet', c.groupingA);
    const draft = await legacy('draft', crypto.randomUUID());
    const sqlText = fs.readFileSync(path.join(process.cwd(), 'src/db/migrations/0231_attachments_company_backfill.sql'), 'utf8');
    const run = async () => {
      for (const stmt of sqlText.split('--> statement-breakpoint')) await db.execute(sql.raw(stmt));
    };
    await run();
    expect((await rowOf(onTxn.id))!.companyId).toBe(c.companyA);
    expect((await rowOf(onContact.id))!.companyId).toBe(c.companyA);
    expect((await rowOf(onGrouping.id))!.companyId).toBe(c.companyA);
    expect((await rowOf(draft.id))!.companyId).toBeNull();
    const before = await db.select().from(attachments).where(eq(attachments.tenantId, c.tenantId));
    await run();
    expect(await db.select().from(attachments).where(eq(attachments.tenantId, c.tenantId))).toEqual(before);
  });
});

describe('M5: the download route checks permission and session first', () => {
  it('no attachments permission is 403 PERMISSION_DENIED, even for a file it could see', async () => {
    const draft = await legacy('draft', crypto.randomUUID());
    const r = await send('GET', `/api/v1/attachments/${draft.id}/download`, c.noPermToken);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('PERMISSION_DENIED');
  });

  it('a non-session JWT in the Authorization header is 401', async () => {
    const draft = await legacy('draft', crypto.randomUUID());
    const base = { userId: c.ownerId, tenantId: c.tenantId, role: 'owner' };
    for (const extra of [{ typ: 'dl' }, { tfa_pending: true }, { checks_stepup: true }]) {
      const t = jwt.sign({ ...base, ...extra }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 60 });
      expect((await send('GET', `/api/v1/attachments/${draft.id}/download`, t)).status).toBe(401);
    }
    expect((await send('GET', `/api/v1/attachments/${draft.id}/download`, c.ownerToken)).status).toBe(200);
  });
});

describe('M6: statement-parse jobs are scoped by company', () => {
  async function jobFor(attachmentId: string) {
    const [job] = await db.insert(aiJobs).values({
      tenantId: c.tenantId, jobType: 'ocr_statement', status: 'complete', inputType: 'attachment', inputId: attachmentId,
      outputData: { transactions: [{ date: '2026-10-01', description: 'x', amount: '1.00', type: 'debit' }] },
    } as never).returning();
    return (job as { id: string }).id;
  }

  it('the excluded user can\'t list, read, edit, reprocess, re-read or delete A\'s parses', async () => {
    const own = await uploadPdf(c.ownerToken, 'draft', crypto.randomUUID(), hdrA());
    const jobA = await jobFor(own.json.attachment.id);
    const mine = await uploadPdf(c.acctToken, 'draft', crypto.randomUUID());
    const jobB = await jobFor(mine.json.attachment.id);

    const list = await send('GET', '/api/v1/ai/parse/statement/jobs', c.acctToken);
    expect(list.status, list.raw).toBe(200);
    expect(list.json.jobs.map((j: any) => j.jobId)).toEqual([jobB]);
    expect(list.json.total).toBe(1);

    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/api/v1/ai/parse/statement/jobs/${jobA}`],
      ['GET', `/api/v1/ai/parse/statement/${jobA}/status`],
      ['PATCH', `/api/v1/ai/parse/statement/jobs/${jobA}/transactions`, { edits: [{ index: 0, amount: '2.00' }] }],
      ['POST', `/api/v1/ai/parse/statement/jobs/${jobA}/reprocess`],
      ['POST', `/api/v1/ai/parse/statement/jobs/${jobA}/reread-checks`],
      ['DELETE', `/api/v1/ai/parse/statement/jobs/${jobA}`],
    ];
    for (const [method, p, body] of calls) {
      const r = await send(method, p, c.acctToken, body);
      expect(r.status, `${method} ${p} ${r.raw}`).toBe(404);
    }
    const [still] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobA));
    expect(still).toBeDefined();
    expect((still!.outputData as any).transactions[0].amount).toBe('1.00');

    // The owner in A, and the bookkeeper on B's own job, are unaffected.
    expect((await send('GET', `/api/v1/ai/parse/statement/jobs/${jobA}`, c.ownerToken, undefined, hdrA())).status).toBe(200);
    expect((await send('GET', `/api/v1/ai/parse/statement/jobs/${jobB}`, c.acctToken)).status).toBe(200);
    const listA = await send('GET', '/api/v1/ai/parse/statement/jobs', c.ownerToken, undefined, hdrA());
    expect(listA.json.jobs.map((j: any) => j.jobId)).toEqual([jobA]);
  });
});

describe('L1: download tokens', () => {
  it('issuing a token for company A is 403 for the excluded user; for B it carries B', async () => {
    expect((await send('POST', '/api/v1/downloads/token', c.acctToken, {}, hdrA())).status).toBe(403);
    const r = await send('POST', '/api/v1/downloads/token', c.acctToken, {}, hdrB());
    expect(r.status).toBe(200);
    expect(consumeDownloadToken(r.json.token)!.companyId).toBe(c.companyB);
    const none = await send('POST', '/api/v1/downloads/token', c.acctToken, {});
    expect(consumeDownloadToken(none.json.token)!.companyId).toBeNull();
  });

  it('at redemption the token\'s company wins over X-Company-Id', async () => {
    const own = await uploadPdf(c.ownerToken, 'draft', crypto.randomUUID(), hdrA());
    const { token } = issueDownloadToken({ userId: c.ownerId, tenantId: c.tenantId, userRole: 'owner', isSuperAdmin: false, companyId: c.companyB });
    // A token for B doesn't reach A's file, whatever the header says.
    expect((await send('GET', `/api/v1/attachments/${own.json.attachment.id}/download?_dl=${token}`, null, undefined, hdrA())).status).toBe(404);
    expect((await send('GET', `/api/v1/attachments/${own.json.attachment.id}/download?_dl=${token}&_company=${c.companyA}`, null)).status).toBe(404);
    const { token: tA } = issueDownloadToken({ userId: c.ownerId, tenantId: c.tenantId, userRole: 'owner', isSuperAdmin: false, companyId: c.companyA });
    expect((await send('GET', `/api/v1/attachments/${own.json.attachment.id}/download?_dl=${tA}`, null, undefined, hdrB())).status).toBe(200);
  });
});
