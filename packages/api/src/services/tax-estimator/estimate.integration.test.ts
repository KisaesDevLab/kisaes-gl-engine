// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10b acceptance: the Rivera household seeded THROUGH THE SERVICES into
// kisbooks_test (three linked companies in three tenants, D1) must produce the oracle
// (features/tax-estimator/docs/reference-calc/rivera_expected.json) end to end:
// books → P&L provider → bridge → computeFederal / computeState → payment ledger
// (GL + manual, attribution window (prior Q4 cutoff, Q4 cutoff], dedupe) → computeFederalEstimates /
// computeStateEstimates. Plus D1 isolation: another firm gets 404 and never sees this
// firm's data; a tenant that leaves the scope drops out of the next estimate with a warning.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import { taxEstTaxpayers } from '../../db/schema/index.js';
import { importSeed } from '../tb/tax-code-seed.service.js';
import { closeTbRedis } from '../tb/tb-redis.js';
import { UNRESTRICTED_VIEWER, type FirmScope } from './firm-scope.service.js';
import { syncShippedSeeds } from './tax-parameters.service.js';
import { syncShippedStateRules } from './tax-state-rules.service.js';
import { createTaxpayer, upsertPerson, upsertLink } from './taxpayers.service.js';
import { putTreatments } from './treatments.service.js';
import { upsertYear } from './years.service.js';
import { createAdjustment } from './adjustments.service.js';
import { listAdjustmentTypes } from './adjustment-types.service.js';
import { replaceStateRows, listStateRows } from './state-rows.service.js';
import { createPayment, getPaymentLedger } from './payments.service.js';
import { computeEstimate, getEstimateReadiness } from './estimate.service.js';
import { captureSnapshots, listSnapshots } from './sch-ai-snapshots.service.js';
import { assign, mkAccount, mkCompany, mkTenant, post, purgeTenants, setProfile } from './entities.test-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_FILE_PATH = join(here, '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');
const expected = JSON.parse(readFileSync(join(here, '..', '..', '..', '..', '..', 'features', 'tax-estimator', 'docs', 'reference-calc', 'rivera_expected.json'), 'utf8')) as Record<string, Record<string, unknown>>;
const BASE = expected['base']!;
const SH = expected['safe_harbor']!;
const MO = expected['missouri']!;

const FIRM_A = '00000000-0000-0000-0000-00000000a10b';
const FIRM_B = '00000000-0000-0000-0000-00000000b10b';
const T = { schc: '', scorp: '', lp: '', other: '', farm: '', cc: '' };
const C = { schc: '', scorp: '', lp: '', other: '', farm: '', cc: '' };
let scopeA: FirmScope;
let scopeB: FirmScope;
let actor = { tenantId: '', userId: '00000000-0000-0000-0000-0000000000a1' };
let taxpayerId = '';
let baseScenarioId = '';
let carlosId = '';
let mariaId = '';
let q1Txn = '';
let decPriorTxn = '';
let janQ4Txn = '';
const TODAY = new Date('2026-10-12T12:00:00Z');

// Rivera Plumbing books (the Phase 4 fixture): 115,400 book → 128,000 tax basis.
const SUPPLIES = ['4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.33', '4183.36', '4183.33', '4183.33', '4183.34'];
const mm = (m: number) => String(m).padStart(2, '0');

