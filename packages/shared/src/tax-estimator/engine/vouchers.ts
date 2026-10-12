// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md "Safe harbor, Schedule AI, vouchers, penalties" — the Phase 10
// orchestrators. One call per jurisdiction:
//   computeFederalEstimates  safe harbor → regular installments → Schedule AI
//                            (lesser-of with recapture) → payments → §6654
//                            penalty → vouchers (holiday-adjusted due dates).
//   computeStateEstimates    the same pattern driven by `state_estimate_rules`
//                            (current/prior pct, high-AGI rule, due dates, pcts,
//                            q4 file-and-pay date, return due date, penalty rate /
//                            schedule / method / min balance, holidays); a
//                            jurisdiction without verified rules falls back to the
//                            federal pattern with "verify" (D12a: every non-verified
//                            key read warns through the readers).
// Phase 9 plugs in through the policies: SafeHarborPolicy (pct keys / explicit
// overrides), InstallmentPolicy (explicit due-date list, single-date key, pcts,
// relief-date key), SchAiPolicy (or null to skip), and a caller-supplied waiver.

import type { FilingStatus } from '../types.js';
import type { TaxEstimatorWarning } from '../entities-api.js';
import type { PenaltyMethod, ThresholdComparison } from '../stateRuleKeys.js';
import { PENALTY_METHODS, statePenaltyRateOn } from '../stateRuleKeys.js';
import { ZERO, ONE, dAdd, dCmp, dIsPos, dMul, dRoundDollars, dSub, dSum, dec, type Dec } from '../decimal.js';
import { nextBusinessDay, rollDateToYear } from '../dates.js';
import type { ParameterMap, ParameterUse } from './types.js';
import type { StateEstimateGate, StateJurisdictionInput, StateRuleReader, StateRuleUse } from './state-types.js';
import { meetsThreshold } from './state-gates.js';
import { EstimateContext, type EstimateTraceRow, type InstallmentDue, type PriorYearInput, type SafeHarborOverride, type SafeHarborRuleSource } from './estimate-types.js';
import {
  INDIVIDUAL_SAFE_HARBOR_POLICY, computeFederalSafeHarbor, federalSafeHarborRates, resolveSafeHarbor,
  type FederalSafeHarborInput, type SafeHarborPolicy, type SafeHarborRates, type SafeHarborResult,
} from './safe-harbor.js';
import { INDIVIDUAL_SCH_AI_POLICY, computeScheduleAi, type FederalCalculator, type SchAiPolicy, type ScheduleAiResult } from './sch-ai.js';
import { applyPayments, dedupePayments, withholdingShares, type EstimatePayment, type PaymentApplicationResult } from './payments.js';
import { accruePenalty, scheduleRateLookup, type PenaltyPolicy, type PenaltyResult, type PenaltyWaiver, type RateLookup } from './penalty.js';
import type { FederalEngineInput, FederalResult } from './types.js';

const STEP_INSTALLMENTS = 'installments';
const STEP_VOUCHERS = 'vouchers';
const FEDERAL = 'federal';
const KEY_PENALTY_RATE_SCHEDULE_FEDERAL = 'penalty.underpayment_rate';
const KEY_RETURN_DUE_DATE = 'return_due_date';
const KEY_HOLIDAYS = 'holidays';
const DEFAULT_COMPARISON: ThresholdComparison = 'at_least';
const DEFAULT_PENALTY_METHOD: PenaltyMethod = 'daily_simple';

// State rule keys (stateRuleKeys.ts registry).
const SK = {
  hasIncomeTax: 'has_income_tax', estimatesRequired: 'estimates_required', requiredThreshold: 'required_threshold', thresholdComparison: 'threshold_comparison',
  currentPct: 'safe_harbor.current_pct', priorPct: 'safe_harbor.prior_pct', highAgiRule: 'safe_harbor.high_agi_rule',
  dueDates: 'installments.due_dates', pcts: 'installments.pcts', q4FileAndPay: 'installments.q4_file_and_pay_date', returnDueDate: 'return_due_date',
  rateSource: 'penalty.rate_source', rate: 'penalty.rate', rateSchedule: 'penalty.rate_schedule', method: 'penalty.method', minBalanceDue: 'penalty.min_balance_due',
  holidays: 'holidays',
} as const;

// ── Installment policy ───────────────────────────────────────────────

export interface InstallmentPolicy {
  label: string;
  /** Explicit statutory due dates (Phase 9 C corp months → dates); win over the keys. */
  dueDates?: string[];
  /** `date_list` key (individuals). */
  dueDatesKey: string | null;
  /** `date` key for a single installment (farmers: `farmer.single_due_date`). */
  singleDueDateKey: string | null;
  /** Explicit percentages; win over `pctsKey`. */
  pcts?: Dec[];
  pctsKey: string | null;
  /** "File and pay by" date that waives the last installment's penalty (`installments.q4_file_and_pay_date`, `farmer.file_by_date`); null = none. */
  lastInstallmentReliefDateKey: string | null;
  returnDueDateKey: string;
  holidaysKey: string | null;
}

