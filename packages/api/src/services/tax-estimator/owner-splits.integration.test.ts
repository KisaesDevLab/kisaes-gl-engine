// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q50 — owner splits on person-target treatments (OPEN-QUESTIONS Q50). Kurt's screenshot:
// "6800 Salaries - Officers" (W-2 wages) offered every firm taxpayer. Now:
//   - pickers / saves are limited to owners linked to THIS business (visible to the caller);
//   - an account may be split by % or by fixed annual $ (remainder to the last owner);
//   - officer wages, the >2% shareholder health add-on, retirement, GPs and estimated-tax
//     payments land on each owner by their portion, traced per portion;
//   - single-owner rows compute exactly as before (the pre-Q50 tests are unchanged).
// Direct DB fixtures for the books (like pl-provider.r1.test.ts); the snapshot / engine part
// reuses the Rivera household seeded through the services.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountTreatmentInputSchema, engineEntityFromTaxBasisPl, type LinkDTO } from '@kis-books/shared';
import { db, pool } from '../../db/index.js';
import {
  taxEstAccountTreatments, taxEstAccountTreatmentSplits, taxEstLinks, taxEstPersons, taxEstTaxpayerStaff, taxEstTaxpayers,
} from '../../db/schema/index.js';
import { importSeed } from '../tb/tax-code-seed.service.js';
import { closeTbRedis } from '../tb/tb-redis.js';
import { UNRESTRICTED_VIEWER, type FirmScope } from './firm-scope.service.js';
import { getTaxBasisPl, loadConfigVersion, taxBasisCacheKey } from './pl-provider.service.js';
import { getReadiness } from './readiness.service.js';
import { listTreatments, putTreatments } from './treatments.service.js';
import { listOwnerCandidates } from './treatment-splits.service.js';
import { getPaymentLedger } from './payments.service.js';
import { upsertLink } from './taxpayers.service.js';
import { computeEstimateWithInputs } from './estimate.service.js';
import { seedRivera, type RiveraFixture } from './rivera.test-fixtures.js';
import { assign, mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');
const FIRM = '00000000-0000-0000-0000-0000000050a1';
const FIRM_OTHER = '00000000-0000-0000-0000-0000000050b1';
const STAFF_USER = '00000000-0000-0000-0000-0000000050c1';
const OTHER_USER = '00000000-0000-0000-0000-0000000050c2';
const OCT_13 = new Date('2026-10-13T12:00:00Z');
const MONTHLY_WAGES = '8470.02'; // × 12 = 101,640.24 (the screenshot account)

let tenant = '';
let S = '';
let scope: FirmScope;
const taxpayerIds: string[] = [];
let kurt = '';
let kurtTp = '';
let irene = '';
let ireneTp = '';
let ursula = '';
let ursulaTp = '';
const a = { chk: '', rev: '', wages: '', health: '', sep: '', est: '' };

async function mkPerson(displayName: string, first: string, last: string): Promise<{ personId: string; taxpayerId: string }> {
  const [tp] = await db.insert(taxEstTaxpayers).values({ firmId: FIRM, displayName }).returning();
  taxpayerIds.push(tp!.id);
  const [p] = await db.insert(taxEstPersons).values({
    taxpayerId: tp!.id, role: 'primary', firstName: first, lastName: last, sehiEligibleMonths: Array(12).fill(true),
  }).returning();
  return { personId: p!.id, taxpayerId: tp!.id };
}

const pl = (through = '2026-12', s: FirmScope = scope) =>
  getTaxBasisPl(s, { tenantId: tenant, companyId: S, taxYear: 2026, throughMonth: through }, { skipCache: true, today: OCT_13 });

beforeAll(async () => {
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  tenant = await mkTenant('TE Q50 split');
  scope = { firmId: FIRM, firmRole: 'firm_staff', allowedTenantIds: [tenant], viewer: UNRESTRICTED_VIEWER };
  ({ personId: kurt, taxpayerId: kurtTp } = await mkPerson('Kurt Krueger', 'Kurt', 'Krueger'));
  ({ personId: irene, taxpayerId: ireneTp } = await mkPerson('Jonathan & Irene', 'Irene', 'Smith'));
  ({ personId: ursula, taxpayerId: ursulaTp } = await mkPerson('Unlinked Ursula', 'Ursula', 'Nolink'));

  S = await mkCompany(tenant, 'Two Shareholders Inc', { accountingMethod: 'cash', entityType: 's_corp' });
  await setProfile(tenant, S, '1120S', 'business');
  a.chk = await mkAccount(tenant, S, '1010', 'Operating', 'asset', { detailType: 'checking' });
  a.rev = await mkAccount(tenant, S, '4000', 'Sales', 'revenue');
  a.wages = await mkAccount(tenant, S, '6800', 'Salaries - Officers', 'expense');
  a.health = await mkAccount(tenant, S, '6810', 'Officer health insurance', 'expense');
  a.sep = await mkAccount(tenant, S, '6820', 'Officer SEP', 'expense');
  a.est = await mkAccount(tenant, S, '3030', 'Shareholder estimated taxes', 'equity');
  await assign(tenant, S, a.rev, 'business', '100');
  for (let m = 1; m <= 12; m++) {
    const dt = `2026-${String(m).padStart(2, '0')}-10`;
    await post(tenant, S, dt, [[a.chk, 30000, 0], [a.rev, 0, 30000]]);
    await post(tenant, S, dt, [[a.wages, MONTHLY_WAGES, 0], [a.chk, 0, MONTHLY_WAGES]]);
    await post(tenant, S, dt, [[a.health, 1000, 0], [a.chk, 0, 1000]]);
  }
  await post(tenant, S, '2026-12-15', [[a.sep, 9000, 0], [a.chk, 0, 9000]]);
  await post(tenant, S, '2026-04-15', [[a.est, '10000.01', 0], [a.chk, 0, '10000.01']]);
  await post(tenant, S, '2026-06-15', [[a.est, 5000, 0], [a.chk, 0, 5000]]);
  // Kurt 60% / Irene 40% shareholders; Ursula is a firm taxpayer NOT linked to this business.
  await db.insert(taxEstLinks).values([
    { taxpayerId: kurtTp, personId: kurt, taxYear: 2026, tenantId: tenant, companyId: S, profitPct: '60', isOfficer: true },
    { taxpayerId: ireneTp, personId: irene, taxYear: 2026, tenantId: tenant, companyId: S, profitPct: '40', isOfficer: true },
  ]);
}, 120_000);

afterAll(async () => {
  await purgeTenants([tenant]);
  if (taxpayerIds.length > 0) {
    await db.delete(taxEstTaxpayerStaff).where(inArray(taxEstTaxpayerStaff.taxpayerId, taxpayerIds));
    await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.id, taxpayerIds));
  }
  await closeTbRedis();
  await pool.end();
});

