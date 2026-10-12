// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10 golden test (MODULE.md "Tests"): computeFederalEstimates and
// computeStateEstimates must match the oracle blocks `safe_harbor`,
// `schedule_ai_period3` and `missouri` in
// features/tax-estimator/docs/reference-calc/rivera_expected.json, with the
// Schedule AI column priced by the REAL federal engine (computeFederal injected
// as the calculator). Parameters are the shipped 2026 federal seed file, read
// as text so the test cannot drift from what ships (and so this package's tsc
// never sees the api package).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import { computeFederalEstimates, computeStateEstimates, type FederalEstimatesInput, type StateEstimatesInput } from './vouchers.js';
import type { EstimatePayment } from './payments.js';
import type { StateJurisdictionInput, StateRuleMap, StateEstimateGate } from './state-types.js';
import type { EngineAdjustment, EngineEntity, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';
import { dDiv, dMul } from '../decimal.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'rivera_expected.json'), 'utf8')) as Record<string, Record<string, unknown>>;
const SH = expected['safe_harbor']!;
const AI = expected['schedule_ai_period3']!;
const MO = expected['missouri']!;
const BASE = expected['base']!;
interface OracleRow { q: string; due: string; required: number; withholding: number; from_estimates: number; paid: number | null; short: number; over: number }
interface OraclePenaltyRow { q: string; due: string; still_unpaid_at_return_due: number; paid_in_full_on: string | null; penalty: number }

/** Every row of the shipped 2026 federal seed, as the engine's parameter map. */
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

// ── Rivera federal input (mirrors federal.golden.test.ts) ────────────
const CARLOS = 'carlos'; const MARIA = 'maria';
const allMonths = (): boolean[] => Array(12).fill(true) as boolean[];
const persons = (): EnginePerson[] => [
  { personId: CARLOS, role: 'primary', displayName: 'Carlos Rivera', dateOfBirth: '1981-05-10', isBlind: false, sehiEligibleMonths: allMonths(), w2Wages: '0', w2SocialSecurityWages: null, withholding: '0', retirementPlan: 'sep', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' } },
  { personId: MARIA, role: 'spouse', displayName: 'Maria Rivera', dateOfBirth: '1983-09-22', isBlind: false, sehiEligibleMonths: allMonths(), w2Wages: '0', w2SocialSecurityWages: null, withholding: '6000', retirementPlan: 'none', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' } },
];
const entityBase = (over: Partial<EngineEntity>): EngineEntity => ({
  tenantId: 'tenant-rivera', companyId: 'c', companyName: 'Co', entityType: 'sch_c', monthsElapsed: 12, monthsRemaining: 0,
  ytd: characters({}), recurringYtd: characters({}), ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
  links: [], isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [], ...over,
});
const linkBase = { profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active' as const, activeParticipation: false, qbiEligible: null, allowedLossOverride: null };
const adjBase: EngineAdjustment = { id: '', label: '', typeCode: null, kind: 'income', amount: '0', pct: null, personId: null, linkId: null, affectsSe: false, affectsQbi: false, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false, isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false };

/** Full-year Rivera; `months` < 12 gives the ACTUALS Jan 1 – month end for a level year (Schedule AI column input). */
function rivera(months = 12): FederalEngineInput {
  const s = (v: string) => (months === 12 ? v : dDiv(dMul(v, String(months)), '12'));
  const remaining = 12 - months;
  return {
    taxYear: 2026, filingStatus: 'mfj', parameters: params, persons: persons(),
    entities: [
      entityBase({ companyId: 'schc', companyName: 'Rivera Plumbing (Sch C)', entityType: 'sch_c', monthsElapsed: months, monthsRemaining: remaining, ytd: characters({ ordinary: s('128000') }), recurringYtd: characters({ ordinary: s('128000') }),
        ownerItems: [{ personId: null, sehi: s('10800'), retirement: '0', sehiAsW2Wages: '0' }], links: [{ ...linkBase, linkId: 'l-schc', personId: CARLOS }] }),
      entityBase({ companyId: 'scorp', companyName: 'Maria Designs Inc (S corp)', entityType: 's_corp', monthsElapsed: months, monthsRemaining: remaining, ytd: characters({ ordinary: s('80000') }), recurringYtd: characters({ ordinary: s('80000') }),
        officerWages: [{ personId: MARIA, amount: s('54000') }], links: [{ ...linkBase, linkId: 'l-scorp', personId: MARIA, isOfficer: true, profitPct: 50 }] }),
      entityBase({ companyId: 'lp', companyName: 'Oak Street Rentals LP', entityType: 'partnership', monthsElapsed: months, monthsRemaining: remaining, ytd: characters({ rental: s('8000') }), recurringYtd: characters({ rental: s('8000') }),
        links: [{ ...linkBase, linkId: 'l-lp', personId: CARLOS, partnerSeStatus: 'limited', activityType: 'rental' }] }),
    ],
    adjustments: [
      { ...adjBase, id: 'interest', label: 'Interest income', typeCode: 'interest_income', kind: 'income', amount: s('2400') },
      { ...adjBase, id: 'sep', label: 'SEP contribution', typeCode: 'sep_solo_401k', kind: 'deduction', amount: s('15000'), isAboveTheLine: true, personId: CARLOS },
    ],
    year: { rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' }, creditsNonrefundable: '2200', creditsRefundable: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false },
    qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null },
  };
}

const base = rivera();
const baseResult = computeFederal(base);
const DUE = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];
const pay = (id: string, date: string, amount: string, jurisdiction = 'federal'): EstimatePayment => ({ id, date, amount, source: 'manual', jurisdiction });
const riveraPayments = (withQ4: boolean): EstimatePayment[] => [pay('q1', DUE[0]!, '6600'), pay('q2', DUE[1]!, '6600'), pay('q3', DUE[2]!, '6000'), ...(withQ4 ? [pay('q4', DUE[3]!, '7046.1')] : [])];

function federalInput(withQ4: boolean, over: Partial<FederalEstimatesInput> = {}): FederalEstimatesInput {
  return {
    taxYear: 2026, filingStatus: 'mfj', parameters: params,
    currentYearTax: baseResult.federalTotal, currentYearAgi: baseResult.exact.agi, withholding: '6000',
    priorYear: { tax: '31500', agi: '182000', twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default',
    payments: riveraPayments(withQ4),
    scheduleAi: { base, baseResult, periodActuals: [null, null, rivera(8)], calc: computeFederal },
    ...over,
  };
}

describe('Rivera federal estimates (oracle safe_harbor + schedule_ai_period3 blocks)', () => {
  it('the base engine still matches the oracle federal total (precondition)', () => {
    expect(baseResult.federalTotal).toBe(String(BASE['federal_total']));
  });

  it('safe harbor: 90% current 32,246, 110% prior 34,650 (prior AGI 182,000 > 150,000), lesser of → 32,246; installment 8,062', () => {
    const r = computeFederalEstimates(federalInput(false));
    expect(r.safeHarbor.currentYear.amount).toBe(String(SH['current_90']));
    expect(r.safeHarbor.priorYear.amount).toBe(String(SH['prior_110']));
    expect(r.safeHarbor.priorYear.highAgiApplied).toBe(true);
    expect(r.safeHarbor.requiredAnnualPayment).toBe(String(SH['required_lesser_of']));
    expect(r.estimatesRequired).toBe(true);
    for (const inst of r.installments) {
      expect(inst.regularInstallment).toBe(String(SH['installment']));
      expect(inst.required).toBe(String(SH['installment']));
      expect(inst.withholdingShare).toBe(String(SH['withholding_per_q']));
    }
  });

  it('voucher schedule: Q1 over 38 and Q2 over 77 carried, Q3 short 485, Q4 voucher 7,046 (oracle schedule rows)', () => {
    const r = computeFederalEstimates(federalInput(false));
    const rows = SH['schedule'] as OracleRow[];
    expect(r.installments.map((i) => i.dueDate)).toEqual(rows.map((x) => x.due));
    expect(r.installments.map((i) => i.label)).toEqual(rows.map((x) => x.q));
    // Oracle from_estimates = each installment's need (required − withholding − carry) for Q1–Q3; for Q4 it is the catch-up
    // amount including the Q3 shortfall. In the ledger the Q4 withholding share (Jan 15) cures Q3 first, so Q3 reads as paid
    // on Jan 15 and the whole 7,046 sits on Q4 — same total, same penalty.
    expect(r.installments.slice(0, 3).map((i) => Number(i.netRequired))).toEqual(rows.slice(0, 3).map((x) => x.from_estimates));
    expect(r.installments.slice(1).map((i) => Number(i.carriedIn))).toEqual(rows.slice(0, 3).map((x) => x.over));
    expect(r.installments[2]!.paidInFullOn).toBe(DUE[3]);
    expect(r.installments[3]!.catchUpAmount).toBe(String(SH['q4_due_from_estimates']));
    expect(r.installments.map((i) => Number(i.unpaid))).toEqual([0, 0, 0, rows[3]!.from_estimates]);
    expect(r.installments.map((i) => i.status)).toEqual(['paid', 'paid', 'paid', 'unpaid']);
    expect(r.totals.unpaid).toBe(String(SH['q4_due_from_estimates']));
    // The Q3 shortfall of 485 is what accrues Sep 15 → Jan 15 (see the penalty test).
    expect(r.penalty!.installments[2]!.segments.map((s) => [Math.round(Number(s.balance)), s.from, s.to])).toEqual([[rows[2]!.short, DUE[2], DUE[3]]]);
  });

  it('penalty: Q3 shortfall cured by the Jan 15 payment → ≈ $11 total; every installment paid in full on the oracle dates', () => {
    const r = computeFederalEstimates(federalInput(true));
    const rows = SH['penalty_by_installment'] as OraclePenaltyRow[];
    expect(r.penalty!.installments.map((i) => Number(i.penalty))).toEqual(rows.map((x) => x.penalty));
    expect(r.penalty!.total).toBe(String(SH['penalty_total_if_q4_paid_on_time']));
    expect(r.payments!.installments.map((i) => i.paidInFullOn)).toEqual(rows.map((x) => x.paid_in_full_on));
    expect(r.payments!.installments.map((i) => Number(i.unpaidAtEnd))).toEqual(rows.map((x) => x.still_unpaid_at_return_due));
    expect(r.penalty!.waiver).toBeNull();
    expect(r.penalty!.method).toBe('daily_simple');
    expect(r.returnDueDate).toBe('2027-04-15');
    expect(r.lastInstallmentReliefDate).toBe('2027-02-01');
    expect(r.installments.every((i) => i.status === 'paid')).toBe(true);
    expect(r.totals.unpaid).toBe('0');
  });

  it('Schedule AI period 3 (Jan–Aug actuals × 1.5) priced by the real engine matches the oracle column', () => {
    const r = computeFederalEstimates(federalInput(false));
    const p3 = r.scheduleAi!.periods[2]!;
    expect(p3.available).toBe(true);
    expect(p3.periodEnd).toBe(AI['period_end']);
    expect(p3.factor).toBe(String(AI['annualization_factor']));
    expect(p3.applicablePct).toBe(String(AI['applicable_pct']));
    expect(p3.annualizedAgi).toBe(String(AI['annualized_agi']));
    expect(p3.standardDeductionFullYear).toBe(String(AI['std_deduction_full_year']));
    expect(p3.annualizedQbi).toBe(String(AI['annualized_qbi']));
    expect(p3.annualizedTaxableIncome).toBe(String(AI['annualized_taxable_income']));
    expect(p3.annualizedIncomeTax).toBe(String(AI['annualized_income_tax']));
    expect(p3.annualizedSeTax).toBe(String(AI['annualized_se_tax']));
    expect(p3.engineSeTax).toBe(String(AI['annualized_se_tax']));
    expect(p3.annualizedTotalTax).toBe(String(AI['annualized_total_tax']));
    expect(p3.requiredCumulative).toBe(String(AI['required_cumulative_through_period']));
    expect(p3.creditsFullYear).toBe('2200');
    // Level income: the annualized column reproduces three regular installments; nothing is lowered.
    expect(p3.usedAnnualized).toBe(false);
    expect(r.scheduleAi!.lowersAnyInstallment).toBe(false);
    expect(r.scheduleAi!.requiredInstallments).toEqual(r.installments.map((i) => i.regularInstallment));
    expect(r.scheduleAi!.periods[3]!.isProjection).toBe(true);
    expect(r.scheduleAi!.periods[3]!.annualizedTotalTax).toBe(baseResult.federalTotal);
    expect(r.warnings.filter((w) => w.code === 'TE_SCH_AI_PERIOD_MISSING')).toHaveLength(2);
    expect(r.warnings.filter((w) => w.code === 'TE_SCH_AI_ASSUMPTION').map((w) => w.message.slice(0, 4))).toEqual(expect.arrayContaining(['Q13a', 'Q13b']));
  });

  it('D12a: the unverified 2027 penalty-rate placeholder is warned once; verified keys are not', () => {
    const r = computeFederalEstimates(federalInput(true));
    const flagged = r.warnings.filter((w) => w.code === 'TE_PARAM_UNVERIFIED').map((w) => w.details!['key']);
    expect(flagged).toContain('penalty.underpayment_rate');
    expect(flagged).not.toContain('safe_harbor.current_pct');
    expect(r.parametersUsed.map((u) => u.key)).toEqual(expect.arrayContaining(['safe_harbor.current_pct', 'safe_harbor.prior_pct_high_agi', 'safe_harbor.high_agi_threshold.standard', 'installments.due_dates', 'installments.pcts', 'return_due_date', 'installments.q4_file_and_pay_date', 'holidays', 'penalty.underpayment_rate', 'sch_ai.period_ends']));
    expect(r.trace.map((t) => t.step)).toEqual(expect.arrayContaining(['safe_harbor', 'installments', 'schedule_ai', 'payments', 'penalty', 'vouchers']));
  });

  it('prior-year overpayment counts as paid on Apr 15 (prior return due date) and is applied to Q1', () => {
    const r = computeFederalEstimates(federalInput(false, { payments: [], priorYearOverpayment: { amount: '7000' } }));
    const q1 = r.payments!.installments[0]!;
    expect(q1.applied.map((a) => [a.source, a.date, a.amount])).toEqual([['withholding', '2026-04-15', '1500'], ['prior_year_overpayment', '2026-04-15', '6561.525']]);
    expect(r.installments[1]!.carriedIn).toBe('438');
  });

  it('§6654(e)(1): tax less withholding below 1,000 → no estimates, no penalty', () => {
    const r = computeFederalEstimates(federalInput(false, { currentYearTax: '6800', payments: [], scheduleAi: null }));
    expect(r.estimatesRequired).toBe(false);
    expect(r.installments).toEqual([]);
    expect(r.penalty).toBeNull();
    expect(r.estimatesRequiredReason).toMatch(/below 1000/);
  });

  it('zero prior-year tax: lesser_of requires nothing; current_year keeps the schedule but waives the penalty', () => {
    const zero = { tax: '0', agi: '50000', twelveMonths: true, filed: true };
    const lesser = computeFederalEstimates(federalInput(false, { priorYear: zero, payments: [], scheduleAi: null }));
    expect(lesser.estimatesRequired).toBe(false);
    const current = computeFederalEstimates(federalInput(false, { priorYear: zero, payments: [], scheduleAi: null, rule: 'current_year', ruleSource: 'taxpayer' }));
    expect(current.estimatesRequired).toBe(true);
    expect(current.penalty!.waiver!.reason).toBe('prior_year_zero_tax');
    expect(current.penalty!.total).toBe('0');
    expect(Number(current.penalty!.totalBeforeWaiver)).toBeGreaterThan(0);
  });
});

// ── States ───────────────────────────────────────────────────────────
type Status = 'verified' | 'unverified' | 'provisional';
function rules(entries: Record<string, unknown>, status: Status = 'verified'): StateRuleMap {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { key, value, status }]));
}
/** MO / AR 2026 seed values the estimate path reads (all verified in the shipped seeds). */
const MO_RULES = {
  has_income_tax: true, estimates_required: true, required_threshold: 100, threshold_comparison: 'at_least',
  'safe_harbor.current_pct': 0.9, 'safe_harbor.prior_pct': 1.0, 'safe_harbor.high_agi_rule': null,
  'installments.due_dates': ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'], 'installments.pcts': [0.25, 0.25, 0.25, 0.25], 'installments.q4_file_and_pay_date': '2027-02-01', 'return_due_date': '2027-04-15',
  'penalty.rate_source': 'state', 'penalty.rate': 0.07, 'penalty.rate_schedule': [{ from: '2026-01-01', to: '2026-12-31', rate: 0.07 }], 'penalty.method': 'daily_simple', 'penalty.min_balance_due': 500,
  credit_for_other_state: true, nonresident_method: 'ratio', holidays: ['2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-05-08', '2026-05-25', '2026-06-19', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
};
const AR_RULES = { ...MO_RULES, required_threshold: 1000, threshold_comparison: 'more_than', 'penalty.rate': 0.1, 'penalty.rate_schedule': null, 'penalty.min_balance_due': null };
const juris = (state: string, r: StateRuleMap, extra: Partial<StateJurisdictionInput> = {}): StateJurisdictionInput => ({ state, rules: r, usesFederalFallback: false, verifyBadge: false, estimatesRequired: true, ...extra });
const gate = (state: string, required: boolean | null, threshold: string, comparison: 'at_least' | 'more_than' = 'at_least'): StateEstimateGate => ({ state, method: 'threshold', required, threshold, comparison, measured: null, gateKind: null, gateSatisfied: null, verify: false, notes: [], ruleKeys: [] });

function stateInput(over: Partial<StateEstimatesInput>): StateEstimatesInput {
  return {
    taxYear: 2026, filingStatus: 'mfj', parameters: params, state: 'MO', jurisdiction: juris('MO', rules(MO_RULES)),
    stateTax: String(BASE['mo']), currentYearAgi: baseResult.exact.agi, gate: gate('MO', true, '100'), withholding: '2000',
    priorYear: { tax: '7050', agi: null, twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default', payments: [],
    ...over,
  };
}

describe('Rivera state estimates (oracle missouri block + AR)', () => {
  it('Missouri: 90% current 6,831 vs 100% prior 7,050 → 6,831; withholding 2,000; 1,208 per installment from estimates', () => {
    const r = computeStateEstimates(stateInput({ payments: MO_RULES['installments.due_dates'].map((d, i) => pay(`mo${i}`, d, '1207.75', 'MO')) }));
    expect(r.penalty!.total).toBe('0');
    expect(r.safeHarbor.currentYear.amount).toBe(String(MO['current_90']));
    expect(r.safeHarbor.priorYear.amount).toBe(String(MO['prior_100']));
    expect(r.safeHarbor.requiredAnnualPayment).toBe(String(MO['required']));
    expect(r.totals.withholding).toBe(String(MO['withholding']));
    expect(r.estimatesRequired).toBe(true);
    expect(r.installments).toHaveLength(4);
    for (const i of r.installments) expect(i.netRequired).toBe(String(MO['per_installment_from_estimates']));
    expect(r.installments.map((i) => i.dueDate)).toEqual(MO_RULES['installments.due_dates']);
    expect(r.usesFederalFallback).toBe(false);
    expect(r.verify).toBe(false);
    expect(r.penalty!.method).toBe('daily_simple');
    expect(r.penalty!.waiver).toBeNull();
    expect(r.lastInstallmentReliefDate).toBe('2027-02-01');
    expect(r.warnings.filter((w) => w.code === 'TE_STATE_RULE_UNVERIFIED')).toEqual([]);
    expect(r.rulesUsed.map((u) => u.key)).toEqual(expect.arrayContaining(['safe_harbor.current_pct', 'safe_harbor.prior_pct', 'installments.due_dates', 'penalty.rate_schedule', 'penalty.min_balance_due']));
  });

  it('Missouri penalty: the state rate schedule (7%) accrues on a late Q1; 2027 days fall back to penalty.rate with verify', () => {
    const r = computeStateEstimates(stateInput({ payments: [pay('late', '2026-07-15', '1207.75', 'MO')] }));
    const q1 = r.penalty!.installments[0]!;
    // Q2's withholding share (Jun 15) reduces the Q1 balance first: 1,207.75 for 61 days, then 707.75 for 30 days.
    expect(q1.segments.map((s) => [s.from, s.to, s.units, s.rate, s.balance])).toEqual([['2026-04-15', '2026-06-15', 61, '0.07', '1207.75'], ['2026-06-15', '2026-07-15', 30, '0.07', '707.75']]);
    expect(Number(q1.exact)).toBeCloseTo((1207.75 * 61 + 707.75 * 30) * 0.07 / 365, 6);
    expect(r.penalty!.installments[3]!.segments.some((s) => s.rateUncovered)).toBe(true);
    expect(r.penalty!.verify).toBe(true);
  });

  it('Missouri $500 floor: tax less withholding under 500 → estimates still due (≥ 100) but no penalty', () => {
    const r = computeStateEstimates(stateInput({ stateTax: '2400', withholding: '2000' }));
    expect(r.estimatesRequired).toBe(true);
    expect(r.penalty!.waiver!.reason).toBe('below_min_balance');
    expect(r.penalty!.total).toBe('0');
  });

  it('Arkansas: under the $1,000 threshold (gate not required) → no vouchers, no penalty; safe harbor still shown', () => {
    const r = computeStateEstimates(stateInput({ state: 'AR', jurisdiction: juris('AR', rules(AR_RULES)), stateTax: String(BASE['ar']), gate: gate('AR', false, '1000', 'more_than'), withholding: '0', priorYear: { tax: '300', agi: null, twelveMonths: true, filed: true } }));
    expect(r.estimatesRequired).toBe(false);
    expect(r.installments).toEqual([]);
    expect(r.penalty).toBeNull();
    expect(r.safeHarbor.currentYear.amount).toBe(String(Math.round(Number(BASE['ar']) * 0.9)));
    expect(r.estimatesRequiredReason).toMatch(/not required/);
  });

  it('unverified rules warn (D12a) and set the verify badge', () => {
    const r = computeStateEstimates(stateInput({ jurisdiction: juris('MO', rules(MO_RULES, 'unverified'), { verifyBadge: true }) }));
    expect(r.verify).toBe(true);
    expect(r.warnings.filter((w) => w.code === 'TE_STATE_RULE_UNVERIFIED').map((w) => w.details!['key'])).toEqual(expect.arrayContaining(['safe_harbor.current_pct', 'installments.due_dates', 'penalty.rate_schedule']));
  });

  it('a state without rules falls back to the federal pattern with verify + warning', () => {
    const r = computeStateEstimates(stateInput({ state: 'XX', jurisdiction: null, gate: null }));
    expect(r.usesFederalFallback).toBe(true);
    expect(r.verify).toBe(true);
    expect(r.warnings.some((w) => w.code === 'TE_STATE_RULES_FALLBACK')).toBe(true);
    expect(r.safeHarbor.currentYear.pct).toBe('0.9');
    expect(r.installments.map((i) => i.dueDate)).toEqual(DUE);
    expect(r.safeHarbor.policy).toMatch(/verify/);
  });

  it('no quarterly regime (estimates_required = false, ID/UT) → no vouchers, no penalty', () => {
    const r = computeStateEstimates(stateInput({ state: 'ID', jurisdiction: juris('ID', rules({ ...MO_RULES, estimates_required: false }), { estimatesRequired: false }), gate: null }));
    expect(r.estimatesRequired).toBe(false);
    expect(r.installments).toEqual([]);
    expect(r.estimatesRequiredReason).toMatch(/no quarterly/);
  });

  it('state high-AGI rule and CA-style current-AGI cutoff are read from safe_harbor.high_agi_rule', () => {
    const high = computeStateEstimates(stateInput({ jurisdiction: juris('MO', rules({ ...MO_RULES, 'safe_harbor.high_agi_rule': { threshold: 150000, pct: 1.1, no_prior_year_agi: 1000000 } })), priorYear: { tax: '7050', agi: '182000', twelveMonths: true, filed: true } }));
    expect(high.safeHarbor.priorYear.highAgiApplied).toBe(true);
    expect(high.safeHarbor.priorYear.amount).toBe('7755');
    const cut = computeStateEstimates(stateInput({ jurisdiction: juris('CA', rules({ ...MO_RULES, 'safe_harbor.high_agi_rule': { threshold: 150000, pct: 1.1, no_prior_year_agi: 100000 } })), state: 'CA', priorYear: { tax: '7050', agi: '182000', twelveMonths: true, filed: true } }));
    expect(cut.safeHarbor.priorYear.unavailableReason).toBe('current_agi_cutoff');
  });

  it('state due dates roll past the state holidays; federal-source penalty rate uses the federal schedule', () => {
    const r = computeStateEstimates(stateInput({ jurisdiction: juris('MO', rules({ ...MO_RULES, holidays: ['2026-04-15'], 'penalty.rate_source': 'federal' })), payments: [pay('late', '2026-07-15', '1207.75', 'MO')] }));
    expect(r.installments[0]!.dueDate).toBe('2026-04-16');
    expect(r.installments[0]!.statutoryDueDate).toBe('2026-04-15');
    expect(r.penalty!.installments[0]!.segments.map((s) => [s.from, s.rate])).toEqual([['2026-04-16', '0.06'], ['2026-06-15', '0.06'], ['2026-07-01', '0.07']]);
    expect(r.parametersUsed.some((u) => u.key === 'penalty.underpayment_rate')).toBe(true);
  });
});
