// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 9: farmer / fisherman rules (IRC §6654(i); MODULE.md "Safe harbor,
// Schedule AI, vouchers, penalties"; PHASES.md Phase 9).
//
//   qualification  = gross income from farming AND fishing ≥ farmer.gross_income_ratio of
//                    total gross income in the CURRENT year OR the PRIOR year (§6654(i)(2));
//                    on a joint return both spouses' gross income is combined; otherwise only
//                    the filer's; tax_est_entity_settings.farmer_override forces the answer
//   66 2/3% rule   = required annual payment is the lesser of farmer.safe_harbor_current_pct ×
//                    current-year tax and farmer.safe_harbor_prior_pct × prior-year tax; the
//                    110% high-AGI variant never applies (§6654(i)(1)(C))
//   installments   = ONE installment of 100% due farmer.single_due_date (Jan 15); filing and
//                    paying by farmer.file_by_date (Mar 1) removes the requirement (§6654(i)(1)(D))
//   fishermen      = same rules; `isFisherman` only labels the result
//   non-qualifying = the regular individual rules (safe_harbor.*, installments.*), returned
//                    in the same shape so Phase 10 consumes one contract
//
// This module decides the RULE SET (percentages, schedule, dates) and, when the
// tax figures are given, the required annual payment. Payments, the lesser-of
// Schedule AI installment, penalties and the Mar 1 cure are Phase 10.

import type { FilingStatus, TraceRow } from '../types.js';
import type { TaxEstimatorWarning } from '../entities-api.js';
import { dAdd, dCmp, dDiv, dIsPos, dMin, dMul, dRoundDollars, dSum, dec, type Dec } from '../decimal.js';
import { ParameterReader } from './parameters.js';
import { TAX_ENGINE_VERSION } from './version.js';
import type { ParameterMap, ParameterUse } from './types.js';

// ── Input ────────────────────────────────────────────────────────────

export interface FarmerPersonGross {
  personId: string;
  /** Gross income from farming (Sch F gross income, farm rental, farm gains per Pub. 505). Positive. */
  farming: Dec;
  /** Gross income from fishing (Sch C fishing gross receipts, etc.). Positive. */
  fishing: Dec;
  /** TOTAL gross income of the person for the year (wages, interest, business gross income, …). */
  totalGross: Dec;
}

export interface FarmerYearGross {
  byPerson: ReadonlyArray<FarmerPersonGross>;
}

export interface FarmerTaxFigures {
  /** Projected current-year tax for the safe-harbor base (Form 2210 line 4 definition: total tax less refundable credits). */
  currentYearTax: Dec;
  /** Prior-year tax (same definition); null = unknown / not filed. Tax return information (D9). */
  priorYearTax: Dec | null;
  /** The prior year was a full 12-month year that was filed. */
  priorYearFullTwelveMonths: boolean;
  /** Prior-year AGI (regular rules' high-AGI test); null = unknown → the standard percentage. */
  priorYearAgi: Dec | null;
}

export interface FarmerEngineInput {
  taxYear: number;
  filingStatus: FilingStatus;
  parameters: ParameterMap;
  /** The filer whose gross income is tested on a non-joint return. */
  primaryPersonId: string;
  currentYear: FarmerYearGross | null;
  priorYear: FarmerYearGross | null;
  /** tax_est_entity_settings.farmer_override: true = farmer, false = never, null = apply the test. */
  farmerOverride: boolean | null;
  /** Labels the taxpayer a fisherman (same rules). */
  isFisherman: boolean;
  /** Tax figures for the required annual payment; null = rule set only. */
  tax: FarmerTaxFigures | null;
}

// ── Result ───────────────────────────────────────────────────────────

export const FARMER_STEPS = ['farmer_test', 'farmer_safe_harbor'] as const;
export type FarmerStep = typeof FARMER_STEPS[number];

export interface FarmerTraceRow extends TraceRow {
  step: FarmerStep;
  id: string;
  exact: Dec;
  parameterKeys?: string[];
}

export interface FarmerGrossTest {
  year: 'current' | 'prior';
  farmingAndFishing: Dec;
  totalGross: Dec;
  /** farmingAndFishing ÷ totalGross (12 places); null when total gross is zero. */
  ratio: Dec | null;
  passes: boolean;
  personsCounted: number;
}

export type PriorYearUnavailableReason = 'not_provided' | 'short_year' | 'zero_liability';