describe('Q50 (1) — owner candidates: owners linked to THIS business only', () => {
  it('lists the linked persons with their profit % and the default split; an unlinked taxpayer never appears', async () => {
    const r = await listOwnerCandidates(scope, tenant, S, 2026);
    expect(r.taxYear).toBe(2026);
    expect(r.candidates.map((c) => [c.personId, c.profitPct, c.defaultPct, c.years])).toEqual([
      [irene, '40.0000', '40', [2026]],
      [kurt, '60.0000', '60', [2026]],
    ]);
    expect(r.candidates.find((c) => c.personId === ursula)).toBeUndefined();
    expect(r.candidates[0]).toMatchObject({ taxpayerId: ireneTp, taxpayerName: 'Jonathan & Irene', firstName: 'Irene', isOfficer: true });
  });

  it('cross-firm / out-of-scope tenant → 404 before any query', async () => {
    const other: FirmScope = { firmId: FIRM_OTHER, firmRole: 'firm_admin', allowedTenantIds: [], viewer: UNRESTRICTED_VIEWER };
    await expect(listOwnerCandidates(other, tenant, S)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('D17 / D18: a taxpayer whose staff list leaves the caller out is not offered (nor accepted)', async () => {
    await db.insert(taxEstTaxpayerStaff).values({ firmId: FIRM, taxpayerId: ireneTp, userId: OTHER_USER });
    try {
      const staff: FirmScope = {
        firmId: FIRM, firmRole: 'firm_staff', allowedTenantIds: [tenant],
        viewer: { userId: STAFF_USER, bypass: false, restrictToLinkedTenants: true },
      };
      const r = await listOwnerCandidates(staff, tenant, S, 2026);
      expect(r.candidates.map((c) => c.personId)).toEqual([kurt]);
      // Only one visible owner → the default is 100%.
      expect(r.candidates[0]!.defaultPct).toBe('100');
      await expect(putTreatments(staff, tenant, S, [{ accountId: a.wages, treatment: 'w2_wages', paymentPersonId: irene, nonRecurring: false }]))
        .rejects.toMatchObject({ statusCode: 422, code: 'TE_TARGET_NOT_LINKED' });
    } finally {
      await db.delete(taxEstTaxpayerStaff).where(eq(taxEstTaxpayerStaff.taxpayerId, ireneTp));
    }
  });
});

describe('Q50 — validation', () => {
  it('a person not linked to the business → 422 TE_TARGET_NOT_LINKED (single target and split row)', async () => {
    await expect(putTreatments(scope, tenant, S, [{ accountId: a.wages, treatment: 'w2_wages', paymentPersonId: ursula, nonRecurring: false }]))
      .rejects.toMatchObject({ statusCode: 422, code: 'TE_TARGET_NOT_LINKED' });
    await expect(putTreatments(scope, tenant, S, [{
      accountId: a.wages, treatment: 'w2_wages', nonRecurring: false, splitMode: 'pct',
      splits: [{ personId: kurt, pct: '50' }, { personId: ursula, pct: '50' }],
    }])).rejects.toMatchObject({ statusCode: 422, code: 'TE_TARGET_NOT_LINKED' });
  });

  it('a payment account credited to an unlinked taxpayer → 422', async () => {
    await expect(putTreatments(scope, tenant, S, [{
      accountId: a.est, treatment: 'estimated_tax_payment', paymentTaxpayerId: ursulaTp, paymentJurisdiction: 'federal', nonRecurring: false,
    }])).rejects.toMatchObject({ statusCode: 422, code: 'TE_TARGET_NOT_LINKED' });
  });

  it('pcts that do not total exactly 100 → 400 TE_SPLIT_PCT_TOTAL; a repeated owner → 400 TE_SPLIT_DUPLICATE_TARGET', async () => {
    await expect(putTreatments(scope, tenant, S, [{
      accountId: a.wages, treatment: 'w2_wages', nonRecurring: false, splits: [{ personId: kurt, pct: '60' }, { personId: irene, pct: '30' }],
    }])).rejects.toMatchObject({ statusCode: 400, code: 'TE_SPLIT_PCT_TOTAL' });
    // Exactly 100 — no float tolerance.
    await expect(putTreatments(scope, tenant, S, [{
      accountId: a.wages, treatment: 'w2_wages', nonRecurring: false, splits: [{ personId: kurt, pct: '60.000001' }, { personId: irene, pct: '40' }],
    }])).rejects.toMatchObject({ statusCode: 400, code: 'TE_SPLIT_PCT_TOTAL' });
    await expect(putTreatments(scope, tenant, S, [{
      accountId: a.wages, treatment: 'w2_wages', nonRecurring: false, splits: [{ personId: kurt, pct: '50' }, { personId: kurt, pct: '50' }],
    }])).rejects.toMatchObject({ statusCode: 400, code: 'TE_SPLIT_DUPLICATE_TARGET' });
  });

  it('schema: splits only on person-target treatments, never with a single target; row shape per mode', () => {
    const base = { accountId: a.wages, nonRecurring: false };
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'owner_personal', splits: [{ personId: kurt, pct: '100' }] }).success).toBe(false);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'w2_wages', paymentPersonId: kurt, splits: [{ personId: kurt, pct: '100' }] }).success).toBe(false);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'w2_wages', splitMode: 'amount', splits: [{ personId: kurt, pct: '100' }] }).success).toBe(false);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'w2_wages', splitMode: 'amount', splits: [{ personId: kurt, amount: '5', taxYear: 2026 }] }).success).toBe(true);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'estimated_tax_payment', splits: [{ personId: kurt, pct: '100' }] }).success).toBe(false);
  });

  it('a lone 100% row is stored as the single target (no split rows)', async () => {
    const list = await putTreatments(scope, tenant, S, [{ accountId: a.sep, treatment: 'owner_retirement', nonRecurring: false, splits: [{ personId: kurt, pct: '100' }] }]);
    const row = list.items.find((x) => x.accountId === a.sep)!;
    expect(row).toMatchObject({ paymentPersonId: kurt, splitMode: 'pct', splits: [] });
    const p = await pl();
    expect(p.accounts.find((x) => x.accountId === a.sep)!.splits).toBeUndefined();
    expect(p.ownerLevel.byPerson.find((x) => x.personId === kurt)).toMatchObject({ employerRetirement: '9000.0000' });
  });
});

