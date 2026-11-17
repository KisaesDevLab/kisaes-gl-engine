// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// payroll-import-review-v1 (ClientLedger P30 review):
//   - B1: a delete racing a post runs entirely before it (post 404, nothing
//     posted) or is refused after it (400, the posted import stays);
//   - S1: two sessions of one file / one provider run posted at once give one
//     200 and one 409;
//   - S5: Mode B negative amounts post the other way; an undated row refuses
//     the file;
//   - S3: Mode A validate lists every department in the file;
//   - M5: generateJE reads the session on the caller's transaction.
// The races are made deterministic: one side is held inside its transaction
// (a test seam) until the other side is seen waiting on the lock.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, sql } from 'drizzle-orm';
import { PayrollLineType, MODE_B_COLUMN_CONFIGS } from '@kis-books/shared';
import { db } from '../db/index.js';
import { companies, accounts, payrollImportSessions, payrollImportRows } from '../db/schema/index.js';
import { payrollImportRouter } from './payroll-import.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as importService from '../services/payroll-import.service.js';
import * as validation from '../services/payroll-validation.service.js';
import * as je from '../services/payroll-je.service.js';
import * as modeB from '../services/payroll-modeb.service.js';
import { __payrollPostTestHooks } from '../services/payroll-je.service.js';
import { __payrollDeleteTestHooks } from '../services/payroll-import.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const openGates: Array<() => void> = [];

interface Res { status: number; json: any }

function request(method: string, pathname: string, token: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json });
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
  for (const tbl of ['idempotency_keys', 'payroll_import_sessions', 'payroll_account_mapping', 'payroll_description_account_map', 'transaction_tags', 'audit_log', 'journal_lines', 'transactions', 'gl_version_stamps', 'tags', 'contacts', 'accounts', 'companies']) {
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
let userId = '';
let token = '';
const acct = { wages: '', fit: '', cash: '' };

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payroll-import', payrollImportRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `payroll-review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: 'Payroll Review Co',
  });
  tenantId = reg.user.tenantId;
  userId = reg.user.id;
  tenantIds.push(tenantId);
  token = reg.tokens.accessToken;
  companyId = (await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1))[0]!.id;
  acct.wages = await mkAccount('Review Wages', 'expense', '69300');
  acct.fit = await mkAccount('Review FIT Payable', 'liability', '29600');
  acct.cash = await mkAccount('Review Checking', 'asset', '19300');
  await importService.saveAccountMappings(tenantId, companyId, {
    [PayrollLineType.GROSS_WAGES_EXPENSE]: acct.wages,
    [PayrollLineType.FIT_PAYABLE]: acct.fit,
    [PayrollLineType.PAYROLL_CLEARING]: acct.cash,
  });
});

afterEach(async () => {
  while (openGates.length) openGates.pop()!();
  await new Promise((r) => setTimeout(r, 50));
  delete __payrollPostTestHooks.beforeEntry;
  delete __payrollDeleteTestHooks.afterLock;
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

async function mkAccount(name: string, accountType: string, accountNumber: string) {
  return (await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber }).returning())[0]!.id;
}

const MAPPING = {
  employee_name: { source: 'Employee' }, check_date: { source: 'Check Date' },
  gross_pay: { source: 'Gross' }, federal_income_tax: { source: 'FIT' }, net_pay: { source: 'Net' },
  department: { source: 'Dept' },
};

/** A validated employee-level session; one row per [date, gross, fit, net, dept?]. */
async function validatedSession(
  rows: Array<[string, string, string, string, string?]>,
  opts: { fileHash?: string; provider?: string; runKey?: string } = {},
) {
  const [s] = await db.insert(payrollImportSessions).values({
    tenantId, companyId, importMode: 'employee_level', originalFilename: 'payroll.csv',
    filePath: '/tmp/payroll.csv', fileHash: opts.fileHash ?? 'hash-' + crypto.randomUUID(), status: 'uploaded',
    rowCount: rows.length, detectedProvider: opts.provider ?? null, idempotencyKey: opts.runKey ?? null,
    metadata: { headers: ['Employee', 'Check Date', 'Gross', 'FIT', 'Net', 'Dept'] },
  }).returning();
  await db.insert(payrollImportRows).values(rows.map(([d, g, f, n, dept], i) => ({
    sessionId: s!.id, rowNumber: i + 1,
    rawData: { Employee: `Sample ${i}`, 'Check Date': d, Gross: g, FIT: f, Net: n, Dept: dept ?? '' },
  })));
  await importService.applyMapping(tenantId, s!.id, { header_row: 0, data_start_row: 1, mappings: MAPPING } as any);
  const v = await validation.validateSession(tenantId, s!.id);
  expect(v.errorRows).toBe(0);
  return s!.id;
}

