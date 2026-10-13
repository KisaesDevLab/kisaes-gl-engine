// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 14 golden test, batch 2 (R7-06; MODULE.md "Tests"; OPEN-QUESTIONS Q37): the
// engine must match features/tax-estimator/docs/reference-calc/scenarios2_expected.json,
// produced by scenarios2_fixture.py (independent Python from the forms and statute,
// no engine code), line by line for the oracles PHASES.md Phase 14 lists that batch 1
// did not deliver: a fiscal-year large C corporation with the §6655(d)(2) first-
// installment rule and recapture, a farmer qualifying on the prior year only
// (§6654(i)), §469(i) phase-out + §461(l) excess business loss, a senior couple's
// Schedule 1-A with the stepped phase-outs (tips / overtime round DOWN, car-loan
// interest UP — 2025 Schedule 1-A lines 11 / 19 / 28), and a multistate return
// (resident credit limit, MO / KS / AR gates and vouchers, AZ / GA / PA income gates).
// Parameters are the shipped 2026 federal seed file read as text, as in
// oracle.scenarios.golden.test.ts; state rules are the 2026 seed values.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import { computeCcorp, type CcorpEngineInput } from './ccorp.js';
import { computeFarmer, type FarmerEngineInput } from './farmer.js';
import { computeFederalEstimates, computeStateEstimates, FARMER_INSTALLMENT_POLICY, type FederalEstimatesInput, type JurisdictionEstimate, type StateEstimatesInput } from './vouchers.js';
import { FARMER_SAFE_HARBOR_POLICY } from './safe-harbor.js';
import { computeState, federalFiguresFromResult, sourcedEntitiesFromFederal, EMPTY_GATE_INPUTS } from './state.js';
import type { StateEngineInput, StateEngineRow, StateJurisdictionInput, StateRuleMap, StateGateInputs } from './state-types.js';
import type { EstimatePayment } from './payments.js';
import type { EngineAdjustment, EngineEntity, EnginePerson, FederalEngineInput, FederalResult, ParameterMap } from './types.js';
import type { FilingStatus } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'scenarios2_expected.json'), 'utf8')) as Record<string, Record<string, unknown>>;

/** Every row of the shipped 2026 federal seed, as the engine's parameter map (same reader as the batch-1 golden test). */
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
  credits_nonrefundable: number; addl_medicare: number; nii: number; niit: number; suspended_passive_loss: number; federal_total: number; federal_total_exact: number;
  sch1a?: { senior: number; tips: number; overtime: number; car_loan_interest: number; total: number; steps: { tips: number; overtime: number; car: number } };
  ebl_addback?: number;
}
interface OracleSafeHarbor { current_90: number; prior: number; prior_pct_high_agi_applied: boolean; required: number; installment: number; withholding_per_q: number; net_per_installment: number }
interface OracleSegment { from: string; to: string; days: number; rate: number; days_in_year: number; balance: number; amount: number }
interface OraclePenaltyRow { q: string; due: string; required: number; withholding: number; still_unpaid_at_return_due: number; paid_in_full_on: string | null; penalty: number; penalty_exact: number; segments: OracleSegment[] }
interface OraclePayments { penalty_by_installment: OraclePenaltyRow[]; penalty_total: number }
interface OracleCcorpInstallment { number: number; fiscal_month: number; statutory_due_date: string; due_date: string; pct: number; current_year_basis: number; prior_year_basis: number | null; recapture: number; required: number; cumulative_required: number; basis: 'current_year' | 'prior_year' }
interface OracleCcorp {
  fiscal_year_start: string; fiscal_year_end: string; taxable_income: number; federal_tax: number; states: Array<{ state: string; apportionment_pct: number; effective_rate: number; apportioned: number; tax: number }>;
  state_total: number; total_tax: number; large_corporation: boolean; large_corporation_source: 'flag' | 'derived' | 'not_large'; estimates_required: boolean;
  prior_year_rule: { available: boolean; applies_to: 'all' | 'first_installment' | 'none' }; required_annual_payment: { current_year: number; prior_year: number | null; required: number }; installments: OracleCcorpInstallment[];
}
interface OracleGate { method: string; measured: number; threshold: number | null; required: boolean; gate_satisfied?: boolean }
interface OracleStateRow { state: string; residency: string; gross_tax: number; credit: number; net_tax: number; sourced_income?: number; credit_details?: Array<{ state: string; other_state_tax: number; resident_rate_on_sourced: number; allowed: number; limited: boolean }>; gate: OracleGate }
interface OracleStateVouchers { current: number; prior: number | null; required: number; installment: number; withholding_per_q: number; net_per_installment: number; due_dates: string[]; return_due: string; payments: Array<{ date: string; amount: number }>; penalty_by_installment: OraclePenaltyRow[]; penalty_total: number; penalty_waived_below_min_balance: boolean }

// ── Input builders (the shapes the batch-1 golden test uses) ─────────
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
const rentalLp = (id: string, name: string, personId: string, rental: string, activeParticipation: boolean): EngineEntity =>
  entityBase({ companyId: id, companyName: name, entityType: 'partnership', ytd: characters({ rental }), recurringYtd: characters({ rental }),
    links: [{ ...linkBase, linkId: `l-${id}`, personId, partnerSeStatus: 'limited', activityType: 'rental', activeParticipation }] });