beforeAll(async () => {
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  await syncShippedSeeds();
  await syncShippedStateRules();

  // ── tenant 1: Rivera Plumbing LLC (Sch C, cash) ──
  T.schc = await mkTenant('TE10 Rivera Plumbing');
  C.schc = await mkCompany(T.schc, 'Rivera Plumbing LLC', { accountingMethod: 'cash', entityType: 'single_member_llc' });
  await setProfile(T.schc, C.schc, '1040', 'business');
  const r = {
    checking: await mkAccount(T.schc, C.schc, '1010', 'Checking', 'asset', { detailType: 'checking' }),
    draws: await mkAccount(T.schc, C.schc, '3020', 'Owner Draws', 'equity', { detailType: 'owners_draw' }),
    revenue: await mkAccount(T.schc, C.schc, '4000', 'Plumbing Revenue', 'revenue'),
    supplies: await mkAccount(T.schc, C.schc, '6100', 'Supplies', 'expense'),
    health: await mkAccount(T.schc, C.schc, '6200', 'Owner Health Insurance', 'expense'),
    meals: await mkAccount(T.schc, C.schc, '6420', 'Meals', 'expense'),
  };
  await assign(T.schc, C.schc, r.revenue, 'business', '801');
  await assign(T.schc, C.schc, r.supplies, 'business', '822');
  for (let m = 1; m <= 12; m++) {
    const d = `2026-${mm(m)}-15`;
    await post(T.schc, C.schc, d, [[r.checking, 15000, 0], [r.revenue, 0, 15000]]);
    await post(T.schc, C.schc, d, [[r.health, 900, 0], [r.checking, 0, 900]]);
    await post(T.schc, C.schc, d, [[r.meals, 300, 0], [r.checking, 0, 300]]);
    await post(T.schc, C.schc, d, [[r.supplies, SUPPLIES[m - 1]!, 0], [r.checking, 0, SUPPLIES[m - 1]!]]);
  }
  // Federal estimates paid from the owner's draw account (oracle dates and amounts),
  // a December 2025 payment (prior year, outside the window) and the Q4 payment on Jan 15, 2027.
  q1Txn = await post(T.schc, C.schc, '2026-04-15', [[r.draws, 6600, 0], [r.checking, 0, 6600]]);
  await post(T.schc, C.schc, '2026-06-15', [[r.draws, 6600, 0], [r.checking, 0, 6600]]);
  await post(T.schc, C.schc, '2026-09-15', [[r.draws, 6000, 0], [r.checking, 0, 6000]]);
  decPriorTxn = await post(T.schc, C.schc, '2025-12-20', [[r.draws, 5000, 0], [r.checking, 0, 5000]]);
  janQ4Txn = await post(T.schc, C.schc, '2027-01-15', [[r.draws, '7046.10', 0], [r.checking, 0, '7046.10']]);

  // ── tenant 2: Maria Designs Inc (1120S): 138,000 − officer 54,000 − rent 4,000 = 80,000 ──
  T.scorp = await mkTenant('TE10 Maria Designs');
  C.scorp = await mkCompany(T.scorp, 'Maria Designs Inc', { accountingMethod: 'accrual', entityType: 's_corp' });
  await setProfile(T.scorp, C.scorp, '1120S', 'business');
  const s = {
    checking: await mkAccount(T.scorp, C.scorp, '1010', 'Operating', 'asset', { detailType: 'checking' }),
    sales: await mkAccount(T.scorp, C.scorp, '4000', 'Design Fees', 'revenue'),
    officer: await mkAccount(T.scorp, C.scorp, '6010', 'Officer Compensation', 'expense'),
    rent: await mkAccount(T.scorp, C.scorp, '6300', 'Rent', 'expense'),
  };
  await assign(T.scorp, C.scorp, s.sales, 'business', '100');
  await assign(T.scorp, C.scorp, s.officer, 'business', '200');
  for (let m = 1; m <= 12; m++) {
    const d = `2026-${mm(m)}-10`;
    const rent = m === 12 ? '333.37' : '333.33';
    await post(T.scorp, C.scorp, d, [[s.checking, 11500, 0], [s.sales, 0, 11500]]);
    await post(T.scorp, C.scorp, d, [[s.officer, 4500, 0], [s.checking, 0, 4500]]);
    await post(T.scorp, C.scorp, d, [[s.rent, rent, 0], [s.checking, 0, rent]]);
  }

  // ── tenant 3: Oak Street Rentals LP (1065 rental): 8,000 net rent ──
  T.lp = await mkTenant('TE10 Oak Street');
  C.lp = await mkCompany(T.lp, 'Oak Street Rentals LP', { accountingMethod: 'cash', entityType: 'partnership' });
  await setProfile(T.lp, C.lp, '1065', 'rental');
  const l = {
    checking: await mkAccount(T.lp, C.lp, '1010', 'Checking', 'asset', { detailType: 'checking' }),
    rents: await mkAccount(T.lp, C.lp, '4100', 'Gross Rents', 'revenue'),
  };
  await assign(T.lp, C.lp, l.rents, 'rental', '502');
  for (let m = 1; m <= 12; m++) {
    const amt = m === 12 ? '666.63' : '666.67';
    await post(T.lp, C.lp, `2026-${mm(m)}-01`, [[l.checking, amt, 0], [l.rents, 0, amt]]);
  }

  // ── tenant 4: another firm's client ──
  T.other = await mkTenant('TE10 Other Firm Client');
  C.other = await mkCompany(T.other, 'Other Firm Co', { accountingMethod: 'cash', entityType: 'sole_prop' });

  scopeA = { firmId: FIRM_A, firmRole: 'firm_staff', allowedTenantIds: [T.schc, T.scorp, T.lp], viewer: UNRESTRICTED_VIEWER };
  scopeB = { firmId: FIRM_B, firmRole: 'firm_staff', allowedTenantIds: [T.other, T.schc], viewer: UNRESTRICTED_VIEWER };
  actor = { tenantId: T.schc, userId: actor.userId };

  // ── taxpayer setup through the services ──
  const tp = await createTaxpayer(scopeA, actor, { displayName: 'Carlos & Maria Rivera', filingStatus: 'mfj', residentState: 'MO' });
  taxpayerId = tp.id;
  carlosId = (await upsertPerson(scopeA, actor, taxpayerId, 'primary', { firstName: 'Carlos', lastName: 'Rivera', dateOfBirth: '1981-05-10', isBlind: false })).id;
  mariaId = (await upsertPerson(scopeA, actor, taxpayerId, 'spouse', { firstName: 'Maria', lastName: 'Rivera', dateOfBirth: '1983-09-22', isBlind: false })).id;
  const link = (input: Parameters<typeof upsertLink>[3]) => upsertLink(scopeA, actor, taxpayerId, input);
  await link({ personRole: 'primary', taxYear: 2026, tenantId: T.schc, companyId: C.schc, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
  await link({ personRole: 'spouse', taxYear: 2026, tenantId: T.scorp, companyId: C.scorp, profitPct: 50, lossPct: 50, isOfficer: true, activityType: 'active', activeParticipation: false });
  await link({ personRole: 'primary', taxYear: 2026, tenantId: T.lp, companyId: C.lp, profitPct: 100, lossPct: 100, partnerSeStatus: 'limited', isOfficer: false, activityType: 'rental', activeParticipation: false });

  await putTreatments(scopeA, T.schc, C.schc, [
    { accountId: r.health, treatment: 'owner_sehi', nonRecurring: false },
    { accountId: r.meals, treatment: 'nondeductible_pct', pct: '50', nonRecurring: false },
    { accountId: r.draws, treatment: 'estimated_tax_payment', paymentTaxpayerId: taxpayerId, paymentPersonId: carlosId, paymentJurisdiction: 'federal', nonRecurring: false },
  ]);
  await putTreatments(scopeA, T.scorp, C.scorp, [
    { accountId: s.officer, treatment: 'w2_wages', paymentTaxpayerId: taxpayerId, paymentPersonId: mariaId, nonRecurring: false },
  ]);

  const year = await upsertYear(scopeA, actor, taxpayerId, 2026, {
    priorYearTax: '31500', priorYearAgi: '182000', priorYearTwelveMonths: true, priorYearFiled: true,
    creditsNonrefundable: '2200', withholding: { federal: 6000, states: { MO: 2000 } },
    personInputs: { primary: { retirementPlanType: 'sep' }, spouse: { retirementPlanType: 'none' } },
  });
  baseScenarioId = year.scenarios.find((x) => x.isBase)!.id;

  const types = await listAdjustmentTypes(scopeA);
  const typeId = (code: string) => types.find((t) => t.code === code)!.id;
  await createAdjustment(scopeA, actor, baseScenarioId, { adjustmentTypeId: typeId('interest_income'), label: 'Interest income', amount: '2400', cadence: 'annual', startMonth: 1, endMonth: 12, glLinked: false, nonRecurring: false });
  await createAdjustment(scopeA, actor, baseScenarioId, { adjustmentTypeId: typeId('sep_solo_401k'), label: 'SEP contribution', personId: carlosId, amount: '15000', cadence: 'annual', startMonth: 1, endMonth: 12, glLinked: false, nonRecurring: false });

  await replaceStateRows(scopeA, actor, baseScenarioId, { rows: [
    // Q53: the Rivera oracle computes the v1 effective-rate formulas — pinned to the effective-rate override.
    { residency: 'resident', state: 'MO', effectiveRate: 0.04, rateMode: 'effective', base: 'federal_agi', sourcedManual: false, priorYearTax: '7050' },
    { residency: 'nonresident', state: 'AR', effectiveRate: 0.039, rateMode: 'effective', base: 'federal_agi', sourcedManual: true, sourcedIncome: '8000', priorYearTax: '300' },
  ] });
}, 180_000);

afterAll(async () => {
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B])); // cascades persons, links, years, scenarios, payments, snapshots
  await purgeTenants([T.schc, T.scorp, T.lp, T.other, T.farm, T.cc]);
  await closeTbRedis();
  await pool.end();
});