const post = (id: string, body: Record<string, unknown> = {}) =>
  request('POST', `/api/v1/payroll-import/sessions/${id}/post`, token, { aggregationMode: 'summary', ...body });
const del = (id: string) => request('DELETE', `/api/v1/payroll-import/sessions/${id}`, token);
const entryCount = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE tenant_id = ${tenantId} AND source = 'payroll_import' AND status = 'posted'`)).rows[0] as { c: number }).c;
const sessionOf = async (id: string) => (await db.select().from(payrollImportSessions).where(eq(payrollImportSessions.id, id)))[0];

/** Holds the first caller of a test seam inside its transaction until released. */
function gate() {
  let entered!: () => void;
  let release!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  const releaseP = new Promise<void>((r) => { release = r; });
  let used = false;
  // A failing test must not leave a transaction held open.
  openGates.push(() => release());
  return {
    hook: async () => {
      if (used) return;
      used = true;
      entered();
      await releaseP;
    },
    entered: enteredP,
    release,
  };
}

/** Waits until another backend is blocked on a lock of the given kind. */
async function waitForLockWaiter(kind: 'row' | 'advisory') {
  for (let i = 0; i < 200; i++) {
    const r = await db.execute(sql`
      SELECT count(*)::int AS c FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND (${kind} <> 'advisory' OR wait_event = 'advisory')
         AND (${kind} <> 'row' OR query ILIKE '%payroll_import_sessions%')`);
    if ((r.rows[0] as { c: number }).c > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend waited on a ${kind} lock`);
}

describe('payroll-import-review-v1', () => {
  it('lists the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('payroll-import-review-v1');
  });
});

describe('B1 delete racing a post', () => {
  it('post first: the delete waits, then is refused 400; the posted import and its entry stay', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    const g = gate();
    __payrollPostTestHooks.beforeEntry = g.hook;
    const posting = post(id);
    await g.entered;
    const deleting = del(id);
    await waitForLockWaiter('row');
    g.release();
    const [p, d] = await Promise.all([posting, deleting]);
    expect(p.status).toBe(200);
    expect(d.status).toBe(400);
    expect(d.json.error.message).toMatch(/Cannot delete a posted import/);
    expect((await sessionOf(id))?.status).toBe('posted');
    expect(await entryCount()).toBe(1);
    // The duplicate guard still sees it.
    const again = await validatedSession([['2026-08-10', '1.00', '0.00', '1.00']], { fileHash: (await sessionOf(id))!.fileHash });
    expect((await post(again, { forcePost: true })).json.error.code).toBe('PAYROLL_DUPLICATE_FILE');
  });

  it('delete first: the post waits, then finds no session (404); nothing posts', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    const g = gate();
    __payrollDeleteTestHooks.afterLock = g.hook;
    const deleting = del(id);
    await g.entered;
    const posting = post(id);
    await waitForLockWaiter('row');
    g.release();
    const [d, p] = await Promise.all([deleting, posting]);
    expect(d.status).toBe(200);
    expect(p.status).toBe(404);
    expect(await sessionOf(id)).toBeUndefined();
    expect(await entryCount()).toBe(0);
    const rows = await db.select().from(payrollImportRows).where(eq(payrollImportRows.sessionId, id));
    expect(rows).toHaveLength(0);
  });

  it('deleting a draft is one audited step; a posted import is still refused 400', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    expect((await post(id)).status).toBe(200);
    expect((await del(id)).status).toBe(400);
    const draft = await validatedSession([['2026-09-10', '10.00', '1.00', '9.00']]);
    expect((await del(draft)).status).toBe(200);
    const audit = await db.execute(sql`SELECT count(*)::int AS c FROM audit_log WHERE tenant_id = ${tenantId} AND entity_type = 'payroll_import_session' AND action = 'delete' AND entity_id = ${draft}`);
    expect((audit.rows[0] as { c: number }).c).toBe(1);
  });
});

