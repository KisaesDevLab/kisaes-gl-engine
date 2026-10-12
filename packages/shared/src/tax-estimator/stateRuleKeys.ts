// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// State estimated-tax rule registry (features/tax-estimator/MODULE.md "State rule keys").
// 50 states + DC = 51 jurisdictions. Jurisdictions with no broad personal income tax
// need only `has_income_tax = false`; the rest need the full key set per tax year.

export const STATE_CODES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO',
  'MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
] as const;
export type StateCode = typeof STATE_CODES[number];

/** Jurisdictions with NO broad-based personal income tax for 2025–2026 (verify yearly). */
export const NO_BROAD_INCOME_TAX_STATES: readonly StateCode[] = ['AK','FL','NV','NH','SD','TN','TX','WA','WY'];

export const STATE_NAMES: Record<StateCode, string> = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',
  FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',
  MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
  NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
};

export function isIncomeTaxState(code: StateCode): boolean {
  return !NO_BROAD_INCOME_TAX_STATES.includes(code);
}

export const STATE_RULE_VALUE_TYPES = ['bool', 'money', 'rate', 'date', 'date_list', 'rate_list', 'enum', 'high_agi_rule', 'farmer_rule', 'rate_schedule'] as const;
export type StateRuleValueType = typeof STATE_RULE_VALUE_TYPES[number];

/** `required_threshold` / `penalty.min_balance_due` boundary: "$X or more" vs "more than $X". */
export const THRESHOLD_COMPARISONS = ['at_least', 'more_than'] as const;
export type ThresholdComparison = typeof THRESHOLD_COMPARISONS[number];

/**
 * How the underpayment penalty accrues. daily_simple = rate x days/365 (federal pattern);
 * monthly_or_fraction = rate/12 per month or part of a month (HI); monthly_compound =
 * rate/12 per month or fraction, compounded (ME); tiered_flat = flat late-payment
 * percentages, not a rate over time (IL; penalty.rate is null).
 */
export const PENALTY_METHODS = ['daily_simple', 'monthly_or_fraction', 'monthly_compound', 'tiered_flat'] as const;
export type PenaltyMethod = typeof PENALTY_METHODS[number];

/** farmer.rule.treatment. Absent = single_installment (the federal pattern). */
export const FARMER_TREATMENTS = ['single_installment', 'quarterly', 'exempt'] as const;
export type FarmerTreatment = typeof FARMER_TREATMENTS[number];

/** One dated leg of `penalty.rate_schedule`, inclusive calendar dates. */
export interface StateRatePeriod { from: string; to: string; rate: number }

export interface StateRuleDef {
  key: string;
  type: StateRuleValueType;
  label: string;
  /** For 'enum' types. */
  options?: readonly string[];
  /** If true the value may be JSON null (rule does not exist in that state). */
  nullable?: boolean;
}

export const STATE_RULE_REGISTRY: readonly StateRuleDef[] = [
  { key: 'has_income_tax', type: 'bool', label: 'Broad-based personal income tax' },
  { key: 'estimates_required', type: 'bool', label: 'State has a quarterly individual estimated-tax regime (false = no vouchers, no underpayment penalty)' },
  { key: 'required_threshold', type: 'money', label: 'Estimates required when tax due after withholding/credits is at least' },
  { key: 'threshold_comparison', type: 'enum', label: 'Threshold boundary for required_threshold and penalty.min_balance_due (null = at_least)', options: THRESHOLD_COMPARISONS, nullable: true },
  { key: 'safe_harbor.current_pct', type: 'rate', label: 'Safe harbor: % of current-year tax' },
  { key: 'safe_harbor.prior_pct', type: 'rate', label: 'Safe harbor: % of prior-year tax', nullable: true },
  { key: 'safe_harbor.high_agi_rule', type: 'high_agi_rule', label: 'High-AGI prior-year rule ({ threshold, pct, threshold_mfs?, no_prior_year_agi?, no_prior_year_agi_mfs? })', nullable: true },
  { key: 'installments.due_dates', type: 'date_list', label: 'Installment due dates' },
  { key: 'installments.pcts', type: 'rate_list', label: 'Installment percentages' },
  { key: 'installments.q4_file_and_pay_date', type: 'date', label: 'Last installment waived if the return is filed and paid in full by (null = no such relief)', nullable: true },
  { key: 'return_due_date', type: 'date', label: 'Return due date that ends the penalty period (null = April 15 of the next year)', nullable: true },
  { key: 'farmer.rule', type: 'farmer_rule', label: 'Farmer/fisherman rule ({ ratio, current_pct, due_date, file_by, treatment? })', nullable: true },
  { key: 'penalty.rate_source', type: 'enum', label: 'Underpayment penalty rate source', options: ['federal', 'state'] },
  { key: 'penalty.rate', type: 'rate', label: 'State underpayment penalty annual rate (when source = state)', nullable: true },
  { key: 'penalty.rate_schedule', type: 'rate_schedule', label: 'Dated penalty rates [{ from, to, rate }] (supersedes penalty.rate on covered days; null = single rate)', nullable: true },
  { key: 'penalty.method', type: 'enum', label: 'How the penalty accrues (null = daily_simple)', options: PENALTY_METHODS, nullable: true },
  { key: 'penalty.min_balance_due', type: 'money', label: 'No penalty when tax after credits less withholding is below (null = use required_threshold)', nullable: true },
  { key: 'credit_for_other_state', type: 'bool', label: 'Credit for tax paid to other states' },
  { key: 'nonresident_method', type: 'enum', label: 'How nonresident tax is computed', options: ['ratio', 'sourced_flat', 'other'] },
  { key: 'holidays', type: 'date_list', label: 'State holidays used for due-date roll-forward' },
];

