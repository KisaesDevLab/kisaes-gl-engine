// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 4 acceptance: the Rivera Plumbing fixture (UI-SPEC "Rivera fixture",
// rivera_fixture.py: books 115,400 → tax-basis 128,000), non-recurring split,
// W-2 wages + override precedence, cash vs accrual, and the cache key.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import { taxEstAccountTreatments, taxEstEntitySettings, taxEstTransactionFlags } from '../../db/schema/index.js';
import { importSeed } from '../tb/tax-code-seed.service.js';
import { getGlVersionStamp } from '../tb/balance-engine.service.js';
import type { FirmScope } from './firm-scope.service.js';
import {
  characterForCode, getTaxBasisPl, monthsBetween, resolveThroughMonth, taxBasisCacheKey, taxYearWindow,
} from './pl-provider.service.js';
import { putTreatments, putTransactionFlags } from './treatments.service.js';
import { upsertEntitySettings, upsertYearInputs } from './entity-settings.service.js';
import { assign, mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');

const R = { checking: '', ar: '', draws: '', revenue: '', supplies: '', health: '', meals: '' };
const B = { checking: '', sales: '', officer: '' };
let rivera = { tenantId: '', companyId: '' };
let bakery = { tenantId: '', companyId: '' };
let scope: FirmScope;
let marchRevenueTxn = '';

// Supplies chosen so Jan–Sep book net = 86,550 and the year = 115,400.
const SUPPLIES = ['4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.36', '4183.33', '4183.33', '4183.34'];

beforeAll(async () => {
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });

  // ── Rivera Plumbing LLC: Sch C, cash basis ──
  rivera.tenantId = await mkTenant('TE4 Rivera');
  rivera.companyId = await mkCompany(rivera.tenantId, 'Rivera Plumbing LLC', { accountingMethod: 'cash', entityType: 'single_member_llc' });
  const t = rivera.tenantId;
  const c = rivera.companyId;
  await setProfile(t, c, '1040', 'business');
  R.checking = await mkAccount(t, c, '1010', 'Checking', 'asset', { detailType: 'checking' });
  R.ar = await mkAccount(t, c, '1200', 'Accounts Receivable', 'asset', { detailType: 'accounts_receivable' });
  R.draws = await mkAccount(t, c, '3020', 'Owner Draws', 'equity', { detailType: 'owners_draw' });
  R.revenue = await mkAccount(t, c, '4000', 'Plumbing Revenue', 'revenue');
  R.supplies = await mkAccount(t, c, '6100', 'Supplies', 'expense');
  R.health = await mkAccount(t, c, '6200', 'Owner Health Insurance', 'expense');
  R.meals = await mkAccount(t, c, '6420', 'Meals', 'expense');
  await assign(t, c, R.revenue, 'business', '801');
  await assign(t, c, R.supplies, 'business', '822');
  for (let m = 1; m <= 12; m++) {
    const d = `2026-${String(m).padStart(2, '0')}-15`;
    const rev = await post(t, c, d, [[R.checking, 15000, 0], [R.revenue, 0, 15000]]);
    if (m === 3) marchRevenueTxn = rev;
    await post(t, c, d, [[R.health, 900, 0], [R.checking, 0, 900]]);
    await post(t, c, d, [[R.meals, 300, 0], [R.checking, 0, 300]]);
    await post(t, c, d, [[R.supplies, SUPPLIES[m - 1]!, 0], [R.checking, 0, SUPPLIES[m - 1]!]]);
  }
  // Federal estimates booked to owner draws (GL), mapped estimated_tax_payment.
  await post(t, c, '2026-04-10', [[R.draws, 6600, 0], [R.checking, 0, 6600]]);
  await post(t, c, '2026-06-12', [[R.draws, 6600, 0], [R.checking, 0, 6600]]);
  // Unpaid December invoice: accrual-only revenue (cash basis must not see it).
  await post(t, c, '2026-12-20', [[R.ar, 5000, 0], [R.revenue, 0, 5000]], { txnType: 'invoice', total: '5000' });

  // ── Ozark Hearth Bakery: S corp (1120S), officer wages ──
  bakery.tenantId = await mkTenant('TE4 Bakery');
  bakery.companyId = await mkCompany(bakery.tenantId, 'Ozark Hearth Bakery', { accountingMethod: 'accrual', entityType: 's_corp' });
  const bt = bakery.tenantId;
  const bc = bakery.companyId;
  await setProfile(bt, bc, '1120S', 'business');
  B.checking = await mkAccount(bt, bc, '1010', 'Operating', 'asset', { detailType: 'checking' });
  B.sales = await mkAccount(bt, bc, '4000', 'Bakery Sales', 'revenue');
  B.officer = await mkAccount(bt, bc, '6010', 'Officer Compensation', 'expense');
  await assign(bt, bc, B.sales, 'business', '100');
  await assign(bt, bc, B.officer, 'business', '200');
  for (let m = 1; m <= 12; m++) {
    const d = `2026-${String(m).padStart(2, '0')}-10`;
    await post(bt, bc, d, [[B.checking, 20000, 0], [B.sales, 0, 20000]]);
    await post(bt, bc, d, [[B.officer, 4500, 0], [B.checking, 0, 4500]]);
  }

  scope = { firmId: '00000000-0000-0000-0000-0000000000f1', firmRole: 'firm_staff', allowedTenantIds: [rivera.tenantId, bakery.tenantId] };

  await putTreatments(scope, t, c, [
    { accountId: R.health, treatment: 'owner_sehi', nonRecurring: false },
    { accountId: R.meals, treatment: 'nondeductible_pct', pct: '50', nonRecurring: false },
    { accountId: R.draws, treatment: 'estimated_tax_payment', paymentJurisdiction: 'federal', nonRecurring: false },
  ]);
}, 60_000);

