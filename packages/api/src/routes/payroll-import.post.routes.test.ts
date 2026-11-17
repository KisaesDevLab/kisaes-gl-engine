// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Payroll post and reverse through the HTTP routes (payroll-import-post-v1):
//   - U-244: one database transaction with the session locked; Idempotency-Key;
//     409 PAYROLL_ALREADY_POSTED / PAYROLL_NOT_POSTED / PAYROLL_DUPLICATE_FILE /
//     PAYROLL_PREVIEW_CHANGED; the overlap prompt claims no key (R2);
//   - U-245: the closing-date password on post and reverse;
//   - U-251: discardEmployeeDetail removes the rows and the stored upload.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, sql } from 'drizzle-orm';
import { PayrollLineType } from '@kis-books/shared';
import { db } from '../db/index.js';
import { companies, accounts, payrollImportSessions, payrollImportRows, payrollCheckRegisterRows } from '../db/schema/index.js';
import { payrollImportRouter } from './payroll-import.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as importService from '../services/payroll-import.service.js';
import * as validation from '../services/payroll-validation.service.js';
import { __payrollPostTestHooks } from '../services/payroll-je.service.js';
import { __idempotencyDiagnostics } from '../services/idempotency.service.js';
import { resolveForExport, resolveForImport } from '../services/tenant-portability/files.js';
import { FILE_COLUMNS } from '../services/tenant-portability/plan.js';
import { env } from '../config/env.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const CLOSING_PHRASE = 'close-the-books';

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function request(method: string, pathname: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanTenant(tid: string) {
  await db.execute(sql`DELETE FROM payroll_import_rows WHERE session_id IN (SELECT id FROM payroll_import_sessions WHERE tenant_id = ${tid})`);
  await db.execute(sql`DELETE FROM payroll_import_errors WHERE session_id IN (SELECT id FROM payroll_import_sessions WHERE tenant_id = ${tid})`);
  await db.execute(sql`DELETE FROM payroll_check_register_rows WHERE session_id IN (SELECT id FROM payroll_import_sessions WHERE tenant_id = ${tid})`);
  for (const tbl of ['idempotency_keys', 'payroll_import_sessions', 'payroll_account_mapping', 'transaction_tags', 'audit_log', 'journal_lines', 'transactions', 'gl_version_stamps', 'tags', 'contacts', 'accounts', 'companies']) {
    await db.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE tenant_id = ${tid}`);
  }
  await db.execute(sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ${tid})`);
  for (const tbl of ['user_permissions', 'user_tenant_access', 'users']) {
    await db.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE tenant_id = ${tid}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tid}`);
}

let tenantId = '';
let companyId = '';
let token = '';
let fitAcct = '';

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payroll-import', payrollImportRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `payroll-post-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: 'Payroll Post Co',
  });
  tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  token = reg.tokens.accessToken;
  companyId = (await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1))[0]!.id;
  const mk = async (name: string, accountType: string, accountNumber: string) =>
    (await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber }).returning())[0]!.id;
  fitAcct = await mk('P30 FIT Payable', 'liability', '29100');
  await importService.saveAccountMappings(tenantId, companyId, {
    [PayrollLineType.GROSS_WAGES_EXPENSE]: await mk('P30 Wages', 'expense', '69000'),
    [PayrollLineType.FIT_PAYABLE]: fitAcct,
    [PayrollLineType.PAYROLL_CLEARING]: await mk('P30 Checking', 'asset', '19100'),
  });
  __idempotencyDiagnostics.unclaimed.length = 0;
});