export const INDIVIDUAL_INSTALLMENT_POLICY: InstallmentPolicy = {
  label: 'individual quarterly installments',
  dueDatesKey: 'installments.due_dates', singleDueDateKey: null, pctsKey: 'installments.pcts',
  lastInstallmentReliefDateKey: 'installments.q4_file_and_pay_date', returnDueDateKey: KEY_RETURN_DUE_DATE, holidaysKey: KEY_HOLIDAYS,
};

/** Phase 9: one installment on `farmer.single_due_date`, relief when filed and paid by `farmer.file_by_date`. */
export const FARMER_INSTALLMENT_POLICY: InstallmentPolicy = {
  label: 'farmer / fisherman single installment',
  dueDatesKey: null, singleDueDateKey: 'farmer.single_due_date', pcts: [ONE], pctsKey: null,
  lastInstallmentReliefDateKey: 'farmer.file_by_date', returnDueDateKey: KEY_RETURN_DUE_DATE, holidaysKey: KEY_HOLIDAYS,
};

// ── Results ──────────────────────────────────────────────────────────

export interface VoucherInstallment {
  index: number;
  /** 'Q1'… for four installments, otherwise 'Installment n'. */
  label: string;
  /** Business-day adjusted. */
  dueDate: string;
  statutoryDueDate: string;
  regularInstallment: Dec;
  /** Schedule AI line 27 when computed. */
  annualizedInstallment: Dec | null;
  /** Lesser of regular / annualized (what the schedule requires). */
  required: Dec;
  withholdingShare: Dec;
  /** Excess from earlier payments that reduced this installment. */
  carriedIn: Dec;
  /** required − withholding − carried in (floored at 0). */
  netRequired: Dec;
  /** Estimated-tax payments applied to this installment. */
  estimatesApplied: Dec;
  /** Still unpaid as of the return due date, given the payments known. */
  unpaid: Dec;
  /** Amount to pay with this voucher to be current: its own unpaid balance plus every earlier installment's. */
  catchUpAmount: Dec;
  paidInFullOn: string | null;
  status: 'paid' | 'unpaid';
  exact: { regularInstallment: Dec; annualizedInstallment: Dec | null; required: Dec; netRequired: Dec; carriedIn: Dec; unpaid: Dec; catchUpAmount: Dec };
}

export interface JurisdictionEstimate {
  engineVersionNote: string;
  jurisdiction: string;
  taxYear: number;
  /** false = no vouchers (no regime, under the threshold, below the minimum balance …). */
  estimatesRequired: boolean;
  estimatesRequiredReason: string;
  /** Federal pattern applied to a state without verified rules. */
  usesFederalFallback: boolean;
  verify: boolean;
  safeHarbor: SafeHarborResult;
  scheduleAi: ScheduleAiResult | null;
  installments: VoucherInstallment[];
  payments: PaymentApplicationResult | null;
  penalty: PenaltyResult | null;
  returnDueDate: string;
  lastInstallmentReliefDate: string | null;
  totals: { required: Dec; withholding: Dec; estimatesPaid: Dec; unpaid: Dec; excess: Dec };
  notes: string[];
  trace: EstimateTraceRow[];
  warnings: TaxEstimatorWarning[];
  parametersUsed: ParameterUse[];
  rulesUsed: StateRuleUse[];
}

// ── Shared pipeline ──────────────────────────────────────────────────

interface Schedule {
  statutoryDueDates: string[];
  dueDates: string[];
  pcts: Dec[];
  returnDueDate: string;
  reliefDate: string | null;
  keys: string[];
  ruleKeys: string[];
}

interface PipelineInput {
  jurisdiction: string;
  ctx: EstimateContext;
  safeHarbor: SafeHarborResult;
  schedule: Schedule;
  withholding: Dec;
  payments: EstimatePayment[];
  priorYearOverpayment: { amount: Dec; date: string } | null;
  scheduleAi: { base: FederalEngineInput; baseResult?: FederalResult; periodActuals: ReadonlyArray<FederalEngineInput | null>; calc: FederalCalculator; policy: SchAiPolicy } | null;
  rateOn: RateLookup;
  penaltyMethod: PenaltyMethod;
  waiver: PenaltyWaiver | null;
  estimatesRequired: boolean;
  estimatesRequiredReason: string;
  usesFederalFallback: boolean;
  verify: boolean;
  notes: string[];
}

const R = dRoundDollars;

const QUARTER_LABELS = ['Q1', 'Q2', 'Q3', 'Q4'];

/** 'Q1'…'Q4' for a four-installment schedule, otherwise 'Installment n'. */
function installmentLabel(i: number, n: number): string {
  return n === QUARTER_LABELS.length ? (QUARTER_LABELS[i] as string) : `Installment ${i + 1}`;
}

