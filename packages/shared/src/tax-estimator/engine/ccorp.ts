// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 9: C corporation path (MODULE.md "Safe harbor, Schedule AI, vouchers,
// penalties" and "State calculation"; PHASES.md Phase 9). C corps are
// entity-level only (no roll-up to the Taxpayer):
//
//   federal tax        = max(0, taxable income) × ccorp.rate                     (IRC §11(b))
//   state tax          = apportionment % × taxable income × rate per state       (computeCcorpStateTax)
//   installment dates  = ccorp.installment_day of the 4th / 6th / 9th / 12th month of the
//                        ENTITY fiscal year (companies.fiscal_year_start_month), rolled past
//                        weekends and `holidays` (§6655(c)(2), §7503)
//   required annual payment (§6655(d)(1)) = lesser of ccorp.safe_harbor_current_pct × current
//                        tax and ccorp.safe_harbor_prior_pct × prior-year tax; the prior-year
//                        rule is UNAVAILABLE when the prior year was short, showed no liability
//                        or is unknown (§6655(d)(1)(B)(ii))
//   large corporation (§6655(g)(2): taxable income ≥ ccorp.large_corp_threshold in any of the
//                        ccorp.large_corp_lookback_years preceding years, or the entity flag):
//                        the prior-year rule applies to the FIRST installment only and the
//                        shortfall is recaptured in the second (§6655(d)(2))
//   estimates required only when the tax is at least ccorp.min_tax_for_estimates (§6655(f))
//
// The tax year of a fiscal-year corporation is the calendar year in which the
// fiscal year BEGINS (Form 1120 year convention). Pure: parameters in, result
// with trace out. Schedule AI for corporations (ccorp.sch_ai.*) is layered on
// this schedule by Phase 10; this module returns the regular installments.

import type { TraceRow } from '../types.js';
import type { TaxEstimatorWarning } from '../entities-api.js';
import { ZERO, dAdd, dCmp, dFloorZero, dIsPos, dMin, dMul, dRoundDollars, dSub, dSum, dec, type Dec } from '../decimal.js';
import { isoDateUtc, lastDayOfMonthUtc, nextBusinessDay } from '../dates.js';
import { computeCcorpStateTax } from './state.js';
import { ParameterReader } from './parameters.js';
import { TAX_ENGINE_VERSION } from './version.js';
import type { ParameterMap, ParameterUse } from './types.js';

// ── Input ────────────────────────────────────────────────────────────

export interface CcorpStateRow {
  state: string;
  /** Apportionment fraction 0..1. */
  apportionmentPct: Dec;
  /** Effective rate, fraction 0..1 (user input; brackets later, as for individuals). */
  effectiveRate: Dec;
}

export interface CcorpPriorYear {
  /** Tax shown on the prior-year return; null = no return / unknown. */
  tax: Dec | null;
  /** The prior year was a full 12-month taxable year (§6655(d)(1)(B)(ii)). */
  fullTwelveMonths: boolean;
}

export interface CcorpEngineInput {
  /** Calendar year in which the fiscal year begins (Form 1120 year). */
  taxYear: number;
  parameters: ParameterMap;
  tenantId: string;
  companyId: string;
  companyName: string;
  /** companies.fiscal_year_start_month, 1..12 (1 = calendar year). */
  fiscalYearStartMonth: number;
  /** Projected full-year taxable income (entity tax-basis projection after entity adjustments; a loss is negative). */
  taxableIncome: Dec;
  /** tax_est_entity_settings.large_corporation. true wins; false lets `priorYearsTaxableIncome` derive the status. */
  largeCorporation: boolean;
  /** Taxable income of the preceding tax years, most recent first; null = unknown. Only the lookback years are examined. */
  priorYearsTaxableIncome: ReadonlyArray<Dec> | null;
  priorYear: CcorpPriorYear | null;
  states: ReadonlyArray<CcorpStateRow>;
}

// ── Result ───────────────────────────────────────────────────────────

export const CCORP_STEPS = ['ccorp_tax', 'ccorp_state', 'ccorp_safe_harbor', 'ccorp_installments'] as const;
export type CcorpStep = typeof CCORP_STEPS[number];

export interface CcorpTraceRow extends TraceRow {
  step: CcorpStep;
  /** Stable id for drill-down ('ccorp.federal_tax', 'state.MO.tax', 'ccorp.installment.2'). */
  id: string;
  /** Unrounded amount. */
  exact: Dec;
  parameterKeys?: string[];
}

