// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-250 exact money, U-242 one entry per pay date, U-243 other-tax line,
// U-246 department tags — through the real mapping, validation, generate and
// post paths on the database.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { PayrollLineType } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, companies, accounts, tags, payrollImportSessions, payrollImportRows } from '../db/schema/index.js';
import * as importService from './payroll-import.service.js';
import * as validation from './payroll-validation.service.js';
import * as je from './payroll-je.service.js';
import * as modeB from './payroll-modeb.service.js';
import { parseFile } from './payroll-parse.service.js';
import { SYSTEM_TEMPLATES } from './payroll-templates.seed.js';

const USER_ID = '00000000-0000-4000-8000-0000000000bb';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'payroll');
let tenantId = '';
let companyId = '';
const acct: Record<string, string> = {};

async function cleanup() {
  if (!tenantId) return;
  for (const tbl of ['journal_lines', 'transaction_tags', 'transactions', 'payroll_account_mapping', 'payroll_description_account_map', 'tags', 'accounts', 'audit_log', 'gl_version_stamps']) {
    await db.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM payroll_import_rows WHERE session_id IN (SELECT id FROM payroll_import_sessions WHERE tenant_id = ${tenantId})`);
  for (const tbl of ['payroll_import_sessions', 'companies']) {
    await db.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  tenantId = '';
}

beforeEach(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({
    name: 'Payroll Exact Test',
    slug: 'payexact-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Payroll Exact Co' }).returning();
  companyId = c!.id;
  const mk = async (name: string, accountType: string, accountNumber: string) =>
    (await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber }).returning())[0]!.id;
  acct.wages = await mk('Wages', 'expense', '60000');
  acct.erTax = await mk('Payroll Tax Expense', 'expense', '60100');
  acct.fit = await mk('FIT Payable', 'liability', '21000');
  acct.ss = await mk('SS Payable', 'liability', '21500');
  acct.med = await mk('Medicare Payable', 'liability', '21600');
  acct.futa = await mk('FUTA Payable', 'liability', '21700');
  acct.suta = await mk('SUTA Payable', 'liability', '21800');
  acct.other = await mk('Payroll Liabilities', 'liability', '21900');
  acct.ded = await mk('Other Deductions Payable', 'liability', '22100');
  acct.cash = await mk('Checking', 'asset', '10100');
  await importService.saveAccountMappings(tenantId, companyId, {
    [PayrollLineType.GROSS_WAGES_EXPENSE]: acct.wages,
    [PayrollLineType.EMPLOYER_TAX_EXPENSE]: acct.erTax,
    [PayrollLineType.FIT_PAYABLE]: acct.fit,
    [PayrollLineType.SS_PAYABLE]: acct.ss,
    [PayrollLineType.MEDICARE_PAYABLE]: acct.med,
    [PayrollLineType.FUTA_PAYABLE]: acct.futa,
    [PayrollLineType.SUTA_PAYABLE]: acct.suta,
    [PayrollLineType.OTHER_TAX_PAYABLE]: acct.other,
    [PayrollLineType.OTHER_DEDUCTION_PAYABLE]: acct.ded,
    [PayrollLineType.PAYROLL_CLEARING]: acct.cash,
  });
});
afterEach(cleanup);

type Row = Record<string, string>;

async function mkSession(rows: Row[], opts: { checkDate?: string; start?: string; end?: string; provider?: string; mode?: string } = {}) {
  const headers = Object.keys(rows[0]!);
  const [s] = await db.insert(payrollImportSessions).values({
    tenantId, companyId, importMode: opts.mode ?? 'employee_level', originalFilename: 'payroll.csv',
    filePath: '/tmp/payroll.csv', fileHash: 'hash-' + Math.random().toString(36).slice(2), status: 'uploaded',
    rowCount: rows.length, checkDate: opts.checkDate ?? null, payPeriodStart: opts.start ?? null, payPeriodEnd: opts.end ?? null,
    detectedProvider: opts.provider ?? null,
    metadata: { headers, detectedProvider: opts.provider ?? null },
  }).returning();
  await db.insert(payrollImportRows).values(rows.map((r, i) => ({ sessionId: s!.id, rowNumber: i + 1, rawData: r })));
  return s!.id;
}

const GENERIC_MAP = {
  employee_name: { source: 'Employee' },
  check_date: { source: 'Check Date' },
  department: { source: 'Department' },
  gross_pay: { source: 'Gross' },
  federal_income_tax: { source: 'FIT' },
  social_security_ee: { source: 'SS EE' },
  medicare_ee: { source: 'Med EE' },
  net_pay: { source: 'Net' },
  social_security_er: { source: 'SS ER' },
  medicare_er: { source: 'Med ER' },
  futa_er: { source: 'FUTA' },
  suta_er: { source: 'SUTA' },
  other_er_tax: { source: 'Other ER' },
};

async function mapAndValidate(sessionId: string, mappings: Record<string, { source: string }> = GENERIC_MAP) {
  await importService.applyMapping(tenantId, sessionId, { header_row: 0, data_start_row: 1, mappings } as any);
  return validation.validateSession(tenantId, sessionId);
}

function row(employee: string, date: string, dept: string, gross: string, fit: string, net: string, extra: Partial<Row> = {}): Row {
  return {
    Employee: employee, 'Check Date': date, Department: dept, Gross: gross, FIT: fit,
    'SS EE': '0.00', 'Med EE': '0.00', Net: net, 'SS ER': '0.00', 'Med ER': '0.00', FUTA: '0.00', SUTA: '0.00', 'Other ER': '0.00',
    ...extra,
  };
}

async function errorOf(p: Promise<unknown>) {
  try { await p; } catch (e) { return e as { statusCode: number; code?: string; details?: Record<string, unknown> }; }
  throw new Error('expected a refusal');
}

describe('U-250 exact money', () => {
  it('a 300-row file whose float sum drifts posts the exact total', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(`W${i}`, '2026-07-10', '', '0.07', '0.00', '0.07'));
    let float = 0;
    for (let i = 0; i < 300; i++) float += 0.07;
    expect(float).not.toBe(21); // binary floating point drifts
    const id = await mkSession(rows);
    const summary = await mapAndValidate(id);
    expect(summary.errorRows).toBe(0);
    const { previews } = await je.generateJE(tenantId, id, { aggregationMode: 'summary' });
    expect(previews).toHaveLength(1);
    expect(previews[0]!.totalDebits).toBe('21.00');
    expect(previews[0]!.difference).toBe('0.00');
    expect(previews[0]!.lines.find(l => l.lineType === 'payroll_clearing')!.credit).toBe('21.00');
    const res = await je.postJE(tenantId, id, USER_ID, false, 'summary', companyId) as { count: number };
    expect(res.count).toBe(1);
  });

  it('a file off by 3 cents is refused with its date and difference, never plugged', async () => {
    const id = await mkSession([row('A', '2026-07-10', '', '1000.00', '100.00', '899.97')]);
    const summary = await mapAndValidate(id);
    expect(summary.messages.find(m => m.code === 'BALANCE_MISMATCH')?.severity).toBe('warning');
    const { previews } = await je.generateJE(tenantId, id, { aggregationMode: 'summary' });
    expect(previews[0]!.isBalanced).toBe(false);
    expect(previews[0]!.difference).toBe('0.03');
    expect(previews[0]!.lines.find(l => l.lineType === 'payroll_clearing')!.credit).toBe('899.97');
    const err = await errorOf(je.postJE(tenantId, id, USER_ID, false, 'summary', companyId));
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('PAYROLL_UNBALANCED');
    expect(err.details).toEqual({ date: '2026-07-10', totalDebits: '1000.00', totalCredits: '999.97', difference: '0.03' });
    const posted = await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE tenant_id = ${tenantId}`);
    expect((posted.rows[0] as { c: number }).c).toBe(0);
  });

  it('an unmapped line type is refused 422 PAYROLL_UNMAPPED before anything posts', async () => {
    await db.execute(sql`DELETE FROM payroll_account_mapping WHERE tenant_id = ${tenantId} AND line_type = 'fit_payable'`);
    const id = await mkSession([row('A', '2026-07-10', '', '1000.00', '100.00', '900.00')]);
    await mapAndValidate(id);
    const err = await errorOf(je.postJE(tenantId, id, USER_ID, false, 'summary', companyId));
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('PAYROLL_UNMAPPED');
    expect(err.details).toEqual({ lineTypes: ['fit_payable'] });
  });

  it('bad and over-precise cells are row errors with row, field and code, never the cell text', async () => {
    const id = await mkSession([
      row('A', '2026-07-10', '', 'abc', '100.00', '900.00'),
      row('B', '2026-07-10', '', '1000.00', '100.005', '900.00'),
    ]);
    const summary = await mapAndValidate(id);
    expect(summary.errorRows).toBe(2);
    const invalid = summary.messages.find(m => m.code === 'AMOUNT_INVALID')!;
    expect(invalid).toMatchObject({ field: 'gross_pay', rowNumber: 1, severity: 'error' });
    expect(invalid.message).not.toContain('abc');
    expect(summary.messages.find(m => m.code === 'AMOUNT_PRECISION')).toMatchObject({ field: 'federal_income_tax', rowNumber: 2 });
    const stored = await db.execute(sql`SELECT mapped_data FROM payroll_import_rows WHERE session_id = ${id} ORDER BY row_number`);
    const first = (stored.rows[0] as { mapped_data: Record<string, unknown> }).mapped_data;
    expect(first['gross_pay']).toBeNull();
    expect(first['net_pay']).toBe('900.00');
  });

  it('Mode B: a bad amount is a validation error and generate-je refuses it', async () => {
    const id = await mkSession([
      { Date: '07/10/2026', Reference: 'PR1', Account: '', Description: 'Wages', Debit: '1O0.00', Credit: '', Memo: '' },
      { Date: '07/10/2026', Reference: 'PR1', Account: '', Description: 'Net Payroll', Debit: '', Credit: '100.00', Memo: '' },
    ], { mode: 'prebuilt_je', provider: 'payroll_relief_gl' });
    const summary = await validation.validateModeBSession(tenantId, id);
    const msg = summary.messages.find(m => m.code === 'AMOUNT_INVALID')!;
    expect(msg.rowNumber).toBe(1);
    expect(msg.message).not.toContain('1O0');
    const err = await errorOf(modeB.generateModeBJE(tenantId, id));
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('PAYROLL_AMOUNT_INVALID');
    expect(err.details).toEqual({ rows: [{ rowNumber: 1, code: 'AMOUNT_INVALID' }] });
  });
});