function runPipeline(p: PipelineInput): JurisdictionEstimate {
  const { ctx, jurisdiction, schedule, safeHarbor } = p;
  const n = schedule.dueDates.length;
  const required = safeHarbor.exact.requiredAnnualPayment;
  const notes = [...p.notes, ...safeHarbor.notes];
  let verify = p.verify || safeHarbor.verify;

  // Regular installments.
  const regular = schedule.pcts.map((pct) => dMul(required, pct));
  regular.forEach((amt, i) => ctx.trace.add({ step: STEP_INSTALLMENTS, id: `${jurisdiction}.installment.${i + 1}.regular`, jurisdiction, label: `${jurisdiction} ${installmentLabel(i, n)} regular installment (${schedule.pcts[i]} of ${R(required)}; due ${schedule.dueDates[i]})`, exact: amt, source: 'parameter', formula: `${required} × ${schedule.pcts[i]}`, parameterKeys: schedule.keys, ruleKeys: schedule.ruleKeys }));

  // Schedule AI (lesser of regular / annualized, with recapture).
  let scheduleAi: ScheduleAiResult | null = null;
  if (p.scheduleAi && p.estimatesRequired) {
    scheduleAi = computeScheduleAi({ base: p.scheduleAi.base, baseResult: p.scheduleAi.baseResult, periodActuals: p.scheduleAi.periodActuals, requiredAnnualPayment: required, installmentPcts: schedule.pcts, calc: p.scheduleAi.calc, policy: p.scheduleAi.policy }, ctx);
    notes.push(...scheduleAi.assumptions);
  }
  const requiredInstallments = regular.map((amt, i) => (scheduleAi ? scheduleAi.exact.requiredInstallments[i] as Dec : amt));

  if (!p.estimatesRequired) {
    ctx.info('TE_ESTIMATES_NOT_REQUIRED', `${jurisdiction}: ${p.estimatesRequiredReason}`, { jurisdiction });
    return finish(p, { scheduleAi, installments: [], payments: null, penalty: null, notes: [...notes, p.estimatesRequiredReason], verify });
  }

  // Payments → application → penalty.
  const dues: InstallmentDue[] = schedule.dueDates.map((d, i) => ({ index: i, dueDate: d, required: requiredInstallments[i] as Dec }));
  const payments = dedupePayments(p.payments);
  if (p.priorYearOverpayment && dIsPos(dec(p.priorYearOverpayment.amount))) {
    payments.push({ id: 'prior_year_overpayment', date: p.priorYearOverpayment.date, amount: dec(p.priorYearOverpayment.amount), source: 'prior_year_overpayment', jurisdiction, memo: 'Prior-year overpayment applied to estimated tax' });
  }
  const shares = withholdingShares(p.withholding, schedule.pcts);
  const applied = applyPayments({ jurisdiction, installments: dues, withholdingShares: shares, payments, endDate: schedule.returnDueDate }, ctx);
  const penalty = accruePenalty(applied, { jurisdiction, method: p.penaltyMethod, rateOn: p.rateOn, returnDueDate: schedule.returnDueDate, waiver: p.waiver, lastInstallmentReliefDate: schedule.reliefDate, verify: p.usesFederalFallback }, ctx);
  verify = verify || penalty.verify;

  // Vouchers.
  let cumulativeUnpaid: Dec = ZERO;
  const installments: VoucherInstallment[] = applied.installments.map((a, i) => {
    const estimates = dSum(a.applied.filter((x) => x.source !== 'withholding' && x.source !== 'carry').map((x) => x.amount));
    cumulativeUnpaid = dAdd(cumulativeUnpaid, a.exact.unpaidAtEnd);
    const annualized = scheduleAi ? (scheduleAi.exact.requiredInstallments[i] as Dec) : null;
    ctx.trace.add({ step: STEP_VOUCHERS, id: `${jurisdiction}.voucher.${i + 1}`, jurisdiction, label: `${jurisdiction} ${installmentLabel(i, n)} voucher — due ${schedule.dueDates[i]}, amount to be current`, exact: cumulativeUnpaid, source: 'input', formula: `unpaid ${a.exact.unpaidAtEnd} + earlier unpaid ${dSub(cumulativeUnpaid, a.exact.unpaidAtEnd)}` });
    return {
      index: i, label: installmentLabel(i, n), dueDate: schedule.dueDates[i] as string, statutoryDueDate: schedule.statutoryDueDates[i] as string,
      regularInstallment: R(regular[i] as Dec), annualizedInstallment: annualized == null ? null : R(annualized), required: a.required,
      withholdingShare: R(shares[i] as Dec), carriedIn: a.carriedIn, netRequired: a.netRequired, estimatesApplied: R(estimates), unpaid: a.unpaidAtEnd, catchUpAmount: R(cumulativeUnpaid),
      paidInFullOn: a.paidInFullOn, status: dIsPos(a.exact.unpaidAtEnd) ? 'unpaid' : 'paid',
      exact: { regularInstallment: regular[i] as Dec, annualizedInstallment: annualized, required: a.exact.required, netRequired: a.exact.netRequired, carriedIn: a.exact.carriedIn, unpaid: a.exact.unpaidAtEnd, catchUpAmount: cumulativeUnpaid },
    };
  });

  return finish(p, { scheduleAi, installments, payments: applied, penalty, notes, verify });
}