const interest = (amount: string): EngineAdjustment => ({ ...adjBase, id: 'int', label: 'Interest income', typeCode: 'interest_income', kind: 'income', amount });
const qualifiedDividends = (amount: string): EngineAdjustment => ({ ...adjBase, id: 'qd', label: 'Qualified dividends', kind: 'income', amount, isQualifiedDividend: true });
const pay = (id: string, date: string, amount: string, jurisdiction = 'federal'): EstimatePayment => ({ id, date, amount, source: 'manual', jurisdiction });

// ── Comparators ──────────────────────────────────────────────────────
const n = (v: string | number | null | undefined): number => Number(v);

/** Every federal line the oracle reports, compared as whole dollars (batch-1 comparator plus the Schedule 1-A detail). */
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
  // The oracle labels every sole-proprietorship component 'sch_c' (Sch F is the same §199A arithmetic).
  const comps = r.qbi.components.filter((c) => c.entityType === 'sch_c' || c.entityType === 'sch_f' || c.entityType === 's_corp');
  expect(comps.map((c) => ({ source: c.entityType === 'sch_f' ? 'sch_c' : c.entityType, component: n(c.component), limit: c.wageUbiaLimit == null ? null : n(c.wageUbiaLimit), excluded: !c.eligible })))
    .toEqual(e.qbi_components.map((c) => ({ source: c.source, component: c.component, limit: c.wage_ubia_limit, excluded: c.excluded != null })));
  if (e.qbi_components.length > 0) expect(Number(r.qbi.phaseInFraction)).toBeCloseTo(e.qbi_components[0]!.phase_in, 5);
  if (e.sch1a) {
    const s = r.deductions.sch1a;
    expect({ senior: n(s.senior), tips: n(s.tips), overtime: n(s.overtime), car_loan_interest: n(s.carLoanInterest), total: n(s.total) })
      .toEqual({ senior: e.sch1a.senior, tips: e.sch1a.tips, overtime: e.sch1a.overtime, car_loan_interest: e.sch1a.car_loan_interest, total: e.sch1a.total });
  }
}

function expectSafeHarbor(est: JurisdictionEstimate, e: OracleSafeHarbor): void {
  expect(n(est.safeHarbor.currentYear.amount)).toBe(e.current_90);
  expect(n(est.safeHarbor.priorYear.amount)).toBe(e.prior);
  expect(est.safeHarbor.priorYear.highAgiApplied).toBe(e.prior_pct_high_agi_applied);
  expect(n(est.safeHarbor.requiredAnnualPayment)).toBe(e.required);
  expect(est.installments.map((i) => n(i.regularInstallment))).toEqual([e.installment, e.installment, e.installment, e.installment]);
  expect(est.installments.map((i) => n(i.withholdingShare))).toEqual(Array(4).fill(e.withholding_per_q));
  expect(est.installments.map((i) => n(i.netRequired))).toEqual(Array(4).fill(Math.max(0, e.net_per_installment)));
}