describe('Q50 (3)(4) — % split: officer wages + >2% shareholder health across two shareholders', () => {
  it('per-person W-2 box 1, SEHI and officer wages; entity totals unchanged; traced per portion', async () => {
    // Single target first (today's data): the entity figures to compare against.
    await putTreatments(scope, tenant, S, [
      { accountId: a.wages, treatment: 'w2_wages', paymentPersonId: kurt, nonRecurring: false },
      { accountId: a.health, treatment: 'owner_sehi', paymentPersonId: kurt, nonRecurring: false },
    ]);
    const single = await pl();
    const list = await putTreatments(scope, tenant, S, [
      { accountId: a.wages, treatment: 'w2_wages', nonRecurring: false, splitMode: 'pct', splits: [{ personId: kurt, pct: '60' }, { personId: irene, pct: '40' }] },
      { accountId: a.health, treatment: 'owner_sehi', nonRecurring: false, splitMode: 'pct', splits: [{ personId: kurt, pct: '60' }, { personId: irene, pct: '40' }] },
    ]);
    const wagesRow = list.items.find((x) => x.accountId === a.wages)!;
    expect(wagesRow).toMatchObject({ paymentPersonId: kurt, paymentTaxpayerId: kurtTp, splitMode: 'pct' });
    expect(wagesRow.splits!.map((x) => [x.personId, x.taxpayerId, x.pct])).toEqual([[kurt, kurtTp, '60.000000'], [irene, ireneTp, '40.000000']]);

    const r = await pl();
    // Entity level: identical to the single-target run.
    for (const k of ['taxBasisProfit', 'bookNetIncome'] as const) expect(r[k]).toBe(single[k]);
    expect(r.ownerLevel.sehiAsW2Wages).toBe(single.ownerLevel.sehiAsW2Wages);
    expect(r.ownerLevel.ownerSehi).toBe('12000.0000');
    expect(r.w2Wages.ytd).toBe('101640.2400');
    expect(r.months.map((m) => m.w2Wages)).toEqual(single.months.map((m) => m.w2Wages));
    // Per person: 8,470.02 × 60% = 5,082.012 a month.
    expect(r.w2Wages.byPerson).toEqual([
      { personId: irene, ytd: '40656.0960' },
      { personId: kurt, ytd: '60984.1440' },
    ].sort((x, y) => x.personId.localeCompare(y.personId)));
    const by = new Map(r.ownerLevel.byPerson.map((p) => [p.personId, p]));
    expect(by.get(kurt)).toMatchObject({ ownerSehi: '7200.0000', sehiAsW2Wages: '7200.0000', employerRetirement: '9000.0000' });
    expect(by.get(irene)).toMatchObject({ ownerSehi: '4800.0000', sehiAsW2Wages: '4800.0000', employerRetirement: '0.0000' });
    expect(r.accounts.find((x) => x.accountId === a.wages)!.splits).toEqual([
      { personId: kurt, taxpayerId: kurtTp, pct: '60.000000', amount: null, allocated: '60984.1440' },
      { personId: irene, taxpayerId: ireneTp, pct: '40.000000', amount: null, allocated: '40656.0960' },
    ]);
    // Trace: one row per portion, with the caller-visible name.
    const wageRow = r.trace.find((t) => t.label === '6800 Salaries - Officers 101,640.24 × 60% → Kurt Krueger');
    expect(wageRow).toMatchObject({ amount: '60984.1440', source: 'gl_map' });
    expect(r.trace.some((t) => t.label === '6810 Officer health insurance 12,000.00 × 40% → Irene Smith')).toBe(true);
    expect(by.get(irene)!.trace.map((t) => t.label)).toEqual(['6810 Officer health insurance 12,000.00 × 40% → Irene Smith']);
    expect(JSON.stringify(r)).not.toContain('{{person:');

    // SS / Medicare: the engine gets officer wages (SS wages) and the health add-on (box 1 only) separately.
    const engine = engineEntityFromTaxBasisPl(r, [], { isSstb: false, rentalQbiTradeOrBusiness: false });
    expect(new Map(engine.officerWages.map((w) => [w.personId, w.amount]))).toEqual(new Map([[kurt, '60984.1440'], [irene, '40656.0960']]));
    expect(new Map(engine.ownerItems.map((o) => [o.personId, o.sehiAsW2Wages]))).toEqual(new Map([[kurt, '7200.0000'], [irene, '4800.0000']]));
  });

  it('a caller who cannot see a shareholder gets a neutral label, never the name', async () => {
    await db.insert(taxEstTaxpayerStaff).values({ firmId: FIRM, taxpayerId: ireneTp, userId: OTHER_USER });
    try {
      const staff: FirmScope = {
        firmId: FIRM, firmRole: 'firm_readonly', allowedTenantIds: [tenant],
        viewer: { userId: STAFF_USER, bypass: false, restrictToLinkedTenants: true },
      };
      const r = await pl('2026-12', staff);
      expect(r.trace.some((t) => t.label === '6800 Salaries - Officers 101,640.24 × 40% → an owner')).toBe(true);
      expect(JSON.stringify(r.trace)).not.toContain('Irene');
    } finally {
      await db.delete(taxEstTaxpayerStaff).where(eq(taxEstTaxpayerStaff.taxpayerId, ireneTp));
    }
  });

  it('a split edit re-keys the provider cache (config version), even when only a split row changes', async () => {
    const before = await loadConfigVersion(tenant, S, 2026);
    await db.execute(sql`UPDATE tax_est_account_treatment_splits SET pct = 59 WHERE person_id = ${kurt}::uuid AND tenant_id = ${tenant}::uuid AND company_id = ${S}::uuid AND sort_order = 0 AND pct = 60 AND treatment_id = (SELECT id FROM tax_est_account_treatments WHERE account_id = ${a.health}::uuid)`);
    const after = await loadConfigVersion(tenant, S, 2026);
    expect(after).not.toBe(before);
    const key = (v: string) => taxBasisCacheKey({ tenantId: tenant, companyId: S, taxYear: 2026, basis: 'cash', throughMonth: '2026-12', glVersionStamp: 1, configVersion: v });
    expect(key(after)).not.toBe(key(before));
    expect(key(after)).toMatch(/^te:pl:v6:/);
    await db.execute(sql`UPDATE tax_est_account_treatment_splits SET pct = 60 WHERE person_id = ${kurt}::uuid AND pct = 59 AND tenant_id = ${tenant}::uuid`);
  });

  it('treatment audits carry the splits before / after', async () => {
    const rows = await db.execute<{ before_data: unknown; after_data: unknown }>(sql`SELECT before_data, after_data FROM audit_log
      WHERE tenant_id = ${tenant}::uuid AND entity_type = 'tax_est_treatment' ORDER BY created_at DESC LIMIT 5`);
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as { splits?: Array<{ personId: string }>; firmId?: string };
    const afters = (rows.rows as Array<{ after_data: unknown }>).map((x) => parse(x.after_data));
    const split = afters.find((x) => (x.splits ?? []).length === 2)!;
    expect(split.splits!.map((x) => x.personId)).toEqual([kurt, irene]);
    expect(split.firmId).toBe(FIRM);
  });
});