function finish(p: PipelineInput, r: { scheduleAi: ScheduleAiResult | null; installments: VoucherInstallment[]; payments: PaymentApplicationResult | null; penalty: PenaltyResult | null; notes: string[]; verify: boolean }): JurisdictionEstimate {
  const { ctx } = p;
  return {
    engineVersionNote: 'estimate — see assumptions',
    jurisdiction: p.jurisdiction, taxYear: ctx.taxYear,
    estimatesRequired: p.estimatesRequired, estimatesRequiredReason: p.estimatesRequiredReason, usesFederalFallback: p.usesFederalFallback, verify: r.verify,
    safeHarbor: p.safeHarbor, scheduleAi: r.scheduleAi, installments: r.installments, payments: r.payments, penalty: r.penalty,
    returnDueDate: p.schedule.returnDueDate, lastInstallmentReliefDate: p.schedule.reliefDate,
    totals: {
      required: r.payments ? r.payments.totalRequired : ZERO, withholding: R(dec(p.withholding)),
      estimatesPaid: r.payments ? r.payments.totalEstimates : ZERO, unpaid: r.payments ? r.payments.totalUnpaidAtEnd : ZERO, excess: r.payments ? r.payments.excessAfterLast : ZERO,
    },
    notes: r.notes, trace: ctx.trace.rows(), warnings: ctx.allWarnings(), parametersUsed: ctx.parametersUsed(), rulesUsed: ctx.rulesUsed(),
  };
}

// ── Federal ──────────────────────────────────────────────────────────

export interface FederalEstimatesInput {
  taxYear: number;
  filingStatus: FilingStatus;
  parameters: ParameterMap;
  /** The tax shown on the return (whole dollars, FederalResult.federalTotal). */
  currentYearTax: Dec;
  currentYearAgi: Dec | null;
  /** Total federal withholding for the year (credited evenly). */
  withholding: Dec;
  priorYear: PriorYearInput;
  rule: SafeHarborOverride;
  ruleSource: SafeHarborRuleSource;
  /** Federal estimated-tax payments (GL + manual; deduplicated here). */
  payments: EstimatePayment[];
  /** Prior-year overpayment applied to this year; `date` defaults to the prior return's original due date. */
  priorYearOverpayment?: { amount: Dec; date?: string } | null;
  /** null / absent = regular installments only. */
  scheduleAi?: { base: FederalEngineInput; baseResult?: FederalResult; periodActuals: ReadonlyArray<FederalEngineInput | null>; calc: FederalCalculator } | null;
  policies?: {
    safeHarbor?: SafeHarborPolicy;
    pctOverrides?: FederalSafeHarborInput['pctOverrides'];
    installments?: InstallmentPolicy;
    /** null = skip Schedule AI even when actuals are given (farmers). */
    schAi?: SchAiPolicy | null;
  };
  /** Caller-decided waiver (Phase 9); the §6654(e) tests here still apply. */
  waiver?: PenaltyWaiver | null;
}

function federalSchedule(ctx: EstimateContext, policy: InstallmentPolicy): Schedule {
  const keys: string[] = [policy.returnDueDateKey];
  let statutory: string[];
  if (policy.dueDates) statutory = [...policy.dueDates];
  else if (policy.dueDatesKey) { statutory = ctx.params.dateList(policy.dueDatesKey); keys.push(policy.dueDatesKey); }
  else if (policy.singleDueDateKey) { statutory = [ctx.params.date(policy.singleDueDateKey)]; keys.push(policy.singleDueDateKey); }
  else throw new Error('TE_INSTALLMENT_POLICY: no due dates');
  let pcts: Dec[];
  if (policy.pcts) pcts = policy.pcts.map((x) => dec(x));
  else if (policy.pctsKey) { pcts = ctx.params.rateList(policy.pctsKey); keys.push(policy.pctsKey); }
  else throw new Error('TE_INSTALLMENT_POLICY: no installment percentages');
  if (pcts.length !== statutory.length) throw new Error('TE_INSTALLMENT_POLICY: due dates and percentages differ in length');
  const holidays = policy.holidaysKey ? ctx.params.dateList(policy.holidaysKey) : [];
  if (policy.holidaysKey) keys.push(policy.holidaysKey);
  const dueDates = statutory.map((d) => nextBusinessDay(d, holidays));
  const returnDueDate = ctx.params.date(policy.returnDueDateKey);
  let reliefDate: string | null = null;
  if (policy.lastInstallmentReliefDateKey) { reliefDate = ctx.params.date(policy.lastInstallmentReliefDateKey); keys.push(policy.lastInstallmentReliefDateKey); }
  return { statutoryDueDates: statutory, dueDates, pcts, returnDueDate, reliefDate, keys, ruleKeys: [] };
}

function federalRateLookup(ctx: EstimateContext): RateLookup {
  return scheduleRateLookup(ctx.params.ratePeriods(KEY_PENALTY_RATE_SCHEDULE_FEDERAL), [KEY_PENALTY_RATE_SCHEDULE_FEDERAL]);
}

/** The prior return's original due date = this year's return due date rolled back one year. */
function priorReturnDueDate(ctx: EstimateContext): string {
  return rollDateToYear(ctx.params.date(KEY_RETURN_DUE_DATE), ctx.taxYear, ctx.taxYear - 1);
}

interface Requirement { required: boolean; reason: string; waiver: PenaltyWaiver | null }

