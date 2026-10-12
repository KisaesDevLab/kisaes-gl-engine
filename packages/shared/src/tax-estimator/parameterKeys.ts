// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Federal parameter registry (features/tax-estimator/MODULE.md "Federal parameter keys").
//
// The engine reads parameters ONLY through this registry — never a literal. Each
// definition says what a value looks like, its unit, and which variants it expands
// into (`{fs}` = one concrete key per filing status). `expandParameterKeys()` yields
// the full set of concrete keys a complete tax year must have; the completeness
// check, the seed files and the admin screen are all driven from it.
//
// Storage: `tax_parameters.value` is jsonb. Money and counts are JSON numbers
// (exact integers), rates are JSON numbers (decimal fractions, 0.9235), dates are
// 'YYYY-MM-DD' strings, month-days are 'MM-DD'. The engine converts every number
// through `new Decimal(String(n))` — nothing here is ever used as a float in math.

import type { FilingStatus } from './types.js';
import { FILING_STATUSES } from './types.js';

export const PARAMETER_VALUE_TYPES = [
  'money',          // whole or cents dollars, number
  'rate',           // fraction 0..N, number
  'int',            // count / year, integer
  'date',           // 'YYYY-MM-DD'
  'month_day',      // 'MM-DD'
  'money_list',     // number[]
  'rate_list',      // number[]
  'number_list',    // number[] (factors)
  'int_list',       // integer[] (months)
  'date_list',      // 'YYYY-MM-DD'[]
  'month_day_list', // 'MM-DD'[]
  'bracket_table',  // [upperBound | null, rate][] — null = no upper bound (last row)
  'rate_period_list', // { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', rate: number }[]
] as const;
export type ParameterValueType = typeof PARAMETER_VALUE_TYPES[number];

export const PARAMETER_UNITS = ['usd', 'rate', 'count', 'year', 'date', 'month_day', 'months', 'factor', 'table'] as const;
export type ParameterUnit = typeof PARAMETER_UNITS[number];

export const PARAMETER_GROUPS = [
  'Self-employment', 'Brackets and capital gains', 'Medicare and NIIT', 'Deductions', 'Schedule 1-A',
  'QBI (§199A)', 'Loss limits', 'Retirement and HSA', 'C corporation', 'Individual safe harbor',
  'Installments', 'Schedule AI', 'Farmers and fishermen', 'Penalty', 'Calendar',
] as const;
export type ParameterGroup = typeof PARAMETER_GROUPS[number];

/** Variant sets a key can expand over. */
export const VARIANT_SETS = {
  fs: FILING_STATUSES,                                  // single | mfj | mfs | hoh | qss
  standard_mfs: ['standard', 'mfs'],
  standard_mfj: ['standard', 'mfj'],
  self_family: ['self', 'family'],
  unmarried_married: ['unmarried', 'married'],
  standard_mfs_living_apart: ['standard', 'mfs_living_apart'],
} as const;
export type VariantSetName = keyof typeof VARIANT_SETS;

/** A statutory calendar day: `monthDay` 'MM-DD' in the tax year (`yearOffset` 0) or the following year (1). */
export interface StatutoryDate {
  monthDay: string;
  yearOffset: 0 | 1;
}

/**
 * How a `rollsWithYear` key is DERIVED for a target tax year (R6-01). The seeds store the
 * observed dates (e.g. 2025-06-16 because June 15, 2025 was a Sunday), so a year roll must
 * never start from the stored date: it starts from the statute and lands on the next
 * business day under IRC §7503 using the target year's legal-holiday calendar.
 *  - `statutory`: the fixed statutory days (IRC §6654(c)/(h)/(i), §6072(a)) in registry order.
 *  - `legal_holidays`: the federal + DC legal-holiday calendar for the tax year and the
 *    following year, computed from 5 U.S.C. 6103 / D.C. Code §1-612.02 (shared dates.ts).
 */
export type DateRollRule =
  | { kind: 'statutory'; dates: ReadonlyArray<StatutoryDate> }
  | { kind: 'legal_holidays' };