describe('Q50 (3) — fixed annual $ split: remainder to the LAST owner', () => {
  it('complete year: Kurt gets his 60,000, Irene the remainder 41,640.24, warned TE_SPLIT_REMAINDER', async () => {
    await putTreatments(scope, tenant, S, [{
      accountId: a.wages, treatment: 'w2_wages', nonRecurring: false, splitMode: 'amount',
      splits: [{ personId: kurt, amount: '60000', taxYear: 2026 }, { personId: irene, amount: '30000', taxYear: 2026 }],
    }]);
    const r = await pl('2026-12');
    expect(new Map(r.w2Wages.byPerson.map((w) => [w.personId, w.ytd]))).toEqual(new Map([[kurt, '60000.0000'], [irene, '41640.2400']]));
    expect(r.w2Wages.ytd).toBe('101640.2400');
    const w = r.warnings.find((x) => x.code === 'TE_SPLIT_REMAINDER')!;
    expect(w.severity).toBe('warning');
    expect((w.details as { accounts: unknown[] }).accounts).toEqual([expect.objectContaining({
      accountId: a.wages, fixedTotal: '90000.0000', booksYear: '101640.2400', remainder: '11640.2400', lastPersonId: irene,
      yearComplete: true, applied: 'remainder_to_last',
    })]);
    expect(r.trace.some((t) => t.label === '6800 Salaries - Officers 101,640.24 fixed annual 60,000.00 → Kurt Krueger')).toBe(true);
    expect(r.trace.some((t) => t.label === '6800 Salaries - Officers 101,640.24 remainder (books 101,640.24 − fixed 60,000.00) → Irene Smith')).toBe(true);
    const ready = await getReadiness(scope, { tenantId: tenant, companyId: S, taxYear: 2026, throughMonth: '2026-12' }, { today: OCT_13 });
    expect(ready.warnings.some((x) => x.code === 'TE_SPLIT_REMAINDER')).toBe(true);
  });

  it('partial year: YTD shared in proportion to the fixed amounts (2 : 1), the projected difference warned', async () => {
    const r = await pl('2026-06');
    // 6 × 8,470.02 = 50,820.12 → 33,880.08 / 16,940.04
    expect(new Map(r.w2Wages.byPerson.map((w) => [w.personId, w.ytd]))).toEqual(new Map([[kurt, '33880.0800'], [irene, '16940.0400']]));
    const w = r.warnings.find((x) => x.code === 'TE_SPLIT_REMAINDER')!;
    expect((w.details as { accounts: unknown[] }).accounts).toEqual([expect.objectContaining({ yearComplete: false, applied: 'proportional_ytd', booksYear: '101640.2400' })]);
  });

  it('no amounts for the year → the ratios of another year, info TE_SPLIT_AMOUNT_YEAR_MISSING', async () => {
    await putTreatments(scope, tenant, S, [{
      accountId: a.wages, treatment: 'w2_wages', nonRecurring: false, splitMode: 'amount',
      splits: [{ personId: kurt, amount: '30000', taxYear: 2025 }, { personId: irene, amount: '10000', taxYear: 2025 }],
    }]);
    const r = await pl('2026-06');
    expect(new Map(r.w2Wages.byPerson.map((w) => [w.personId, w.ytd]))).toEqual(new Map([[kurt, '38115.0900'], [irene, '12705.0300']]));
    expect(r.warnings.find((x) => x.code === 'TE_SPLIT_AMOUNT_YEAR_MISSING')).toMatchObject({
      severity: 'info', details: { accounts: [{ accountId: a.wages, usedYear: 2025 }] },
    });
  });
});