/** Penalty per installment to the dollar, the exact amount to the cent, paid / unpaid dates and balances, every oracle leg covered at the same rate. */
function expectPenalty(est: JurisdictionEstimate, e: OraclePayments): void {
  expect(est.penalty!.installments.map((i) => n(i.penalty))).toEqual(e.penalty_by_installment.map((x) => x.penalty));
  est.penalty!.installments.forEach((i, k) => expect(Number(i.exact)).toBeCloseTo(e.penalty_by_installment[k]!.penalty_exact, 2));
  expect(n(est.penalty!.total)).toBe(e.penalty_total);
  expect(est.payments!.installments.map((i) => i.paidInFullOn)).toEqual(e.penalty_by_installment.map((x) => x.paid_in_full_on));
  expect(est.payments!.installments.map((i) => n(i.unpaidAtEnd))).toEqual(e.penalty_by_installment.map((x) => x.still_unpaid_at_return_due));
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

// ── State rule maps (2026 rows of the shipped seeds) ──────────────────
type Status = 'verified' | 'unverified' | 'provisional';
function rules(entries: Record<string, unknown>, statuses: Record<string, Status> = {}): StateRuleMap {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { key, value, status: statuses[key] ?? 'verified' }]));
}
const DUE = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];
const QUARTERS = [0.25, 0.25, 0.25, 0.25];
const COMMON = { has_income_tax: true, estimates_required: true, 'safe_harbor.current_pct': 0.9, 'safe_harbor.prior_pct': 1.0, 'safe_harbor.high_agi_rule': null, 'installments.due_dates': DUE, 'installments.pcts': QUARTERS, 'penalty.rate_source': 'state', 'penalty.rate_schedule': null, credit_for_other_state: true, holidays: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15'] };
const MO_RULES = rules({ ...COMMON, required_threshold: 100, threshold_comparison: 'at_least', 'installments.q4_file_and_pay_date': '2027-02-01', return_due_date: '2027-04-15', 'penalty.rate': 0.07, 'penalty.rate_schedule': [{ from: '2026-01-01', to: '2026-12-31', rate: 0.07 }], 'penalty.method': 'daily_simple', 'penalty.min_balance_due': 500, nonresident_method: 'ratio' });
const KS_RULES = rules({ ...COMMON, required_threshold: 500, threshold_comparison: null, 'installments.q4_file_and_pay_date': null, return_due_date: null, 'penalty.rate': 0.08, 'penalty.method': null, 'penalty.min_balance_due': null, nonresident_method: 'ratio' });
const AR_RULES = rules({ ...COMMON, required_threshold: 1000, threshold_comparison: 'more_than', 'installments.q4_file_and_pay_date': '2027-02-01', return_due_date: '2027-04-15', 'penalty.rate': 0.1, 'penalty.method': 'daily_simple', 'penalty.min_balance_due': null, nonresident_method: 'ratio' });
const GATE_UNVERIFIED: Record<string, Status> = { requirement_gate: 'unverified' };
const AZ_RULES = rules({ ...COMMON, required_threshold: 1000, threshold_comparison: null, 'installments.q4_file_and_pay_date': null, return_due_date: null, 'penalty.rate': 0.07, 'penalty.method': null, 'penalty.min_balance_due': 1000, nonresident_method: 'sourced_flat', requirement_gate: { kind: 'gross_income_both_years', threshold: 75000, threshold_mfj: 150000 } }, GATE_UNVERIFIED);
const GA_RULES = rules({ ...COMMON, 'safe_harbor.current_pct': 0.7, required_threshold: 0, threshold_comparison: null, 'installments.q4_file_and_pay_date': null, return_due_date: null, 'penalty.rate': 0.09, 'penalty.method': null, 'penalty.min_balance_due': null, nonresident_method: 'sourced_flat', requirement_gate: { kind: 'gross_over_exemptions_deductions', non_withheld_floor: 1000 } }, GATE_UNVERIFIED);
const PA_RULES = rules({ ...COMMON, required_threshold: 430, threshold_comparison: null, 'installments.q4_file_and_pay_date': null, return_due_date: null, 'penalty.rate': 0.07, 'penalty.method': null, 'penalty.min_balance_due': null, nonresident_method: 'sourced_flat', requirement_gate: { kind: 'non_withheld_income', threshold: 11000 } }, GATE_UNVERIFIED);
const juris = (state: string, r: StateRuleMap, verifyBadge = false): StateJurisdictionInput => ({ state, rules: r, usesFederalFallback: false, verifyBadge, estimatesRequired: true });
// Q53: the multistate oracle computes the v1 effective-rate formulas, so its rows are pinned to the
// effective-rate override (the rate-schedule path has its own oracle, state_brackets_fixture.py).
const row = (partial: Partial<StateEngineRow> & Pick<StateEngineRow, 'state' | 'residency' | 'effectiveRate'>, gate: Partial<StateGateInputs> = {}): StateEngineRow => ({
  rowId: `row-${partial.state}`, base: 'federal_agi', customBase: null, sourcedIncome: null, sourcedManual: false, creditOverride: null, rateMode: 'effective', ...partial, gate: { ...EMPTY_GATE_INPUTS, ...gate },
});

function expectGate(got: { method: string; required: boolean | null; measured: string | null; threshold: string | null; gateSatisfied: boolean | null }, e: OracleGate): void {
  expect(got.method).toBe(e.method);
  expect(got.required).toBe(e.required);
  // The oracle measures on the whole-dollar AGI of the return; the engine on the exact AGI — within a few cents at a 2.5–4% rate.
  expect(Number(got.measured)).toBeCloseTo(e.measured, 1);
  if (e.threshold == null) expect(got.threshold).toBeNull(); else expect(Number(got.threshold)).toBeCloseTo(e.threshold, 4);
  if (e.gate_satisfied !== undefined) expect(got.gateSatisfied).toBe(e.gate_satisfied);
}

// ── ccorp_fye_june ───────────────────────────────────────────────────
describe('oracle scenario: FYE-June C corporation — large-corporation first-installment rule and recapture (§6655(d)(2), Form 2220)', () => {
  const C = expected['ccorp_fye_june']!;
  const base: CcorpEngineInput = {
    taxYear: 2026, parameters: params, tenantId: 't', companyId: 'ozark', companyName: 'Ozark Fabrication Inc.', fiscalYearStartMonth: 7,
    taxableIncome: '2400000', largeCorporation: false, priorYearsTaxableIncome: ['1100000', '800000', '600000'], priorYear: { tax: '300000', fullTwelveMonths: true },
    states: [{ state: 'MO', apportionmentPct: '0.6', effectiveRate: '0.04' }, { state: 'KS', apportionmentPct: '0.15', effectiveRate: '0.035' }],
  };

  function expectCcorp(r: ReturnType<typeof computeCcorp>, e: OracleCcorp): void {
    expect({ fiscal_year_start: r.fiscalYearStart, fiscal_year_end: r.fiscalYearEnd, taxable_income: n(r.taxableIncome), federal_tax: n(r.federalTax), state_total: n(r.stateTotal), total_tax: n(r.totalTax), large_corporation: r.largeCorporation, large_corporation_source: r.largeCorporationSource, estimates_required: r.estimatesRequired })
      .toEqual({ fiscal_year_start: e.fiscal_year_start, fiscal_year_end: e.fiscal_year_end, taxable_income: e.taxable_income, federal_tax: e.federal_tax, state_total: e.state_total, total_tax: e.total_tax, large_corporation: e.large_corporation, large_corporation_source: e.large_corporation_source, estimates_required: e.estimates_required });
    expect(r.states.map((s) => ({ state: s.state, apportionment_pct: Number(s.apportionmentPct), effective_rate: Number(s.effectiveRate), apportioned: n(s.apportioned), tax: n(s.tax) }))).toEqual(e.states);
    expect({ available: r.priorYearRule.available, applies_to: r.priorYearRule.appliesTo }).toEqual(e.prior_year_rule);
    expect({ current_year: n(r.requiredAnnualPayment.currentYear), prior_year: r.requiredAnnualPayment.priorYear == null ? null : n(r.requiredAnnualPayment.priorYear), required: n(r.requiredAnnualPayment.required) }).toEqual(e.required_annual_payment);
    expect(r.installments.map((i) => ({ number: i.number, fiscal_month: i.fiscalMonth, statutory_due_date: i.statutoryDueDate, due_date: i.dueDate, pct: Number(i.pct), current_year_basis: n(i.currentYearBasis), prior_year_basis: i.priorYearBasis == null ? null : n(i.priorYearBasis), recapture: n(i.recapture), required: n(i.required), cumulative_required: n(i.cumulativeRequired), basis: i.basis })))
      .toEqual(e.installments);
  }

  it('large corporation by the three-year lookback: 75,000 (prior-year base) / 177,000 (incl. 51,000 recapture) / 126,000 / 126,000 on the 15th of fiscal months 4 / 6 / 9 / 12', () => {
    const r = computeCcorp(base);
    expectCcorp(r, C['large'] as OracleCcorp);
    expect(r.warnings.some((w) => w.code === 'TE_CCORP_LARGE_CORP_DERIVED')).toBe(true);
    expect(r.installments.reduce((s, i) => s + n(i.required), 0)).toBe(n(r.requiredAnnualPayment.required));
  });

  it('non-large corporation: lesser of 100% current / 100% prior in four equal installments', () => {
    const r = computeCcorp({ ...base, taxableIncome: '400000', priorYear: { tax: '60000', fullTwelveMonths: true }, priorYearsTaxableIncome: ['300000', '200000', '250000'], states: [] });
    expectCcorp(r, C['non_large'] as OracleCcorp);
    expect(r.installments.every((i) => i.basis === 'prior_year' && i.recapture === '0')).toBe(true);
  });

  it('§6655(f): tax below 500 → no installments required, prior-year rule unavailable (no return)', () => {
    const r = computeCcorp({ ...base, taxableIncome: '2000', priorYear: null, priorYearsTaxableIncome: [], states: [] });
    expectCcorp(r, C['below_minimum'] as OracleCcorp);
    expect(r.warnings.some((w) => w.code === 'TE_CCORP_BELOW_MIN_TAX')).toBe(true);
  });
});

// ── farmer_prior_year ────────────────────────────────────────────────
describe('oracle scenario: farmer qualifying on the prior year only (§6654(i): 66⅔%, one Jan 15 installment, Mar 1 note)', () => {
  const F = expected['farmer_prior_year']!;
  const fed = F['federal'] as OracleFederal;
  const sh = F['safe_harbor'] as { current: number; prior: number; required: number; installment: number; withholding: number; net_required: number };
  const ERIK = 'erik'; const ANNA = 'anna';
  const r = computeFederal(input('mfj',
    [person({ personId: ERIK, role: 'primary', dateOfBirth: '1972-03-03' }), person({ personId: ANNA, role: 'spouse', dateOfBirth: '1974-07-07', w2Wages: '95000' })],
    [entityBase({ companyId: 'farm', companyName: 'Lindqvist Farms', entityType: 'sch_f', ytd: characters({ ordinary: '90000' }), recurringYtd: characters({ ordinary: '90000' }), links: [{ ...linkBase, linkId: 'l-farm', personId: ERIK }] })],
    [interest('5000')],
  ));
  const farmerInput: FarmerEngineInput = {
    taxYear: 2026, filingStatus: 'mfj', parameters: params, primaryPersonId: ERIK,
    currentYear: { byPerson: [{ personId: ERIK, farming: '150000', fishing: '0', totalGross: '155000' }, { personId: ANNA, farming: '0', fishing: '0', totalGross: '95000' }] },
    priorYear: { byPerson: [{ personId: ERIK, farming: '210000', fishing: '0', totalGross: '215000' }, { personId: ANNA, farming: '0', fishing: '0', totalGross: '45000' }] },
    farmerOverride: null, isFisherman: false,
    tax: { currentYearTax: r.federalTotal, priorYearTax: '24000', priorYearFullTwelveMonths: true, priorYearAgi: '190000' },
  };
  const est = (payments: EstimatePayment[]) => estimates('mfj', {
    currentYearTax: r.federalTotal, currentYearAgi: r.exact.agi, withholding: '9000', priorYear: { tax: '24000', agi: '190000', twelveMonths: true, filed: true }, payments,
    policies: { safeHarbor: FARMER_SAFE_HARBOR_POLICY, installments: FARMER_INSTALLMENT_POLICY, schAi: null },
  });

  it('the Sch F return matches every federal line (Sch F is SE income and QBI)', () => {
    expectFederal(r, fed, ERIK);
  });

  it('two-thirds test fails on the current year (60%) and passes on the prior year (80.8%): farmer rules, no 110% variant', () => {
    const f = computeFarmer(farmerInput);
    const t = F['gross_income_test'] as { current: { farming_and_fishing: number; total_gross: number; ratio: number; passes: boolean }; prior: { farming_and_fishing: number; total_gross: number; ratio: number; passes: boolean } };
    expect(f.qualifies).toBe(true);
    expect(f.basis).toBe('prior_year');
    expect(f.jointTest).toBe(true);
    expect(f.tests.map((x) => ({ year: x.year, farmingAndFishing: n(x.farmingAndFishing), totalGross: n(x.totalGross), passes: x.passes })))
      .toEqual([{ year: 'current', ...{ farmingAndFishing: t.current.farming_and_fishing, totalGross: t.current.total_gross, passes: t.current.passes } }, { year: 'prior', farmingAndFishing: t.prior.farming_and_fishing, totalGross: t.prior.total_gross, passes: t.prior.passes }]);
    expect(Number(f.tests[0]!.ratio)).toBeCloseTo(t.current.ratio, 6);
    expect(Number(f.tests[1]!.ratio)).toBeCloseTo(t.prior.ratio, 6);
    expect(f.safeHarbor.regime).toBe('farmer');
    expect(f.safeHarbor.priorPctHighAgi).toBeNull();
    expect({ currentYear: n(f.requiredAnnualPayment!.currentYear), priorYear: n(f.requiredAnnualPayment!.priorYear), required: n(f.requiredAnnualPayment!.required), highAgiApplied: f.requiredAnnualPayment!.highAgiApplied })
      .toEqual({ currentYear: sh.current, priorYear: sh.prior, required: sh.required, highAgiApplied: false });
    expect(f.installments.map((i) => ({ number: i.number, dueDate: i.dueDate, pct: Number(i.pct) }))).toEqual((F['installments'] as Array<{ number: number; due_date: string; pct: number }>).map((i) => ({ number: i.number, dueDate: i.due_date, pct: i.pct })));
    expect(f.fileAndPayByDate).toBe(F['file_and_pay_by']);
    expect(f.notes.some((x) => x.includes('prior year'))).toBe(true);
  });

  it('vouchers: one installment of 100% due Jan 15, 2027, withholding credited in full, paid on time → no penalty', () => {
    const o = F['paid_jan_15'] as OraclePayments & { payment: number };
    const e = est([pay('p', (F['installments'] as Array<{ due_date: string }>)[0]!.due_date, String(o.payment))]);
    expect(e.installments).toHaveLength(1);
    expect(e.installments[0]!.dueDate).toBe('2027-01-15');
    expect(n(e.safeHarbor.currentYear.amount)).toBe(sh.current);
    expect(n(e.safeHarbor.priorYear.amount)).toBe(sh.prior);
    expect(e.safeHarbor.priorYear.highAgiApplied).toBe(false);
    expect(n(e.safeHarbor.requiredAnnualPayment)).toBe(sh.required);
    expect(n(e.installments[0]!.regularInstallment)).toBe(sh.installment);
    expect(n(e.installments[0]!.withholdingShare)).toBe(sh.withholding);
    expect(n(e.installments[0]!.netRequired)).toBe(sh.net_required);
    expect(e.lastInstallmentReliefDate).toBe(F['file_and_pay_by']);
    expectPenalty(e, o);
    expect(e.scheduleAi).toBeNull();
  });

  it('paid Mar 1, 2027 instead: 45 days at the 2027 Q1 rate; the §6654(i)(1)(D) Mar 1 relief is a note, not assumed', () => {
    const o = F['paid_mar_1'] as OraclePayments & { payment: number };
    const e = est([pay('p', F['file_and_pay_by'] as string, String(o.payment))]);
    expectPenalty(e, o);
    expect(e.penalty!.notes.some((x) => x.includes(F['file_and_pay_by'] as string))).toBe(true);
  });
});

// ── passive_ebl ──────────────────────────────────────────────────────
describe('oracle scenario: §469(i) rental allowance phase-out + §461(l) excess business loss with the NOL note', () => {
  const E = expected['passive_ebl']!;
  const fed = E['federal'] as OracleFederal;
  const ll = E['loss_limits'] as { magi: number; allowance_maximum: number; allowance_after_phaseout: number; eligible_loss: number; allowance_used: number; suspended_passive_loss: number; rental_allowed: number; business_net: number; ebl_threshold: number; excess_business_loss: number };
  const MARCUS = 'marcus';
  const r = computeFederal(input('single',
    [person({ personId: MARCUS, role: 'primary', dateOfBirth: '1980-09-09', w2Wages: '380000' })],
    [schC('robotics', MARCUS, '-300000'), rentalLp('cedar', 'Cedar Lane Rentals LLC', MARCUS, '-30000', true)],
  ));

  it('matches every federal line: AGI 124,000 after the 13,000 allowance and the 57,000 EBL add-back; Additional Medicare on wages; no NIIT', () => {
    expectFederal(r, fed, MARCUS);
    expect(n(r.income.rental)).toBe(ll.rental_allowed);
  });

  it('§469(i): MAGI 124,000 (AGI without passive losses, incl. the §461(l) add-back on the nonpassive loss) → allowance 13,000 of the 30,000 eligible loss, 17,000 suspended (Form 8582 Part II)', () => {
    const a = r.lossLimitations.rentalAllowance;
    expect({ variant: a.variant, maximum: n(a.maximum), magi: n(a.magi), afterPhaseOut: n(a.afterPhaseOut), eligibleLoss: n(a.eligibleLoss), used: n(a.used) })
      .toEqual({ variant: 'standard', maximum: ll.allowance_maximum, magi: ll.magi, afterPhaseOut: ll.allowance_after_phaseout, eligibleLoss: ll.eligible_loss, used: ll.allowance_used });
    expect(n(r.lossLimitations.suspendedPassiveLoss)).toBe(ll.suspended_passive_loss);
    expect(r.warnings.some((w) => w.code === 'TE_PASSIVE_ALLOWANCE_PHASED_OUT')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'TE_PASSIVE_LOSS_SUSPENDED')).toBe(true);
  });

  it('§461(l) after §469: business loss 313,000 over the 256,000 threshold → 57,000 disallowed, NOL carryover noted', () => {
    expect({ businessNet: n(r.lossLimitations.businessNet), eblThreshold: n(r.lossLimitations.eblThreshold), excessBusinessLoss: n(r.lossLimitations.excessBusinessLoss) })
      .toEqual({ businessNet: ll.business_net, eblThreshold: ll.ebl_threshold, excessBusinessLoss: ll.excess_business_loss });
    const ebl = r.warnings.find((w) => w.code === 'TE_EXCESS_BUSINESS_LOSS')!;
    expect(ebl.message).toMatch(/net operating loss/);
    expect(r.lossLimitations.notes.some((x) => x.includes('§461(l)') && x.includes('NOL'))).toBe(true);
    expect(r.warnings.some((w) => w.code === 'TE_EBL_QBI_TIMING')).toBe(true);
  });

  it('safe harbor: prior AGI 450,000 → 110% of prior tax, above 90% of current → current-year amount', () => {
    const est = estimates('single', { currentYearTax: r.federalTotal, currentYearAgi: r.exact.agi, withholding: '10000', priorYear: { tax: '90000', agi: '450000', twelveMonths: true, filed: true } });
    expectSafeHarbor(est, E['safe_harbor'] as OracleSafeHarbor);
  });
});