const estimate = (scope = scopeA, extra: { throughMonth?: string; refresh?: boolean } = {}) =>
  computeEstimate(scope, { taxpayerId, taxYear: 2026, scenarioId: baseScenarioId, throughMonth: '2026-12', refresh: true, ...extra }, { today: TODAY, skipProviderCache: true });

describe('payment ledger (GL reader + manual rows)', () => {
  it('reads estimated_tax_payment lines over the attribution window: Jan 15 Q4 payment in, Dec prior-year payment out', async () => {
    const ledger = await getPaymentLedger(scopeA, taxpayerId, 2026, baseScenarioId);
    // R3-02: the attribution window — (2025 Q4 cutoff Feb 2, 2026, 2026 Q4 cutoff Feb 1, 2027].
    expect(ledger.window).toEqual({ start: '2026-02-03', end: '2027-02-01', returnDueDate: '2027-04-15' });
    expect(ledger.payments.map((p) => [p.date, Number(p.amount), p.jurisdiction, p.source])).toEqual([
      ['2026-04-15', 6600, 'federal', 'gl'], ['2026-06-15', 6600, 'federal', 'gl'], ['2026-09-15', 6000, 'federal', 'gl'], ['2027-01-15', 7046.1, 'federal', 'gl'],
    ]);
    expect(ledger.payments.some((p) => p.transactionId === decPriorTxn)).toBe(false);
    expect(ledger.payments.find((p) => p.transactionId === janQ4Txn)!.companyName).toBe('Rivera Plumbing LLC');
    expect(Number(ledger.totals['federal'])).toBeCloseTo(26246.1, 4);
  });

  it('a stored row with the same (jurisdiction, transaction) supersedes the GL row; duplicates are rejected', async () => {
    const pinned = await createPayment(scopeA, actor, taxpayerId, 2026, { jurisdiction: 'federal', date: '2026-04-15', amount: '6600', source: 'gl', tenantId: T.schc, transactionId: q1Txn, memo: 'Q1 voucher (pinned)' });
    const ledger = await getPaymentLedger(scopeA, taxpayerId, 2026, baseScenarioId);
    expect(ledger.payments.filter((p) => p.transactionId === q1Txn)).toHaveLength(1);
    expect(ledger.payments.find((p) => p.transactionId === q1Txn)!.stored).toBe(true);
    expect(ledger.duplicatesDropped.map((p) => p.transactionId)).toEqual([q1Txn]);
    expect(Number(ledger.totals['federal'])).toBeCloseTo(26246.1, 4);
    await expect(createPayment(scopeA, actor, taxpayerId, 2026, { jurisdiction: 'federal', date: '2026-04-15', amount: '6600', source: 'gl', tenantId: T.schc, transactionId: q1Txn }))
      .rejects.toMatchObject({ code: 'TE_PAYMENT_DUPLICATE' });
    expect(pinned.memo).toBe('Q1 voucher (pinned)');
  });

  it('firm B cannot read or write firm A ledger rows (404)', async () => {
    await expect(getPaymentLedger(scopeB, taxpayerId, 2026, null)).rejects.toMatchObject({ code: 'TE_TAXPAYER_NOT_FOUND' });
    await expect(createPayment(scopeB, actor, taxpayerId, 2026, { jurisdiction: 'federal', date: '2026-04-15', amount: '1', source: 'manual' }))
      .rejects.toMatchObject({ code: 'TE_TAXPAYER_NOT_FOUND' });
    // A manual row pointing into a tenant outside the caller's scope is a 404.
    await expect(createPayment(scopeA, actor, taxpayerId, 2026, { jurisdiction: 'federal', date: '2026-04-15', amount: '1', source: 'manual', tenantId: T.other }))
      .rejects.toMatchObject({ code: 'TE_TENANT_NOT_MANAGED' });
  });
});

