// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 11: tax-dataset pivot (code lines from the TAX column via
// resolved assignments), DONOTMAP exclusion, vendor-code gate (11.8a),
// unassigned hard block, and the working-TB workbook builder.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql, and } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, activityUnits, companies, companyTaxProfiles,
  journalLines, tagActivityMap, tags, tenants, transactions,
} from '../../db/schema/index.js';
import { importSeed } from './tax-code-seed.service.js';
import { createUnit, mapTag } from './activity-units.service.js';
import { buildTaxDataset, buildVendorFile, buildWorkingTbXlsx, validateForExport } from './exports.service.js';
import { buildTbWorkpaperReport } from './tb-reports.service.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');

let tenantId: string;
let companyId: string;
const A: Record<string, string> = {};

beforeAll(async () => {
  // CI runs against a fresh DB with no tax-code seed — import it
  // idempotently (byte-identical re-import is a no-op locally).
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  const [t] = await db.insert(tenants).values({ name: 'tb-exp-test', slug: `tb-exp-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Export Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1065' });

  const mk = async (num: string, name: string, type: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type }).returning();
    A[name] = a!.id;
  };
  await mk('1000', 'Cash', 'asset');
  await mk('4000', 'Sales', 'revenue');
  await mk('4100', 'Interest Income', 'revenue');
  await mk('5000', 'Rent Expense', 'expense');

  const [txn] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-04-01', status: 'posted', basis: 'both',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, transactionId: txn!.id, accountId: A['Cash']!, debit: '1500', credit: '0', lineOrder: 0 },
    { tenantId, transactionId: txn!.id, accountId: A['Sales']!, debit: '0', credit: '1000', lineOrder: 1 },
    { tenantId, transactionId: txn!.id, accountId: A['Interest Income']!, debit: '0', credit: '300', lineOrder: 2 },
    { tenantId, transactionId: txn!.id, accountId: A['Rent Expense']!, debit: '200', credit: '0', lineOrder: 3 },
    { tenantId, transactionId: txn!.id, accountId: A['Cash']!, debit: '0', credit: '400', lineOrder: 4 },
  ]);
});

afterAll(async () => {
  await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.tenantId, tenantId));
  await db.delete(companyTaxProfiles).where(eq(companyTaxProfiles.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(tagActivityMap).where(eq(tagActivityMap.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(activityUnits).where(eq(activityUnits.tenantId, tenantId));
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

async function seedCode(where: string): Promise<{ code: string; activity_type: string; ultratax_code: string | null }> {
  // Constrain to the latest version — the workpaper resolves codes
  // against it, and stale-version rows may no longer exist there.
  const res = await db.execute(sql.raw(`
    SELECT code, activity_type, ultratax_code FROM tax_codes tc
    WHERE ${where} AND tc.return_form IN ('1065', 'common')
      AND tc.version_id = (SELECT id FROM tax_code_seed_versions WHERE tax_year = 2025 ORDER BY version DESC LIMIT 1)
    LIMIT 1
  `));
  return (res.rows as Array<{ code: string; activity_type: string; ultratax_code: string | null }>)[0]!;
}

async function assign(accountId: string, code: string, activityType: string) {
  await db.insert(accountTaxAssignments).values({
    tenantId, companyId, accountId, activityUnitId: null,
    seedCode: code, seedActivityType: activityType, source: 'manual',
  });
}

describe('vendor export dataset (Phase 11)', () => {
  it('hard-blocks while accounts with balances are unassigned', async () => {
    const { validation } = await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'ultratax' });
    expect(validation.hardBlocked).toBe(true);
    expect(validation.unassigned.length).toBeGreaterThan(0);
  });

  it('pivots the tax column into code lines, merging same-code accounts and dropping DONOTMAP', async () => {
    const withUt = await seedCode('tc.ultratax_code IS NOT NULL');
    // Sales + Interest Income share one code (merge case); Cash gets a
    // code too; Rent → DONOTMAP (excluded from vendor files).
    await assign(A['Sales']!, withUt.code, withUt.activity_type);
    await assign(A['Interest Income']!, withUt.code, withUt.activity_type);
    await assign(A['Cash']!, withUt.code, withUt.activity_type);
    await assign(A['Rent Expense']!, 'DONOTMAP', 'common');

    const dataset = await buildTaxDataset(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'ultratax' });
    expect(dataset.unassigned).toHaveLength(0);
    expect(dataset.lines.some((l) => l.code === 'DONOTMAP')).toBe(false);
    const merged = dataset.lines.find((l) => l.code === withUt.code)!;
    // Cash 1100 dr, Sales -1000, Interest -300 → net -200 on one line,
    // three account sub-rows.
    expect(merged.accounts.length).toBe(3);
    expect(merged.amount).toBeCloseTo(-200, 2);
    expect(merged.vendorCode).toBe(withUt.ultratax_code);

    const { validation } = await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'ultratax' });
    expect(validation.hardBlocked).toBe(false);
    expect(validation.balanced).toBe(true);
    expect(validation.ready).toBe(true);
  });

  it('flags codes missing the selected vendor code (11.8a)', async () => {
    const noUt = await seedCode('tc.ultratax_code IS NULL AND tc.code <> \'DONOTMAP\'');
    if (!noUt) return; // seed guarantees REPORTING_ONLY-style rows, but stay defensive
    await db.delete(accountTaxAssignments)
      .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.accountId, A['Cash']!)));
    await assign(A['Cash']!, noUt.code, noUt.activity_type);
    const { validation } = await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'ultratax' });
    expect(validation.missingVendorCode.map((m) => m.code)).toContain(noUt.code);
    expect(validation.hardBlocked).toBe(true);
    // Generic export doesn't require the UltraTax code.
    const generic = await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    expect(generic.validation.missingVendorCode.map((m) => m.code)).not.toContain(noUt.code);
  });

  it('consolidates a code into one custom export line when prefs say so', async () => {
    const before = await buildTaxDataset(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'ultratax' });
    const target = before.lines.find((l) => l.accounts.length > 1)!;
    expect(target.consolidated).toBeNull();

    await db.update(companyTaxProfiles)
      .set({ consolidationPrefs: { [target.key]: { exportCode: '4010', description: 'Receipts' } } })
      .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)));

    const after = await buildTaxDataset(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'ultratax' });
    const line = after.lines.find((l) => l.key === target.key)!;
    expect(line.consolidated).toEqual({ exportCode: '4010', description: 'Receipts' });
    // Reference semantics: consolidation replaces the ACCOUNT identity
    // in the file — the tax-line software code stays untouched.
    expect(line.vendorCode).toBe(target.vendorCode);
    expect(line.amount).toBeCloseTo(target.amount, 2);

    // File level: the consolidated group becomes one row, identified by
    // the custom export number/description, emitted FIRST.
    const file = await buildVendorFile('ultratax', after, 'Export Co', new Map(), new Map(), after.consolidationPrefs);
    expect(file.fileName).toMatch(/^ultratax-export-\d{8}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('UltraTax CS Export')!;
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(['AccountNumber', 'AccountName', 'TaxCode', 'Book Basis Amt', 'Tax Basis Amt']);
    const first = ws.getRow(2);
    expect(String(first.getCell(1).value)).toBe('4010');
    expect(String(first.getCell(2).value)).toBe('Receipts');
    expect(String(first.getCell(3).value)).toBe(target.vendorCode ?? '');

    await db.update(companyTaxProfiles).set({ consolidationPrefs: {} })
      .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)));
  });

  it('vendor files match the Vibe TB reference layouts (account grain, book+tax)', async () => {
    const dataset = await buildTaxDataset(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'lacerte' });
    const expectSheet = async (software: 'lacerte' | 'gosystem' | 'cch' | 'generic', sheet: string, header: string[]) => {
      const file = await buildVendorFile(software, dataset, 'Export Co', new Map());
      expect(file.mimeType).toContain('spreadsheetml');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(sheet);
      expect(ws, sheet).toBeTruthy();
      expect((ws!.getRow(1).values as unknown[]).slice(1)).toEqual(header);
      // One row per account with BOTH basis columns present.
      expect(ws!.rowCount).toBeGreaterThan(1);
      return ws!;
    };
    await expectSheet('lacerte', 'Lacerte Export', ['LineCode', 'Description', 'Book Basis Amt', 'Tax Basis Amt']);
    await expectSheet('gosystem', 'GoSystem Tax RS Export', ['LineCode', 'Description', 'Book Basis Amt', 'Tax Basis Amt']);
    await expectSheet('cch', 'CCH Axcess Export', ['AccountNumber', 'AccountName', 'CCHCode', 'Description', 'Book Basis Amt', 'Tax Basis Amt']);
    const ws = await expectSheet('generic', 'Generic Export', ['AccountNumber', 'AccountName', 'TaxCode', 'TaxDescription', 'Book Basis Amt', 'Tax Basis Amt']);
    // Account grain: rows sorted by account number ascending.
    const nums: string[] = [];
    for (let i = 2; i <= ws.rowCount; i++) nums.push(String(ws.getRow(i).getCell(1).value ?? ''));
    expect([...nums].sort((a, b) => a.localeCompare(b))).toEqual(nums);
  });

  it('unit suffixes apply only to split accounts; consolidated identity collisions 409', async () => {
    const synthetic = {
      taxYear: 2026, periodEnd: '2026-12-31', basis: 'accrual' as const,
      glVersionStamp: 1, consolidationPrefs: {}, unitNumberPlacement: 'suffix' as const,
      unassigned: [], missingVendorCode: [],
      lines: [
        { key: 'seed|business|X1', code: 'X1', description: 'Split code', vendorCode: 'X1', sortOrder: 1, amount: 30, bookAmount: 30, consolidated: null,
          accounts: [
            { accountId: 'a', accountNumber: '100', name: 'Split Acct', unitId: 'u1', amount: 10, bookAmount: 10 },
            { accountId: 'a', accountNumber: '100', name: 'Split Acct', unitId: 'u2', amount: 20, bookAmount: 20 },
          ] },
        { key: 'seed|business|X2', code: 'X2', description: 'Single code', vendorCode: 'X2', sortOrder: 2, amount: 5, bookAmount: 5, consolidated: null,
          accounts: [{ accountId: 'b', accountNumber: '200', name: 'Single Acct', unitId: 'u1', amount: 5, bookAmount: 5 }] },
      ],
    };
    const unitInfo = new Map([['u1', { name: 'Unit One', number: 1 }], ['u2', { name: 'Unit Two', number: 2 }]]);
    const file = await buildVendorFile('generic', synthetic, 'Co', new Map(), unitInfo);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Generic Export')!;
    const nums: string[] = [];
    for (let i = 2; i <= ws.rowCount; i++) nums.push(String(ws.getRow(i).getCell(1).value ?? ''));
    // Split account gets per-unit suffixes; single-slice account stays plain.
    expect(nums.sort()).toEqual(['100-1', '100-2', '200']);

    // 'prefix' placement prepends the unit number instead; single-slice
    // accounts still stay plain.
    const prefixed = await buildVendorFile('generic', { ...synthetic, unitNumberPlacement: 'prefix' as const }, 'Co', new Map(), unitInfo);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(prefixed.buffer as unknown as ArrayBuffer);
    const ws2 = wb2.getWorksheet('Generic Export')!;
    const nums2: string[] = [];
    for (let i = 2; i <= ws2.rowCount; i++) nums2.push(String(ws2.getRow(i).getCell(1).value ?? ''));
    expect(nums2.sort()).toEqual(['1-100', '2-100', '200']);

    // Two consolidated groups sharing an export code → DUPLICATE_ACCOUNT.
    const prefs = {
      'seed|business|X1': { exportCode: '4010', description: 'One' },
      'seed|business|X2': { exportCode: '4010', description: 'Two' },
    };
    await expect(buildVendorFile('generic', { ...synthetic, consolidationPrefs: prefs }, 'Co', new Map(), unitInfo, prefs))
      .rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_ACCOUNT' });
  });

  it('segments P&L accounts by unit but never balance sheet accounts (engine-driven)', async () => {
    const main = await createUnit(tenantId, companyId, { activityType: 'business', displayName: 'Main' });
    const rental = await createUnit(tenantId, companyId, { activityType: 'rental', displayName: 'Rental' });
    const [tag] = await db.insert(tags).values({ tenantId, name: 'rental-tag' }).returning();
    await mapTag(tenantId, companyId, tag!.id, rental.id);
    // Tagged deposit: BOTH the Cash line and the Sales line carry the
    // rental tag — Sales splits (main 1000 / rental 250), Cash must not.
    const [txn] = await db.insert(transactions).values({
      tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-05-01', status: 'posted', basis: 'both',
    }).returning();
    await db.insert(journalLines).values([
      { tenantId, transactionId: txn!.id, accountId: A['Cash']!, debit: '250', credit: '0', lineOrder: 0, tagId: tag!.id },
      { tenantId, transactionId: txn!.id, accountId: A['Sales']!, debit: '0', credit: '250', lineOrder: 1, tagId: tag!.id },
    ]);

    const dataset = await buildTaxDataset(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    const cashRows = dataset.lines.flatMap((l) => l.accounts).filter((a) => a.accountId === A['Cash']);
    const salesRows = dataset.lines.flatMap((l) => l.accounts).filter((a) => a.accountId === A['Sales']);
    expect(cashRows).toHaveLength(1);
    expect(cashRows[0]!.amount).toBeCloseTo(1350, 2);
    expect(salesRows.map((r) => [r.unitId, r.amount]).sort()).toEqual([[main.id, -1000], [rental.id, -250]].sort());

    const unitInfo = new Map([[main.id, { name: 'Main', number: 1 }], [rental.id, { name: 'Rental', number: 2 }]]);
    const file = await buildVendorFile('generic', dataset, 'Co', new Map(), unitInfo);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Generic Export')!;
    const nums: string[] = [];
    for (let i = 2; i <= ws.rowCount; i++) nums.push(String(ws.getRow(i).getCell(1).value ?? ''));
    expect(nums).toContain('1000');
    expect(nums.filter((x) => x.startsWith('1000'))).toEqual(['1000']);
    expect(nums.filter((x) => x.startsWith('4000')).sort()).toEqual(['4000-1', '4000-2']);
  });

  it('builds the working TB workbook with sections and five columns', async () => {
    const file = await buildWorkingTbXlsx(tenantId, companyId, { taxYear: 2026, basis: 'accrual' });
    expect(file.fileName).toMatch(/working-tb-20261231-accrual\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Working TB')!;
    const texts: string[] = [];
    ws.eachRow((row) => texts.push(String(row.getCell(1).value ?? '') + '|' + String(row.getCell(2).value ?? '')));
    const flat = texts.join('\n');
    expect(flat).toContain('Assets');
    expect(flat).toContain('Revenue');
    expect(flat).toContain('Total Assets');
    expect(flat).toContain('Cash');
  });

  it('working TB "by tag / unit #" segments P&L lines with unit-numbered account numbers, never the balance sheet', async () => {
    // Fixture from the engine-driven test above: Sales 1000 untagged
    // + 250 under the rental tag; Cash touched by the same tagged JE.
    const units = await db.select().from(activityUnits)
      .where(and(eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)));
    const rental = units.find((u) => u.displayName === 'Rental')!;
    await db.update(companyTaxProfiles).set({ unitNumberPlacement: 'prefix' })
      .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)));

    const file = await buildWorkingTbXlsx(tenantId, companyId, { taxYear: 2026, basis: 'accrual', view: { activityView: 'tags' } });
    expect(file.fileName).toMatch(/working-tb-20261231-accrual-by-tag\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Working TB')!;
    const lines: Array<[string, string, string, number]> = [];
    ws.eachRow((row) => lines.push([
      String(row.getCell(1).value ?? ''), String(row.getCell(2).value ?? ''),
      String(row.getCell(3).value ?? ''), Number(row.getCell(6).value ?? 0),
    ]));
    expect(lines.find((l) => l[0] === 'Acct #')!.slice(0, 3)).toEqual(['Acct #', 'Account', 'Unit']);
    // Balance sheet: ONE line, unit 0, plain balance.
    const cash = lines.filter((l) => l[1] === 'Cash');
    expect(cash).toEqual([['0-1000', 'Cash', 'balance sheet · not segmented', 1350]]);
    // P&L: untagged activity is unit 0, the tagged slice carries the
    // rental unit's number (prefix placement honoured).
    const sales = lines.filter((l) => l[1] === 'Sales');
    expect(sales).toEqual([
      ['0-4000', 'Sales', 'no tag', -1000],
      [`${rental.instanceNumber}-4000`, 'Sales', 'Rental', -250],
    ]);
    // Section subtotal still foots to the account total.
    expect(lines.find((l) => l[1] === 'Total Revenue')![3]).toBeCloseTo(-1550, 2);

    // The Workpaper report shares the same segmentation + formatting.
    const report = await buildTbWorkpaperReport(tenantId, companyId, '2026-12-31', 'accrual', null, { activityView: 'tags' });
    expect(report.title).toContain('By tag / unit #');
    expect(report._exportColumns.map((c) => c.key)).toContain('segment');
    const salesRows = report.data.filter((r) => r['name'] === 'Sales');
    expect(salesRows.map((r) => [r['account_number'], r['segment'], r['adjusted']])).toEqual([
      ['0-4000', 'no tag', -1000],
      [`${rental.instanceNumber}-4000`, 'Rental', -250],
    ]);
    expect(report.data.filter((r) => r['name'] === 'Cash')).toHaveLength(1);
    // Totals foot to the emitted lines (DR 1350 / CR 1350 in TB terms:
    // 1350 cash vs 1000 + 250 + 300 revenue − 200 expense).
    const totals = report.data.find((r) => r['name'] === 'TOTALS (DR/CR)')!;
    expect(totals['adjusted']).toBe('1550.00 / 1550.00');

    // Filters mirror the grid toolbar: type + search narrow the lines.
    const filtered = await buildTbWorkpaperReport(tenantId, companyId, '2026-12-31', 'accrual', null,
      { activityView: 'tags', accountType: 'revenue', search: 'sales' });
    expect(filtered.data.map((r) => r['name'])).toEqual(['Sales', 'Sales', 'TOTALS (DR/CR)']);
    expect(filtered.title).toContain('Type: revenue');

    // Single-unit view: accounts with no activity in the unit drop out.
    const rentalOnly = await buildWorkingTbXlsx(tenantId, companyId, { taxYear: 2026, basis: 'accrual', view: { activityView: rental.id } });
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(rentalOnly.buffer as unknown as ArrayBuffer);
    const names: string[] = [];
    wb2.getWorksheet('Working TB')!.eachRow((row) => names.push(String(row.getCell(2).value ?? '')));
    expect(names).toContain('Sales');
    expect(names).not.toContain('Interest Income');
    expect(names).not.toContain('Cash');
  });
});