// ── senior_sch1a ─────────────────────────────────────────────────────
describe('oracle scenario: senior couple — Schedule 1-A senior phase-out, car-loan step rounded UP, tips / overtime steps rounded DOWN', () => {
  const S = expected['senior_sch1a']!;
  const SAMIR = 'samir'; const LEILA = 'leila';
  const haddads = (samirWages: string, tips: string, car: string, leilaWages: string, overtime: string, interestAmt: string, qd: string) => computeFederal(input('mfj',
    [
      person({ personId: SAMIR, role: 'primary', dateOfBirth: '1959-05-10', w2Wages: samirWages, sch1a: { qualifiedTips: tips, qualifiedOvertime: '0', carLoanInterest: car } }),
      person({ personId: LEILA, role: 'spouse', dateOfBirth: '1962-01-01', w2Wages: leilaWages, sch1a: { qualifiedTips: '0', qualifiedOvertime: overtime, carLoanInterest: '0' } }),
    ],
    [], [interest(interestAmt), qualifiedDividends(qd)], { itemized: { ...yearBase.itemized, charitableCash: '3000' } },
  ));

  it('MAGI 203,400: seniors 2 × 6,000 less 6% of 53,400 = 8,796 (Leila born Jan 1, 1962 counts as 65); car interest 3,700 less 4 × 200 (3,400 → 4 steps UP) = 2,900; tips and overtime in full', () => {
    const A = S['in_band'] as { federal: OracleFederal; safe_harbor: OracleSafeHarbor };
    const r = haddads('40000', '4300', '3700', '150000', '7500', '6000', '7400');
    expectFederal(r, A.federal, SAMIR);
    expect(r.deductions.standard.additionalCount).toBe(2);
    expect(r.deductions.sch1a.inEffect).toBe(true);
    const est = estimates('mfj', { currentYearTax: r.federalTotal, currentYearAgi: r.exact.agi, withholding: '12000', priorYear: { tax: '30000', agi: '190000', twelveMonths: true, filed: true } });
    expectSafeHarbor(est, A.safe_harbor);
  });

  it('MAGI 302,350: tips 6,200 and overtime 21,000 each less 2 × 100 (2,350 → 2 steps DOWN, 2025 Schedule 1-A lines 11 / 19); car fully phased out (103 steps UP); seniors 2,859', () => {
    const B = S['above_tips_threshold'] as { federal: OracleFederal; safe_harbor: OracleSafeHarbor };
    const r = haddads('45000', '6200', '3700', '240000', '21000', '10000', '7350');
    expectFederal(r, B.federal, SAMIR);
    expect(n(r.otherTaxes.additionalMedicare.wagesAboveThreshold)).toBe(35000);
    expect(n(r.otherTaxes.niit.base)).toBe(B.federal.nii);
    const est = estimates('mfj', { currentYearTax: r.federalTotal, currentYearAgi: r.exact.agi, withholding: '30000', priorYear: { tax: '30000', agi: '190000', twelveMonths: true, filed: true } });
    expectSafeHarbor(est, B.safe_harbor);
  });
});