describe('U-242 one entry per pay date', () => {
  const twoDates = () => [
    row('A', '2026-07-10', '', '1000.00', '100.00', '900.00'),
    row('B', '2026-07-24', '', '500.00', '50.00', '450.00'),
    row('C', '2026-07-10', '', '200.00', '20.00', '180.00'),
  ];

  it('gives one balanced preview per date, ascending, totals from its own rows', async () => {
    const id = await mkSession(twoDates(), { start: '2026-07-01', end: '2026-07-24', provider: 'gusto' });
    await mapAndValidate(id);
    const { previews } = await je.generateJE(tenantId, id, { aggregationMode: 'summary' });
    expect(previews.map(p => [p.date, p.totalDebits, p.isBalanced])).toEqual([
      ['2026-07-10', '1200.00', true],
      ['2026-07-24', '500.00', true],
    ]);
    expect(previews[0]!.memo).toBe('Payroll 2026-07-01–2026-07-24 — Gusto — pay date 2026-07-10');
    expect(previews.every(p => !/\bA\b|\bB\b|\bC\b/.test(p.memo))).toBe(true);
    const res = await je.postJE(tenantId, id, USER_ID, false, 'summary', companyId) as { journalEntryIds: string[] };
    expect(res.journalEntryIds).toHaveLength(2);
    const dates = await db.execute(sql`SELECT txn_date::text AS d FROM transactions WHERE tenant_id = ${tenantId} AND source_id = ${id} ORDER BY txn_date`);
    expect(dates.rows.map(r => (r as { d: string }).d)).toEqual(['2026-07-10', '2026-07-24']);
  });

  it('overlap is found on the second date only', async () => {
    const prior = await mkSession([row('P', '2026-07-24', '', '500.00', '50.00', '450.00')]);
    await mapAndValidate(prior);
    await je.postJE(tenantId, prior, USER_ID, false, 'summary', companyId);

    const id = await mkSession(twoDates());
    await mapAndValidate(id);
    const res = await je.postJE(tenantId, id, USER_ID, false, 'summary', companyId) as { requiresConfirmation: boolean; overlaps: Array<{ sessionId: string; matchingDates: string[] }> };
    expect(res.requiresConfirmation).toBe(true);
    expect(res.overlaps).toHaveLength(1);
    expect(res.overlaps[0]).toMatchObject({ sessionId: prior, matchingDates: ['2026-07-24'] });
    const forced = await je.postJE(tenantId, id, USER_ID, true, 'summary', companyId) as { count: number };
    expect(forced.count).toBe(2);
  });

  it('a file without a date column validates and posts on the upload date', async () => {
    const rows = [row('A', '', '', '1000.00', '100.00', '900.00')].map(({ 'Check Date': _d, ...r }) => r);
    const id = await mkSession(rows, { checkDate: '2026-07-17' });
    const { check_date: _c, ...mappings } = GENERIC_MAP;
    const summary = await mapAndValidate(id, mappings);
    expect(summary.errorRows).toBe(0);
    const res = await je.postJE(tenantId, id, USER_ID, false, 'summary', companyId) as { journalEntryIds: string[] };
    const d = await db.execute(sql`SELECT txn_date::text AS d FROM transactions WHERE id = ${res.journalEntryIds[0]!}`);
    expect((d.rows[0] as { d: string }).d).toBe('2026-07-17');
  });

  it('warns when the upload date is none of the dates in the file', async () => {
    const id = await mkSession(twoDates(), { checkDate: '2026-07-31' });
    const summary = await mapAndValidate(id);
    expect(summary.messages.find(m => m.code === 'CHECK_DATE_NOT_IN_FILE')?.severity).toBe('warning');
  });
});