/** §6654(e): minimum balance and zero prior-year tax. */
function federalRequirement(safeHarbor: SafeHarborResult, policy: SafeHarborPolicy, tax: Dec, withholding: Dec, ctx: EstimateContext, jurisdiction: string): Requirement {
  const balance = dSub(dec(tax), dec(withholding));
  if (policy.minBalanceDueKey) {
    const min = ctx.params.money(policy.minBalanceDueKey);
    ctx.trace.add({ step: STEP_INSTALLMENTS, id: `${jurisdiction}.balance_after_withholding`, jurisdiction, label: `${jurisdiction} tax less withholding (minimum ${min} for estimates / penalty)`, exact: balance, source: 'parameter', formula: `${tax} − ${withholding}`, parameterKeys: [policy.minBalanceDueKey] });
    if (dCmp(balance, min) < 0) {
      return { required: false, reason: `Tax ${R(dec(tax))} less withholding ${R(dec(withholding))} = ${R(balance)} is below ${min}: no estimated payments are required and no underpayment penalty applies.`, waiver: { reason: 'below_min_balance', detail: `tax less withholding (${R(balance)}) is below ${min}.` } };
    }
  }
  if (safeHarbor.noPenaltyReason === 'prior_year_zero_tax') {
    const waiver: PenaltyWaiver = { reason: 'prior_year_zero_tax', detail: 'the prior-year tax was zero on a filed 12-month return (§6654(e)(2)).' };
    if (!dIsPos(safeHarbor.exact.requiredAnnualPayment)) return { required: false, reason: 'The prior-year tax was zero: the required annual payment under the prior-year rule is 0; no penalty can apply.', waiver };
    return { required: true, reason: 'Estimates are optional (zero prior-year tax waives the penalty); the schedule follows the selected rule.', waiver };
  }
  if (!dIsPos(safeHarbor.exact.requiredAnnualPayment)) return { required: false, reason: 'The required annual payment is zero.', waiver: null };
  return { required: true, reason: 'Estimates required.', waiver: null };
}

export function computeFederalEstimates(input: FederalEstimatesInput): JurisdictionEstimate {
  const ctx = new EstimateContext(input.parameters, input.taxYear, input.filingStatus);
  const shPolicy = input.policies?.safeHarbor ?? INDIVIDUAL_SAFE_HARBOR_POLICY;
  const instPolicy = input.policies?.installments ?? INDIVIDUAL_INSTALLMENT_POLICY;
  const schAiPolicy = input.policies?.schAi === undefined ? INDIVIDUAL_SCH_AI_POLICY : input.policies.schAi;

  const safeHarbor = computeFederalSafeHarbor({ currentYearTax: input.currentYearTax, currentYearAgi: input.currentYearAgi, priorYear: input.priorYear, rule: input.rule, ruleSource: input.ruleSource, policy: shPolicy, pctOverrides: input.policies?.pctOverrides }, ctx);
  const schedule = federalSchedule(ctx, instPolicy);
  const req = federalRequirement(safeHarbor, shPolicy, input.currentYearTax, input.withholding, ctx, FEDERAL);
  const waiver = input.waiver ?? req.waiver;
  const overpayment = input.priorYearOverpayment && dIsPos(dec(input.priorYearOverpayment.amount))
    ? { amount: dec(input.priorYearOverpayment.amount), date: input.priorYearOverpayment.date ?? priorReturnDueDate(ctx) }
    : null;

  return runPipeline({
    jurisdiction: FEDERAL, ctx, safeHarbor, schedule, withholding: dec(input.withholding), payments: input.payments.filter((p) => p.jurisdiction === FEDERAL),
    priorYearOverpayment: overpayment,
    scheduleAi: input.scheduleAi && schAiPolicy ? { ...input.scheduleAi, policy: schAiPolicy } : null,
    rateOn: federalRateLookup(ctx), penaltyMethod: DEFAULT_PENALTY_METHOD, waiver,
    estimatesRequired: req.required, estimatesRequiredReason: req.reason, usesFederalFallback: false, verify: false, notes: [],
  });
}

// ── State ────────────────────────────────────────────────────────────