describe('Rivera estimate through the services (rivera_expected.json)', () => {
  it('federal lines match the oracle base block through the federal total (35,829)', async () => {
    const r = await estimate();
    const f = r.federal;
    const carlos = f.persons.find((p) => p.personId === carlosId)!;
    const got = {
      sch_c_tax_profit: Number(f.entities.find((e) => e.companyId === C.schc)!.projectedProfit), total_income: Number(f.income.totalIncome),
      se_tax: Number(f.seTax), half_se: Number(f.adjustmentsToIncome.halfSeTax), sep_deducted: Number(carlos.retirement.deducted),
      sep_limit: Number(carlos.retirement.limit), sehi: Number(f.adjustmentsToIncome.sehi), agi: Number(f.agi), std_deduction: Number(f.deductions.deduction),
      qbi: Number(f.qbi.deduction), taxable_income: Number(f.taxableIncome), income_tax_brackets: Number(f.regularTax.tax),
      credits_nonrefundable: Number(f.credits.nonrefundableAllowed), addl_medicare: Number(f.additionalMedicareTax), niit: Number(f.niit), federal_total: Number(f.federalTotal),
    };
    expect(got).toEqual(Object.fromEntries(Object.keys(got).map((k) => [k, BASE[k]])));
    expect(r.summary.federalTotal).toBe('35829');
    expect(r.entities.map((e) => [e.companyName, e.path, e.entityType, e.monthsElapsed])).toEqual(expect.arrayContaining([
      ['Rivera Plumbing LLC', 'individual', 'sch_c', 12], ['Maria Designs Inc', 'individual', 's_corp', 12], ['Oak Street Rentals LP', 'individual', 'partnership', 12],
    ]));
    expect(f.persons.find((p) => p.personId === mariaId)!.totalWages).toBe('54000');
    expect(f.income.rental).toBe('8000');
    expect(r.warnings.some((w) => w.code === 'TE_RETIREMENT_PLAN_ASSUMED')).toBe(false);
  }, 120_000);

  it('state: MO 7,902 − 312 AR credit = 7,590; AR 312; state total 7,902; total 43,732', async () => {
    const r = await estimate();
    const mo = r.state!.rows.find((x) => x.state === 'MO')!;
    const ar = r.state!.rows.find((x) => x.state === 'AR')!;
    expect([mo.grossTax, mo.creditForOtherStates, mo.netTax, ar.netTax, r.state!.stateTotal]).toEqual(
      [BASE['mo_gross'], BASE['mo_credit'], BASE['mo'], BASE['ar'], BASE['state_total']].map(String));
    expect(r.summary.total).toBe(String(BASE['total']));
  }, 120_000);

  it('federal vouchers: required 32,246 (lesser of), 110% prior 34,650, installment 8,062; penalty ≈ $11 with the Jan 15 payment', async () => {
    const r = await estimate();
    const fe = r.federalEstimates;
    expect(fe.safeHarbor.currentYear.amount).toBe(String(SH['current_90']));
    expect(fe.safeHarbor.priorYear.amount).toBe(String(SH['prior_110']));
    expect(fe.safeHarbor.requiredAnnualPayment).toBe(String(SH['required_lesser_of']));
    expect(r.safeHarborRuleSource).toBe('firm_default');
    expect(fe.installments.map((i) => i.regularInstallment)).toEqual(Array(4).fill(String(SH['installment'])));
    expect(fe.installments.map((i) => i.withholdingShare)).toEqual(Array(4).fill(String(SH['withholding_per_q'])));
    // Schedule AI: periods 1-3 read live through 3/31, 5/31, 8/31 (level books: nothing lowered).
    expect(r.scheduleAi.map((p) => p.source)).toEqual(['live', 'live', 'live']);
    const p3 = fe.scheduleAi!.periods[2]!;
    expect(p3.annualizedAgi).toBe(String(expected['schedule_ai_period3']!['annualized_agi']));
    expect(p3.annualizedTotalTax).toBe(String(expected['schedule_ai_period3']!['annualized_total_tax']));
    expect(p3.requiredCumulative).toBe(String(expected['schedule_ai_period3']!['required_cumulative_through_period']));
    expect(fe.scheduleAi!.requiredInstallments).toEqual(Array(4).fill(String(SH['installment'])));
    // All four payments (incl. the pinned Q1 row and the Jan 15 GL payment) are applied; Q4 paid → penalty ≈ $11.
    expect(fe.installments.every((i) => i.status === 'paid')).toBe(true);
    expect(fe.penalty!.total).toBe(String(SH['penalty_total_if_q4_paid_on_time']));
    expect(r.parametersUsed.some((u) => u.key === 'penalty.underpayment_rate')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'TE_PARAM_UNVERIFIED')).toBe(true); // D12a surfaces
  }, 120_000);

  it('Missouri vouchers: 90% current 6,831 vs 100% prior 7,050 → 6,831; 1,208 per installment from estimates; AR not required', async () => {
    const r = await estimate();
    const mo = r.stateEstimates.find((e) => e.jurisdiction === 'MO')!;
    expect(mo.safeHarbor.currentYear.amount).toBe(String(MO['current_90']));
    expect(mo.safeHarbor.priorYear.amount).toBe(String(MO['prior_100']));
    expect(mo.safeHarbor.requiredAnnualPayment).toBe(String(MO['required']));
    expect(mo.totals.withholding).toBe(String(MO['withholding']));
    expect(mo.installments.map((i) => i.netRequired)).toEqual(Array(4).fill(String(MO['per_installment_from_estimates'])));
    const ar = r.stateEstimates.find((e) => e.jurisdiction === 'AR')!;
    expect(ar.estimatesRequired).toBe(false);
    expect(ar.installments).toEqual([]);
  }, 120_000);

  it('caches by inputs hash: a second identical call is served from Redis; a book change misses the cache', async () => {
    const opts = { today: TODAY, skipProviderCache: true };
    const req = { taxpayerId, taxYear: 2026, scenarioId: baseScenarioId, throughMonth: '2026-12' };
    const a = await computeEstimate(scopeA, { ...req, refresh: true }, opts);
    const b = await computeEstimate(scopeA, req, opts);
    expect(b.cached).toBe(true);
    expect(b.inputsHash).toBe(a.inputsHash);
    expect(b.summary).toEqual(a.summary);
    await createPayment(scopeA, actor, taxpayerId, 2026, { jurisdiction: 'MO', date: '2026-04-15', amount: '1208', source: 'manual', memo: 'MO Q1' });
    const c = await computeEstimate(scopeA, req, opts);
    expect(c.cached).toBe(false);
    expect(c.inputsHash).not.toBe(a.inputsHash);
    expect(c.stateEstimates.find((e) => e.jurisdiction === 'MO')!.totals.estimatesPaid).toBe('1208');
  }, 120_000);

  it('state-row gate inputs and prior-year state figures persist (D9: never returned, omitted keeps the saved value)', async () => {
    const rows = await listStateRows(scopeA, baseScenarioId);
    const mo = rows.find((x) => x.state === 'MO')!;
    expect(mo.priorYearTaxPresent).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('7050');
  });

  it('Q53: on the rate schedule (shipped 2026 MO / AR rows) the rows compute from the brackets; flipping back restores the oracle figures', async () => {
    const sched = await replaceStateRows(scopeA, actor, baseScenarioId, { rows: [
      { residency: 'resident', state: 'MO', effectiveRate: 0.04, rateMode: 'brackets', base: 'federal_agi', sourcedManual: false },
      { residency: 'nonresident', state: 'AR', effectiveRate: 0.039, rateMode: 'brackets', nonresidentMode: 'ratio', base: 'federal_agi', sourcedManual: true, sourcedIncome: '8000' },
    ] });
    expect(sched.map((x) => x.rateMode)).toEqual(['brackets', 'brackets']);
    const r = await estimate();
    const mo = r.state!.rows.find((x) => x.state === 'MO')!;
    const ar = r.state!.rows.find((x) => x.state === 'AR')!;
    expect(mo).toMatchObject({ rateMode: 'brackets', method: 'resident' });
    // 2026 MO: federal AGI start, standard deduction = federal MFJ 32,200 (2026 withholding formula), top rate 4.7%.
    expect(mo.schedule).toMatchObject({ startingPoint: 'federal_agi', standardDeduction: '32200' });
    expect(Number(mo.schedule!.taxableIncome)).toBe(Number(mo.schedule!.start) - Number(mo.schedule!.capitalGainExclusion) - Number(mo.schedule!.federalTaxDeduction) - 32200);
    expect(ar).toMatchObject({ rateMode: 'brackets', method: 'nonresident_ratio' });
    expect(r.state!.trace.some((t) => t.id.startsWith('state.MO.schedule.bracket.'))).toBe(true);
    expect(r.warnings.some((w) => w.code === 'TE_STATE_BRACKETS_UNAVAILABLE')).toBe(false);
    // Back to the override: the v1 figures again.
    await replaceStateRows(scopeA, actor, baseScenarioId, { rows: [
      { residency: 'resident', state: 'MO', effectiveRate: 0.04, rateMode: 'effective', base: 'federal_agi', sourcedManual: false },
      { residency: 'nonresident', state: 'AR', effectiveRate: 0.039, rateMode: 'effective', base: 'federal_agi', sourcedManual: true, sourcedIncome: '8000' },
    ] });
    const back = await estimate();
    expect(back.state!.rows.find((x) => x.state === 'MO')!.netTax).toBe(String(BASE['mo']));
  }, 120_000);
});