describe('S1 two sessions of one payroll posted at once', () => {
  async function race(a: string, b: string) {
    const g = gate();
    __payrollPostTestHooks.beforeEntry = g.hook;
    const first = post(a, { forcePost: true });
    await g.entered;
    const second = post(b, { forcePost: true });
    await waitForLockWaiter('advisory');
    g.release();
    return Promise.all([first, second]);
  }

  it('same file hash: exactly one posts, the other is 409 PAYROLL_DUPLICATE_FILE', async () => {
    const a = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']], { fileHash: 'review-same-file' });
    const b = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']], { fileHash: 'review-same-file' });
    const [ra, rb] = await race(a, b);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(409);
    expect(rb.json.error.code).toBe('PAYROLL_DUPLICATE_FILE');
    expect(rb.json.error.details.priorSessionId).toBe(a);
    expect(await entryCount()).toBe(1);
    expect((await sessionOf(b))?.status).toBe('validated');
  });

  it('same provider run key, different files: exactly one posts, the other is 409 PAYROLL_DUPLICATE_RUN', async () => {
    const a = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']], { provider: 'gusto', runKey: 'review-run-1' });
    const b = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']], { provider: 'gusto', runKey: 'review-run-1' });
    const [ra, rb] = await race(a, b);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(409);
    expect(rb.json.error.code).toBe('PAYROLL_DUPLICATE_RUN');
    expect(rb.json.error.details.priorSessionId).toBe(a);
    expect(await entryCount()).toBe(1);
  });

  it('posts of unrelated files in the same company both succeed', async () => {
    const a = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    const b = await validatedSession([['2026-09-10', '500.00', '50.00', '450.00']]);
    const [ra, rb] = await race(a, b);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await entryCount()).toBe(2);
  });
});

describe('S5 Mode B negative amounts and dates', () => {
  const HEADERS = ['Date', 'Reference', 'Account', 'Description', 'Debit', 'Credit', 'Memo'];
  async function modeBSession(rows: Array<[string, string, string, string]>) {
    const [s] = await db.insert(payrollImportSessions).values({
      tenantId, companyId, importMode: 'prebuilt_je', originalFilename: 'gl.csv', filePath: '/tmp/gl.csv',
      fileHash: 'hash-' + crypto.randomUUID(), status: 'uploaded', rowCount: rows.length, detectedProvider: 'payroll_relief_gl',
      metadata: { headers: HEADERS, detectedProvider: 'payroll_relief_gl' },
    }).returning();
    await db.insert(payrollImportRows).values(rows.map(([date, desc, debit, credit], i) => ({
      sessionId: s!.id, rowNumber: i + 1,
      rawData: { Date: date, Reference: 'PR1', Account: '', Description: desc, Debit: debit, Credit: credit, Memo: '' },
    })));
    return s!.id;
  }

  it('a correction pair (Debit -50 on X, Credit -50 on Y) posts X credited 50 and Y debited 50', async () => {
    const x = await mkAccount('Review X', 'expense', '69400');
    const y = await mkAccount('Review Y', 'liability', '29700');
    const id = await modeBSession([
      ['07/10/2026', 'Wages and Salary', '$1,000.00', '$0.00'],
      ['07/10/2026', 'Net Payroll', '$0.00', '$1,000.00'],
      ['07/10/2026', 'Correction X', '-50.00', ''],
      ['07/10/2026', 'Correction Y', '', '-50.00'],
    ]);
    await importService.saveDescriptionMap(tenantId, id, 'payroll_relief_gl', [
      { sourceDescription: 'Wages and Salary', accountId: acct.wages },
      { sourceDescription: 'Net Payroll', accountId: acct.cash },
      { sourceDescription: 'Correction X', accountId: x },
      { sourceDescription: 'Correction Y', accountId: y },
    ]);
    const summary = await validation.validateModeBSession(tenantId, id);
    expect(summary.errorRows).toBe(0);
    const map = await importService.getDescriptionMap(tenantId, id);
    expect(map.find(m => m.sourceDescription === 'Correction X')).toMatchObject({ debitOrCredit: 'credit', sampleAmount: '50.00' });
    expect(map.find(m => m.sourceDescription === 'Correction Y')).toMatchObject({ debitOrCredit: 'debit', sampleAmount: '50.00' });

    const res = await modeB.postModeBJE(tenantId, id, userId, true, companyId) as { count: number };
    expect(res.count).toBe(1);
    const lines = await db.execute(sql`
      SELECT account_id, debit::numeric(19,2)::text AS debit, credit::numeric(19,2)::text AS credit
        FROM journal_lines WHERE tenant_id = ${tenantId} AND account_id IN (${x}, ${y})`);
    const byAcct = new Map(lines.rows.map(r => [(r as any).account_id, r as { debit: string; credit: string }]));
    expect(byAcct.get(x)).toMatchObject({ debit: '0.00', credit: '50.00' });
    expect(byAcct.get(y)).toMatchObject({ debit: '50.00', credit: '0.00' });
  });

  it('category_derived keeps the sign: a negative expense is a credit, a negative liability a debit', () => {
    const c = MODE_B_COLUMN_CONFIGS['onpay_gl_summary']!;
    const amounts = (category: string, amount: string) => {
      const r = modeB.glRowAmounts({ 'Pay Date': '07/10/2026', Description: 'X', Category: category, Amount: amount }, c);
      return [r.debit.toFixed(2), r.credit.toFixed(2)];
    };
    expect(amounts('Expense', '100.00')).toEqual(['100.00', '0.00']);
    expect(amounts('Expense', '-25.00')).toEqual(['0.00', '25.00']);
    expect(amounts('Liability', '40.00')).toEqual(['0.00', '40.00']);
    expect(amounts('Liability', '-10.00')).toEqual(['10.00', '0.00']);
  });

  it('a row whose date does not parse refuses the file: validate DATE_INVALID, generate and post 422 PAYROLL_DATE_INVALID', async () => {
    const id = await modeBSession([
      ['07/10/2026', 'Wages and Salary', '$1,000.00', '$0.00'],
      ['07/10/2026', 'Net Payroll', '$0.00', '$900.00'],
      ['', 'Federal Withholding', '$0.00', '$100.00'],
    ]);
    await importService.saveDescriptionMap(tenantId, id, 'payroll_relief_gl', [
      { sourceDescription: 'Wages and Salary', accountId: acct.wages },
      { sourceDescription: 'Net Payroll', accountId: acct.cash },
      { sourceDescription: 'Federal Withholding', accountId: acct.fit },
    ]);
    const summary = await validation.validateModeBSession(tenantId, id);
    expect(summary.messages.find(m => m.code === 'DATE_INVALID')).toMatchObject({ field: 'date', rowNumber: 3, severity: 'error' });
    expect(summary.errorRows).toBeGreaterThan(0);

    const gen = await request('POST', `/api/v1/payroll-import/sessions/${id}/generate-je`, token, {});
    expect(gen.status).toBe(422);
    expect(gen.json.error.code).toBe('PAYROLL_DATE_INVALID');
    expect(gen.json.error.details).toEqual({ rows: [{ rowNumber: 3, code: 'DATE_INVALID' }] });
    const p = await post(id, { forcePost: true });
    expect(p.status).toBe(422);
    expect(p.json.error.code).toBe('PAYROLL_DATE_INVALID');
    expect(await entryCount()).toBe(0);
  });
});