export interface StateEstimatesInput {
  taxYear: number;
  filingStatus: FilingStatus;
  /** Federal parameters (fallback pattern, default return due date, federal-source penalty rates). */
  parameters: ParameterMap;
  state: string;
  /** null = no rule set supplied → federal pattern, verify. */
  jurisdiction: StateJurisdictionInput | null;
  /** This state's tax for the year after the credit for other-state taxes (StateRowResult.exact.netTax). */
  stateTax: Dec;
  /** Current-year AGI (federal AGI as the proxy for the CA-style current-AGI cutoff). */
  currentYearAgi: Dec | null;
  /** Phase 8 estimate-requirement gate for this row; null = not evaluated (threshold test skipped, verify). */
  gate: StateEstimateGate | null;
  withholding: Dec;
  priorYear: PriorYearInput;
  rule: SafeHarborOverride;
  ruleSource: SafeHarborRuleSource;
  payments: EstimatePayment[];
  priorYearOverpayment?: { amount: Dec; date?: string } | null;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isIsoDateString = (x: unknown): x is string => typeof x === 'string' && /^\d\d\d\d-\d\d-\d\d$/.test(x);

function ruleDateList(rules: StateRuleReader, key: string): string[] | null {
  const v = rules.value(key);
  if (v == null) return null;
  if (!Array.isArray(v) || !v.every(isIsoDateString)) throw new Error(`TE_STATE_RULE_INVALID: ${rules.state} rule '${key}' is not a list of dates`);
  return [...v];
}

function ruleRateList(rules: StateRuleReader, key: string): Dec[] | null {
  const v = rules.value(key);
  if (v == null) return null;
  if (!Array.isArray(v) || !v.every(isNum)) throw new Error(`TE_STATE_RULE_INVALID: ${rules.state} rule '${key}' is not a list of numbers`);
  return v.map((x) => dec(x));
}

function ruleDate(rules: StateRuleReader, key: string): string | null {
  const v = rules.value(key);
  if (v == null) return null;
  if (!isIsoDateString(v)) throw new Error(`TE_STATE_RULE_INVALID: ${rules.state} rule '${key}' is not a date`);
  return v;
}

function stateSafeHarborRates(rules: StateRuleReader, filingStatus: FilingStatus, ctx: EstimateContext): SafeHarborRates {
  const keys = [SK.currentPct, SK.priorPct, SK.highAgiRule];
  const currentPct = rules.money(SK.currentPct);
  if (currentPct == null) throw new Error(`TE_STATE_RULE_INVALID: ${rules.state} has no ${SK.currentPct}`);
  const priorPct = rules.money(SK.priorPct);
  const high = rules.object(SK.highAgiRule);
  let priorPctHighAgi: Dec | null = null;
  let highAgiThreshold: Dec | null = null;
  let cutoff: Dec | null = null;
  if (high) {
    const mfs = filingStatus === 'mfs';
    const threshold = mfs && isNum(high['threshold_mfs']) ? high['threshold_mfs'] : high['threshold'];
    if (!isNum(threshold) || !isNum(high['pct'])) throw new Error(`TE_STATE_RULE_INVALID: ${rules.state} ${SK.highAgiRule} needs threshold and pct`);
    highAgiThreshold = dec(threshold);
    priorPctHighAgi = dec(high['pct']);
    const c = mfs && isNum(high['no_prior_year_agi_mfs']) ? high['no_prior_year_agi_mfs'] : high['no_prior_year_agi'];
    if (isNum(c)) cutoff = dec(c);
  }
  if (priorPct == null) ctx.info('TE_STATE_NO_PRIOR_YEAR_HARBOR', `${rules.state} has no prior-year safe harbor; only the current-year rule applies.`, { state: rules.state });
  return { currentPct, priorPct, priorPctHighAgi, highAgiThreshold, priorHarborCurrentAgiCutoff: cutoff, keys, priorUnavailableReason: null };
}

function stateSchedule(rules: StateRuleReader, ctx: EstimateContext): Schedule {
  const statutory = ruleDateList(rules, SK.dueDates);
  const pcts = ruleRateList(rules, SK.pcts);
  if (!statutory || !pcts) throw new Error(`TE_STATE_RULE_INVALID: ${rules.state} needs ${SK.dueDates} and ${SK.pcts}`);
  if (statutory.length !== pcts.length) throw new Error(`TE_STATE_RULE_INVALID: ${rules.state} due dates and percentages differ in length`);
  const holidays = ruleDateList(rules, SK.holidays) ?? [];
  const dueDates = statutory.map((d) => nextBusinessDay(d, holidays));
  const keys: string[] = [];
  let returnDueDate = ruleDate(rules, SK.returnDueDate);
  if (!returnDueDate) { returnDueDate = ctx.params.date(KEY_RETURN_DUE_DATE); keys.push(KEY_RETURN_DUE_DATE); }
  const reliefDate = ruleDate(rules, SK.q4FileAndPay);
  return { statutoryDueDates: statutory, dueDates, pcts, returnDueDate, reliefDate, keys, ruleKeys: [SK.dueDates, SK.pcts, SK.holidays, SK.returnDueDate, SK.q4FileAndPay] };
}

function stateRateLookup(rules: StateRuleReader, ctx: EstimateContext): { rateOn: RateLookup; notes: string[]; verify: boolean } {
  const source = rules.text(SK.rateSource);
  const notes: string[] = [];
  if (source === 'federal') {
    notes.push(`${rules.state} charges the federal underpayment rate; the federal quarterly schedule was used.`);
    return { rateOn: scheduleRateLookup(ctx.params.ratePeriods(KEY_PENALTY_RATE_SCHEDULE_FEDERAL), [KEY_PENALTY_RATE_SCHEDULE_FEDERAL, SK.rateSource]), notes, verify: false };
  }
  const values: Record<string, unknown> = { [SK.rate]: rules.value(SK.rate), [SK.rateSchedule]: rules.value(SK.rateSchedule) };
  const method = rules.text(SK.method);
  if (values[SK.rate] == null && values[SK.rateSchedule] == null && method !== 'tiered_flat') {
    notes.push(`${rules.state} has no underpayment rate on file; the penalty could not be estimated. Verify.`);
  }
  const rateOn: RateLookup = (isoDate) => {
    const r = statePenaltyRateOn(values, isoDate);
    return { rate: r.rate == null ? null : dec(r.rate), covered: r.covered, keys: [r.fromSchedule ? SK.rateSchedule : SK.rate, SK.rateSource] };
  };
  return { rateOn, notes, verify: false };
}

function statePenaltyMethod(rules: StateRuleReader): PenaltyMethod {
  const m = rules.text(SK.method);
  if (m == null) return DEFAULT_PENALTY_METHOD;
  if (!(PENALTY_METHODS as readonly string[]).includes(m)) throw new Error(`TE_STATE_RULE_INVALID: ${rules.state} ${SK.method} '${m}'`);
  return m as PenaltyMethod;
}

function stateComparison(rules: StateRuleReader): ThresholdComparison {
  const c = rules.text(SK.thresholdComparison);
  return c === 'more_than' ? 'more_than' : DEFAULT_COMPARISON;
}

function stateRequirement(input: StateEstimatesInput, rules: StateRuleReader, safeHarbor: SafeHarborResult, ctx: EstimateContext): Requirement & { verify: boolean } {
  const state = input.state;
  const balance = dSub(dec(input.stateTax), dec(input.withholding));
  const comparison = stateComparison(rules);
  let verify = false;
  if (input.gate) {
    if (input.gate.required === false) return { required: false, reason: `${state}: estimates are not required (${input.gate.method}${input.gate.threshold != null ? `, threshold ${input.gate.threshold} ${input.gate.comparison}` : ''}).`, waiver: { reason: 'estimates_not_required', detail: `${state} does not require estimated payments from this taxpayer.` }, verify: input.gate.verify };
    if (input.gate.required === null) { verify = true; ctx.warn('TE_STATE_GATE_UNDETERMINED', `${state}: the estimate-requirement gate could not be decided; vouchers are shown. Verify.`, { state }); }
  } else {
    verify = true;
    ctx.warn('TE_STATE_GATE_NOT_EVALUATED', `${state}: no estimate-requirement gate was supplied; vouchers are shown. Verify.`, { state });
  }
  // Penalty floor: `penalty.min_balance_due`, null = `required_threshold`.
  const min = rules.money(SK.minBalanceDue) ?? rules.money(SK.requiredThreshold);
  let waiver: PenaltyWaiver | null = null;
  if (min != null) {
    ctx.trace.add({ step: STEP_INSTALLMENTS, id: `${state}.balance_after_withholding`, jurisdiction: state, label: `${state} tax less withholding (penalty floor ${min}, ${comparison})`, exact: balance, source: 'state_rule', formula: `${input.stateTax} − ${input.withholding}`, ruleKeys: [SK.minBalanceDue, SK.requiredThreshold, SK.thresholdComparison] });
    if (!meetsThreshold(balance, min, comparison)) waiver = { reason: 'below_min_balance', detail: `${state} tax less withholding (${R(balance)}) does not reach ${min} (${comparison}).` };
  }
  if (safeHarbor.noPenaltyReason === 'prior_year_zero_tax') {
    waiver = waiver ?? { reason: 'prior_year_zero_tax', detail: `the prior-year ${state} tax was zero on a filed 12-month return (verify: the state's zero-prior-tax relief may differ).` };
    verify = true;
  }
  if (!dIsPos(safeHarbor.exact.requiredAnnualPayment)) return { required: false, reason: `${state}: the required annual payment is zero.`, waiver, verify };
  return { required: true, reason: `${state}: estimates required.`, waiver, verify };
}

export function computeStateEstimates(input: StateEstimatesInput): JurisdictionEstimate {
  const ctx = new EstimateContext(input.parameters, input.taxYear, input.filingStatus);
  const state = input.state;
  const j = input.jurisdiction;
  const rules = j ? ctx.reader(state, j.rules) : null;
  const hasIncomeTax = rules ? rules.bool(SK.hasIncomeTax) !== false : true;

  // Federal pattern fallback (no rules / incomplete rules).
  if (!j || !rules || j.usesFederalFallback) {
    ctx.warn('TE_STATE_RULES_FALLBACK', `${state} has no verified estimated-tax rule set; the federal pattern (percentages, due dates, penalty rate) was applied. Verify.`, { state });
    const rates = federalSafeHarborRates(input.filingStatus, ctx);
    const safeHarbor = { ...resolveSafeHarbor({ jurisdiction: state, currentYearTax: input.stateTax, currentYearAgi: input.currentYearAgi, priorYear: input.priorYear, rule: input.rule, ruleSource: input.ruleSource, rates }, ctx), policy: `${INDIVIDUAL_SAFE_HARBOR_POLICY.label} — federal pattern (verify)`, verify: true };
    const schedule = federalSchedule(ctx, INDIVIDUAL_INSTALLMENT_POLICY);
    const req = federalRequirement(safeHarbor, INDIVIDUAL_SAFE_HARBOR_POLICY, input.stateTax, input.withholding, ctx, state);
    const gateOff = input.gate?.required === false;
    return runPipeline({
      jurisdiction: state, ctx, safeHarbor, schedule, withholding: dec(input.withholding), payments: input.payments.filter((p) => p.jurisdiction === state),
      priorYearOverpayment: overpaymentFor(input, ctx), scheduleAi: null, rateOn: federalRateLookup(ctx), penaltyMethod: DEFAULT_PENALTY_METHOD,
      waiver: gateOff ? { reason: 'estimates_not_required', detail: `${state} does not require estimated payments from this taxpayer.` } : req.waiver,
      estimatesRequired: req.required && !gateOff, estimatesRequiredReason: gateOff ? `${state}: estimates are not required (${input.gate?.method}).` : req.reason,
      usesFederalFallback: true, verify: true, notes: [`${state}: federal pattern applied (no verified state rules). Verify.`],
    });
  }

  if (!hasIncomeTax) {
    const safeHarbor: SafeHarborResult = { ...resolveSafeHarbor({ jurisdiction: state, currentYearTax: ZERO, currentYearAgi: null, priorYear: input.priorYear, rule: input.rule, ruleSource: input.ruleSource, rates: { currentPct: ZERO, priorPct: null, priorPctHighAgi: null, highAgiThreshold: null, priorHarborCurrentAgiCutoff: null, keys: [SK.hasIncomeTax], priorUnavailableReason: `${state} has no income tax.` } }), policy: 'no income tax' };
    return runPipeline({
      jurisdiction: state, ctx, safeHarbor, schedule: { statutoryDueDates: [], dueDates: [], pcts: [], returnDueDate: ctx.params.date(KEY_RETURN_DUE_DATE), reliefDate: null, keys: [KEY_RETURN_DUE_DATE], ruleKeys: [SK.hasIncomeTax] },
      withholding: ZERO, payments: [], priorYearOverpayment: null, scheduleAi: null, rateOn: () => ({ rate: null, covered: true, keys: [] }), penaltyMethod: DEFAULT_PENALTY_METHOD,
      waiver: { reason: 'no_estimate_regime', detail: `${state} has no broad-based personal income tax.` }, estimatesRequired: false, estimatesRequiredReason: `${state} has no broad-based personal income tax.`,
      usesFederalFallback: false, verify: j.verifyBadge, notes: [],
    });
  }

  const rates = stateSafeHarborRates(rules, input.filingStatus, ctx);
  const safeHarbor = { ...resolveSafeHarbor({ jurisdiction: state, currentYearTax: input.stateTax, currentYearAgi: input.currentYearAgi, priorYear: input.priorYear, rule: input.rule, ruleSource: input.ruleSource, rates }, ctx), policy: `${state} state_estimate_rules` };

  // No quarterly regime (ID, UT): no vouchers, no penalty.
  const estimatesRegime = rules.bool(SK.estimatesRequired) !== false && j.estimatesRequired;
  if (!estimatesRegime) {
    return runPipeline({
      jurisdiction: state, ctx, safeHarbor, schedule: { statutoryDueDates: [], dueDates: [], pcts: [], returnDueDate: ruleDate(rules, SK.returnDueDate) ?? ctx.params.date(KEY_RETURN_DUE_DATE), reliefDate: null, keys: [], ruleKeys: [SK.estimatesRequired] },
      withholding: dec(input.withholding), payments: [], priorYearOverpayment: null, scheduleAi: null, rateOn: () => ({ rate: null, covered: true, keys: [] }), penaltyMethod: DEFAULT_PENALTY_METHOD,
      waiver: { reason: 'no_estimate_regime', detail: `${state} has no quarterly individual estimated-tax requirement.` }, estimatesRequired: false,
      estimatesRequiredReason: `${state} has no quarterly individual estimated-tax requirement: no vouchers, no underpayment penalty.`, usesFederalFallback: false, verify: j.verifyBadge, notes: [],
    });
  }

  const schedule = stateSchedule(rules, ctx);
  const req = stateRequirement(input, rules, safeHarbor, ctx);
  const rate = stateRateLookup(rules, ctx);
  const method = statePenaltyMethod(rules);
  const notes = [...rate.notes];
  if (method !== DEFAULT_PENALTY_METHOD) notes.push(`${state} accrues its underpayment penalty as ${method}; add-ons and caps are not modelled.`);
  return runPipeline({
    jurisdiction: state, ctx, safeHarbor, schedule, withholding: dec(input.withholding), payments: input.payments.filter((p) => p.jurisdiction === state),
    priorYearOverpayment: overpaymentFor(input, ctx), scheduleAi: null, rateOn: rate.rateOn, penaltyMethod: method, waiver: req.waiver,
    estimatesRequired: req.required, estimatesRequiredReason: req.reason, usesFederalFallback: false, verify: j.verifyBadge || req.verify || rate.verify, notes,
  });
}

function overpaymentFor(input: StateEstimatesInput, ctx: EstimateContext): { amount: Dec; date: string } | null {
  if (!input.priorYearOverpayment || !dIsPos(dec(input.priorYearOverpayment.amount))) return null;
  return { amount: dec(input.priorYearOverpayment.amount), date: input.priorYearOverpayment.date ?? priorReturnDueDate(ctx) };
}
