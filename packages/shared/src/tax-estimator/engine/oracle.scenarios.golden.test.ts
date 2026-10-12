// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 14 golden test (MODULE.md "Tests", R2 O-2, OPEN-QUESTIONS Q35): the engine
// must match features/tax-estimator/docs/reference-calc/scenarios_expected.json,
// produced by scenarios_fixture.py (independent Python, no engine code), line by
// line for five scenarios Rivera does not reach: a seasonal Sch C where Schedule
// AI lowers columns (a)–(c) and column (d) recaptures, a late-payment ledger
// across the Jun 30 rate change and the Dec 31 year end, an MFS return (no
// Schedule 1-A, §469(i) denied), a high-income MFJ itemizer (§68, SALT floor,
// QD / LTCG 15 / 20, §199A W-2 / UBIA limit, SSTB, Additional Medicare, NIIT) and
// an MFJ itemizer inside the SALT phase-down with a §199A phase-in. Parameters are
// the shipped 2026 federal seed file read as text, as in estimates.golden.test.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import { computeFederalEstimates, type FederalEstimatesInput, type JurisdictionEstimate } from './vouchers.js';
import type { EstimatePayment } from './payments.js';
import type { EngineAdjustment, EngineEntity, EnginePerson, FederalEngineInput, FederalResult, ParameterMap } from './types.js';
import type { FilingStatus } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'scenarios_expected.json'), 'utf8')) as Record<string, Record<string, unknown>>;