describe('U-243 Square and other taxes balance', () => {
  it('a Square-shaped file balances with the seed template', async () => {
    const buffer = fs.readFileSync(path.join(FIXTURES, 'square-payroll.csv'));
    const { rows } = await parseFile(buffer, 'square-payroll.csv');
    const headers = rows[0]!;
    const records = rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
    const id = await mkSession(records, { checkDate: '2026-07-17', start: '2026-07-01', end: '2026-07-15', provider: 'square_payroll' });
    const square = SYSTEM_TEMPLATES.find(t => t.providerKey === 'square_payroll')!;
    await importService.applyMapping(tenantId, id, square.columnMap as any);
    const summary = await validation.validateSession(tenantId, id);
    expect(summary.errorRows).toBe(0);
    const { previews } = await je.generateJE(tenantId, id, { aggregationMode: 'summary' });
    expect(previews).toHaveLength(1);
    const p = previews[0]!;
    expect(p.date).toBe('2026-07-17');
    expect([p.totalDebits, p.totalCredits, p.difference, p.isBalanced]).toEqual(['4804.69', '4804.69', '0.00', true]);
    expect(p.lines.find(l => l.lineType === 'other_tax_payable')!.credit).toBe('757.68');
    expect(p.lines.find(l => l.lineType === 'payroll_clearing')!.credit).toBe('3397.82');
    const res = await je.postJE(tenantId, id, USER_ID, false, 'summary', companyId) as { count: number };
    expect(res.count).toBe(1);
  });

  it('other employer tax is debited to tax expense and credited to other taxes payable', async () => {
    const id = await mkSession([row('A', '2026-07-10', '', '1000.00', '100.00', '900.00', { 'Other ER': '12.34' })]);
    await mapAndValidate(id);
    const { previews } = await je.generateJE(tenantId, id, { aggregationMode: 'summary' });
    const p = previews[0]!;
    expect(p.lines.find(l => l.lineType === 'employer_tax_expense')!.debit).toBe('12.34');
    expect(p.lines.find(l => l.lineType === 'other_tax_payable')!.credit).toBe('12.34');
    expect(p.isBalanced).toBe(true);
  });
});