afterAll(async () => {
  await purgeTenants([rivera.tenantId, bakery.tenantId]);
  await pool.end();
});

const d = (s: string) => Number(s);

describe('Rivera Plumbing acceptance fixture (books 115,400 → tax-basis 128,000)', () => {
  it('full year: SEHI reclass 10,800, meals add-back 1,800, tax-basis profit 128,000', async () => {
    const pl = await getTaxBasisPl(scope, { ...rivera, taxYear: 2026, throughMonth: '2026-12' }, { skipCache: true });
    expect(pl.basis).toBe('cash');
    expect(pl.entityType).toBe('sch_c');
    expect(d(pl.bookNetIncome)).toBe(115400);
    expect(d(pl.taxBasisProfit)).toBe(128000);
    expect(d(pl.byCharacter.ordinary)).toBe(128000);
    expect(d(pl.ownerLevel.ownerSehi)).toBe(10800);
    expect(d(pl.nondeductibleAddBack)).toBe(1800);
    expect(d(pl.recurring.ordinary)).toBe(128000);
    expect(d(pl.nonRecurring.ordinary)).toBe(0);
    expect(pl.monthsElapsed).toBe(12);
    expect(pl.months).toHaveLength(12);
    expect(d(pl.months[0]!.ownerSehi)).toBe(900);

    // Payment transactions separated from profit (equity account, no profit effect).
    expect(pl.estimatedPayments.map((p) => [p.date, d(p.amount), p.jurisdiction])).toEqual([
      ['2026-04-10', 6600, 'federal'], ['2026-06-12', 6600, 'federal'],
    ]);

    // Trace row for each reclass, source gl_map.
    const sehi = pl.trace.find((r) => r.label.startsWith('6200 Owner Health Insurance'));
    const meals = pl.trace.find((r) => r.label.startsWith('6420 Meals'));
    expect(sehi).toMatchObject({ source: 'gl_map' });
    expect(d(sehi!.amount)).toBe(10800);
    expect(meals).toMatchObject({ source: 'gl_map' });
    expect(d(meals!.amount)).toBe(1800);
    expect(d(pl.trace.find((r) => r.label === 'Tax-basis profit')!.amount)).toBe(128000);

    const healthLine = pl.accounts.find((a) => a.accountId === R.health)!;
    expect(healthLine).toMatchObject({ route: 'owner_sehi', taxAmount: '0.0000' });
    expect(pl.accounts.find((a) => a.accountId === R.revenue)!.characterSource).toBe('tb_assignment');
    expect(pl.warnings.find((w) => w.code === 'TE_UNMAPPED_ACCOUNTS')).toBeUndefined();
  });

  it('Jan–Sep: book 86,550 → tax-basis 96,000 (mockup footer)', async () => {
    const pl = await getTaxBasisPl(scope, { ...rivera, taxYear: 2026, throughMonth: '2026-09' }, { skipCache: true });
    expect(d(pl.bookNetIncome)).toBe(86550);
    expect(d(pl.taxBasisProfit)).toBe(96000);
    expect(pl.monthsElapsed).toBe(9);
  });
});

