// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Copy tax-code mappings between activity units: dry-run, skip/overwrite,
// incompatible codes skipped and reported, balance-sheet rows ignored,
// default-unit target refused, per-account filter, single audit row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, activityUnits, auditLog, companies, companyTaxProfiles, tenants,
} from '../../db/schema/index.js';
import { importSeed } from './tax-code-seed.service.js';
import { createUnit, setDefaultUnit } from './activity-units.service.js';
import { copyAssignments } from './assignments.service.js';
import { upsertProfile } from './tax-profile.service.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');

let tenantId: string;
let companyId: string;
const A: Record<string, string> = {};
let biz: { id: string }; let r1: { id: string }; let r2: { id: string }; let farm: { id: string };
let bizCode: { code: string; activity_type: string };
let rentalCode: { code: string; activity_type: string };

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
const rowsFor = (unitId: string | null) => db.select().from(accountTaxAssignments)
  .where(and(eq(accountTaxAssignments.companyId, companyId),
    unitId ? eq(accountTaxAssignments.activityUnitId, unitId) : sql`${accountTaxAssignments.activityUnitId} IS NULL`));

beforeAll(async () => {
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  const [t] = await db.insert(tenants).values({ name: 'tb-copy', slug: `tb-copy-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Copy Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1065', defaultActivityType: 'business', taxCodeMappingMode: 'unit' });
  const mk = async (num: string, name: string, type: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type }).returning();
    A[name] = a!.id;
  };
  await mk('1000', 'Cash', 'asset');
  await mk('4000', 'Sales', 'revenue');
  await mk('5000', 'Utilities', 'expense');
  biz = await createUnit(tenantId, companyId, { activityType: 'business', displayName: 'Biz' });
  r1 = await createUnit(tenantId, companyId, { activityType: 'rental', displayName: 'Rental 1' });
  r2 = await createUnit(tenantId, companyId, { activityType: 'rental', displayName: 'Rental 2' });
  farm = await createUnit(tenantId, companyId, { activityType: 'farm', displayName: 'Farm 1' });
  bizCode = await seedCode("tc.activity_type = 'business' AND tc.code NOT IN ('DONOTMAP','MEMO','SUSPENSE','REPORTING_ONLY')");
  rentalCode = await seedCode("tc.activity_type = 'rental'");
  // Account-level rows: Sales = business-only code, Utilities = utility (common) code, Cash = utility code.
  await db.insert(accountTaxAssignments).values([
    { tenantId, companyId, accountId: A['Sales']!, activityUnitId: null, seedCode: bizCode.code, seedActivityType: bizCode.activity_type, source: 'manual' },
    { tenantId, companyId, accountId: A['Utilities']!, activityUnitId: null, seedCode: 'DONOTMAP', seedActivityType: 'common', source: 'manual' },
    { tenantId, companyId, accountId: A['Cash']!, activityUnitId: null, seedCode: 'DONOTMAP', seedActivityType: 'common', source: 'manual' },
  ]);
});

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.tenantId, tenantId));
  await db.delete(companyTaxProfiles).where(eq(companyTaxProfiles.tenantId, tenantId));
  await db.delete(activityUnits).where(eq(activityUnits.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('copyAssignments', () => {
  it('dry run reports what would happen and writes nothing', async () => {
    const before = (await rowsFor(r1.id)).length;
    const res = await copyAssignments(tenantId, companyId, { sourceUnitId: null, targetUnitIds: [r1.id, r2.id], mode: 'skip_existing', dryRun: true });
    expect(res.dryRun).toBe(true);
    // Utilities (common) copies to both; Sales (business) is incompatible with rental; Cash is balance sheet → ignored.
    expect(res.copied).toBe(2);
    expect(res.skippedIncompatible).toBe(2);
    expect(res.perTarget.map((p) => p.copied)).toEqual([1, 1]);
    expect(res.perTarget[0]!.incompatible[0]).toMatchObject({ accountId: A['Sales'], reason: 'incompatible_activity' });
    expect((await rowsFor(r1.id)).length).toBe(before);
  });

  it('copies compatible codes, skips balance sheet, writes one audit row', async () => {
    const res = await copyAssignments(tenantId, companyId, { sourceUnitId: null, targetUnitIds: [r1.id, r2.id], mode: 'skip_existing' }, undefined);
    expect(res.copied).toBe(2);
    const r1Rows = await rowsFor(r1.id);
    expect(r1Rows.map((r) => r.accountId)).toEqual([A['Utilities']]);
    expect((await rowsFor(r2.id)).length).toBe(1);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'account_tax_assignment_copy')));
    expect(audits).toHaveLength(1);
  });

  it('skip_existing leaves an existing row; overwrite replaces it; rental → rental copies rental codes', async () => {
    await db.insert(accountTaxAssignments).values({
      tenantId, companyId, accountId: A['Sales']!, activityUnitId: r1.id, seedCode: rentalCode.code, seedActivityType: rentalCode.activity_type, source: 'manual',
    });
    await db.update(accountTaxAssignments).set({ seedCode: 'MEMO', seedActivityType: 'common' })
      .where(and(eq(accountTaxAssignments.accountId, A['Utilities']!), eq(accountTaxAssignments.activityUnitId, r1.id)));
    let res = await copyAssignments(tenantId, companyId, { sourceUnitId: r1.id, targetUnitIds: [r2.id], mode: 'skip_existing' });
    expect(res.copied).toBe(1); // Sales rental code → Rental 2 (new); Utilities exists → skipped
    expect(res.skippedExisting).toBe(1);
    let r2Rows = await rowsFor(r2.id);
    expect(r2Rows.find((r) => r.accountId === A['Sales'])?.seedCode).toBe(rentalCode.code);
    expect(r2Rows.find((r) => r.accountId === A['Utilities'])?.seedCode).toBe('DONOTMAP');

    res = await copyAssignments(tenantId, companyId, { sourceUnitId: r1.id, targetUnitIds: [r2.id], mode: 'overwrite' });
    expect(res.perTarget[0]!.overwritten).toBe(2);
    r2Rows = await rowsFor(r2.id);
    expect(r2Rows.find((r) => r.accountId === A['Utilities'])?.seedCode).toBe('MEMO');
  });

  it('accountIds restricts the copy (per-row apply-to-all)', async () => {
    await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.activityUnitId, r2.id));
    const res = await copyAssignments(tenantId, companyId, { sourceUnitId: r1.id, targetUnitIds: [r2.id], mode: 'overwrite', accountIds: [A['Sales']!] });
    expect(res.copied).toBe(1);
    expect((await rowsFor(r2.id)).map((r) => r.accountId)).toEqual([A['Sales']]);
  });

  it('rental code → farm target is incompatible; default-unit target and archived/unknown targets are refused', async () => {
    const res = await copyAssignments(tenantId, companyId, { sourceUnitId: r1.id, targetUnitIds: [farm.id], mode: 'skip_existing', dryRun: true });
    expect(res.perTarget[0]!.incompatible.some((i) => i.accountId === A['Sales'] && i.reason === 'incompatible_activity')).toBe(true);
    await expect(copyAssignments(tenantId, companyId, { sourceUnitId: r1.id, targetUnitIds: [biz.id], mode: 'skip_existing' }))
      .rejects.toMatchObject({ code: 'TB_NOT_ASSIGNABLE' });
    await expect(copyAssignments(tenantId, companyId, { sourceUnitId: r1.id, targetUnitIds: ['00000000-0000-0000-0000-00000000dead'], mode: 'skip_existing' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('setDefaultUnit in unit mode returns an impact preview, then applies with confirm (+ convertOldDefault)', async () => {
    const preview = await setDefaultUnit(tenantId, companyId, r1.id);
    expect(preview.requiresConfirm).toBe(true);
    // Sales + Utilities have account-level rows and no Biz unit row → lose coverage; Sales' business code mismatches rental.
    expect(preview.impact?.accountsLosingCoverage.map((a) => a.name).sort()).toEqual(['Sales', 'Utilities']);
    expect(preview.impact?.mismatches.map((m) => m.name)).toEqual(['Sales']);
    expect((await db.select().from(activityUnits).where(eq(activityUnits.id, biz.id)))[0]!.isDefault).toBe(true);

    const applied = await setDefaultUnit(tenantId, companyId, r1.id, undefined, { confirm: true, convertOldDefault: true });
    expect(applied.requiresConfirm).toBe(false);
    expect(applied.unit?.isDefault).toBe(true);
    expect((await rowsFor(biz.id)).map((r) => r.accountId).sort()).toEqual([A['Sales'], A['Utilities']].sort());
    // Restore Biz as default for any later assertions.
    await setDefaultUnit(tenantId, companyId, biz.id, undefined, { confirm: true });
  });

  it('the profile refuses unit mode with no live units', async () => {
    const [t2] = await db.insert(tenants).values({ name: 'tb-copy-nounits', slug: `tb-copy-nu-${Date.now()}` }).returning();
    const [c2] = await db.insert(companies).values({ tenantId: t2!.id, businessName: 'No Units', fiscalYearStartMonth: 1 }).returning();
    try {
      await expect(upsertProfile(t2!.id, c2!.id, { returnForm: '1065', taxCodeMappingMode: 'unit' }))
        .rejects.toMatchObject({ code: 'TB_MODE_REQUIRES_UNITS' });
    } finally {
      await db.delete(companyTaxProfiles).where(eq(companyTaxProfiles.tenantId, t2!.id));
      await db.delete(companies).where(eq(companies.id, c2!.id));
      await db.delete(tenants).where(eq(tenants.id, t2!.id));
    }
  });
});
