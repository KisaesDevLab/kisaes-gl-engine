// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-252: rows the column mapping drops on purpose (a Total row matched by
// skip_rules, skip_footer_rows) are marked 'skipped' at apply-mapping and are
// neither validated nor summed into the entry. A row that is data but has a
// bad cell is still an error.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, sql } from 'drizzle-orm';
import { PayrollLineType } from '@kis-books/shared';
import { db } from '../db/index.js';
import { companies, accounts, payrollImportSessions, payrollImportRows } from '../db/schema/index.js';
import { payrollImportRouter } from './payroll-import.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as importService from '../services/payroll-import.service.js';
import * as validation from '../services/payroll-validation.service.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const uploads: string[] = [];

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
let userId = '';
let token = '';

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payroll-import', payrollImportRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `payroll-skip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: 'Payroll Skip Co',
  });
  tenantId = reg.user.tenantId;
  userId = reg.user.id;
  tenantIds.push(tenantId);
  token = reg.tokens.accessToken;
  companyId = (await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1))[0]!.id;
  const mk = async (name: string, accountType: string, accountNumber: string) =>
    (await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber }).returning())[0]!.id;
  await importService.saveAccountMappings(tenantId, companyId, {
    [PayrollLineType.GROSS_WAGES_EXPENSE]: await mk('U252 Wages', 'expense', '69100'),
    [PayrollLineType.EMPLOYER_TAX_EXPENSE]: await mk('U252 Employer Taxes', 'expense', '69200'),
    [PayrollLineType.FIT_PAYABLE]: await mk('U252 FIT Payable', 'liability', '29200'),
    [PayrollLineType.SIT_PAYABLE]: await mk('U252 SIT Payable', 'liability', '29300'),
    [PayrollLineType.SS_PAYABLE]: await mk('U252 SS Payable', 'liability', '29400'),
    [PayrollLineType.MEDICARE_PAYABLE]: await mk('U252 Medicare Payable', 'liability', '29500'),
    [PayrollLineType.PAYROLL_CLEARING]: await mk('U252 Checking', 'asset', '19200'),
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (uploads.length) { try { fs.unlinkSync(uploads.pop()!); } catch { /* already gone */ } }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

// Shaped like a QuickBooks Payroll summary export (synthetic): three report
// metadata rows, the header, the employee rows and a Total row.
const QB_HEADER = 'Employee,Pay Period,Total Hours,Gross Pay,Federal Taxes,State Taxes,Social Security Employee,Medicare Employee,Social Security Employer,Medicare Employer,Net Pay';
const QB_EMPLOYEES = [
  'Test Worker 11,03/01/2025 - 03/14/2025,80.00,"$2,083.35",208.34,83.33,129.17,30.21,129.17,30.21,"$1,632.30"',
  'Test Worker 12,03/01/2025 - 03/14/2025,80.00,"$1,450.65",116.05,43.52,89.94,21.03,89.94,21.03,"$1,180.11"',
  'Test Worker 13,03/01/2025 - 03/14/2025,80.00,"$987.15",39.49,19.74,61.20,14.31,61.20,14.31,"$852.41"',
];
const QB_TOTAL = 'Total,,240.00,"$4,521.15",363.88,146.59,280.31,65.55,280.31,65.55,"$3,664.82"';
const qbFile = (employees: string[], footer: string[]) =>
  ['Payroll Summary', 'Synthetic Test Co', 'Pay date 03/14/2025', QB_HEADER, ...employees, ...footer].join('\n') + '\n';

// The desktop's QuickBooks mapping: no date column (the pay date is given at
// upload), eight money fields.
const QB_MAPPINGS = {
  employee_name: { source: 'Employee' },
  gross_pay: { source: 'Gross Pay' },
  federal_income_tax: { source: 'Federal Taxes' },
  state_income_tax: { source: 'State Taxes' },
  social_security_ee: { source: 'Social Security Employee' },
  medicare_ee: { source: 'Medicare Employee' },
  social_security_er: { source: 'Social Security Employer' },
  medicare_er: { source: 'Medicare Employer' },
  net_pay: { source: 'Net Pay' },
};
const TOTAL_RULES = [
  { type: 'blank_field', field: 'employee_name' },
  { type: 'value_match', field: 'employee_name', values: ['Total', 'Totals'] },
];

async function upload(csv: string) {
  const out = await importService.uploadPayrollFile(
    tenantId, companyId,
    { buffer: Buffer.from(csv, 'utf8'), originalname: `qb-${crypto.randomUUID()}.csv` },
    undefined,
    { importMode: 'employee_level', checkDate: '2025-03-14', payPeriodStart: '2025-03-01', payPeriodEnd: '2025-03-14' },
    userId,
  );
  if (out.session.filePath) uploads.push(out.session.filePath);
  return out.session;
}

const rowsOf = async (id: string) =>
  db.select().from(payrollImportRows).where(eq(payrollImportRows.sessionId, id)).orderBy(payrollImportRows.rowNumber);
const generate = (id: string) =>
  request('POST', `/api/v1/payroll-import/sessions/${id}/generate-je`, token, { aggregationMode: 'summary' });
const amountsOf = (preview: any) =>
  Object.fromEntries(preview.lines.map((l: any) => [l.lineType, l.debit !== '0.00' ? l.debit : l.credit]));

// Expected from the employee rows only (fixtures/payroll/expected/quickbooks_payroll.json).
const EXPECTED = {
  gross_wages_expense: '4521.15',
  employer_tax_expense: '345.86',
  fit_payable: '363.88',
  sit_payable: '146.59',
  ss_payable: '560.62',
  medicare_payable: '131.10',
  payroll_clearing: '3664.82',
};

describe('U-252 rows skipped at mapping', () => {
  it('a QuickBooks Payroll summary with metadata rows and a Total row validates, previews the employee sums and posts', async () => {
    const s = await upload(qbFile(QB_EMPLOYEES, [QB_TOTAL]));
    const mapped = await importService.applyMapping(tenantId, s.id,
      { header_row: 0, data_start_row: 1, skip_footer_rows: 0, mappings: QB_MAPPINGS, skip_rules: TOTAL_RULES } as any);
    expect(mapped).toEqual({ mappedCount: 3, skippedCount: 1 });

    const rows = await rowsOf(s.id);
    expect(rows).toHaveLength(4);
    expect(rows[3]!.validationStatus).toBe('skipped');
    expect(rows[3]!.mappedData).toBeNull();

    const v = await validation.validateSession(tenantId, s.id);
    // 2025 pay dates are more than 90 days old: STALE_DATE warnings, no errors.
    expect(v).toMatchObject({ totalRows: 3, errorRows: 0 });
    expect(v.validRows + v.warningRows).toBe(3);
    expect(v.messages.filter(m => m.severity === 'error')).toEqual([]);
    expect((await rowsOf(s.id))[3]!.validationStatus).toBe('skipped');

    const gen = await generate(s.id);
    expect(gen.status).toBe(200);
    expect(gen.json.previews).toHaveLength(1);
    const p = gen.json.previews[0];
    expect(p.date).toBe('2025-03-14');
    expect(amountsOf(p)).toEqual(EXPECTED);
    expect(p).toMatchObject({ totalDebits: '4867.01', totalCredits: '4867.01', difference: '0.00', isBalanced: true });

    const posted = await request('POST', `/api/v1/payroll-import/sessions/${s.id}/post`, token,
      { aggregationMode: 'summary', previewToken: gen.json.previewToken });
    expect(posted.status).toBe(200);
    expect(posted.json.count).toBe(1);
    const total = await db.execute(sql`
      SELECT COALESCE(SUM(jl.debit), 0)::text AS d, COALESCE(SUM(jl.credit), 0)::text AS c
      FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
      WHERE t.tenant_id = ${tenantId} AND t.source = 'payroll_import' AND t.status = 'posted'`);
    const sums = total.rows[0] as { d: string; c: string };
    expect(Number(sums.d).toFixed(2)).toBe('4867.01');
    expect(Number(sums.c).toFixed(2)).toBe('4867.01');
  });

  it('a footer dropped by skip_footer_rows is not validated or summed', async () => {
    // A footer whose name is not "Total", so only skip_footer_rows drops it.
    const footer = 'Report run 03/15/2025,,,,,,,,,,';
    const s = await upload(qbFile(QB_EMPLOYEES, [footer]));
    const mapped = await importService.applyMapping(tenantId, s.id,
      { header_row: 0, data_start_row: 1, skip_footer_rows: 1, mappings: QB_MAPPINGS } as any);
    expect(mapped.mappedCount).toBe(3);
    expect((await rowsOf(s.id))[3]!.validationStatus).toBe('skipped');

    const v = await validation.validateSession(tenantId, s.id);
    expect(v).toMatchObject({ totalRows: 3, errorRows: 0 });
    const gen = await generate(s.id);
    expect(amountsOf(gen.json.previews[0])).toEqual(EXPECTED);
    await importService.deleteSession(tenantId, s.id, userId);
  });

  it('a re-map that adds the Total skip rule clears the row an earlier mapping kept', async () => {
    const s = await upload(qbFile(QB_EMPLOYEES, [QB_TOTAL]));
    await importService.applyMapping(tenantId, s.id, { header_row: 0, data_start_row: 1, mappings: QB_MAPPINGS } as any);
    const before = await validation.validateSession(tenantId, s.id);
    expect(before.totalRows).toBe(4);
    // Without the rule the Total row is data and doubles the entry.
    expect(amountsOf((await generate(s.id)).json.previews[0]).gross_wages_expense).toBe('9042.30');

    await importService.applyMapping(tenantId, s.id,
      { header_row: 0, data_start_row: 1, mappings: QB_MAPPINGS, skip_rules: TOTAL_RULES } as any);
    const total = (await rowsOf(s.id))[3]!;
    expect(total).toMatchObject({ validationStatus: 'skipped', mappedData: null, validationMessages: null });
    expect((await validation.validateSession(tenantId, s.id)).totalRows).toBe(3);
    expect(amountsOf((await generate(s.id)).json.previews[0])).toEqual(EXPECTED);
    await importService.deleteSession(tenantId, s.id, userId);
  });

  it('a draft mapped before the marker (dropped row with no mapped data) is treated as skipped', async () => {
    const s = await upload(qbFile(QB_EMPLOYEES, [QB_TOTAL]));
    await importService.applyMapping(tenantId, s.id,
      { header_row: 0, data_start_row: 1, mappings: QB_MAPPINGS, skip_rules: TOTAL_RULES } as any);
    const totalRow = (await rowsOf(s.id))[3]!;
    // What an older engine left behind: no marker, no mapped data.
    await db.update(payrollImportRows).set({ validationStatus: 'pending' }).where(eq(payrollImportRows.id, totalRow.id));
    const v = await validation.validateSession(tenantId, s.id);
    expect(v).toMatchObject({ totalRows: 3, errorRows: 0 });
    expect((await rowsOf(s.id))[3]!.validationStatus).toBe('skipped');
    await importService.deleteSession(tenantId, s.id, userId);
  });

  it('an employee row with a bad amount is still an error', async () => {
    const bad = [
      ...QB_EMPLOYEES,
      'Test Worker 14,03/01/2025 - 03/14/2025,80.00,"$500.00",10.00,5.00,31.00,7.25,31.00,7.25,12.345',
      'Test Worker 15,03/01/2025 - 03/14/2025,80.00,abc,10.00,5.00,31.00,7.25,31.00,7.25,"$400.00"',
    ];
    const s = await upload(qbFile(bad, [QB_TOTAL]));
    await importService.applyMapping(tenantId, s.id,
      { header_row: 0, data_start_row: 1, mappings: QB_MAPPINGS, skip_rules: TOTAL_RULES } as any);
    const rows = await rowsOf(s.id);
    expect(rows.map(r => r.validationStatus)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'skipped']);

    const v = await validation.validateSession(tenantId, s.id);
    expect(v).toMatchObject({ totalRows: 5, errorRows: 2 });
    const rowErrors = v.messages.filter(m => m.severity === 'error').map(m => m.rowNumber);
    expect(rowErrors).toContain(4);
    expect(rowErrors).toContain(5);
    expect(rowErrors).not.toContain(6);
    expect((await db.select().from(payrollImportSessions).where(eq(payrollImportSessions.id, s.id)))[0]!.status).toBe('failed');
    await importService.deleteSession(tenantId, s.id, userId);
  });
});