export type CcorpPriorYearReason = 'ok' | 'not_provided' | 'short_year' | 'zero_liability';

export interface CcorpPriorYearRule {
  available: boolean;
  reason: CcorpPriorYearReason;
  /** 'all' = every installment may use the prior-year base; 'first_installment' = large corporation; 'none' = unavailable. */
  appliesTo: 'all' | 'first_installment' | 'none';
}

export interface CcorpInstallmentExact {
  currentYearBasis: Dec;
  priorYearBasis: Dec | null;
  recapture: Dec;
  required: Dec;
  cumulativeRequired: Dec;
}

export interface CcorpInstallment {
  /** 1-based. */
  number: number;
  /** Month of the fiscal year (4, 6, 9, 12). */
  fiscalMonth: number;
  /** Day-of-month date before the §7503 roll. */
  statutoryDueDate: string;
  /** Due date after rolling past weekends and holidays. */
  dueDate: string;
  pct: Dec;
  /** pct × current-year required annual payment. */
  currentYearBasis: Dec;
  /** pct × prior-year required annual payment; null when the prior-year rule does not reach this installment. */
  priorYearBasis: Dec | null;
  /** §6655(d)(2)(B): the first-installment shortfall added to the second installment of a large corporation. */
  recapture: Dec;
  /** The required installment (whole dollars). */
  required: Dec;
  cumulativeRequired: Dec;
  /** Which base produced `required` (before recapture). */
  basis: 'current_year' | 'prior_year';
  exact: CcorpInstallmentExact;
}

export interface CcorpStateResult {
  state: string;
  apportionmentPct: Dec;
  effectiveRate: Dec;
  apportioned: Dec;
  tax: Dec;
  exact: { apportioned: Dec; tax: Dec };
}

export interface CcorpRequiredAnnualPayment {
  currentYearPct: Dec;
  /** currentYearPct × federal tax. */
  currentYear: Dec;
  priorYearPct: Dec;
  /** priorYearPct × prior-year tax; null when the prior-year rule is unavailable. */
  priorYear: Dec | null;
  /** The annual amount the installments sum to (lesser of the two for a non-large corporation; current year otherwise). */
  required: Dec;
}

export interface CcorpExactTotals {
  taxableIncome: Dec;
  federalTax: Dec;
  stateTotal: Dec;
  totalTax: Dec;
  requiredAnnualPayment: { currentYear: Dec; priorYear: Dec | null; required: Dec };
}

export interface CcorpResult {
  engineVersion: string;
  taxYear: number;
  tenantId: string;
  companyId: string;
  companyName: string;
  fiscalYearStartMonth: number;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  /** Taxable income as given (a loss stays negative), whole dollars. */
  taxableIncome: Dec;
  rate: Dec;
  federalTax: Dec;
  states: CcorpStateResult[];
  stateTotal: Dec;
  /** federal + states. */
  totalTax: Dec;
  largeCorporation: boolean;
  largeCorporationSource: 'flag' | 'derived' | 'not_large';
  /** §6655(f): false when the federal tax is below ccorp.min_tax_for_estimates (schedule still shown). */
  estimatesRequired: boolean;
  minTaxForEstimates: Dec;
  priorYearRule: CcorpPriorYearRule;
  requiredAnnualPayment: CcorpRequiredAnnualPayment;
  installments: CcorpInstallment[];
  exact: CcorpExactTotals;
  trace: CcorpTraceRow[];
  warnings: TaxEstimatorWarning[];
  /** Every parameter the calculation read, with its status (D12a). */
  parametersUsed: ParameterUse[];
}

// ── Installment dates ────────────────────────────────────────────────

export interface CcorpInstallmentDateInput {
  /** Calendar year in which the fiscal year begins. */
  taxYear: number;
  /** 1..12. */
  fiscalYearStartMonth: number;
  /** Months of the fiscal year (ccorp.installment_months). */
  installmentMonths: ReadonlyArray<number>;
  /** Day of the month (ccorp.installment_day). */
  installmentDay: number;
  /** Legal holidays ('YYYY-MM-DD') for the §7503 roll. */
  holidays: ReadonlyArray<string>;
}

export interface CcorpInstallmentDate {
  fiscalMonth: number;
  statutoryDueDate: string;
  dueDate: string;
}

const MONTHS_PER_YEAR = 12;