describe('U-246 departments to tags', () => {
  const deptRows = () => [
    row('A', '2026-07-10', 'Sales', '1000.00', '100.00', '900.00', { 'SS ER': '62.00', 'SS EE': '0.00' }),
    row('B', '2026-07-10', 'Ops', '500.00', '50.00', '450.00', { 'SS ER': '31.00' }),
    row('C', '2026-07-10', '', '200.00', '20.00', '180.00', { 'SS ER': '12.40' }),
    row('D', '2026-07-24', 'Sales', '300.00', '30.00', '270.00'),
  ];

  it('splits expense lines by department, keeps one net-pay line per date, totals unchanged', async () => {
    const sales = (await db.insert(tags).values({ tenantId, name: 'Sales' }).returning())[0]!.id;
    const ops = (await db.insert(tags).values({ tenantId, name: 'Ops' }).returning())[0]!.id;
    const id = await mkSession(deptRows());
    await mapAndValidate(id);
    const plain = (await je.generateJE(tenantId, id, { aggregationMode: 'summary' })).previews;
    const split = (await je.generateJE(tenantId, id, { aggregationMode: 'summary', departmentTagMap: { Sales: sales, Ops: ops } })).previews;

    expect(plain[0]!.lines.some(l => 'department' in l)).toBe(false);
    expect(split.map(p => [p.totalDebits, p.totalCredits])).toEqual(plain.map(p => [p.totalDebits, p.totalCredits]));
    const wages = split[0]!.lines.filter(l => l.lineType === 'gross_wages_expense');
    expect(wages.map(l => [l.department, l.tagId, l.debit])).toEqual([
      ['Ops', ops, '500.00'], ['Sales', sales, '1000.00'], [null, null, '200.00'],
    ]);
    expect(split[0]!.lines.filter(l => l.lineType === 'employer_tax_expense').map(l => l.debit)).toEqual(['31.00', '62.00', '12.40']);
    for (const p of split) {
      expect(p.lines.filter(l => l.lineType === 'payroll_clearing')).toHaveLength(1);
      expect(p.lines.filter(l => l.lineType === 'payroll_clearing')[0]!.tagId).toBeUndefined();
    }

    await je.postJE(tenantId, id, USER_ID, false, 'summary', companyId, undefined, { Sales: sales, Ops: ops });
    const lines = await db.execute(sql`SELECT account_id, tag_id, debit::text AS debit FROM journal_lines WHERE tenant_id = ${tenantId} AND account_id = ${acct.wages} ORDER BY journal_lines.debit`);
    expect(lines.rows.map(r => [(r as any).tag_id, (r as any).debit])).toEqual([
      [null, '200.0000'], [sales, '300.0000'], [ops, '500.0000'], [sales, '1000.0000'],
    ]);
  });

  it('refuses a tag that is not the tenant\'s', async () => {
    const id = await mkSession(deptRows());
    await mapAndValidate(id);
    const err = await errorOf(je.generateJE(tenantId, id, { aggregationMode: 'summary', departmentTagMap: { Sales: '00000000-0000-4000-8000-00000000dead' } }));
    expect(err.statusCode).toBe(400);
  });
});