// ── multistate ───────────────────────────────────────────────────────
describe('oracle scenario: MO resident with KS (credit limited) and AR (full credit) nonresident rows, gates and vouchers', () => {
  const M = expected['multistate']!;
  const fed = M['federal'] as OracleFederal;
  const states = M['states'] as Record<string, OracleStateRow>;
  const vouchers = M['vouchers'] as Record<string, OracleStateVouchers>;
  const CHIDI = 'chidi'; const NGOZI = 'ngozi';
  const federal = computeFederal(input('mfj',
    [person({ personId: CHIDI, role: 'primary', dateOfBirth: '1978-02-02' }), person({ personId: NGOZI, role: 'spouse', dateOfBirth: '1980-04-04', w2Wages: '60000' })],
    [schC('consulting', CHIDI, '120000', { companyName: 'Okafor Consulting' }), schC('kc', CHIDI, '40000', { companyName: 'Okafor KC-Kansas' }), rentalLp('lp', 'Riverbend Flats LP', CHIDI, '12000', false)],
    [interest('2000')],
  ));
  const stateInput: StateEngineInput = {
    taxYear: 2026, filingStatus: 'mfj', parameters: params, federal: federalFiguresFromResult(federal),
    rows: [
      row({ state: 'MO', residency: 'resident', effectiveRate: '0.04' }, { withholding: '2400' }),
      row({ state: 'KS', residency: 'nonresident', effectiveRate: '0.057' }),
      row({ state: 'AR', residency: 'nonresident', effectiveRate: '0.039' }),
    ],
    jurisdictions: [juris('MO', MO_RULES), juris('KS', KS_RULES), juris('AR', AR_RULES)],
    entities: sourcedEntitiesFromFederal(federal, [{ companyId: 'consulting', stateSourcing: 'MO' }, { companyId: 'kc', stateSourcing: 'KS' }, { companyId: 'lp', stateSourcing: 'AR' }]),
  };
  const st = computeState(stateInput);
  const by = (s: string) => st.rows.find((x) => x.state === s)!;

  it('federal return: two Sch C businesses (½ SE allocated pro rata to the §199A components), passive AR rental, spouse wages', () => {
    expectFederal(federal, fed, CHIDI);
    const est = estimates('mfj', { currentYearTax: federal.federalTotal, currentYearAgi: federal.exact.agi, withholding: '5000', priorYear: { tax: '28000', agi: '200000', twelveMonths: true, filed: true } });
    expectSafeHarbor(est, M['safe_harbor'] as OracleSafeHarbor);
  });

  it('derived sourcing: KS 40,000 and AR 12,000 from the entities\' state_sourcing; MO credit 1,600 (limited) + 468 (full) = 2,068', () => {
    const src = M['sourcing'] as Record<string, { income: number }>;
    expect(n(by('KS').sourcedIncome)).toBe(src['KS']!.income);
    expect(n(by('AR').sourcedIncome)).toBe(src['AR']!.income);
    expect(by('KS').sourcedDerived && by('AR').sourcedDerived).toBe(true);
    for (const s of ['MO', 'KS', 'AR']) {
      const e = states[s]!; const g = by(s);
      expect({ gross_tax: n(g.grossTax), credit: n(g.creditForOtherStates), net_tax: n(g.netTax) }).toEqual({ gross_tax: e.gross_tax, credit: e.credit, net_tax: e.net_tax });
    }
    expect(by('MO').creditDetails.map((d) => ({ state: d.state, other_state_tax: n(d.otherStateTax), resident_rate_on_sourced: n(d.residentRateOnSourced), allowed: n(d.allowed), limited: n(d.otherStateTax) > n(d.residentRateOnSourced) })))
      .toEqual(states['MO']!.credit_details);
    expect(n(st.stateTotal)).toBe(M['state_total'] as number);
  });

  it('gates: MO ≥ 100 after withholding → required; KS 2,280 ≥ 500 → required; AR 468 not more than 1,000 → not required', () => {
    for (const s of ['MO', 'KS', 'AR']) expectGate(by(s).gate, states[s]!.gate);
  });

  it('MO vouchers: lesser of 90% current / 100% prior (no high-AGI rule), 600 withholding per quarter; nothing paid → 7% penalty, 2027 days on the fallback rate (verify)', () => {
    const e = vouchers['MO']!;
    const v = computeStateEstimates({
      taxYear: 2026, filingStatus: 'mfj', parameters: params, state: 'MO', jurisdiction: juris('MO', MO_RULES), stateTax: by('MO').netTax, currentYearAgi: federal.exact.agi, gate: by('MO').gate,
      withholding: '2400', priorYear: { tax: '6000', agi: null, twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default', payments: [],
    } satisfies StateEstimatesInput);
    expect(v.estimatesRequired).toBe(true);
    expect({ current: n(v.safeHarbor.currentYear.amount), prior: n(v.safeHarbor.priorYear.amount), required: n(v.safeHarbor.requiredAnnualPayment) }).toEqual({ current: e.current, prior: e.prior, required: e.required });
    expect(v.installments.map((i) => i.dueDate)).toEqual(e.due_dates);
    expect(v.installments.map((i) => n(i.regularInstallment))).toEqual(Array(4).fill(e.installment));
    expect(v.installments.map((i) => n(i.withholdingShare))).toEqual(Array(4).fill(e.withholding_per_q));
    expect(v.installments.map((i) => n(i.netRequired))).toEqual(Array(4).fill(e.net_per_installment));
    expect(v.returnDueDate).toBe(e.return_due);
    expect(v.penalty!.waiver).toBeNull();
    expectPenalty(v, e);
    expect(v.penalty!.installments[2]!.segments.some((s) => s.rateUncovered)).toBe(true);
  });

  it('KS vouchers: no prior-year KS tax → 90% of current, 513 per quarter; Q1 + Q2 paid Jul 1 → 8% for 77 / 16 days, Q3 / Q4 accrue to Apr 15, 2027 across Dec 31', () => {
    const e = vouchers['KS']!;
    const v = computeStateEstimates({
      taxYear: 2026, filingStatus: 'mfj', parameters: params, state: 'KS', jurisdiction: juris('KS', KS_RULES), stateTax: by('KS').netTax, currentYearAgi: federal.exact.agi, gate: by('KS').gate,
      withholding: '0', priorYear: { tax: null, agi: null, twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default',
      payments: e.payments.map((p, i) => pay(`ks${i}`, p.date, String(p.amount), 'KS')),
    } satisfies StateEstimatesInput);
    expect(v.estimatesRequired).toBe(true);
    expect(n(v.safeHarbor.currentYear.amount)).toBe(e.current);
    expect(v.safeHarbor.priorYear.amount == null || n(v.safeHarbor.priorYear.amount) === 0).toBe(true);
    expect(n(v.safeHarbor.requiredAnnualPayment)).toBe(e.required);
    expect(v.installments.map((i) => n(i.regularInstallment))).toEqual(Array(4).fill(e.installment));
    expect(v.returnDueDate).toBe(e.return_due);
    expect(v.penalty!.waiver).toBeNull();
    expectPenalty(v, e);
    expect(v.penalty!.installments.every((i) => i.segments.every((s) => !s.rateUncovered))).toBe(true);
  });

  it('AR: estimates not required (gate) → no vouchers, no penalty', () => {
    const v = computeStateEstimates({
      taxYear: 2026, filingStatus: 'mfj', parameters: params, state: 'AR', jurisdiction: juris('AR', AR_RULES), stateTax: by('AR').netTax, currentYearAgi: federal.exact.agi, gate: by('AR').gate,
      withholding: '0', priorYear: { tax: null, agi: null, twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default', payments: [],
    } satisfies StateEstimatesInput);
    expect(v.estimatesRequired).toBe(false);
    expect(v.installments).toEqual([]);
    expect(v.penalty).toBeNull();
  });
});

// ── multistate_gates ─────────────────────────────────────────────────
describe('oracle scenario: AZ resident with GA / PA nonresident rows — the two-year gross-income, gross-over-exemptions and non-withheld-income gates', () => {
  const G = expected['multistate_gates']!;
  const fed = G['federal'] as { total_income: number; agi: number; deduction: number; federal_total: number };
  const states = G['states'] as Record<string, OracleStateRow & { effective_rate: number }>;
  const KENJI = 'kenji';
  const federal = computeFederal(input('single',
    [person({ personId: KENJI, role: 'primary', dateOfBirth: '1985-05-05', w2Wages: '90000' })],
    [
      schC('ga-consulting', KENJI, '9000'),
      entityBase({ companyId: 'pa-lp', companyName: 'Keystone Partners', entityType: 'partnership', ytd: characters({ ordinary: '15000' }), recurringYtd: characters({ ordinary: '15000' }), links: [{ ...linkBase, linkId: 'l-pa-lp', personId: KENJI, partnerSeStatus: 'general' }] }),
    ],
  ));
  const st = computeState({
    taxYear: 2026, filingStatus: 'single', parameters: params, federal: federalFiguresFromResult(federal),
    rows: [
      row({ state: 'AZ', residency: 'resident', effectiveRate: '0.025' }, { withholding: '1000', priorYearGrossIncome: '80000' }),
      row({ state: 'GA', residency: 'nonresident', effectiveRate: '0.0539', sourcedManual: true, sourcedIncome: '9000' }, { grossIncome: '9000', exemptions: '0' }),
      row({ state: 'PA', residency: 'nonresident', effectiveRate: '0.0307', sourcedManual: true, sourcedIncome: '15000' }, { nonWithheldIncome: '24000' }),
    ],
    jurisdictions: [juris('AZ', AZ_RULES, true), juris('GA', GA_RULES, true), juris('PA', PA_RULES, true)],
    entities: [],
  });
  const by = (s: string) => st.rows.find((x) => x.state === s)!;

  it('federal figures the gates read: total income 114,000, AGI, standard deduction', () => {
    expect({ total_income: n(federal.income.totalIncome), agi: n(federal.agi), deduction: n(federal.deductions.deduction), federal_total: n(federal.federalTotal) }).toEqual(fed);
  });

  it('AZ resident 2.5% less GA / PA credits (each limited to the AZ rate on the sourced income); GA and PA nonresident flat', () => {
    for (const s of ['AZ', 'GA', 'PA']) {
      const e = states[s]!; const g = by(s);
      expect({ gross_tax: n(g.grossTax), credit: n(g.creditForOtherStates), net_tax: n(g.netTax) }).toEqual({ gross_tax: e.gross_tax ?? e.net_tax, credit: e.credit ?? 0, net_tax: e.net_tax });
    }
  });

  it('AZ: gross income over 75,000 in both years AND ≥ 1,000 after withholding → required; GA: 9,000 gross not over exemptions + deductions + 1,000 → not required; PA: 24,000 non-withheld income > 11,000 → required', () => {
    for (const s of ['AZ', 'GA', 'PA']) expectGate(by(s).gate, states[s]!.gate);
    expect(by('AZ').gate.gateKind).toBe('gross_income_both_years');
    expect(by('GA').gate.gateKind).toBe('gross_over_exemptions_deductions');
    expect(by('PA').gate.gateKind).toBe('non_withheld_income');
    // The seeded requirement_gate rows are not CPA-verified: every gate carries the verify badge and a D12a warning.
    expect(st.rows.every((x) => x.gate.verify)).toBe(true);
    expect(st.warnings.filter((w) => w.code === 'TE_STATE_RULE_UNVERIFIED').map((w) => `${w.details!['state']}:${w.details!['key']}`)).toEqual(expect.arrayContaining(['AZ:requirement_gate', 'GA:requirement_gate', 'PA:requirement_gate']));
  });
});