/**
 * The safe-harbor rule set in force for the taxpayer. Phase 10 computes the
 * installment amounts from these percentages and this schedule.
 */
export interface SafeHarborRuleSet {
  regime: 'farmer' | 'regular';
  /** Fraction of current-year tax (farmer 66 2/3%, regular 90%). */
  currentPct: Dec;
  /** Fraction of prior-year tax (100%). */
  priorPct: Dec;
  /** Regular rules only: the high-AGI prior-year fraction (110%); null for farmers. */
  priorPctHighAgi: Dec | null;
  /** Regular rules only: prior-year AGI above which `priorPctHighAgi` applies (filing-status variant); null for farmers. */
  highAgiThreshold: Dec | null;
  /** false when the prior year is unknown, short or showed no tax (then only the current-year rule applies). */
  priorYearRuleAvailable: boolean;
  priorYearUnavailableReason: PriorYearUnavailableReason | null;
}

export interface InstallmentScheduleEntry {
  /** 1-based. */
  number: number;
  /** Parameter due date (already weekend/holiday adjusted in the seed). */
  dueDate: string;
  /** Fraction of the required annual payment due. */
  pct: Dec;
}

export interface FarmerRequiredAnnualPayment {
  /** currentPct × current-year tax. */
  currentYear: Dec;
  /** (priorPct or priorPctHighAgi) × prior-year tax; null when unavailable. */
  priorYear: Dec | null;
  /** Lesser of the available bases. */
  required: Dec;
  highAgiApplied: boolean;
}

export interface FarmerResult {
  engineVersion: string;
  taxYear: number;
  filingStatus: FilingStatus;
  qualifies: boolean;
  basis: 'current_year' | 'prior_year' | 'override' | 'none';
  label: 'farmer' | 'fisherman';
  /** true on a joint return: both spouses' gross income was combined for the test. */
  jointTest: boolean;
  requiredRatio: Dec;
  tests: FarmerGrossTest[];
  safeHarbor: SafeHarborRuleSet;
  installments: InstallmentScheduleEntry[];
  /** Filing and paying the balance by this date removes the (last) installment requirement. */
  fileAndPayByDate: string;
  fileAndPayNote: string;
  requiredAnnualPayment: FarmerRequiredAnnualPayment | null;
  notes: string[];
  exact: { requiredAnnualPayment: { currentYear: Dec; priorYear: Dec | null; required: Dec } | null };
  trace: FarmerTraceRow[];
  warnings: TaxEstimatorWarning[];
  parametersUsed: ParameterUse[];
}

// ── Gross-income test ────────────────────────────────────────────────

/** Pure: Σ (farming + fishing) ÷ Σ total gross ≥ requiredRatio over the persons given. */
export function farmerGrossIncomeTest(persons: ReadonlyArray<FarmerPersonGross>, requiredRatio: Dec, year: FarmerGrossTest['year'] = 'current'): FarmerGrossTest {
  const farmingAndFishing = dSum(persons.map((p) => dAdd(dec(p.farming), dec(p.fishing))));
  const totalGross = dSum(persons.map((p) => dec(p.totalGross)));
  const ratio = dIsPos(totalGross) ? dDiv(farmingAndFishing, totalGross) : null;
  const passes = ratio !== null && dCmp(ratio, dec(requiredRatio)) >= 0;
  return { year, farmingAndFishing, totalGross, ratio, passes, personsCounted: persons.length };
}

// ── Engine ───────────────────────────────────────────────────────────

class Sink {
  readonly rows: FarmerTraceRow[] = [];
  readonly warnings: TaxEstimatorWarning[] = [];
  private readonly seen = new Set<string>();

