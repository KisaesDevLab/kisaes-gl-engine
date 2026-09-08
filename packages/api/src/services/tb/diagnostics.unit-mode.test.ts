// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Unit mapping mode (migration 0170): strict per-unit resolution, the
// unit_gap / activity_mismatch / default_unit_override diagnostics, and
// the export gate — with account mode asserted unchanged on the same
// fixture.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, activityUnits, companies, companyTaxProfiles, journalLines,
  tagActivityMap, tags, tenants, transactions,
} from '../../db/schema/index.js';
import { importSeed } from './tax-code-seed.service.js';
import { createUnit, mapTag } from './activity-units.service.js';
import { runDiagnostics, resolveCodeFor, buildResolveContext, ACCOUNT_MODE_CONTEXT, type AssignmentRow } from './diagnostics.service.js';
import { validateForExport, buildTaxDataset } from './exports.service.js';
import { setAssignment } from './assignments.service.js';
import { ZERO_UUID } from './balance-engine.service.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');

let tenantId: string;
let companyId: string;
const A: Record<string, string> = {};
let main: { id: string; activityType: string };
let oak: { id: string; activityType: string };
let elm: { id: string; activityType: string };
let bizCode: { code: string; activity_type: string };
let rentalCode: { code: string; activity_type: string };
let commonCode: { code: string; activity_type: string };

async function seedCode(where: string) {
  const res = await db.execute(sql.raw(`
    SELECT code, activity_type FROM tax_codes tc
    WHERE ${where} AND tc.return_form IN ('1065', 'common')
      AND tc.version_id = (SELECT id FROM tax_code_seed_versions WHERE tax_year = 2025 ORDER BY version DESC LIMIT 1)
    ORDER BY sort_order LIMIT 1
  `));
  const row = (res.rows as Array<{ code: string; activity_type: string }>)[0];
  if (!row) throw new Error(`no seed code for: ${where}`);
  return row;
}
const setMode = (mode: 'account' | 'unit') =>
  db.update(companyTaxProfiles).set({ taxCodeMappingMode: mode }).where(eq(companyTaxProfiles.companyId, companyId));
const diag = async () => (await runDiagnostics(tenantId, companyId, { periodEnd: '2026-12-31', basis: 'accrual', taxYear: 2026 })).diagnostics;