describe('S3 Mode A validate lists every department', () => {
  it('a 60-row file whose third department first appears at row 40', async () => {
    const rows: Array<[string, string, string, string, string]> = [];
    for (let i = 1; i <= 60; i++) {
      const dept = i === 40 ? ' Bar ' : i > 40 && i % 3 === 0 ? 'Bar' : i % 2 === 0 ? 'Kitchen' : 'Front';
      rows.push(['2026-07-10', '100.00', '10.00', '90.00', i === 5 ? '' : dept]);
    }
    const id = await validatedSession(rows);
    const r = await request('POST', `/api/v1/payroll-import/sessions/${id}/validate`, token, {});
    expect(r.status).toBe(200);
    expect(r.json.departments).toEqual(['Bar', 'Front', 'Kitchen']);
    expect(r.json.departmentsTruncated).toBe(false);
  });

  it('caps the list at 200 and says so', () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ mappedData: { department: `D${String(i).padStart(3, '0')}` }, validationStatus: 'valid' }));
    rows.push({ mappedData: { department: 'Skipped dept' }, validationStatus: 'skipped' });
    const out = validation.departmentsOfRows(rows);
    expect(out.departments).toHaveLength(200);
    expect(out.departments[0]).toBe('D000');
    expect(out.departments).not.toContain('Skipped dept');
    expect(out.departmentsTruncated).toBe(true);
  });
});

describe('M5 generateJE reads the session on the caller transaction', () => {
  it('sees the session as the transaction does', async () => {
    const id = await validatedSession([['2026-07-10', '1000.00', '100.00', '900.00']]);
    let memo = '';
    const undo = new Error('undo');
    await expect(db.transaction(async (tx) => {
      // Not committed: only a read on this transaction sees the period.
      await tx.update(payrollImportSessions).set({ payPeriodStart: '2026-07-01', payPeriodEnd: '2026-07-15' })
        .where(eq(payrollImportSessions.id, id));
      const { previews } = await je.generateJE(tenantId, id, { aggregationMode: 'summary' }, tx);
      memo = previews[0]!.memo;
      throw undo;
    })).rejects.toBe(undo);
    expect(memo).toContain('2026-07-01–2026-07-15');
    expect((await sessionOf(id))?.payPeriodStart).toBeNull();
  });
});