  add(row: Omit<FarmerTraceRow, 'amount'>): void {
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

function priorYearAvailability(tax: FarmerTaxFigures | null): { available: boolean; reason: PriorYearUnavailableReason | null } {
  if (!tax || tax.priorYearTax === null) return { available: false, reason: 'not_provided' };
  if (!tax.priorYearFullTwelveMonths) return { available: false, reason: 'short_year' };
  if (!dIsPos(dec(tax.priorYearTax))) return { available: false, reason: 'zero_liability' };
  return { available: true, reason: null };
}

/**
 * Farmer / fisherman qualification and the safe-harbor rule set in force
 * (farmer rules when qualifying, otherwise the regular individual rules). Pure.
 */
export function computeFarmer(input: FarmerEngineInput): FarmerResult {
  const params = new ParameterReader(input.parameters);
  const sink = new Sink();
  const notes: string[] = [];
  const jointTest = input.filingStatus === 'mfj';
  const label: FarmerResult['label'] = input.isFisherman ? 'fisherman' : 'farmer';

  // Qualification (§6654(i)(2)).
  const requiredRatio = params.rate('farmer.gross_income_ratio');
  const tests: FarmerGrossTest[] = [];
  const testedPersons = (year: FarmerYearGross): ReadonlyArray<FarmerPersonGross> => {
    if (jointTest) return year.byPerson;
    const filer = year.byPerson.filter((p) => p.personId === input.primaryPersonId);
    if (filer.length !== year.byPerson.length) {
      sink.warn('TE_FARMER_SPOUSE_INCOME_IGNORED', 'The gross-income test on a separate return counts only the filer\'s gross income; the other person\'s amounts were ignored.', { filingStatus: input.filingStatus }, 'info');
    }
    return filer;
  };
  for (const [year, data] of [['current', input.currentYear], ['prior', input.priorYear]] as const) {
    if (!data) continue;
    const t = farmerGrossIncomeTest(testedPersons(data), requiredRatio, year);
    tests.push(t);
    sink.add({
      step: 'farmer_test', id: `farmer.test.${year}`, label: `Gross income from farming/fishing, ${year} year (${t.passes ? 'passes' : 'fails'} the ${requiredRatio} test)`,
      exact: t.farmingAndFishing, source: 'input', formula: t.ratio === null ? 'total gross income is zero' : `${t.farmingAndFishing} ÷ ${t.totalGross} = ${t.ratio}`, parameterKeys: ['farmer.gross_income_ratio'],
    });
  }
  if (tests.length === 0 && input.farmerOverride === null) {
    sink.warn('TE_FARMER_NO_GROSS_INCOME', 'No gross-income figures were available for the farmer/fisherman test; the regular estimated-tax rules apply.', undefined, 'info');
  }

  let qualifies: boolean;
  let basis: FarmerResult['basis'];
  if (input.farmerOverride !== null) {
    qualifies = input.farmerOverride;
    basis = 'override';
    sink.warn('TE_FARMER_OVERRIDE', `The ${label} status is set by the entity override (${qualifies ? 'qualifies' : 'does not qualify'}); the gross-income test was not used.`, { farmerOverride: qualifies }, 'info');
  } else if (tests.find((t) => t.year === 'current')?.passes) {
    qualifies = true; basis = 'current_year';
  } else if (tests.find((t) => t.year === 'prior')?.passes) {
    qualifies = true; basis = 'prior_year';
    notes.push(`Qualifies as a ${label} on the prior year's gross income only (IRC §6654(i)(2)).`);
  } else {
    qualifies = false; basis = 'none';
  }

  // Rule set.
  const prior = priorYearAvailability(input.tax);
  let safeHarbor: SafeHarborRuleSet;
  let installments: InstallmentScheduleEntry[];
  let fileAndPayByDate: string;
  let fileAndPayNote: string;
  if (qualifies) {
    const currentPct = params.rate('farmer.safe_harbor_current_pct');
    const priorPct = params.rate('farmer.safe_harbor_prior_pct');
    safeHarbor = { regime: 'farmer', currentPct, priorPct, priorPctHighAgi: null, highAgiThreshold: null, priorYearRuleAvailable: prior.available, priorYearUnavailableReason: prior.reason };
    installments = [{ number: 1, dueDate: params.date('farmer.single_due_date'), pct: dec(1) }];
    fileAndPayByDate = params.date('farmer.file_by_date');
    fileAndPayNote = `${label === 'fisherman' ? 'Fishermen' : 'Farmers'}: one installment is due ${installments[0]!.dueDate}. If the return is filed and the full balance paid by ${fileAndPayByDate}, no estimated tax payment is required (IRC §6654(i)(1)(D)).`;
    notes.push(`Farmer/fisherman safe harbor: ${currentPct} of current-year tax (the 110% high-AGI rule does not apply).`);
  } else {
    const currentPct = params.rate('safe_harbor.current_pct');
    const priorPct = params.rate('safe_harbor.prior_pct');
    const priorPctHighAgi = params.rate('safe_harbor.prior_pct_high_agi');
    const highAgiThreshold = params.money(input.filingStatus === 'mfs' ? 'safe_harbor.high_agi_threshold.mfs' : 'safe_harbor.high_agi_threshold.standard');
    safeHarbor = { regime: 'regular', currentPct, priorPct, priorPctHighAgi, highAgiThreshold, priorYearRuleAvailable: prior.available, priorYearUnavailableReason: prior.reason };
    const dueDates = params.dateList('installments.due_dates');
    const pcts = params.rateList('installments.pcts');
    if (dueDates.length !== pcts.length || dueDates.length === 0) throw new Error(`TE_INSTALLMENT_LISTS: installments.due_dates (${dueDates.length}) and installments.pcts (${pcts.length}) must be non-empty and the same length`);
    installments = dueDates.map((dueDate, i) => ({ number: i + 1, dueDate, pct: pcts[i]! }));
    fileAndPayByDate = params.date('installments.q4_file_and_pay_date');
    fileAndPayNote = `If the return is filed and the full balance paid by ${fileAndPayByDate}, the last installment is treated as paid on time (IRC §6654(h)).`;
    if (tests.length > 0 && basis === 'none') notes.push(`Does not qualify as a ${label} (gross income from farming/fishing below ${requiredRatio} of total gross income in both years); regular estimated-tax rules apply.`);
  }

  // Required annual payment when the tax figures are known.
  let rap: FarmerRequiredAnnualPayment | null = null;
  let rapExact: FarmerResult['exact']['requiredAnnualPayment'] = null;
  if (input.tax) {
    const currentTax = dec(input.tax.currentYearTax);
    const current = dMul(currentTax, safeHarbor.currentPct);
    let priorAmount: Dec | null = null;
    let highAgiApplied = false;
    if (prior.available && input.tax.priorYearTax !== null) {
      let pct = safeHarbor.priorPct;
      if (safeHarbor.regime === 'regular' && safeHarbor.priorPctHighAgi !== null && safeHarbor.highAgiThreshold !== null && input.tax.priorYearAgi !== null && dCmp(dec(input.tax.priorYearAgi), safeHarbor.highAgiThreshold) > 0) {
        pct = safeHarbor.priorPctHighAgi; highAgiApplied = true;
      }
      priorAmount = dMul(dec(input.tax.priorYearTax), pct);
      sink.add({ step: 'farmer_safe_harbor', id: 'safe_harbor.prior_year', label: `Required annual payment: prior-year rule (${pct} of prior-year tax)`, exact: priorAmount, source: 'parameter', formula: `${dec(input.tax.priorYearTax)} × ${pct}`, parameterKeys: [safeHarbor.regime === 'farmer' ? 'farmer.safe_harbor_prior_pct' : (highAgiApplied ? 'safe_harbor.prior_pct_high_agi' : 'safe_harbor.prior_pct')] });
    }
    const required = priorAmount === null ? current : dMin(current, priorAmount);
    sink.add({ step: 'farmer_safe_harbor', id: 'safe_harbor.current_year', label: `Required annual payment: current-year rule (${safeHarbor.currentPct} of current-year tax)`, exact: current, source: 'parameter', formula: `${currentTax} × ${safeHarbor.currentPct}`, parameterKeys: [safeHarbor.regime === 'farmer' ? 'farmer.safe_harbor_current_pct' : 'safe_harbor.current_pct'] });
    sink.add({ step: 'farmer_safe_harbor', id: 'safe_harbor.required', label: 'Required annual payment (lesser of the available rules)', exact: required, source: 'parameter' });
    rap = { currentYear: R(current), priorYear: priorAmount === null ? null : R(priorAmount), required: R(required), highAgiApplied };
    rapExact = { currentYear: current, priorYear: priorAmount, required };
  }

  return {
    engineVersion: TAX_ENGINE_VERSION,
    taxYear: input.taxYear,
    filingStatus: input.filingStatus,
    qualifies,
    basis,
    label,
    jointTest,
    requiredRatio,
    tests,
    safeHarbor,
    installments,
    fileAndPayByDate,
    fileAndPayNote,
    requiredAnnualPayment: rap,
    notes,
    exact: { requiredAnnualPayment: rapExact },
    trace: sink.rows,
    warnings: [...sink.warnings, ...params.warnings()],
    parametersUsed: params.used(),
  };
}