describe('non-recurring exclusion', () => {
  it('account flag and transaction flag move amounts out of the recurring series', async () => {
    await putTreatments(scope, rivera.tenantId, rivera.companyId, [{ accountId: R.supplies, treatment: null, nonRecurring: true }]);
    await putTransactionFlags(scope, rivera.tenantId, rivera.companyId, { flags: [{ transactionId: marchRevenueTxn, nonRecurring: true }] });
    try {
      const pl = await getTaxBasisPl(scope, { ...rivera, taxYear: 2026, throughMonth: '2026-12' }, { skipCache: true });
      // Supplies year total 50,200 (expense, profit −) + March revenue 15,000.
      expect(d(pl.nonRecurring.ordinary)).toBe(15000 - 50200);
      expect(d(pl.recurring.ordinary)).toBe(128000 - (15000 - 50200));
      expect(d(pl.taxBasisProfit)).toBe(128000); // the split never changes the total
      expect(d(pl.months[2]!.nonRecurring.ordinary)).toBe(15000 - 4183.33);
      expect(d(pl.accounts.find((a) => a.accountId === R.revenue)!.nonRecurringBookAmount)).toBe(15000);
      expect(pl.trace.some((r) => r.label.includes('non-recurring'))).toBe(true);
    } finally {
      await putTreatments(scope, rivera.tenantId, rivera.companyId, [{ accountId: R.supplies, treatment: null, nonRecurring: false }]);
      await putTransactionFlags(scope, rivera.tenantId, rivera.companyId, { flags: [{ transactionId: marchRevenueTxn, nonRecurring: false }] });
    }
    const rows = await db.select().from(taxEstTransactionFlags).where(eq(taxEstTransactionFlags.tenantId, rivera.tenantId));
    expect(rows).toHaveLength(0);
  });
});

describe('W-2 wages (D8)', () => {
  it('sums w2_wages accounts; the per-year override wins when set', async () => {
    await putTreatments(scope, bakery.tenantId, bakery.companyId, [{ accountId: B.officer, treatment: 'w2_wages', nonRecurring: false }]);
    let pl = await getTaxBasisPl(scope, { ...bakery, taxYear: 2026, throughMonth: '2026-12' }, { skipCache: true });
    expect(pl.entityType).toBe('s_corp');
    expect(d(pl.w2Wages.booksYtd)).toBe(54000);
    expect(pl.w2Wages).toMatchObject({ source: 'books', override: null });
    expect(d(pl.w2Wages.effective)).toBe(54000);
    expect(d(pl.taxBasisProfit)).toBe(240000 - 54000); // wages stay deductible
    expect(d(pl.months[5]!.w2Wages)).toBe(4500);

    await upsertYearInputs(scope, bakery.tenantId, bakery.companyId, 2026, { w2WagesOverride: '60000', w2WagesOverrideReason: 'Payroll report incl. Dec bonus' });
    pl = await getTaxBasisPl(scope, { ...bakery, taxYear: 2026, throughMonth: '2026-12' }, { skipCache: true });
    expect(pl.w2Wages.source).toBe('override');
    expect(d(pl.w2Wages.effective)).toBe(60000);
    expect(d(pl.w2Wages.booksYtd)).toBe(54000);

    await upsertYearInputs(scope, bakery.tenantId, bakery.companyId, 2026, { w2WagesOverride: null });
    pl = await getTaxBasisPl(scope, { ...bakery, taxYear: 2026, throughMonth: '2026-12' }, { skipCache: true });
    expect(pl.w2Wages.source).toBe('books');
  });
});

describe('basis follows the effective tax method', () => {
  it('cash excludes the unpaid invoice; the accrual override includes it', async () => {
    const cash = await getTaxBasisPl(scope, { ...rivera, taxYear: 2026, throughMonth: '2026-12' }, { skipCache: true });
    expect(cash.basis).toBe('cash');
    expect(d(cash.bookNetIncome)).toBe(115400);
    await upsertEntitySettings(scope, rivera.tenantId, rivera.companyId, { taxMethod: 'accrual' });
    try {
      const accrual = await getTaxBasisPl(scope, { ...rivera, taxYear: 2026, throughMonth: '2026-12' }, { skipCache: true });
      expect(accrual.basis).toBe('accrual');
      expect(d(accrual.bookNetIncome)).toBe(120400);
      expect(d(accrual.taxBasisProfit)).toBe(133000);
    } finally {
      await db.delete(taxEstEntitySettings).where(and(
        eq(taxEstEntitySettings.tenantId, rivera.tenantId), eq(taxEstEntitySettings.companyId, rivera.companyId),
      ));
    }
  });
});