const REQUIRED_WHEN_TAXED = STATE_RULE_REGISTRY.map((d) => d.key);

/** Keys a complete (state, year) row set must contain. */
export function requiredStateRuleKeys(hasIncomeTax: boolean): string[] {
  return hasIncomeTax ? REQUIRED_WHEN_TAXED : ['has_income_tax'];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** Strict calendar check (rejects 2026-02-30). */
function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function getStateRuleDef(key: string): StateRuleDef | undefined {
  return STATE_RULE_REGISTRY.find((d) => d.key === key);
}

export function validateStateRuleValue(def: StateRuleDef, value: unknown): string | null {
  if (value === null) return def.nullable ? null : 'null not allowed for this key';
  switch (def.type) {
    case 'bool': return typeof value === 'boolean' ? null : 'expected true/false';
    case 'money': case 'rate': return isNum(value) && value >= 0 ? null : 'expected a non-negative number';
    case 'date': return typeof value === 'string' && isIsoDate(value) ? null : 'expected a YYYY-MM-DD date';
    case 'date_list': return Array.isArray(value) && value.every((x) => typeof x === 'string' && ISO_DATE.test(x)) ? null : 'expected YYYY-MM-DD dates';
    case 'rate_list': return Array.isArray(value) && value.length > 0 && value.every((x) => isNum(x) && x >= 0) ? null : 'expected a non-empty list of non-negative numbers';
    case 'enum': return typeof value === 'string' && (def.options ?? []).includes(value) ? null : `expected one of ${(def.options ?? []).join(', ')}`;
    case 'high_agi_rule': {
      if (!isObj(value)) return 'expected { threshold, pct }';
      const v = value as { threshold?: unknown; pct?: unknown; threshold_mfs?: unknown; no_prior_year_agi?: unknown; no_prior_year_agi_mfs?: unknown };
      if (!isNum(v.threshold) || !isNum(v.pct)) return 'expected { threshold, pct }';
      const optNum = (x: unknown) => x === undefined || (isNum(x) && x >= 0);
      return optNum(v.threshold_mfs) && optNum(v.no_prior_year_agi) && optNum(v.no_prior_year_agi_mfs)
        ? null : 'threshold_mfs / no_prior_year_agi / no_prior_year_agi_mfs must be non-negative numbers';
    }
    case 'farmer_rule': {
      if (!isObj(value)) return 'expected { ratio, current_pct, due_date, file_by }';
      const v = value as { ratio?: unknown; current_pct?: unknown; due_date?: unknown; file_by?: unknown; treatment?: unknown };
      if (!(isNum(v.ratio) && isNum(v.current_pct) && typeof v.due_date === 'string' && isIsoDate(v.due_date) && typeof v.file_by === 'string' && isIsoDate(v.file_by))) {
        return 'expected { ratio, current_pct, due_date, file_by }';
      }
      if (v.treatment !== undefined && !(FARMER_TREATMENTS as readonly unknown[]).includes(v.treatment)) {
        return `treatment must be one of ${FARMER_TREATMENTS.join(', ')}`;
      }
      return null;
    }
    case 'rate_schedule': {
      if (!Array.isArray(value) || value.length === 0) return 'expected a non-empty list of { from, to, rate }';
      let prevTo = '';
      for (const p of value as unknown[]) {
        if (!isObj(p)) return 'expected a non-empty list of { from, to, rate }';
        const r = p as { from?: unknown; to?: unknown; rate?: unknown };
        if (typeof r.from !== 'string' || !isIsoDate(r.from) || typeof r.to !== 'string' || !isIsoDate(r.to) || !isNum(r.rate) || r.rate < 0) {
          return 'each period needs from/to YYYY-MM-DD dates and a non-negative rate';
        }
        if (r.from > r.to) return `period ${r.from}..${r.to} ends before it starts`;
        if (prevTo && r.from <= prevTo) return 'periods must be in date order and must not overlap';
        prevTo = r.to;
      }
      return null;
    }
    default: return 'unknown type';
  }
}

export interface StateRuleSeedRow {
  state: StateCode;
  year: number;
  key: string;
  value: unknown;
  citation: string;
  status: 'verified' | 'unverified' | 'provisional';
}

/**
 * Penalty rate for one calendar day under a resolved rule set: a `penalty.rate_schedule`
 * leg covering `isoDate` wins; otherwise the single `penalty.rate`. `covered` is false
 * when a schedule exists but has no leg for that day (e.g. a next-year rate not yet
 * published) — the caller then uses the returned single rate and shows "verify".
 */
export function statePenaltyRateOn(rules: Record<string, unknown>, isoDate: string): { rate: number | null; fromSchedule: boolean; covered: boolean } {
  const single = typeof rules['penalty.rate'] === 'number' ? (rules['penalty.rate'] as number) : null;
  const sched = rules['penalty.rate_schedule'];
  if (Array.isArray(sched) && sched.length > 0) {
    const leg = (sched as StateRatePeriod[]).find((p) => p.from <= isoDate && isoDate <= p.to);
    return leg ? { rate: leg.rate, fromSchedule: true, covered: true } : { rate: single, fromSchedule: false, covered: false };
  }
  return { rate: single, fromSchedule: false, covered: true };
}