export interface ParameterDef {
  /** Base key. A variant key is `${key}.${variant}`. */
  key: string;
  type: ParameterValueType;
  unit: ParameterUnit;
  group: ParameterGroup;
  label: string;
  /** Expands into one concrete key per member of the named set. */
  variants?: VariantSetName;
  /** Present on keys whose value is a calendar date or date list: derived for the target year by "create year from prior year" and the missing-year fallback. */
  rollsWithYear?: boolean;
  /** Required when `rollsWithYear` is set: how the target year's value is derived (never from the stored observed date). */
  roll?: DateRollRule;
}

const D = (
  key: string, type: ParameterValueType, unit: ParameterUnit, group: ParameterGroup, label: string,
  extra: Partial<Pick<ParameterDef, 'variants' | 'rollsWithYear' | 'roll'>> = {},
): ParameterDef => ({ key, type, unit, group, label, ...extra });

const SD = (monthDay: string, yearOffset: 0 | 1 = 0): StatutoryDate => ({ monthDay, yearOffset });
const statutory = (...dates: StatutoryDate[]): DateRollRule => ({ kind: 'statutory', dates });

export const PARAMETER_REGISTRY: readonly ParameterDef[] = [
  // ── Self-employment ────────────────────────────────────────────────────
  D('se.nese_factor', 'rate', 'rate', 'Self-employment', 'Net earnings from SE factor'),
  D('se.min_nese', 'money', 'usd', 'Self-employment', 'Minimum net SE earnings subject to SE tax'),
  D('se.ss_rate', 'rate', 'rate', 'Self-employment', 'Social Security rate (SE)'),
  D('se.medicare_rate', 'rate', 'rate', 'Self-employment', 'Medicare rate (SE)'),
  D('se.ss_wage_base', 'money', 'usd', 'Self-employment', 'Social Security wage base'),
  D('se.deduction_factor', 'rate', 'rate', 'Self-employment', 'Deductible share of SE tax'),
  // ── Brackets and capital gains ─────────────────────────────────────────
  D('brackets', 'bracket_table', 'table', 'Brackets and capital gains', 'Ordinary income brackets', { variants: 'fs' }),
  D('ltcg.breakpoints', 'money_list', 'usd', 'Brackets and capital gains', 'LTCG 0% / 15% upper breakpoints', { variants: 'fs' }),
  D('ltcg.rates', 'rate_list', 'rate', 'Brackets and capital gains', 'LTCG rates (0 / 15 / 20)'),
  D('collectibles_rate', 'rate', 'rate', 'Brackets and capital gains', 'Collectibles gain maximum rate'),
  D('unrecaptured_1250_rate', 'rate', 'rate', 'Brackets and capital gains', 'Unrecaptured §1250 gain maximum rate'),
  D('capital_loss.limit', 'money', 'usd', 'Brackets and capital gains', 'Net capital loss deductible against ordinary income (§1211(b))', { variants: 'standard_mfs' }),
  // ── Medicare and NIIT ──────────────────────────────────────────────────
  D('addl_medicare.rate', 'rate', 'rate', 'Medicare and NIIT', 'Additional Medicare tax rate'),
  D('addl_medicare.threshold', 'money', 'usd', 'Medicare and NIIT', 'Additional Medicare threshold', { variants: 'fs' }),
  D('niit.rate', 'rate', 'rate', 'Medicare and NIIT', 'Net investment income tax rate'),
  D('niit.threshold', 'money', 'usd', 'Medicare and NIIT', 'NIIT MAGI threshold', { variants: 'fs' }),
  // ── Deductions ─────────────────────────────────────────────────────────
  D('std_deduction', 'money', 'usd', 'Deductions', 'Standard deduction', { variants: 'fs' }),
  D('std_deduction.additional_65_blind', 'money', 'usd', 'Deductions', 'Additional standard deduction (65 / blind), per person', { variants: 'unmarried_married' }),
  D('std_deduction.additional_age', 'int', 'count', 'Deductions', 'Age at year end for the additional standard deduction (§63(f))'),
  D('salt.cap', 'money', 'usd', 'Deductions', 'SALT deduction cap', { variants: 'standard_mfs' }),
  D('salt.phase_down.threshold', 'money', 'usd', 'Deductions', 'SALT cap phase-down MAGI threshold', { variants: 'standard_mfs' }),
  D('salt.phase_down.rate', 'rate', 'rate', 'Deductions', 'SALT cap phase-down rate'),
  D('salt.floor', 'money', 'usd', 'Deductions', 'SALT cap floor after phase-down', { variants: 'standard_mfs' }),
  D('charity.agi_floor_pct', 'rate', 'rate', 'Deductions', 'Charitable itemized floor (% of AGI)'),
  D('charity.nonitemizer', 'money', 'usd', 'Deductions', 'Charitable deduction for non-itemizers (max cash)', { variants: 'fs' }),
  D('itemized.benefit_cap_rate', 'rate', 'rate', 'Deductions', 'Itemized deduction tax-benefit cap rate'),
  // ── Schedule 1-A ───────────────────────────────────────────────────────
  D('sch1a.senior.amount', 'money', 'usd', 'Schedule 1-A', 'Senior deduction (per eligible person)'),
  D('sch1a.senior.age', 'int', 'count', 'Schedule 1-A', 'Age at year end for the senior deduction'),
  D('sch1a.senior.phaseout_threshold', 'money', 'usd', 'Schedule 1-A', 'Senior deduction MAGI phase-out start', { variants: 'fs' }),
  D('sch1a.senior.phaseout_rate', 'rate', 'rate', 'Schedule 1-A', 'Senior deduction phase-out rate'),
  D('sch1a.tips.max', 'money', 'usd', 'Schedule 1-A', 'Qualified tips deduction maximum'),
  D('sch1a.tips.phaseout_threshold', 'money', 'usd', 'Schedule 1-A', 'Tips deduction MAGI phase-out start', { variants: 'fs' }),
  D('sch1a.tips.phaseout_rate', 'rate', 'rate', 'Schedule 1-A', 'Tips deduction phase-out rate'),
  D('sch1a.overtime.max', 'money', 'usd', 'Schedule 1-A', 'Qualified overtime deduction maximum', { variants: 'standard_mfj' }),
  D('sch1a.overtime.phaseout_threshold', 'money', 'usd', 'Schedule 1-A', 'Overtime deduction MAGI phase-out start', { variants: 'fs' }),
  D('sch1a.overtime.phaseout_rate', 'rate', 'rate', 'Schedule 1-A', 'Overtime deduction phase-out rate'),
  D('sch1a.car_interest.max', 'money', 'usd', 'Schedule 1-A', 'Car-loan interest deduction maximum'),
  D('sch1a.car_interest.phaseout_threshold', 'money', 'usd', 'Schedule 1-A', 'Car-loan interest MAGI phase-out start', { variants: 'fs' }),
  D('sch1a.car_interest.phaseout_rate', 'rate', 'rate', 'Schedule 1-A', 'Car-loan interest phase-out rate'),
  D('sch1a.phaseout_step', 'money', 'usd', 'Schedule 1-A', 'MAGI step for the tips / overtime / car-loan phase-outs (reduction = rate × step per step or fraction thereof)'),
  D('sch1a.first_year', 'int', 'year', 'Schedule 1-A', 'First tax year Schedule 1-A applies'),
  D('sch1a.last_year', 'int', 'year', 'Schedule 1-A', 'Last tax year Schedule 1-A applies'),
  // ── QBI ────────────────────────────────────────────────────────────────
  D('qbi.rate', 'rate', 'rate', 'QBI (§199A)', 'QBI deduction rate'),
  D('qbi.threshold', 'money', 'usd', 'QBI (§199A)', 'QBI taxable-income threshold', { variants: 'fs' }),
  D('qbi.phase_in_range', 'money', 'usd', 'QBI (§199A)', 'QBI phase-in range above the threshold', { variants: 'fs' }),
  D('qbi.w2_wage_pct', 'rate', 'rate', 'QBI (§199A)', 'W-2 wage limit (% of W-2 wages)'),
  D('qbi.alt_w2_wage_pct', 'rate', 'rate', 'QBI (§199A)', 'Alternative W-2 wage limit (% of W-2 wages)'),
  D('qbi.ubia_pct', 'rate', 'rate', 'QBI (§199A)', 'UBIA limit (% of qualified property)'),
  D('qbi.taxable_income_limit_pct', 'rate', 'rate', 'QBI (§199A)', 'Overall limit (% of taxable income less net capital gain)'),
  D('qbi.min_deduction_amount', 'money', 'usd', 'QBI (§199A)', 'Minimum QBI deduction'),
  D('qbi.min_deduction_active_qbi_threshold', 'money', 'usd', 'QBI (§199A)', 'Active QBI needed for the minimum deduction'),
  // ── Loss limits ────────────────────────────────────────────────────────
  D('ebl.threshold', 'money', 'usd', 'Loss limits', 'Excess business loss threshold', { variants: 'standard_mfj' }),
  D('passive.rental_allowance', 'money', 'usd', 'Loss limits', '§469(i) rental loss allowance', { variants: 'standard_mfs_living_apart' }),
  D('passive.rental_allowance_phaseout_start', 'money', 'usd', 'Loss limits', '§469(i) allowance phase-out start (MAGI)', { variants: 'standard_mfs_living_apart' }),
  D('passive.rental_allowance_phaseout_end', 'money', 'usd', 'Loss limits', '§469(i) allowance phase-out end (MAGI)', { variants: 'standard_mfs_living_apart' }),
  // ── Retirement and HSA ─────────────────────────────────────────────────
  D('retirement.sep.pct_of_comp', 'rate', 'rate', 'Retirement and HSA', 'SEP contribution limit (% of compensation)'),
  D('retirement.sep.dollar_limit', 'money', 'usd', 'Retirement and HSA', 'SEP / defined-contribution annual additions limit'),
  D('retirement.comp_limit', 'money', 'usd', 'Retirement and HSA', 'Compensation limit for plan contributions'),
  D('retirement.401k.deferral', 'money', 'usd', 'Retirement and HSA', '401(k) elective deferral limit'),
  D('retirement.401k.catch_up_50', 'money', 'usd', 'Retirement and HSA', '401(k) catch-up (age 50+)'),
  D('retirement.401k.catch_up_60_63', 'money', 'usd', 'Retirement and HSA', '401(k) catch-up (ages 60–63)'),
  D('retirement.catch_up_age', 'int', 'count', 'Retirement and HSA', 'Age at year end for the 401(k) / SIMPLE catch-up (§414(v))'),
  D('retirement.401k.catch_up_60_63_ages', 'int_list', 'count', 'Retirement and HSA', 'Age range [first, last] at year end for the higher 401(k) catch-up (§414(v)(2)(E))'),
  D('retirement.simple.deferral', 'money', 'usd', 'Retirement and HSA', 'SIMPLE IRA deferral limit'),
  D('retirement.simple.catch_up', 'money', 'usd', 'Retirement and HSA', 'SIMPLE IRA catch-up (age 50+)'),
  D('retirement.simple.match_pct', 'rate', 'rate', 'Retirement and HSA', 'SIMPLE IRA employer matching contribution (% of net SE earnings)'),
  D('hsa.limit', 'money', 'usd', 'Retirement and HSA', 'HSA contribution limit', { variants: 'self_family' }),
  D('hsa.catch_up_55', 'money', 'usd', 'Retirement and HSA', 'HSA catch-up (age 55+)'),
  D('hsa.catch_up_age', 'int', 'count', 'Retirement and HSA', 'Age at year end for the HSA catch-up (§223(b)(3))'),
  // ── C corporation ──────────────────────────────────────────────────────
  D('ccorp.rate', 'rate', 'rate', 'C corporation', 'C corporation tax rate'),
  D('ccorp.large_corp_threshold', 'money', 'usd', 'C corporation', 'Large corporation taxable-income threshold'),
  D('ccorp.installment_months', 'int_list', 'months', 'C corporation', 'Installment due months (of the tax year)'),
  D('ccorp.installment_pcts', 'rate_list', 'rate', 'C corporation', 'Installment percentages'),
  D('ccorp.safe_harbor_current_pct', 'rate', 'rate', 'C corporation', 'Safe harbor: % of current-year tax'),
  D('ccorp.safe_harbor_prior_pct', 'rate', 'rate', 'C corporation', 'Safe harbor: % of prior-year tax'),
  D('ccorp.sch_ai.period_ends', 'month_day_list', 'month_day', 'C corporation', 'Annualization period ends (C corporation)'),
  D('ccorp.sch_ai.annualization_factors', 'number_list', 'factor', 'C corporation', 'Annualization factors (C corporation)'),
  D('ccorp.sch_ai.applicable_pcts', 'rate_list', 'rate', 'C corporation', 'Applicable percentages (C corporation)'),
  D('ccorp.installment_day', 'int', 'count', 'C corporation', 'Installment due day of the month (15th day of the 4th/6th/9th/12th month)'),
  D('ccorp.large_corp_lookback_years', 'int', 'count', 'C corporation', 'Large corporation test: number of preceding tax years examined'),
  D('ccorp.min_tax_for_estimates', 'money', 'usd', 'C corporation', 'No estimated-tax requirement (no §6655 addition) when the tax is less than this'),
  // ── Individual safe harbor ─────────────────────────────────────────────
  D('safe_harbor.current_pct', 'rate', 'rate', 'Individual safe harbor', 'Safe harbor: % of current-year tax'),
  D('safe_harbor.prior_pct', 'rate', 'rate', 'Individual safe harbor', 'Safe harbor: % of prior-year tax'),
  D('safe_harbor.prior_pct_high_agi', 'rate', 'rate', 'Individual safe harbor', 'Safe harbor: % of prior-year tax (high AGI)'),
  D('safe_harbor.high_agi_threshold', 'money', 'usd', 'Individual safe harbor', 'High-AGI threshold (prior-year AGI)', { variants: 'standard_mfs' }),
  D('safe_harbor.min_balance_due', 'money', 'usd', 'Individual safe harbor', 'No penalty if balance due is below'),
  // ── Installments ───────────────────────────────────────────────────────
  // IRC §6654(c)(2): April 15, June 15, September 15 and January 15 of the following year.
  D('installments.due_dates', 'date_list', 'date', 'Installments', 'Individual estimated-tax due dates', { rollsWithYear: true, roll: statutory(SD('04-15'), SD('06-15'), SD('09-15'), SD('01-15', 1)) }),
  D('installments.pcts', 'rate_list', 'rate', 'Installments', 'Individual installment percentages'),
  // IRC §6654(h): January 31 of the following year.
  D('installments.q4_file_and_pay_date', 'date', 'date', 'Installments', 'File and pay by this date to avoid a Q4 penalty', { rollsWithYear: true, roll: statutory(SD('01-31', 1)) }),
  // IRC §6072(a): the 15th day of April following the calendar year.
  D('return_due_date', 'date', 'date', 'Installments', 'Return due date (penalty accrual end)', { rollsWithYear: true, roll: statutory(SD('04-15', 1)) }),
  // ── Schedule AI ────────────────────────────────────────────────────────
  D('sch_ai.period_ends', 'month_day_list', 'month_day', 'Schedule AI', 'Annualization period ends'),
  D('sch_ai.annualization_factors', 'number_list', 'factor', 'Schedule AI', 'Annualization factors'),
  D('sch_ai.applicable_pcts', 'rate_list', 'rate', 'Schedule AI', 'Applicable percentages'),
  D('sch_ai.period_months', 'int_list', 'months', 'Schedule AI', 'Months in each annualization period'),
  // ── Farmers and fishermen ──────────────────────────────────────────────
  D('farmer.gross_income_ratio', 'rate', 'rate', 'Farmers and fishermen', 'Gross income from farming/fishing test (fraction)'),
  D('farmer.safe_harbor_current_pct', 'rate', 'rate', 'Farmers and fishermen', 'Safe harbor: % of current-year tax'),
  D('farmer.safe_harbor_prior_pct', 'rate', 'rate', 'Farmers and fishermen', 'Safe harbor: % of prior-year tax'),
  // IRC §6654(i)(1)(B): January 15 of the following year; §6654(i)(1)(D)(i): March 1 of the following year.
  D('farmer.single_due_date', 'date', 'date', 'Farmers and fishermen', 'Single installment due date', { rollsWithYear: true, roll: statutory(SD('01-15', 1)) }),
  D('farmer.file_by_date', 'date', 'date', 'Farmers and fishermen', 'File and pay by this date for no penalty', { rollsWithYear: true, roll: statutory(SD('03-01', 1)) }),
  // ── Penalty ────────────────────────────────────────────────────────────
  D('penalty.underpayment_rate', 'rate_period_list', 'table', 'Penalty', 'Underpayment rate by quarter'),
  // ── Calendar ───────────────────────────────────────────────────────────
  D('holidays', 'date_list', 'date', 'Calendar', 'Federal / DC legal holidays (date roll-forward)', { rollsWithYear: true, roll: { kind: 'legal_holidays' } }),
];