/** Every row of the shipped 2026 federal seed, as the engine's parameter map (same reader as estimates.golden.test.ts). */
function loadSeed2026(): ParameterMap {
  const seed = readFileSync(join(repoRoot, 'packages', 'api', 'src', 'db', 'seeds', 'tax-estimator', 'federal', '2026.ts'), 'utf8');
  const rowRe = /key: '([^']+)',\s*value: ([^\n]+?),\s*citation:[\s\S]*?status: '(\w+)'/g;
  const out: Record<string, ParameterMap[string]> = {};
  for (let m = rowRe.exec(seed); m; m = rowRe.exec(seed)) {
    out[m[1]!] = { key: m[1]!, value: JSON.parse(m[2]!.replace(/'/g, '"')) as unknown, status: m[3] as 'verified' | 'unverified' | 'provisional' };
  }
  return out;
}
const params = loadSeed2026();

// ── Oracle row shapes ────────────────────────────────────────────────
interface OracleFederal {
  total_income: number; se_income: number; nese: number; se_tax: number; half_se: number; sep_deducted: number; sep_limit: number; sehi: number; agi: number;
  standard_deduction: number; nonitemizer_charitable: number; deduction_chosen: 'standard' | 'itemized'; deduction: number; sch1a_total: number;
  taxable_income_before_qbi: number; qbi: number; qbi_overall_limit: number; taxable_income: number; income_tax: number;
  worksheet: { ordinary_portion: number; taxed_at_zero: number; taxed_at_fifteen: number; taxed_at_twenty: number } | null;
  qbi_components: Array<{ source: 'sch_c' | 's_corp'; component: number; phase_in: number; wage_ubia_limit: number | null; excluded: string | null }>;
  itemized?: { salt_cap: number; salt_allowed: number; mortgage: number; charity_floor: number; charity_allowed: number; before_68: number; sec68_reduction: number; total: number };
  credits_nonrefundable: number; addl_medicare: number; nii: number; niit: number; suspended_passive_loss: number; federal_total: number; federal_total_exact: number;
}
interface OracleSafeHarbor { current_90: number; prior: number; prior_pct_high_agi_applied: boolean; required: number; installment: number; withholding_per_q: number; net_per_installment: number }
interface OracleAiRow { period: number; period_end: string; annualization_factor: number; applicable_pct: number; annualized_agi: number; annualized_qbi: number; annualized_taxable_income: number; annualized_income_tax: number; annualized_se_tax: number; annualized_total_tax: number; required_cumulative: number; annualized_installment: number; regular_installment: number; regular_with_recapture: number; required_installment: number; used_annualized: boolean }
interface OracleSegment { from: string; to: string; days: number; rate: number; days_in_year: number; balance: number; amount: number }
interface OraclePenaltyRow { q: string; due: string; required: number; withholding: number; still_unpaid_at_return_due: number; paid_in_full_on: string | null; penalty: number; penalty_exact: number; segments: OracleSegment[] }
interface OraclePayments { penalty_by_installment: OraclePenaltyRow[]; penalty_total: number }

// ── Input builders (the shapes the Rivera golden tests use) ───────────
const allMonths = (): boolean[] => Array(12).fill(true) as boolean[];
const person = (over: Partial<EnginePerson> & { personId: string; role: EnginePerson['role']; dateOfBirth: string }): EnginePerson => ({
  displayName: over.personId, isBlind: false, sehiEligibleMonths: allMonths(), w2Wages: '0', w2SocialSecurityWages: null, withholding: '0', retirementPlan: 'none', retirementEmployeeDeferral: null,
  hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' }, ...over,
});
const entityBase = (over: Partial<EngineEntity>): EngineEntity => ({
  tenantId: 't', companyId: 'c', companyName: 'Co', entityType: 'sch_c', monthsElapsed: 12, monthsRemaining: 0,
  ytd: characters({}), recurringYtd: characters({}), ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
  links: [], isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [], ...over,
});
const linkBase = { profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active' as const, activeParticipation: false, qbiEligible: null, allowedLossOverride: null };
const adjBase: EngineAdjustment = { id: '', label: '', typeCode: null, kind: 'income', amount: '0', pct: null, personId: null, linkId: null, affectsSe: false, affectsQbi: false, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false, isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false };
const yearBase: FederalEngineInput['year'] = {
  rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' },
  creditsNonrefundable: '0', creditsRefundable: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false,
};
function input(filingStatus: FilingStatus, persons: EnginePerson[], entities: EngineEntity[], adjustments: EngineAdjustment[] = [], year: Partial<FederalEngineInput['year']> = {}): FederalEngineInput {
  return { taxYear: 2026, filingStatus, parameters: params, persons, entities, adjustments, year: { ...yearBase, ...year }, qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null } };
}
const schC = (id: string, personId: string, profit: string, over: Partial<EngineEntity> = {}): EngineEntity =>
  entityBase({ companyId: id, companyName: id, entityType: 'sch_c', ytd: characters({ ordinary: profit }), recurringYtd: characters({ ordinary: profit }), links: [{ ...linkBase, linkId: `l-${id}`, personId }], ...over });
const pay = (id: string, date: string, amount: string): EstimatePayment => ({ id, date, amount, source: 'manual', jurisdiction: 'federal' });
const DUE = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];

// ── Comparators ──────────────────────────────────────────────────────
const n = (v: string | number | null | undefined): number => Number(v);

/** Every federal line the oracle reports, compared as whole dollars. */
function expectFederal(r: FederalResult, e: OracleFederal, sePersonId: string): void {
  const se = r.persons.find((p) => p.personId === sePersonId)!;
  const got = {
    total_income: n(r.income.totalIncome), se_income: n(se.seIncome), nese: n(se.nese), se_tax: n(r.seTax), half_se: n(r.adjustmentsToIncome.halfSeTax),
    sep_deducted: n(se.retirement.deducted), sep_limit: e.sep_limit === 0 ? 0 : n(se.retirement.limit), sehi: n(r.adjustmentsToIncome.sehi), agi: n(r.agi),
    standard_deduction: n(r.deductions.standard.total), nonitemizer_charitable: n(r.deductions.standard.nonItemizerCharitable), deduction_chosen: r.deductions.chosen, deduction: n(r.deductions.deduction),
    sch1a_total: n(r.deductions.sch1a.total), taxable_income_before_qbi: n(r.qbi.taxableIncomeBeforeQbi), qbi: n(r.qbi.deduction), qbi_overall_limit: n(r.qbi.overallLimit),
    taxable_income: n(r.taxableIncome), income_tax: n(r.regularTax.tax),
    worksheet: r.regularTax.worksheet == null ? null : { ordinary_portion: n(r.regularTax.worksheet.ordinaryPortion), taxed_at_zero: n(r.regularTax.worksheet.taxedAtZero), taxed_at_fifteen: n(r.regularTax.worksheet.taxedAtFifteen), taxed_at_twenty: n(r.regularTax.worksheet.taxedAtTwenty) },
    credits_nonrefundable: n(r.credits.nonrefundableAllowed), addl_medicare: n(r.additionalMedicareTax), nii: n(r.otherTaxes.niit.netInvestmentIncome), niit: n(r.niit),
    suspended_passive_loss: n(r.lossLimitations.suspendedPassiveLoss), federal_total: n(r.federalTotal),
  };
  const want = Object.fromEntries(Object.keys(got).map((k) => [k, (e as unknown as Record<string, unknown>)[k]]));
  expect(got).toEqual(want);
  expect(Number(r.exact.federalTotal)).toBeCloseTo(e.federal_total_exact, 4);
  // §199A components: the Sch C first, then the S corp when present.
  const comps = r.qbi.components.filter((c) => c.entityType === 'sch_c' || c.entityType === 's_corp');
  expect(comps.map((c) => ({ source: c.entityType, component: n(c.component), limit: c.wageUbiaLimit == null ? null : n(c.wageUbiaLimit), excluded: !c.eligible })))
    .toEqual(e.qbi_components.map((c) => ({ source: c.source, component: c.component, limit: c.wage_ubia_limit, excluded: c.excluded != null })));
  expect(Number(r.qbi.phaseInFraction)).toBeCloseTo(e.qbi_components[0]!.phase_in, 5);
  if (e.itemized) {
    const i = r.deductions.itemized;
    expect({ salt_cap: n(i.saltCap), salt_allowed: n(i.saltAllowed), mortgage: n(i.mortgageInterest), charity_floor: n(i.charitableFloor), charity_allowed: n(i.charitableAllowed), before_68: n(i.beforeBenefitCap), sec68_reduction: n(i.benefitCapReduction), total: n(i.total) })
      .toEqual({ salt_cap: Math.round(e.itemized.salt_cap), salt_allowed: Math.round(e.itemized.salt_allowed), mortgage: e.itemized.mortgage, charity_floor: Math.round(e.itemized.charity_floor), charity_allowed: Math.round(e.itemized.charity_allowed), before_68: Math.round(e.itemized.before_68), sec68_reduction: Math.round(e.itemized.sec68_reduction), total: Math.round(e.itemized.total) });
  }
}

function expectSafeHarbor(est: JurisdictionEstimate, e: OracleSafeHarbor): void {
  expect(n(est.safeHarbor.currentYear.amount)).toBe(e.current_90);
  expect(n(est.safeHarbor.priorYear.amount)).toBe(e.prior);
  expect(est.safeHarbor.priorYear.highAgiApplied).toBe(e.prior_pct_high_agi_applied);
  expect(n(est.safeHarbor.requiredAnnualPayment)).toBe(e.required);
  expect(est.installments.map((i) => n(i.regularInstallment))).toEqual([e.installment, e.installment, e.installment, e.installment]);
  expect(est.installments.map((i) => n(i.withholdingShare))).toEqual(Array(4).fill(e.withholding_per_q));
}

/** Penalty per installment to the dollar, the exact amount to the cent, and the paid / unpaid dates and balances. */
function expectPenalty(est: JurisdictionEstimate, e: OraclePayments): void {
  expect(est.penalty!.installments.map((i) => n(i.penalty))).toEqual(e.penalty_by_installment.map((x) => x.penalty));
  est.penalty!.installments.forEach((i, k) => expect(Number(i.exact)).toBeCloseTo(e.penalty_by_installment[k]!.penalty_exact, 2));
  expect(n(est.penalty!.total)).toBe(e.penalty_total);
  expect(est.payments!.installments.map((i) => i.paidInFullOn)).toEqual(e.penalty_by_installment.map((x) => x.paid_in_full_on));
  expect(est.payments!.installments.map((i) => n(i.unpaidAtEnd))).toEqual(e.penalty_by_installment.map((x) => x.still_unpaid_at_return_due));
  // Every oracle leg (split at each rate-period end and Dec 31, Form 2210 Part III Section B) is covered by an engine segment
  // at the same rate; the engine only splits where the rate, the year length or the balance changes.
  est.penalty!.installments.forEach((inst, k) => {
    for (const leg of e.penalty_by_installment[k]!.segments) {
      const seg = inst.segments.find((s) => s.from <= leg.from && leg.to <= s.to);
      expect(seg, `${inst.dueDate} leg ${leg.from}→${leg.to}`).toBeDefined();
      expect(Number(seg!.rate)).toBe(leg.rate);
      expect(seg!.daysInYear).toBe(leg.days_in_year);
      expect(Number(seg!.balance)).toBeCloseTo(leg.balance, 4);
    }
    expect(inst.segments.reduce((d, s) => d + s.units, 0)).toBe(e.penalty_by_installment[k]!.segments.reduce((d, s) => d + s.days, 0));
  });
}

function estimates(fs: FilingStatus, over: Partial<FederalEstimatesInput>): JurisdictionEstimate {
  return computeFederalEstimates({
    taxYear: 2026, filingStatus: fs, parameters: params, currentYearTax: '0', currentYearAgi: null, withholding: '0',
    priorYear: { tax: null, agi: null, twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default', payments: [], scheduleAi: null, ...over,
  });
}

// ── seasonal ─────────────────────────────────────────────────────────
describe('oracle scenario: seasonal Sch C (Schedule AI lowers columns (a)–(c), column (d) recaptures)', () => {
  const S = expected['seasonal']!;
  const monthly = S['monthly_sch_c_profit'] as number[];
  const cum = (m: number) => String(monthly.slice(0, m).reduce((a, b) => a + b, 0));
  const ORTIZ = 'ortiz';
  const forMonths = (m: number): FederalEngineInput => input('single', [person({ personId: ORTIZ, role: 'primary', dateOfBirth: '1985-06-01' })], [schC('decor', ORTIZ, cum(m), { monthsElapsed: m, monthsRemaining: 12 - m })]);
  const base = forMonths(12);
  const full = computeFederal(base);
  const fed = S['federal'] as OracleFederal;
  const sh = S['safe_harbor'] as OracleSafeHarbor;
  const est = (payments: EstimatePayment[]) => estimates('single', {
    currentYearTax: full.federalTotal, currentYearAgi: full.exact.agi, priorYear: { tax: '50000', agi: '140000', twelveMonths: true, filed: true }, payments,
    scheduleAi: { base, baseResult: full, periodActuals: [forMonths(3), forMonths(5), forMonths(8)], calc: computeFederal },
  });

  it('full year matches every federal line (§199A limited to 20% of taxable income)', () => {
    expectFederal(full, fed, ORTIZ);
    expect(full.qbi.overallLimit).toBe(full.qbi.deduction);
  });

  it('safe harbor: 100% prior exceeds 90% current, so the current-year rule gives the required annual payment', () => {
    expectSafeHarbor(est([]), sh);
  });

  it('Schedule AI: every column matches the oracle (2025 Form 2210 lines 21–27), (a)–(c) annualized and (d) recaptured', () => {
    const r = est([]);
    const rows = S['schedule_ai'] as OracleAiRow[];
    expect(r.scheduleAi!.periods).toHaveLength(4);
    r.scheduleAi!.periods.forEach((p, i) => {
      const o = rows[i]!;
      expect({
        period: p.period, period_end: p.periodEnd, annualization_factor: Number(p.factor), applicable_pct: Number(p.applicablePct),
        annualized_agi: n(p.annualizedAgi), annualized_qbi: n(p.annualizedQbi), annualized_taxable_income: n(p.annualizedTaxableIncome), annualized_income_tax: n(p.annualizedIncomeTax),
        annualized_se_tax: n(p.annualizedSeTax), annualized_total_tax: n(p.annualizedTotalTax), required_cumulative: n(p.requiredCumulative), annualized_installment: n(p.annualizedInstallment),
        regular_installment: n(p.regularInstallment), regular_with_recapture: n(p.regularWithRecapture), required_installment: n(p.requiredInstallment), used_annualized: p.usedAnnualized,
      }).toEqual(o);
      expect(p.available).toBe(true);
      expect(n(p.engineSeTax)).toBe(o.annualized_se_tax);
    });
    expect(r.scheduleAi!.lowersAnyInstallment).toBe(true);
    expect(r.scheduleAi!.requiredInstallments.map(Number)).toEqual(S['required_installments']);
    expect(r.installments.map((i) => n(i.required))).toEqual(S['required_installments']);
    expect(r.warnings.filter((w) => w.code === 'TE_SCH_AI_SE_PART2_DIFFERS')).toEqual([]);
    expect(r.warnings.filter((w) => w.code === 'TE_SCH_AI_PERIOD_MISSING')).toEqual([]);
  });

  it('paying each annualized installment (rounded up) on its due date: no penalty, everything paid on time', () => {
    const o = S['paid_annualized_on_time'] as OraclePayments & { payments: number[] };
    const r = est(o.payments.map((amt, i) => pay(`p${i}`, DUE[i]!, String(amt))));
    expectPenalty(r, o);
    expect(r.installments.every((i) => i.status === 'paid')).toBe(true);
    expect(r.penalty!.total).toBe('0');
  });

  it('paying everything on Jan 15, 2027: (a)–(c) accrue across the 6% Q2 leg, Sep 30, Dec 31; (d) is on time', () => {
    const o = S['paid_all_on_jan_15'] as OraclePayments & { payment: number; q4_catch_up_before_payment: number };
    const r = est([pay('all', DUE[3]!, String(o.payment))]);
    expectPenalty(r, o);
    expect(r.installments.every((i) => i.status === 'paid')).toBe(true);
    const unpaid = est([]);
    expect(n(unpaid.installments[3]!.catchUpAmount)).toBe(o.q4_catch_up_before_payment);
  });
});

// ── late_payments ────────────────────────────────────────────────────
describe('oracle scenario: late payments across the Jun 30 rate change and the Dec 31 year end', () => {
  const L = expected['late_payments']!;
  it('earliest-unpaid application with even withholding, legs at 6% / 7%, exact penalties', () => {
    const paysIn = L['payments'] as Array<{ date: string; amount: number }>;
    const r = estimates('mfj', {
      currentYearTax: String(L['current_year_tax']), withholding: String(L['withholding']),
      priorYear: { tax: String((L['prior_year'] as { tax: number }).tax), agi: String((L['prior_year'] as { agi: number }).agi), twelveMonths: true, filed: true },
      payments: paysIn.map((p, i) => pay(`p${i}`, p.date, String(p.amount))),
    });
    expectSafeHarbor(r, L['safe_harbor'] as OracleSafeHarbor);
    expectPenalty(r, L as unknown as OraclePayments);
    // The Q2 shortfall: 15 days at the Q2 6% rate to Jun 30, then 32 days at 7% from Jun 30 to Aug 1 (Form 2210 Part III, rate period 2 starts "from 6/30").
    expect(r.penalty!.installments[1]!.segments.map((s) => [s.from, s.to, s.units, s.rate])).toEqual([['2026-06-15', '2026-06-30', 15, '0.06'], ['2026-06-30', '2026-08-01', 32, '0.07']]);
    expect(r.installments.map((i) => i.status)).toEqual(['paid', 'paid', 'paid', 'paid']);
  });
});

// ── mfs ──────────────────────────────────────────────────────────────
describe('oracle scenario: married filing separately (no Schedule 1-A, §469(i) denied, MFS thresholds)', () => {
  const M = expected['mfs']!;
  const fed = M['federal'] as OracleFederal & { sch1a_inputs: { qualified_tips: number; qualified_overtime: number; car_loan_interest: number }; rental_loss_input: number };
  const DANA = 'dana';
  const inp = input('mfs',
    [person({ personId: DANA, role: 'primary', dateOfBirth: '1958-03-15', w2Wages: '60000', withholding: '6000', sch1a: { qualifiedTips: String(fed.sch1a_inputs.qualified_tips), qualifiedOvertime: String(fed.sch1a_inputs.qualified_overtime), carLoanInterest: String(fed.sch1a_inputs.car_loan_interest) } })],
    [
      schC('consulting', DANA, '30000'),
      entityBase({ companyId: 'lp', companyName: 'Elm Street Rentals LP', entityType: 'partnership', ytd: characters({ rental: String(fed.rental_loss_input) }), recurringYtd: characters({ rental: String(fed.rental_loss_input) }),
        links: [{ ...linkBase, linkId: 'l-lp', personId: DANA, partnerSeStatus: 'limited', activityType: 'rental', activeParticipation: true }] }),
    ],
    [{ ...adjBase, id: 'qd', label: 'Qualified dividends', kind: 'income', amount: '5000', isQualifiedDividend: true }],
    { itemized: { ...yearBase.itemized, charitableCash: '1500' }, mfsLivedApartAllYear: false },
  );
  const r = computeFederal(inp);

  it('matches every federal line: Schedule 1-A 0, 1,650 married add-on, 1,000 non-itemizer charitable, QD at 15%, rental loss suspended', () => {
    expectFederal(r, fed, DANA);
    expect(r.deductions.sch1a).toEqual({ inEffect: true, senior: '0', tips: '0', overtime: '0', carLoanInterest: '0', total: '0' });
    expect(r.warnings.some((w) => w.code === 'TE_SCH1A_MFS_NOT_ALLOWED')).toBe(true);
    expect(r.deductions.standard.additionalCount).toBe(1);
    expect(r.deductions.standard.additionalEach).toBe('1650');
    expect(r.lossLimitations.rentalAllowance.variant).toBe('none');
    expect(r.lossLimitations.rentalAllowance.used).toBe('0');
    expect(r.income.rental).toBe('0');
    expect(r.warnings.some((w) => w.code === 'TE_PASSIVE_MFS_NO_ALLOWANCE')).toBe(true);
    expect(r.regularTax.marginalCapitalGainRate).toBe('0.15');
  });

  it('safe harbor uses the MFS 75,000 high-AGI threshold (prior AGI 80,000 → 110%)', () => {
    const est = estimates('mfs', { currentYearTax: r.federalTotal, currentYearAgi: r.exact.agi, withholding: '6000', priorYear: { tax: '12000', agi: '80000', twelveMonths: true, filed: true } });
    expectSafeHarbor(est, M['safe_harbor'] as OracleSafeHarbor);
    expect(est.installments.map((i) => n(i.netRequired))).toEqual(Array(4).fill((M['safe_harbor'] as OracleSafeHarbor).net_per_installment));
  });
});

// ── high_income_mfj ──────────────────────────────────────────────────
describe('oracle scenario: high-income MFJ itemizer (§68, SALT floor, QD / LTCG 15 / 20, §199A W-2 / UBIA limit, SSTB, Addl Medicare, NIIT)', () => {
  const H = expected['high_income_mfj']!;
  const fed = H['federal'] as OracleFederal;
  const RAJ = 'raj'; const PRIYA = 'priya';
  const inp = input('mfj',
    [person({ personId: RAJ, role: 'primary', dateOfBirth: '1979-02-11', retirementPlan: 'sep' }), person({ personId: PRIYA, role: 'spouse', dateOfBirth: '1981-08-30', withholding: '60000' })],
    [
      schC('mfg', RAJ, '300000', { w2WagesEffective: '60000', ubia: '700000' }),
      entityBase({ companyId: 'law', companyName: 'Patel Law PC (S corp, SSTB)', entityType: 's_corp', isSstb: true, ytd: characters({ ordinary: '150000' }), recurringYtd: characters({ ordinary: '150000' }),
        officerWages: [{ personId: PRIYA, amount: '200000' }], links: [{ ...linkBase, linkId: 'l-law', personId: PRIYA, isOfficer: true }] }),
      entityBase({ companyId: 'lp', companyName: 'Harbor View LP', entityType: 'partnership', ytd: characters({ rental: '30000' }), recurringYtd: characters({ rental: '30000' }),
        links: [{ ...linkBase, linkId: 'l-lp', personId: RAJ, partnerSeStatus: 'limited', activityType: 'rental' }] }),
    ],
    [
      { ...adjBase, id: 'int', label: 'Interest income', typeCode: 'interest_income', kind: 'income', amount: '20000' },
      { ...adjBase, id: 'qd', label: 'Qualified dividends', kind: 'income', amount: '40000', isQualifiedDividend: true },
      { ...adjBase, id: 'ltcg', label: 'Long-term capital gain', kind: 'income', amount: '150000', isCapitalGainLt: true },
      { ...adjBase, id: 'sep', label: 'SEP contribution', typeCode: 'sep_solo_401k', kind: 'deduction', amount: '60000', isAboveTheLine: true, personId: RAJ },
    ],
    { itemized: { ...yearBase.itemized, saltPaid: '60000', mortgageInterest: '25000', charitableCash: '50000' } },
  );
  const r = computeFederal(inp);

  it('matches every federal line', () => {
    expectFederal(r, fed, RAJ);
    expect(r.persons.find((p) => p.personId === RAJ)!.retirement.capped).toBe(true);
    expect(r.deductions.itemized.saltCap).toBe('10000');
    expect(r.warnings.some((w) => w.code === 'TE_SALT_PHASED_DOWN')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'TE_ITEMIZED_BENEFIT_CAPPED')).toBe(true);
    const mfg = r.qbi.components.find((c) => c.linkId === 'l-mfg')!;
    expect(mfg.limitApplied).toBe(true);
    expect(mfg.wageUbiaLimit).toBe('32500'); // 25% × 60,000 + 2.5% × 700,000 beats 50% × 60,000
    expect(r.qbi.components.find((c) => c.linkId === 'l-law')!.reason).toMatch(/specified service/);
    expect(r.qbi.phaseInFraction).toBe('1');
    expect(r.otherTaxes.additionalMedicare.wagesAboveThreshold).toBe('0');
    expect(r.otherTaxes.additionalMedicare.neseAboveThreshold).toBe('227050');
    expect(r.otherTaxes.niit.base).toBe('240000');
    expect(r.regularTax.marginalCapitalGainRate).toBe('0.2');
  });

  it('safe harbor: prior AGI 700,000 → 110% of prior tax, below 90% of current', () => {
    const est = estimates('mfj', { currentYearTax: r.federalTotal, currentYearAgi: r.exact.agi, withholding: '60000', priorYear: { tax: '150000', agi: '700000', twelveMonths: true, filed: true } });
    expectSafeHarbor(est, H['safe_harbor'] as OracleSafeHarbor);
    expect(est.safeHarbor.appliedRule).toBe('lesser_of');
  });
});

// ── itemizer_salt ────────────────────────────────────────────────────
describe('oracle scenario: MFJ itemizer inside the SALT phase-down with a §199A phase-in', () => {
  const I = expected['itemizer_salt']!;
  const fed = I['federal'] as OracleFederal;
  const LINH = 'linh'; const TUAN = 'tuan';
  const inp = input('mfj',
    [person({ personId: LINH, role: 'primary', dateOfBirth: '1984-04-04' }), person({ personId: TUAN, role: 'spouse', dateOfBirth: '1983-12-12', w2Wages: '250000', withholding: '45000' })],
    [schC('studio', LINH, '300000', { w2WagesEffective: '60000', ubia: '100000', ownerItems: [{ personId: null, sehi: '12000', retirement: '0', sehiAsW2Wages: '0' }] })],
    [{ ...adjBase, id: 'int', label: 'Interest income', typeCode: 'interest_income', kind: 'income', amount: '3000' }],
    { itemized: { ...yearBase.itemized, saltPaid: '45000', mortgageInterest: '18000', charitableCash: '20000' } },
  );
  const r = computeFederal(inp);

  it('matches every federal line: SALT cap 40,400 − 30% × excess, partial §199A phase-in, SEHI attributable', () => {
    expectFederal(r, fed, LINH);
    expect(Number(r.deductions.itemized.saltCap)).toBeGreaterThan(10000);
    expect(Number(r.deductions.itemized.saltCap)).toBeLessThan(40400);
    expect(r.deductions.itemized.benefitCapReduction).toBe('0');
    const studio = r.qbi.components.find((c) => c.linkId === 'l-studio')!;
    expect(studio.limitApplied).toBe(true);
    expect(studio.wageUbiaLimit).toBe('30000');
    expect(n(studio.attributableDeductions)).toBe(fed.half_se + fed.sehi);
    expect(Number(r.qbi.phaseInFraction)).toBeGreaterThan(0);
    expect(Number(r.qbi.phaseInFraction)).toBeLessThan(1);
    expect(r.otherTaxes.additionalMedicare.neseAboveThreshold).toBe('277050');
    expect(r.otherTaxes.niit.base).toBe('3000');
  });

  it('safe harbor: prior AGI 400,000 → 110% of prior tax, above 90% of current → current-year amount', () => {
    const est = estimates('mfj', { currentYearTax: r.federalTotal, currentYearAgi: r.exact.agi, withholding: '45000', priorYear: { tax: '100000', agi: '400000', twelveMonths: true, filed: true } });
    expectSafeHarbor(est, I['safe_harbor'] as OracleSafeHarbor);
    expect(est.installments.map((i) => n(i.netRequired))).toEqual(Array(4).fill((I['safe_harbor'] as OracleSafeHarbor).net_per_installment));
  });
});