describe('Q50 (2)(4) — estimated-tax payments split between taxpayers', () => {
  it('each portion is its own payment row of the same transaction, and lands in each taxpayer ledger', async () => {
    await putTreatments(scope, tenant, S, [{
      accountId: a.est, treatment: 'estimated_tax_payment', paymentJurisdiction: 'federal', nonRecurring: false, splitMode: 'pct',
      splits: [{ taxpayerId: kurtTp, personId: kurt, pct: '70' }, { taxpayerId: ireneTp, pct: '30' }],
    }]);
    const r = await pl();
    const rows = r.estimatedPayments.map((p) => [p.date, p.taxpayerId, p.amount]);
    // 10,000.01 × 70% = 7,000.007 → 7,000.0070; the last row takes the residual.
    expect(rows).toEqual([
      ['2026-04-15', kurtTp, '7000.0070'], ['2026-04-15', ireneTp, '3000.0030'],
      ['2026-06-15', kurtTp, '3500.0000'], ['2026-06-15', ireneTp, '1500.0000'],
    ]);
    expect(new Set(r.estimatedPayments.slice(0, 2).map((p) => p.transactionId)).size).toBe(1);
    expect(r.trace.some((t) => t.label.startsWith('Shareholder estimated taxes: estimated tax payments 15,000.01 × 30% → Jonathan & Irene'))).toBe(true);

    const ledgerOf = async (tp: string) => {
      const link = { tenantId: tenant, companyId: S, companyName: 'Two Shareholders Inc', outOfScope: false } as unknown as LinkDTO;
      const lg = await getPaymentLedger(scope, tp, 2026, null, { links: [link] });
      return lg.payments.map((p) => [p.date, p.amount, p.transactionId != null]);
    };
    expect(await ledgerOf(kurtTp)).toEqual([['2026-04-15', '7000.0070', true], ['2026-06-15', '3500.0000', true]]);
    expect(await ledgerOf(ireneTp)).toEqual([['2026-04-15', '3000.0030', true], ['2026-06-15', '1500.0000', true]]);
  });
});