export interface ExpandedParameterKey {
  /** Concrete key stored in tax_parameters.key, e.g. `brackets.mfj`. */
  key: string;
  def: ParameterDef;
  variant: string | null;
}

/** Every concrete key a complete tax year must contain. */
export function expandParameterKeys(): ExpandedParameterKey[] {
  const out: ExpandedParameterKey[] = [];
  for (const def of PARAMETER_REGISTRY) {
    if (!def.variants) { out.push({ key: def.key, def, variant: null }); continue; }
    for (const v of VARIANT_SETS[def.variants]) out.push({ key: `${def.key}.${v}`, def, variant: v });
  }
  return out;
}

const BY_CONCRETE_KEY: ReadonlyMap<string, ExpandedParameterKey> = new Map(
  expandParameterKeys().map((e) => [e.key, e]),
);

export function getParameterDef(concreteKey: string): ExpandedParameterKey | undefined {
  return BY_CONCRETE_KEY.get(concreteKey);
}

export function isParameterKey(concreteKey: string): boolean {
  return BY_CONCRETE_KEY.has(concreteKey);
}

export function filingStatusKey(base: string, fs: FilingStatus): string {
  return `${base}.${fs}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY = /^\d{2}-\d{2}$/;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Returns an error message, or null when `value` is a valid value for `type`. */
export function validateParameterValue(type: ParameterValueType, value: unknown): string | null {
  const list = (pred: (x: unknown) => boolean, what: string) =>
    Array.isArray(value) && value.length > 0 && value.every(pred) ? null : `expected a non-empty list of ${what}`;
  switch (type) {
    case 'money': return isNum(value) && value >= 0 ? null : 'expected a non-negative number';
    case 'rate': return isNum(value) && value >= 0 ? null : 'expected a non-negative number';
    case 'int': return Number.isInteger(value) ? null : 'expected an integer';
    case 'date': return typeof value === 'string' && ISO_DATE.test(value) ? null : 'expected YYYY-MM-DD';
    case 'month_day': return typeof value === 'string' && MONTH_DAY.test(value) ? null : 'expected MM-DD';
    case 'money_list': return list((x) => isNum(x) && x >= 0, 'non-negative numbers');
    case 'rate_list': return list((x) => isNum(x) && x >= 0, 'non-negative numbers');
    case 'number_list': return list(isNum, 'numbers');
    case 'int_list': return list((x) => Number.isInteger(x), 'integers');
    case 'date_list': return list((x) => typeof x === 'string' && ISO_DATE.test(x), 'YYYY-MM-DD dates');
    case 'month_day_list': return list((x) => typeof x === 'string' && MONTH_DAY.test(x), 'MM-DD values');
    case 'bracket_table': {
      if (!Array.isArray(value) || value.length === 0) return 'expected a non-empty bracket table';
      let prev = -1;
      for (let i = 0; i < value.length; i++) {
        const row = value[i];
        if (!Array.isArray(row) || row.length !== 2 || !isNum(row[1]) || row[1] < 0) return `row ${i}: expected [upper|null, rate]`;
        const upper = row[0];
        const last = i === value.length - 1;
        if (last) { if (upper !== null) return 'last bracket must have a null upper bound'; }
        else { if (!isNum(upper) || upper <= prev) return `row ${i}: upper bounds must increase`; prev = upper; }
      }
      return null;
    }
    case 'rate_period_list':
      return list((x) => {
        const r = x as { from?: unknown; to?: unknown; rate?: unknown };
        return !!r && typeof r.from === 'string' && ISO_DATE.test(r.from) && typeof r.to === 'string' && ISO_DATE.test(r.to) && isNum(r.rate) && r.rate >= 0;
      }, '{ from, to, rate } periods');
    default: return 'unknown parameter type';
  }
}

export interface ParameterSeedRow {
  key: string;
  value: unknown;
  /** Primary-source citation (Rev. Proc. / IRC section / notice). Required. */
  citation: string;
  status: 'verified' | 'unverified' | 'provisional';
}