describe('Schedule AI snapshots and readiness', () => {
  it('captures reached periods (3/31, 5/31, 8/31 by Oct 12) and the estimate reads them as snapshots', async () => {
    const res = await captureSnapshots(scopeA, actor, taxpayerId, 2026, { replace: false }, { today: TODAY });
    expect(res.captured.filter((s) => s.periodIndex === 2)).toHaveLength(3);
    expect((await listSnapshots(scopeA, taxpayerId, 2026)).length).toBe(9);
    const r = await estimate();
    expect(r.scheduleAi.map((p) => p.source)).toEqual(['snapshot', 'snapshot', 'snapshot']);
    expect(r.summary.federalTotal).toBe('35829');
  }, 180_000);

  it('readiness lists every linked company with its books readiness and the snapshot status', async () => {
    const rd = await getEstimateReadiness(scopeA, taxpayerId, 2026, { today: TODAY });
    expect(rd.entities).toHaveLength(3);
    expect(rd.outOfScopeLinks).toBe(0);
    expect(rd.schAiPeriods.map((p) => [p.periodEnd, p.reached, p.snapshotsCaptured, p.entitiesExpected])).toEqual([
      ['2026-03-31', true, 3, 3], ['2026-05-31', true, 3, 3], ['2026-08-31', true, 3, 3],
    ]);
  }, 120_000);
});

