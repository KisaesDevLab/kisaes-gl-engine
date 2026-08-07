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
  accounts, accountTaxAssignments, companies, companyTaxProfiles,
  journalLines, tenants, transactions,
} from '../../db/schema/index.js';
import { importSeed } from './tax-code-seed.service.js';
import { buildTaxDataset, buildWorkingTbXlsx, validateForExport } from './exports.service.js';

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
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

async function seedCode(where: string): Promise<{ code: string; activity_type: string; ultratax_code: string | null }> {
  const res = await db.execute(sql.raw(`
    SELECT code, activity_type, ultratax_code FROM tax_codes tc
    WHERE ${where} AND tc.return_form IN ('1065', 'common')
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
    expect(line.vendorCode).toBe('4010');
    expect(line.description).toBe('Receipts');
    // The custom code satisfies the vendor-code requirement.
    expect(after.missingVendorCode.map((m) => m.code)).not.toContain(line.code);
    // Amount unchanged — consolidation reshapes lines, never totals.
    expect(line.amount).toBeCloseTo(target.amount, 2);

    await db.update(companyTaxProfiles).set({ consolidationPrefs: {} })
      .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)));
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
});
