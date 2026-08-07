// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 8.4 invariants: RJEs never touch the GL; entries must net to
// zero; numbering per (company, taxYear); stamp bumps on RJE edits so
// caches + sign-off staleness stay exact; M-1 flag resolution.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, companies, companyTaxProfiles,
  journalLines, tbTaxEntries, tbTaxEntryLines, tenants, transactions,
} from '../../db/schema/index.js';
import { buildTrialBalance } from '../report.service.js';
import { getGlVersionStamp } from './balance-engine.service.js';
import { createTaxEntry, deleteTaxEntry, listTaxEntries, updateTaxEntry } from './tax-entries.service.js';

let tenantId: string;
let companyId: string;
let depExpId: string;
let accDepId: string;
let cashId: string;

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-rje-test', slug: `tb-rje-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'RJE Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const mk = async (num: string, name: string, type: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type }).returning();
    return a!.id;
  };
  cashId = await mk('1000', 'Cash', 'asset');
  depExpId = await mk('5100', 'Depreciation Expense', 'expense');
  accDepId = await mk('1590', 'Accumulated Depreciation', 'asset');

  // Some GL activity so the trial balance is non-trivial.
  const [txn] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-02-01', status: 'posted', basis: 'both',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, transactionId: txn!.id, accountId: cashId, debit: '1000', credit: '0', lineOrder: 0 },
    { tenantId, transactionId: txn!.id, accountId: depExpId, debit: '0', credit: '1000', lineOrder: 1 },
  ]);
});

afterAll(async () => {
  await db.delete(tbTaxEntryLines).where(eq(tbTaxEntryLines.tenantId, tenantId));
  await db.delete(tbTaxEntries).where(eq(tbTaxEntries.tenantId, tenantId));
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

describe('tax RJEs (ADR-TB-03)', () => {
  it('rejects unbalanced and empty entries', async () => {
    await expect(createTaxEntry(tenantId, companyId, {
      taxYear: 2026, memo: 'bad',
      lines: [
        { accountId: depExpId, debit: '100', credit: '0' },
        { accountId: accDepId, debit: '0', credit: '99' },
      ],
    })).rejects.toMatchObject({ statusCode: 422, code: 'TB_UNBALANCED' });
    await expect(createTaxEntry(tenantId, companyId, {
      taxYear: 2026,
      lines: [
        { accountId: depExpId, debit: '0', credit: '0' },
        { accountId: accDepId, debit: '0', credit: '0' },
      ],
    })).rejects.toMatchObject({ code: 'TB_UNBALANCED' });
  });

  it('numbers RJE-001 per tax year, bumps the stamp, and never touches the GL', async () => {
    const glBefore = await buildTrialBalance(tenantId, '2026-01-01', '2026-12-31', companyId, null, 'accrual');
    const stampBefore = await getGlVersionStamp(tenantId, companyId);

    const e1 = await createTaxEntry(tenantId, companyId, {
      taxYear: 2026, memo: 'Sec 179',
      lines: [
        { accountId: depExpId, debit: '500', credit: '0' },
        { accountId: accDepId, debit: '0', credit: '500' },
      ],
    });
    expect(e1.entryNumberLabel).toBe('RJE-001');
    const e2 = await createTaxEntry(tenantId, companyId, {
      taxYear: 2026, memo: 'M&E 50%',
      lines: [
        { accountId: depExpId, debit: '80', credit: '0' },
        { accountId: accDepId, debit: '0', credit: '80' },
      ],
    });
    expect(e2.entryNumber).toBe(2);
    const prior = await createTaxEntry(tenantId, companyId, {
      taxYear: 2025,
      lines: [
        { accountId: depExpId, debit: '10', credit: '0' },
        { accountId: accDepId, debit: '0', credit: '10' },
      ],
    });
    expect(prior.entryNumberLabel).toBe('RJE-001'); // per-year sequence

    // Stamp moved (cache + staleness), GL identical (invariant #3).
    const stampAfter = await getGlVersionStamp(tenantId, companyId);
    expect(stampAfter).toBeGreaterThan(stampBefore);
    const glAfter = await buildTrialBalance(tenantId, '2026-01-01', '2026-12-31', companyId, null, 'accrual');
    expect(glAfter.data).toEqual(glBefore.data);
    expect(glAfter.totalDebits).toBe(glBefore.totalDebits);
  });

  it('updates atomically (line replacement) and deletes with stamp bumps', async () => {
    const { entries } = await listTaxEntries(tenantId, companyId, 2026);
    const target = entries.find((e) => e.memo === 'M&E 50%')!;
    const stampBefore = await getGlVersionStamp(tenantId, companyId);
    await updateTaxEntry(tenantId, companyId, target.id, {
      taxYear: 2026, memo: 'M&E 50% (updated)',
      lines: [
        { accountId: depExpId, debit: '90', credit: '0' },
        { accountId: accDepId, debit: '0', credit: '90' },
      ],
    });
    const afterUpdate = await listTaxEntries(tenantId, companyId, 2026);
    const updated = afterUpdate.entries.find((e) => e.id === target.id)!;
    expect(updated.memo).toBe('M&E 50% (updated)');
    expect(Number(updated.lines[0]!.debit)).toBe(90);
    expect(await getGlVersionStamp(tenantId, companyId)).toBeGreaterThan(stampBefore);

    await deleteTaxEntry(tenantId, companyId, target.id);
    const afterDelete = await listTaxEntries(tenantId, companyId, 2026);
    expect(afterDelete.entries.find((e) => e.id === target.id)).toBeUndefined();
    // Lines cascaded.
    const orphans = await db.select().from(tbTaxEntryLines).where(eq(tbTaxEntryLines.entryId, target.id));
    expect(orphans).toHaveLength(0);
  });

  it('flags entries touching M-1 codes (8.3)', async () => {
    // Profile + an M-1 assignment: use the seeded TY2025 codes — pick a
    // real is_m1_adjustment row dynamically so the test doesn't hardcode
    // seed contents.
    await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1065' });
    const m1Code = await db.execute(sql`
      SELECT tc.code, tc.activity_type FROM tax_codes tc
      JOIN tax_code_seed_versions v ON v.id = tc.version_id
      WHERE tc.is_m1_adjustment = TRUE AND tc.return_form IN ('1065', 'common')
      ORDER BY v.imported_at DESC LIMIT 1
    `);
    const codeRow = (m1Code.rows as Array<{ code: string; activity_type: string }>)[0];
    expect(codeRow).toBeTruthy();
    await db.insert(accountTaxAssignments).values({
      tenantId, companyId,
      accountId: depExpId,
      activityUnitId: null,
      seedCode: codeRow!.code,
      seedActivityType: codeRow!.activity_type,
      source: 'manual',
    });
    const { entries } = await listTaxEntries(tenantId, companyId, 2026);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.isM1)).toBe(true); // all touch depExp
  });
});