describe('D1 isolation', () => {
  it('another firm gets 404 on the estimate and the readiness of this taxpayer', async () => {
    await expect(estimate(scopeB)).rejects.toMatchObject({ code: 'TE_TAXPAYER_NOT_FOUND' });
    await expect(getEstimateReadiness(scopeB, taxpayerId, 2026)).rejects.toMatchObject({ code: 'TE_TAXPAYER_NOT_FOUND' });
  });

  it("firm A's estimate never contains firm B data; firm B's own taxpayer never contains firm A data", async () => {
    const tpB = await createTaxpayer(scopeB, actor, { displayName: 'Other Firm Taxpayer', filingStatus: 'single', residentState: 'MO' });
    await upsertPerson(scopeB, actor, tpB.id, 'primary', { firstName: 'Olga', lastName: 'Other', dateOfBirth: '1970-01-01', isBlind: false });
    await upsertLink(scopeB, actor, tpB.id, { personRole: 'primary', taxYear: 2026, tenantId: T.other, companyId: C.other, profitPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
    const yB = await upsertYear(scopeB, actor, tpB.id, 2026, { creditsNonrefundable: '0' });
    const rB = await computeEstimate(scopeB, { taxpayerId: tpB.id, taxYear: 2026, scenarioId: yB.scenarios[0]!.id, throughMonth: '2026-12', refresh: true }, { today: TODAY, skipProviderCache: true });
    const bJson = JSON.stringify(rB);
    for (const id of [C.schc, C.scorp, C.lp, carlosId, mariaId, taxpayerId]) expect(bJson).not.toContain(id);
    expect(rB.payments).toEqual([]); // firm A's draws are tied to firm A's taxpayer, never credited to B
    const rA = await estimate();
    const aJson = JSON.stringify(rA);
    for (const id of [C.other, tpB.id]) expect(aJson).not.toContain(id);
  }, 120_000);

  it('a tenant that leaves the scope drops out of the next computation with a readiness warning', async () => {
    const dropped: FirmScope = { ...scopeA, allowedTenantIds: [T.schc, T.scorp] };
    const r = await estimate(dropped);
    expect(r.entities.map((e) => e.companyId)).not.toContain(C.lp);
    expect(r.federal.income.rental).toBe('0');
    expect(r.warnings.some((w) => w.code === 'TE_TENANT_NOT_MANAGED')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('Oak Street Rentals LP');
    const rd = await getEstimateReadiness(dropped, taxpayerId, 2026, { today: TODAY });
    expect(rd.outOfScopeLinks).toBe(1);
    expect(rd.ready).toBe(false);
    expect(rd.entities.find((e) => e.companyId === C.lp)!.companyName).toBeNull();
  }, 120_000);
});

describe('farmer (§6654(i)) and C corporation paths', () => {
  it('a Sch F farmer gets the single Jan 15 installment at 66⅔%; a linked C corp is computed at entity level, outside the totals', async () => {
    T.farm = await mkTenant('TE10 Farm');
    C.farm = await mkCompany(T.farm, 'Hank Family Farm', { accountingMethod: 'cash', entityType: 'sole_prop' });
    await setProfile(T.farm, C.farm, '1040', 'farm');
    const f = {
      checking: await mkAccount(T.farm, C.farm, '1010', 'Checking', 'asset', { detailType: 'checking' }),
      sales: await mkAccount(T.farm, C.farm, '4000', 'Cattle Sales', 'revenue'),
      feed: await mkAccount(T.farm, C.farm, '6000', 'Feed', 'expense'),
    };
    await assign(T.farm, C.farm, f.sales, 'farm', '604');
    T.cc = await mkTenant('TE10 C Corp');
    C.cc = await mkCompany(T.cc, 'Hank Holdings Inc', { accountingMethod: 'accrual', entityType: 'c_corp' });
    await setProfile(T.cc, C.cc, '1120', 'business');
    const k = {
      checking: await mkAccount(T.cc, C.cc, '1010', 'Operating', 'asset', { detailType: 'checking' }),
      sales: await mkAccount(T.cc, C.cc, '4000', 'Sales', 'revenue'),
      costs: await mkAccount(T.cc, C.cc, '6000', 'Costs', 'expense'),
    };
    await assign(T.cc, C.cc, k.sales, 'business', '100');
    for (let m = 1; m <= 12; m++) {
      const d = `2026-${mm(m)}-05`;
      await post(T.farm, C.farm, d, [[f.checking, 10000, 0], [f.sales, 0, 10000]]);
      await post(T.farm, C.farm, d, [[f.feed, 4000, 0], [f.checking, 0, 4000]]);
      await post(T.cc, C.cc, d, [[k.checking, 5000, 0], [k.sales, 0, 5000]]);
      await post(T.cc, C.cc, d, [[k.costs, 1000, 0], [k.checking, 0, 1000]]);
    }
    const scope: FirmScope = { ...scopeA, allowedTenantIds: [...scopeA.allowedTenantIds, T.farm, T.cc] };
    const tp = await createTaxpayer(scope, actor, { displayName: 'Hank Farmer', filingStatus: 'single', residentState: 'MO' });
    await upsertPerson(scope, actor, tp.id, 'primary', { firstName: 'Hank', lastName: 'Farmer', dateOfBirth: '1975-03-03', isBlind: false });
    await upsertLink(scope, actor, tp.id, { personRole: 'primary', taxYear: 2026, tenantId: T.farm, companyId: C.farm, profitPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
    await upsertLink(scope, actor, tp.id, { personRole: 'primary', taxYear: 2026, tenantId: T.cc, companyId: C.cc, profitPct: 100, isOfficer: false, activityType: 'investment', activeParticipation: false });
    const y = await upsertYear(scope, actor, tp.id, 2026, { priorYearTax: '15000', priorYearAgi: '70000' });
    const r = await computeEstimate(scope, { taxpayerId: tp.id, taxYear: 2026, scenarioId: y.scenarios[0]!.id, throughMonth: '2026-12', refresh: true }, { today: TODAY, skipProviderCache: true });

    expect(r.entities.map((e) => [e.companyName, e.path, e.entityType])).toEqual(expect.arrayContaining([['Hank Family Farm', 'individual', 'sch_f'], ['Hank Holdings Inc', 'c_corp', 'c_corp']]));
    expect(r.federal.income.businessOrdinary).toBe('72000'); // the C corp's 48,000 is NOT the shareholder's income
    expect(r.farmer!.qualifies).toBe(true);
    expect(r.farmer!.basis).toBe('current_year');
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['TE_FARMER_GROSS_FROM_BOOKS', 'TE_CCORP_INPUTS_LIMITED']));
    const fe = r.federalEstimates;
    expect(fe.installments).toHaveLength(1);
    expect(fe.scheduleAi).toBeNull();
    const twoThirds = Math.round(Number(r.federal.federalTotal) * Number(r.parametersUsed.find((u) => u.key === 'farmer.safe_harbor_current_pct')!.value));
    expect(Math.abs(Number(fe.safeHarbor.currentYear.amount) - twoThirds)).toBeLessThanOrEqual(1);
    expect(fe.safeHarbor.requiredAnnualPayment).toBe(String(Math.min(Number(fe.safeHarbor.currentYear.amount), 15000)));

    const cc = r.ccorps[0]!;
    expect(cc.taxableIncome).toBe('48000');
    expect(cc.federalTax).toBe(String(Math.round(48000 * Number(cc.rate))));
    expect(r.summary.federalTotal).toBe(r.federal.federalTotal);
  }, 180_000);
});