afterEach(async () => {
  delete __payrollPostTestHooks.beforeEntry;
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const MAPPING = {
  employee_name: { source: 'Employee' }, check_date: { source: 'Check Date' },
  gross_pay: { source: 'Gross' }, federal_income_tax: { source: 'FIT' }, net_pay: { source: 'Net' },
};

/** A validated employee-level session; one row per [date, gross, fit, net]. */
async function validatedSession(rows: Array<[string, string, string, string]>, opts: { fileHash?: string; filePath?: string } = {}) {
  const [s] = await db.insert(payrollImportSessions).values({
    tenantId, companyId, importMode: 'employee_level', originalFilename: 'payroll.csv',
    filePath: opts.filePath ?? '/tmp/payroll.csv', fileHash: opts.fileHash ?? 'hash-' + crypto.randomUUID(), status: 'uploaded',
    rowCount: rows.length, metadata: { headers: ['Employee', 'Check Date', 'Gross', 'FIT', 'Net'] },
  }).returning();
  await db.insert(payrollImportRows).values(rows.map(([d, g, f, n], i) => ({
    sessionId: s!.id, rowNumber: i + 1, rawData: { Employee: `Sample ${i}`, 'Check Date': d, Gross: g, FIT: f, Net: n },
  })));
  await importService.applyMapping(tenantId, s!.id, { header_row: 0, data_start_row: 1, mappings: MAPPING } as any);
  const v = await validation.validateSession(tenantId, s!.id);
  expect(v.errorRows).toBe(0);
  return s!.id;
}

const post = (id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  request('POST', `/api/v1/payroll-import/sessions/${id}/post`, token, { aggregationMode: 'summary', ...body }, headers);
const reverse = (id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  request('POST', `/api/v1/payroll-import/sessions/${id}/reverse`, token, { reason: 'test', ...body }, headers);
const entryCount = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE tenant_id = ${tenantId} AND source = 'payroll_import' AND status = 'posted'`)).rows[0] as { c: number }).c;
const statusOf = async (id: string) => (await db.select().from(payrollImportSessions).where(eq(payrollImportSessions.id, id)))[0]!;
const newKey = () => crypto.randomUUID();

describe('U-244 atomic post and reverse', () => {
  it('lists the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('payroll-import-post-v1');
  });

  it('a failure on entry 2 leaves no entry and the session validated', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00'], ['2026-07-24', '500.00', '50.00', '450.00']]);
    __payrollPostTestHooks.beforeEntry = (i) => { if (i === 1) throw new Error('forced failure on entry 2'); };
    const r = await post(id);
    expect(r.status).toBe(500);
    expect(await entryCount()).toBe(0);
    expect((await statusOf(id)).status).toBe('validated');
    delete __payrollPostTestHooks.beforeEntry;
    const ok = await post(id);
    expect(ok.status).toBe(200);
    expect(ok.json.count).toBe(2);
  });

  it('two concurrent posts give one 200 and one 409 PAYROLL_ALREADY_POSTED', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    const results = await Promise.all([post(id), post(id)]);
    const statuses = results.map(r => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.json.error.code).toBe('PAYROLL_ALREADY_POSTED');
    expect(await entryCount()).toBe(1);
  });

  it('the same Idempotency-Key replays one set of entries', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    const key = newKey();
    const first = await post(id, {}, { 'Idempotency-Key': key });
    expect(first.status).toBe(200);
    const again = await post(id, {}, { 'Idempotency-Key': key });
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(first.json);
    expect(await entryCount()).toBe(1);
  });

  it('reverse voids every entry once; a second reverse is 409 PAYROLL_NOT_POSTED', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00'], ['2026-07-24', '500.00', '50.00', '450.00']]);
    expect((await post(id)).status).toBe(200);
    const r1 = await reverse(id, {}, { 'Idempotency-Key': newKey() });
    expect(r1.status).toBe(200);
    expect(r1.json.reversed).toBe(2);
    expect(await entryCount()).toBe(0);
    const r2 = await reverse(id);
    expect(r2.status).toBe(409);
    expect(r2.json.error.code).toBe('PAYROLL_NOT_POSTED');
    expect(r2.json.error.details).toEqual({ status: 'cancelled' });
  });

  it('the overlap prompt writes nothing and claims no key (R2); forcePost with a new key posts', async () => {
    const prior = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    expect((await post(prior)).status).toBe(200);
    const id = await validatedSession([['2026-07-11', '800.00', '80.00', '720.00']]);
    const key = newKey();
    const prompt = await post(id, {}, { 'Idempotency-Key': key });
    expect(prompt.status).toBe(200);
    expect(prompt.json.requiresConfirmation).toBe(true);
    expect(prompt.json.overlaps[0].matchingDates).toEqual(['2026-07-11']);
    expect(__idempotencyDiagnostics.unclaimed).toEqual([]);
    const stored = await db.execute(sql`SELECT count(*)::int AS c FROM idempotency_keys WHERE tenant_id = ${tenantId} AND idempotency_key = ${key}`);
    expect((stored.rows[0] as { c: number }).c).toBe(0);
    const forced = await post(id, { forcePost: true }, { 'Idempotency-Key': newKey() });
    expect(forced.status).toBe(200);
    expect(forced.json.count).toBe(1);
  });

  it('a changed preview is 409 PAYROLL_PREVIEW_CHANGED', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    const gen = await request('POST', `/api/v1/payroll-import/sessions/${id}/generate-je`, token, { aggregationMode: 'summary' });
    expect(gen.status).toBe(200);
    expect(gen.json.previewToken).toMatch(/^[0-9a-f]{64}$/);
    const other = (await db.insert(accounts).values({ tenantId, companyId, name: 'P30 FIT 2', accountType: 'liability', accountNumber: '29101' }).returning())[0]!.id;
    await importService.saveAccountMappings(tenantId, companyId, { [PayrollLineType.FIT_PAYABLE]: other });
    const stale = await post(id, { previewToken: gen.json.previewToken });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('PAYROLL_PREVIEW_CHANGED');
    expect(await entryCount()).toBe(0);
    const fresh = await request('POST', `/api/v1/payroll-import/sessions/${id}/generate-je`, token, { aggregationMode: 'summary' });
    expect((await post(id, { previewToken: fresh.json.previewToken })).status).toBe(200);
  });

  it('the same file twice is 409 PAYROLL_DUPLICATE_FILE naming the prior import', async () => {
    const first = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']], { fileHash: 'same-file-hash' });
    expect((await post(first)).status).toBe(200);
    const second = await validatedSession([['2026-08-10', '1000.00', '100.00', '900.00']], { fileHash: 'same-file-hash' });
    const r = await post(second, { forcePost: true });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('PAYROLL_DUPLICATE_FILE');
    expect(r.json.error.details.priorSessionId).toBe(first);
  });

  it('a session that is not validated is 409 PAYROLL_NOT_READY', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    await db.update(payrollImportSessions).set({ status: 'mapped' }).where(eq(payrollImportSessions.id, id));
    const r = await post(id);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'PAYROLL_NOT_READY', details: { status: 'mapped' } });
  });
});

describe('U-245 closing-date password', () => {
  const auditCount = async (entityType: string) =>
    ((await db.execute(sql`SELECT count(*)::int AS c FROM audit_log WHERE tenant_id = ${tenantId} AND entity_type = ${entityType}`)).rows[0] as { c: number }).c;

  it('post and reverse in a closed period need the password, and each override is audited', async () => {
    const id = await validatedSession([['2026-06-15', '1000.00', '100.00', '900.00']]);
    await db.update(companies).set({ lockDate: '2026-06-30', closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) })
      .where(eq(companies.id, companyId));

    const locked = await post(id);
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe('TB_PERIOD_LOCKED');
    const wrong = await post(id, { closingPassword: 'nope' });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect(await entryCount()).toBe(0);

    const ok = await post(id, { closingPassword: CLOSING_PHRASE });
    expect(ok.status).toBe(200);
    expect(await auditCount('closing_date_override')).toBe(1);

    const rLocked = await reverse(id);
    expect(rLocked.status).toBe(423);
    const rOk = await reverse(id, { closingPassword: CLOSING_PHRASE });
    expect(rOk.status).toBe(200);
    expect(await auditCount('closing_date_override')).toBe(2);
  });
});

describe('U-251 discard employee detail on post', () => {
  it('removes the rows and the stored upload, keeps reverse and duplicate checks working', async () => {
    const dir = path.join(env.UPLOAD_DIR || '/data/uploads', 'payroll');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${crypto.randomUUID()}.csv`);
    fs.writeFileSync(filePath, 'Employee,Check Date,Gross,FIT,Net\n');
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']], { filePath, fileHash: 'discard-hash' });

    const r = await post(id, { discardEmployeeDetail: true });
    expect(r.status).toBe(200);
    const s = await statusOf(id);
    expect(s.status).toBe('posted');
    expect(s.filePath).toBeNull();
    expect(s.detailDiscardedAt).not.toBeNull();
    expect(s.fileHash).toBe('discard-hash');
    const left = await db.select().from(payrollImportRows).where(eq(payrollImportRows.sessionId, id));
    expect(left).toHaveLength(0);
    expect(fs.existsSync(filePath)).toBe(false);

    const preview = await request('GET', `/api/v1/payroll-import/sessions/${id}/preview`, token);
    expect(preview.json.rows).toEqual([]);
    expect(preview.json.detailDiscarded).toBe(true);

    // The tenant export carries no file for the session, and an import keeps NULL.
    const rule = FILE_COLUMNS['payroll_import_sessions.file_path']!;
    const ctx = { uploadDir: env.UPLOAD_DIR || '/data/uploads' } as any;
    expect(resolveForExport(rule, ctx, s.filePath, {}).kind).toBe('none');
    expect(resolveForImport(rule, ctx, crypto.randomUUID(), crypto.randomUUID(), null, false)).toMatchObject({ value: null, nulled: false });

    const dup = await validatedSession([['2026-09-10', '1.00', '0.00', '1.00']], { fileHash: 'discard-hash' });
    expect((await post(dup, { forcePost: true })).json.error.code).toBe('PAYROLL_DUPLICATE_FILE');

    const rev = await reverse(id);
    expect(rev.status).toBe(200);
    expect(rev.json.reversed).toBe(1);
  });

  it('is refused 422 PAYROLL_DISCARD_UNSUPPORTED when the session has check-register rows', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    await db.insert(payrollCheckRegisterRows).values({
      sessionId: id, rowNumber: 1, checkDate: '2026-07-10', payeeName: 'Sample', amount: '900.00', checkType: 'employee', posted: false,
    } as any);
    const r = await post(id, { discardEmployeeDetail: true });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('PAYROLL_DISCARD_UNSUPPORTED');
    expect(await entryCount()).toBe(0);
    const rows = await db.select().from(payrollImportRows).where(and(eq(payrollImportRows.sessionId, id)));
    expect(rows.length).toBe(1);
  });
});