describe('cache (TB1/TB6 pattern)', () => {
  it('the key embeds the glVersionStamp and the config version', () => {
    const base = { tenantId: 't', companyId: 'c', taxYear: 2026, basis: 'cash' as const, throughMonth: '2026-09', glVersionStamp: 7, configVersion: 'abc' };
    expect(taxBasisCacheKey(base)).not.toBe(taxBasisCacheKey({ ...base, glVersionStamp: 8 }));
    expect(taxBasisCacheKey(base)).not.toBe(taxBasisCacheKey({ ...base, configVersion: 'abd' }));
    expect(taxBasisCacheKey(base)).not.toBe(taxBasisCacheKey({ ...base, basis: 'accrual' }));
  });

  it('a GL posting bumps the stamp, so the next read recomputes; a treatment change does too', async () => {
    const req = { ...bakery, taxYear: 2026, throughMonth: '2026-12' };
    let cached = false;
    let first = await getTaxBasisPl(scope, req);
    for (let i = 0; i < 5 && !cached; i++) {
      first = await getTaxBasisPl(scope, req);
      cached = first.cached;
    }
    expect(cached).toBe(true); // Redis at REDIS_URL (test redis 6390)

    const stampBefore = await getGlVersionStamp(bakery.tenantId, bakery.companyId);
    await post(bakery.tenantId, bakery.companyId, '2026-12-28', [[B.checking, 1000, 0], [B.sales, 0, 1000]]);
    const stampAfter = await getGlVersionStamp(bakery.tenantId, bakery.companyId);
    expect(stampAfter).toBeGreaterThan(stampBefore);
    const after = await getTaxBasisPl(scope, req);
    expect(after.cached).toBe(false);
    expect(after.glVersionStamp).toBe(stampAfter);
    expect(d(after.bookNetIncome)).toBe(d(first.bookNetIncome) + 1000);

    await putTreatments(scope, bakery.tenantId, bakery.companyId, [{ accountId: B.officer, treatment: null, nonRecurring: false }]);
    const afterTreatment = await getTaxBasisPl(scope, req);
    expect(afterTreatment.cached).toBe(false);
    expect(afterTreatment.configVersion).not.toBe(after.configVersion);
    expect(d(afterTreatment.w2Wages.booksYtd)).toBe(0);
    const rows = await db.select().from(taxEstAccountTreatments).where(eq(taxEstAccountTreatments.tenantId, bakery.tenantId));
    expect(rows).toHaveLength(0);
  });
});

describe('pure helpers', () => {
  it('character mapping from TB codes', () => {
    const code = (activityType: string, description: string) => ({ returnForm: '1065', activityType, code: 'x', description });
    expect(characterForCode(code('rental', 'Rent; L01 - Gross rents'), 'revenue')).toBe('rental');
    expect(characterForCode(code('farm_rental', 'FRent; L01 - Income'), 'revenue')).toBe('rental');
    expect(characterForCode(code('common', 'Sch K; L05 - Interest income'), 'other_revenue')).toBe('interest');
    expect(characterForCode(code('business', 'Sch C; L16b - Interest - other'), 'expense')).toBe('ordinary');
    expect(characterForCode(code('common', 'Sch K; L06a - Ordinary dividends'), 'other_revenue')).toBe('dividends_ordinary');
    expect(characterForCode(code('common', 'Sch K; L06b - Qualified dividends'), 'other_revenue')).toBe('dividends_qualified');
    expect(characterForCode(code('common', 'Sch D; L14 - Capital gain distributions'), 'other_revenue')).toBe('capital_gain_lt');
    expect(characterForCode(code('common', 'Sch D; L7 - Short-term capital gain'), 'other_revenue')).toBe('capital_gain_st');
    expect(characterForCode(code('common', 'Sch K; L13a - Capital gain property (20%)'), 'expense')).toBe('ordinary');
    expect(characterForCode(code('common', '4797; Section 1231 gain'), 'other_revenue')).toBe('section_1231');
    expect(characterForCode(code('common', 'R/E Wrk; var - Dividend distributions'), 'other_revenue')).toBe('ordinary');
  });

  it('windows: calendar year for individuals, fiscal year for C corps', () => {
    expect(taxYearWindow(2026, 'sch_c', 7)).toMatchObject({ start: '2026-01-01', end: '2026-12-31' });
    expect(taxYearWindow(2026, 'c_corp', 7)).toMatchObject({ start: '2025-07-01', end: '2026-06-30', startMonth: '2025-07', endMonth: '2026-06' });
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    const w = taxYearWindow(2026, 'sch_c', 1);
    expect(resolveThroughMonth(w, undefined, new Date('2026-10-11T00:00:00Z'))).toBe('2026-10');
    expect(resolveThroughMonth(w, undefined, new Date('2027-03-01T00:00:00Z'))).toBe('2026-12');
    expect(() => resolveThroughMonth(w, '2027-01')).toThrow(/through must be/);
  });
});