describe('Q50 — existing rows that name an unlinked owner keep computing, warned', () => {
  it('TE_TARGET_NOT_LINKED on the estimate input and readiness; the amount still reaches the person', async () => {
    // A pre-Q50 row (written directly: the API would refuse it now).
    await db.update(taxEstAccountTreatments).set({ paymentPersonId: ursula, paymentTaxpayerId: ursulaTp, updatedAt: new Date() })
      .where(and(eq(taxEstAccountTreatments.tenantId, tenant), eq(taxEstAccountTreatments.accountId, a.sep)));
    const r = await pl();
    expect(r.ownerLevel.byPerson.find((p) => p.personId === ursula)).toMatchObject({ employerRetirement: '9000.0000' });
    const w = r.warnings.find((x) => x.code === 'TE_TARGET_NOT_LINKED')!;
    expect(w.severity).toBe('warning');
    expect((w.details as { targets: unknown[] }).targets).toEqual([{ accountId: a.sep, treatment: 'owner_retirement', personId: ursula, taxpayerId: ursulaTp }]);
    const ready = await getReadiness(scope, { tenantId: tenant, companyId: S, taxYear: 2026, throughMonth: '2026-12' }, { today: OCT_13 });
    expect(ready.warnings.some((x) => x.code === 'TE_TARGET_NOT_LINKED')).toBe(true);
    // Re-saving the row unchanged (e.g. toggling non-recurring) is allowed: the stored target is kept.
    await putTreatments(scope, tenant, S, [{ accountId: a.sep, treatment: 'owner_retirement', paymentPersonId: ursula, nonRecurring: true }]);
    await putTreatments(scope, tenant, S, [{ accountId: a.sep, treatment: 'owner_retirement', paymentPersonId: kurt, nonRecurring: false }]);
  });

  it('deleting the treatment removes its split rows (cascade)', async () => {
    await putTreatments(scope, tenant, S, [{ accountId: a.health, treatment: null, nonRecurring: false }]);
    const left = await db.select().from(taxEstAccountTreatmentSplits).where(and(eq(taxEstAccountTreatmentSplits.tenantId, tenant)));
    const list = await listTreatments(scope, tenant, S, { limit: 50, offset: 0 });
    expect(list.items.find((x) => x.accountId === a.health)).toBeUndefined();
    const treated = new Set(list.items.map((x) => x.id));
    expect(left.every((x) => treated.has(x.treatmentId))).toBe(true);
  });
});