beforeAll(async () => {
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  const [t] = await db.insert(tenants).values({ name: 'tb-unitmode', slug: `tb-unitmode-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Unit Mode Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1065', defaultActivityType: 'business' });
  const mk = async (num: string, name: string, type: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type }).returning();
    A[name] = a!.id;
  };
  await mk('1000', 'Cash', 'asset');
  await mk('4000', 'Sales', 'revenue');
  await mk('5000', 'Rent Expense', 'expense');
  main = await createUnit(tenantId, companyId, { activityType: 'business', displayName: 'Main' });
  oak = await createUnit(tenantId, companyId, { activityType: 'rental', displayName: 'Oak' });
  elm = await createUnit(tenantId, companyId, { activityType: 'rental', displayName: 'Elm' });
  const [tag] = await db.insert(tags).values({ tenantId, companyId, name: 'oak' }).returning();
  await mapTag(tenantId, companyId, tag!.id, oak.id);
  // Sales: 600 untagged (→ Main) + 400 tagged Oak. Rent: 200 untagged.
  const [txn] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-03-01', status: 'posted', basis: 'both',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, transactionId: txn!.id, accountId: A['Cash']!, debit: '800', credit: '0', lineOrder: 0 },
    { tenantId, transactionId: txn!.id, accountId: A['Sales']!, debit: '0', credit: '600', lineOrder: 1 },
    { tenantId, transactionId: txn!.id, accountId: A['Sales']!, debit: '0', credit: '400', lineOrder: 2, tagId: tag!.id },
    { tenantId, transactionId: txn!.id, accountId: A['Rent Expense']!, debit: '200', credit: '0', lineOrder: 3 },
  ]);
  bizCode = await seedCode("tc.activity_type = 'business' AND tc.code NOT IN ('DONOTMAP','MEMO','SUSPENSE','REPORTING_ONLY')");
  rentalCode = await seedCode("tc.activity_type = 'rental'");
  commonCode = await seedCode("tc.return_form = 'common' AND tc.activity_type = 'common' AND tc.code = 'DONOTMAP'");
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

describe('resolveCodeFor (pure)', () => {
  const rows: AssignmentRow[] = [
    { accountId: 'acct', activityUnitId: null, seedCode: 'ACCT', seedActivityType: 'business', firmCodeId: null },
    { accountId: 'acct', activityUnitId: 'oak', seedCode: 'OAK', seedActivityType: 'rental', firmCodeId: null },
  ];
  const ctx = buildResolveContext('unit', [
    { id: 'main', activityType: 'business', isDefault: true, archivedAt: null },
    { id: 'oak', activityType: 'rental', isDefault: false, archivedAt: null },
    { id: 'elm', activityType: 'rental', isDefault: false, archivedAt: null },
  ]);
  it('account mode always falls back to the account-level row', () => {
    expect(resolveCodeFor(rows, 'acct', 'elm', ACCOUNT_MODE_CONTEXT, 'revenue')?.seedCode).toBe('ACCT');
    expect(resolveCodeFor(rows, 'acct', 'oak', ACCOUNT_MODE_CONTEXT, 'revenue')?.seedCode).toBe('OAK');
  });
  it('unit mode: unit row wins; default unit, zero bucket and balance sheet fall back; other units do not', () => {
    expect(resolveCodeFor(rows, 'acct', 'oak', ctx, 'revenue')?.seedCode).toBe('OAK');
    expect(resolveCodeFor(rows, 'acct', 'main', ctx, 'revenue')?.seedCode).toBe('ACCT');
    expect(resolveCodeFor(rows, 'acct', ZERO_UUID, ctx, 'revenue')?.seedCode).toBe('ACCT');
    expect(resolveCodeFor(rows, 'acct', 'elm', ctx, 'asset')?.seedCode).toBe('ACCT');
    expect(resolveCodeFor(rows, 'acct', 'elm', ctx, 'revenue')).toBeNull();
  });
});

describe('unit mapping mode diagnostics + export gate', () => {
  it('account mode: account-level rows cover every slice, no unit-mode kinds', async () => {
    await setAssignment(tenantId, companyId, { accountId: A['Sales']!, seedCode: bizCode.code, seedActivityType: bizCode.activity_type });
    await setAssignment(tenantId, companyId, { accountId: A['Rent Expense']!, seedCode: bizCode.code, seedActivityType: bizCode.activity_type });
    await setAssignment(tenantId, companyId, { accountId: A['Cash']!, seedCode: commonCode.code, seedActivityType: commonCode.activity_type });
    const d = await diag();
    expect(d.filter((x) => ['unit_gap', 'activity_mismatch', 'default_unit_override', 'unassigned', 'split_gap'].includes(x.kind))).toEqual([]);
    const { validation } = await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    expect(validation.unitGaps).toBe(0);
    expect(validation.hardBlocked).toBe(false);
  });

  it('unit mode: the Oak slice with balance and no unit row is a unit_gap; Elm (no balance) and Rent (default only) are not', async () => {
    await setMode('unit');
    const d = await diag();
    const gaps = d.filter((x) => x.kind === 'unit_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ accountId: A['Sales'], unitId: oak.id, severity: 'error' });
    expect(d.some((x) => x.kind === 'split_gap')).toBe(false);
    const { validation, dataset } = await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    expect(validation.unitGaps).toBe(1);
    expect(validation.hardBlocked).toBe(true);
    expect(dataset.unassigned.some((u) => u.accountId === A['Sales'] && u.name.includes('Oak'))).toBe(true);
  });

  it('a unit row for Oak clears the gap and exports the two slices under different codes', async () => {
    await setAssignment(tenantId, companyId, {
      accountId: A['Sales']!, activityUnitId: oak.id, seedCode: rentalCode.code, seedActivityType: rentalCode.activity_type,
      // legacy body field — must be ignored (the unit is rental)
      activityUnitType: 'business',
    });
    const d = await diag();
    expect(d.filter((x) => x.kind === 'unit_gap')).toEqual([]);
    const { validation, dataset } = await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    expect(validation.hardBlocked).toBe(false);
    const salesLines = dataset.lines.filter((l) => l.accounts.some((a) => a.accountId === A['Sales']));
    const codes = new Set(salesLines.map((l) => l.code));
    expect(codes.size).toBe(2);
    expect(codes.has(bizCode.code)).toBe(true);
    expect(codes.has(rentalCode.code)).toBe(true);
  });

  it('server ignores the body activity type: a business code on the rental unit is refused', async () => {
    await expect(setAssignment(tenantId, companyId, {
      accountId: A['Rent Expense']!, activityUnitId: oak.id, seedCode: bizCode.code, seedActivityType: bizCode.activity_type,
      activityUnitType: 'business',
    })).rejects.toMatchObject({ code: 'TB_NOT_ASSIGNABLE' });
  });

  it('a write aimed at the default unit lands account-level; balance-sheet unit writes are refused', async () => {
    const row = await setAssignment(tenantId, companyId, {
      accountId: A['Rent Expense']!, activityUnitId: main.id, seedCode: bizCode.code, seedActivityType: bizCode.activity_type,
    });
    expect(row.activityUnitId).toBeNull();
    await expect(setAssignment(tenantId, companyId, {
      accountId: A['Cash']!, activityUnitId: oak.id, seedCode: commonCode.code, seedActivityType: commonCode.activity_type,
    })).rejects.toMatchObject({ code: 'TB_NOT_ASSIGNABLE' });
    expect((await diag()).filter((x) => x.kind === 'default_unit_override')).toEqual([]);
  });

  it('activity_mismatch: an account-level rental code on a business default unit is an error in unit mode only', async () => {
    // Bypass validation (legacy data) — write the row directly.
    await db.update(accountTaxAssignments)
      .set({ seedCode: rentalCode.code, seedActivityType: rentalCode.activity_type })
      .where(and(eq(accountTaxAssignments.accountId, A['Rent Expense']!), sql`${accountTaxAssignments.activityUnitId} IS NULL`));
    let d = await diag();
    expect(d.filter((x) => x.kind === 'activity_mismatch')).toHaveLength(1);
    expect((await validateForExport(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' })).validation.activityMismatches).toBe(1);
    await setMode('account');
    d = await diag();
    expect(d.filter((x) => x.kind === 'activity_mismatch')).toEqual([]);
    // restore
    await db.update(accountTaxAssignments)
      .set({ seedCode: bizCode.code, seedActivityType: bizCode.activity_type })
      .where(and(eq(accountTaxAssignments.accountId, A['Rent Expense']!), sql`${accountTaxAssignments.activityUnitId} IS NULL`));
    await setMode('unit');
  });

  it('default_unit_override flags a legacy unit row for the default unit', async () => {
    await db.insert(accountTaxAssignments).values({
      tenantId, companyId, accountId: A['Rent Expense']!, activityUnitId: main.id,
      seedCode: bizCode.code, seedActivityType: bizCode.activity_type, source: 'manual',
    });
    const d = await diag();
    expect(d.filter((x) => x.kind === 'default_unit_override')).toHaveLength(1);
    await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.activityUnitId, main.id));
  });

  it('account mode on the same data still produces the original dataset (fallback for every slice)', async () => {
    await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.activityUnitId, oak.id));
    await setMode('account');
    const dataset = await buildTaxDataset(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    const sales = dataset.lines.filter((l) => l.accounts.some((a) => a.accountId === A['Sales']));
    expect(sales).toHaveLength(1);
    expect(sales[0]!.accounts.filter((a) => a.accountId === A['Sales'])).toHaveLength(2); // two slices, one code
    expect(dataset.unassigned).toEqual([]);
    await setMode('unit');
    const strict = await buildTaxDataset(tenantId, companyId, { taxYear: 2026, basis: 'accrual', software: 'generic' });
    expect(strict.unassigned.map((u) => u.accountId)).toContain(A['Sales']);
  });
});