function assertFiscalMonth(m: number): void {
  if (!Number.isInteger(m) || m < 1 || m > MONTHS_PER_YEAR) throw new Error(`TE_CCORP_FISCAL_MONTH: fiscal_year_start_month ${m} is not 1..12`);
}

/** Zero-based calendar month offset from Jan of `taxYear` for fiscal month `fiscalMonth` (1-based) of a year starting in `startMonth` (1-based). */
function calendarMonthIndex(startMonth: number, fiscalMonth: number): number {
  return (startMonth - 1) + (fiscalMonth - 1);
}

/** Pure: the statutory and rolled due dates of each fiscal-year installment. */
export function ccorpInstallmentDates(input: CcorpInstallmentDateInput): CcorpInstallmentDate[] {
  assertFiscalMonth(input.fiscalYearStartMonth);
  const holidays = [...input.holidays];
  return input.installmentMonths.map((fiscalMonth) => {
    if (!Number.isInteger(fiscalMonth) || fiscalMonth < 1 || fiscalMonth > MONTHS_PER_YEAR) throw new Error(`TE_CCORP_INSTALLMENT_MONTH: installment month ${fiscalMonth} is not 1..12`);
    const statutoryDueDate = isoDateUtc(input.taxYear, calendarMonthIndex(input.fiscalYearStartMonth, fiscalMonth), input.installmentDay);
    return { fiscalMonth, statutoryDueDate, dueDate: nextBusinessDay(statutoryDueDate, holidays) };
  });
}

// ── Engine ───────────────────────────────────────────────────────────

class Sink {
  readonly rows: CcorpTraceRow[] = [];
  readonly warnings: TaxEstimatorWarning[] = [];
  private readonly seen = new Set<string>();

  add(row: Omit<CcorpTraceRow, 'amount'>): void {
    this.rows.push({ ...row, amount: dRoundDollars(row.exact) });
  }