describe('Q50 — estimate end to end (Rivera): officer wages split between spouses; snapshots freeze the splits', () => {
  let fx: RiveraFixture;
  const FIRM_A = '00000000-0000-0000-0000-0000000050d1';
  const FIRM_B = '00000000-0000-0000-0000-0000000050d2';
  const USER = '00000000-0000-0000-0000-0000000050d3';

  beforeAll(async () => {
    fx = await seedRivera(FIRM_A, FIRM_B, USER);
  }, 240_000);

  afterAll(async () => {
    if (fx) {
      await purgeTenants(Object.values(fx.T));
      await db.delete(taxEstTaxpayers).where(eq(taxEstTaxpayers.firmId, FIRM_A));
    }
  });

  it('per-person W-2 box 1 and Social Security wages follow the split; SEHI is box 1 only', async () => {
    const { T, C, scopeA, actor, taxpayerId, baseScenarioId, carlosId, mariaId } = fx;
    // Carlos becomes a 50% shareholder too; the officer health account is added to the S corp books.
    await upsertLink(scopeA, actor, taxpayerId, { personRole: 'primary', taxYear: 2026, tenantId: T.scorp, companyId: C.scorp, profitPct: 50, lossPct: 50, isOfficer: true, activityType: 'active', activeParticipation: false });
    const chk = (await db.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE tenant_id = ${T.scorp}::uuid AND account_number = '1010'`)).rows[0]!.id;
    const officer = (await db.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE tenant_id = ${T.scorp}::uuid AND account_number = '6010'`)).rows[0]!.id;
    const health = await mkAccount(T.scorp, C.scorp, '6020', 'Shareholder health insurance', 'expense');
    for (let m = 1; m <= 12; m++) await post(T.scorp, C.scorp, `2026-${String(m).padStart(2, '0')}-12`, [[health, 500, 0], [chk, 0, 500]]);
    await putTreatments(scopeA, T.scorp, C.scorp, [
      { accountId: officer, treatment: 'w2_wages', nonRecurring: false, splitMode: 'pct', splits: [{ personId: mariaId, pct: '75' }, { personId: carlosId, pct: '25' }] },
      { accountId: health, treatment: 'owner_sehi', nonRecurring: false, splitMode: 'pct', splits: [{ personId: mariaId, pct: '50' }, { personId: carlosId, pct: '50' }] },
    ]);
    const { result, inputs } = await computeEstimateWithInputs(scopeA, { taxpayerId, taxYear: 2026, scenarioId: baseScenarioId, throughMonth: '2026-12', refresh: true }, { today: OCT_13, skipProviderCache: true });
    const person = (id: string) => result.federal.persons.find((p) => p.personId === id)!;
    // 54,000 officer wages: Maria 40,500 + 3,000 health; Carlos 13,500 + 3,000 health.
    expect(person(mariaId).exact.socialSecurityWages).toBe('40500');
    expect(person(carlosId).exact.socialSecurityWages).toBe('13500');
    expect(person(mariaId).totalWages).toBe('43500');
    expect(person(carlosId).totalWages).toBe('16500');
    // Snapshots freeze the splits as read.
    const sc = inputs.companies.find((c) => c.companyId === C.scorp)!;
    expect(sc.ownerSplits).toHaveLength(2);
    expect(sc.ownerSplits).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: officer, treatment: 'w2_wages', splitMode: 'pct', splits: [expect.objectContaining({ personId: mariaId, pct: '75.000000' }), expect.objectContaining({ personId: carlosId, pct: '25.000000' })] }),
      expect.objectContaining({ accountId: health, treatment: 'owner_sehi' }),
    ]));
    expect(inputs.companies.find((c) => c.companyId === C.schc)!.ownerSplits).toBeUndefined();
  });
});