  warn(code: string, message: string, details?: Record<string, unknown>, severity: 'warning' | 'info' = 'warning'): void {
    const key = `${code}|${JSON.stringify(details ?? null)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.warnings.push(details ? { code, severity, message, details } : { code, severity, message });
  }
}

const R = dRoundDollars;

function priorYearRuleFor(prior: CcorpPriorYear | null, large: boolean): CcorpPriorYearRule {
  if (!prior || prior.tax === null) return { available: false, reason: 'not_provided', appliesTo: 'none' };
  if (!prior.fullTwelveMonths) return { available: false, reason: 'short_year', appliesTo: 'none' };
  if (!dIsPos(dec(prior.tax))) return { available: false, reason: 'zero_liability', appliesTo: 'none' };
  return { available: true, reason: 'ok', appliesTo: large ? 'first_installment' : 'all' };
}

/**
 * C corp entity-level estimate: federal tax, state apportionment, fiscal-year
 * installment schedule with the large-corporation / prior-year rules. Pure.
 */
export function computeCcorp(input: CcorpEngineInput): CcorpResult {
  assertFiscalMonth(input.fiscalYearStartMonth);
  const params = new ParameterReader(input.parameters);
  const sink = new Sink();
  const entityId = input.companyId;

  // Fiscal year.
  const fiscalYearStart = isoDateUtc(input.taxYear, calendarMonthIndex(input.fiscalYearStartMonth, 1), 1);
  const fiscalYearEnd = lastDayOfMonthUtc(input.taxYear, calendarMonthIndex(input.fiscalYearStartMonth, MONTHS_PER_YEAR));

  // Federal tax (§11(b)).
  const taxableIncome = dec(input.taxableIncome);
  const taxableBase = dFloorZero(taxableIncome);
  const rate = params.rate('ccorp.rate');
  const federalTax = dMul(taxableBase, rate);
  sink.add({ step: 'ccorp_tax', id: 'ccorp.taxable_income', label: `${input.companyName} taxable income`, exact: taxableIncome, source: 'input' });
  sink.add({ step: 'ccorp_tax', id: 'ccorp.federal_tax', label: 'Federal income tax (taxable income × rate)', exact: federalTax, source: 'parameter', formula: `max(0, ${taxableIncome}) × ${rate}`, parameterKeys: ['ccorp.rate'] });

  // States: apportionment % × taxable income × rate.
  const states: CcorpStateResult[] = input.states.map((row) => {
    const e = computeCcorpStateTax({ state: row.state, taxableIncome: taxableIncome, apportionmentPct: row.apportionmentPct, effectiveRate: row.effectiveRate });
    sink.add({ step: 'ccorp_state', id: `state.${row.state}.apportioned`, label: `${row.state} apportioned taxable income`, exact: e.apportioned, source: 'input', formula: `max(0, ${taxableIncome}) × ${dec(row.apportionmentPct)}` });
    sink.add({ step: 'ccorp_state', id: `state.${row.state}.tax`, label: `${row.state} C corp tax (apportioned × rate)`, exact: e.tax, source: 'input', formula: `${e.apportioned} × ${dec(row.effectiveRate)}` });
    return { state: row.state, apportionmentPct: dec(row.apportionmentPct), effectiveRate: dec(row.effectiveRate), apportioned: R(e.apportioned), tax: R(e.tax), exact: { apportioned: e.apportioned, tax: e.tax } };
  });
  const stateTotal = dSum(states.map((s) => s.exact.tax));
  const totalTax = dAdd(federalTax, stateTotal);
  sink.add({ step: 'ccorp_state', id: 'ccorp.state_total', label: 'State tax (all jurisdictions)', exact: stateTotal, source: 'input' });
  sink.add({ step: 'ccorp_tax', id: 'ccorp.total_tax', label: 'Total tax (federal + states)', exact: totalTax, source: 'input', formula: `${federalTax} + ${stateTotal}` });

  // §6655(f) floor.
  const minTax = params.money('ccorp.min_tax_for_estimates');
  const estimatesRequired = dCmp(federalTax, minTax) >= 0;
  if (!estimatesRequired) {
    sink.warn('TE_CCORP_BELOW_MIN_TAX', `Federal tax ${R(federalTax)} is below ${minTax}; no estimated-tax installments are required (IRC §6655(f)). The schedule is shown for reference.`, { federalTax: R(federalTax), minTax }, 'info');
  }

  // Large corporation (§6655(g)(2)).
  let large = false;
  let largeSource: CcorpResult['largeCorporationSource'] = 'not_large';
  if (input.largeCorporation) {
    large = true; largeSource = 'flag';
  } else if (input.priorYearsTaxableIncome && input.priorYearsTaxableIncome.length > 0) {
    const threshold = params.money('ccorp.large_corp_threshold');
    const lookback = params.int('ccorp.large_corp_lookback_years');
    const tested = input.priorYearsTaxableIncome.slice(0, lookback);
    if (tested.some((ti) => dCmp(dec(ti), threshold) >= 0)) {
      large = true; largeSource = 'derived';
      sink.warn('TE_CCORP_LARGE_CORP_DERIVED', `${input.companyName} is treated as a large corporation: taxable income reached ${threshold} in one of the ${lookback} preceding years (IRC §6655(g)(2)); the entity flag is off.`, { companyId: entityId, threshold, lookback });
    }
  }

  // Required annual payment (§6655(d)(1)).
  const currentPct = params.rate('ccorp.safe_harbor_current_pct');
  const priorPct = params.rate('ccorp.safe_harbor_prior_pct');
  const priorYearRule = priorYearRuleFor(input.priorYear, large);
  const rapCurrent = dMul(federalTax, currentPct);
  const rapPrior = priorYearRule.available && input.priorYear?.tax != null ? dMul(dec(input.priorYear.tax), priorPct) : null;
  const rapRequired = rapPrior !== null && priorYearRule.appliesTo === 'all' ? dMin(rapCurrent, rapPrior) : rapCurrent;
  sink.add({ step: 'ccorp_safe_harbor', id: 'ccorp.rap.current_year', label: 'Required annual payment: current-year rule', exact: rapCurrent, source: 'parameter', formula: `${federalTax} × ${currentPct}`, parameterKeys: ['ccorp.safe_harbor_current_pct'] });
  if (rapPrior !== null) {
    sink.add({ step: 'ccorp_safe_harbor', id: 'ccorp.rap.prior_year', label: `Required annual payment: prior-year rule${large ? ' (first installment only — large corporation)' : ''}`, exact: rapPrior, source: 'parameter', formula: `${dec(input.priorYear!.tax!)} × ${priorPct}`, parameterKeys: ['ccorp.safe_harbor_prior_pct'] });
  } else {
    sink.warn('TE_CCORP_PRIOR_YEAR_UNAVAILABLE', `The prior-year safe harbor is unavailable (${priorYearRule.reason.replace('_', ' ')}); installments are based on the current-year tax (IRC §6655(d)(1)(B)(ii)).`, { reason: priorYearRule.reason }, 'info');
  }
  sink.add({ step: 'ccorp_safe_harbor', id: 'ccorp.rap.required', label: 'Required annual payment', exact: rapRequired, source: 'parameter' });

  // Installments (§6655(c), (d)(2)).
  const months = params.intList('ccorp.installment_months');
  const pcts = params.rateList('ccorp.installment_pcts');
  if (months.length !== pcts.length || months.length === 0) throw new Error(`TE_CCORP_INSTALLMENT_LISTS: ccorp.installment_months (${months.length}) and ccorp.installment_pcts (${pcts.length}) must be non-empty and the same length`);
  const day = params.int('ccorp.installment_day');
  const holidays = params.dateList('holidays');
  const dates = ccorpInstallmentDates({ taxYear: input.taxYear, fiscalYearStartMonth: input.fiscalYearStartMonth, installmentMonths: months, installmentDay: day, holidays });

  const installments: CcorpInstallment[] = [];
  let cumulative: Dec = ZERO;
  let recaptureCarry: Dec = ZERO;
  dates.forEach((d, idx) => {
    const pct = pcts[idx]!;
    const number = idx + 1;
    const currentBasis = dMul(rapCurrent, pct);
    const priorReaches = rapPrior !== null && (priorYearRule.appliesTo === 'all' || (priorYearRule.appliesTo === 'first_installment' && idx === 0));
    const priorBasis = priorReaches ? dMul(rapPrior!, pct) : null;
    const base = priorBasis !== null ? dMin(currentBasis, priorBasis) : currentBasis;
    const basis: CcorpInstallment['basis'] = priorBasis !== null && dCmp(priorBasis, currentBasis) < 0 ? 'prior_year' : 'current_year';
    const recapture = recaptureCarry;
    recaptureCarry = ZERO;
    if (large && idx === 0 && priorBasis !== null) recaptureCarry = dFloorZero(dSub(currentBasis, base));
    const required = dAdd(base, recapture);
    cumulative = dAdd(cumulative, required);
    const label = `Installment ${number} (fiscal month ${d.fiscalMonth}, due ${d.dueDate})${dIsPos(recapture) ? ' incl. large-corporation recapture' : ''}`;
    sink.add({
      step: 'ccorp_installments', id: `ccorp.installment.${number}`, label, exact: required, source: 'parameter',
      formula: `${pct} × ${basis === 'prior_year' ? rapPrior : rapCurrent}${dIsPos(recapture) ? ` + recapture ${recapture}` : ''}`,
      parameterKeys: ['ccorp.installment_months', 'ccorp.installment_pcts', 'ccorp.installment_day', 'holidays'],
    });
    installments.push({
      number, fiscalMonth: d.fiscalMonth, statutoryDueDate: d.statutoryDueDate, dueDate: d.dueDate, pct,
      currentYearBasis: R(currentBasis), priorYearBasis: priorBasis === null ? null : R(priorBasis), recapture: R(recapture), required: R(required), cumulativeRequired: R(cumulative), basis,
      exact: { currentYearBasis: currentBasis, priorYearBasis: priorBasis, recapture, required, cumulativeRequired: cumulative },
    });
  });

  return {
    engineVersion: TAX_ENGINE_VERSION,
    taxYear: input.taxYear,
    tenantId: input.tenantId,
    companyId: input.companyId,
    companyName: input.companyName,
    fiscalYearStartMonth: input.fiscalYearStartMonth,
    fiscalYearStart,
    fiscalYearEnd,
    taxableIncome: R(taxableIncome),
    rate,
    federalTax: R(federalTax),
    states,
    stateTotal: R(stateTotal),
    totalTax: R(totalTax),
    largeCorporation: large,
    largeCorporationSource: largeSource,
    estimatesRequired,
    minTaxForEstimates: minTax,
    priorYearRule,
    requiredAnnualPayment: { currentYearPct: currentPct, currentYear: R(rapCurrent), priorYearPct: priorPct, priorYear: rapPrior === null ? null : R(rapPrior), required: R(rapRequired) },
    installments,
    exact: { taxableIncome, federalTax, stateTotal, totalTax, requiredAnnualPayment: { currentYear: rapCurrent, priorYear: rapPrior, required: rapRequired } },
    trace: sink.rows,
    warnings: [...sink.warnings, ...params.warnings()],
    parametersUsed: params.used(),
  };
}
