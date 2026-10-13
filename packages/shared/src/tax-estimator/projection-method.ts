// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator — projection method per linked business per tax year (OPEN-QUESTIONS Q46, Kurt
// 2026-10-13: "Add an option to utilize the ordinary net income monthly trends from the prior year
// to project the annual amount for the current year"). The system default stays the run rate;
// the prior-year trend methods are an option per entity year (tax_est_entity_year_inputs.projection_method).
//
//   run_rate           ordinary = YTD + recurring YTD ÷ months elapsed × months remaining (MODULE.md "Projection")
//   prior_year_scaled  ordinary = YTD + PY remaining × (CY recurring YTD ÷ PY recurring same months), factor capped
//   prior_year_dollar  ordinary = YTD + PY remaining (the prior year's remaining months as-is)
//
// ORDINARY character only; every other character, owner item, guaranteed payment and officer wage
// keeps the run rate. Prior-year figures are the same company's books read through the SAME P&L
// provider (treatment map, tax method, non-recurring flags) for the prior calendar year, recurring
// portion only. The guardrail thresholds below are projection policy, NOT tax parameters: they
// live here (outside engine/, which may hold no literals) and are documented in MODULE.md.

export const PROJECTION_METHODS = ['run_rate', 'prior_year_scaled', 'prior_year_dollar'] as const;
export type ProjectionMethod = typeof PROJECTION_METHODS[number];
export type PriorYearTrendMethod = Exclude<ProjectionMethod, 'run_rate'>;
export const DEFAULT_PROJECTION_METHOD: ProjectionMethod = 'run_rate';

/** Lower bound of the prior-year scale factor (CY recurring YTD ÷ PY same months); a smaller ratio is capped here. */
export const PY_TREND_FACTOR_MIN = '0.25';
/** Upper bound of the prior-year scale factor; a larger ratio is capped here. */
export const PY_TREND_FACTOR_MAX = '4';
/** Scaled method: the PY same months must hold at least this share of the PY full year (|same| ≥ share × |full|). */
export const PY_TREND_MIN_SAME_MONTHS_SHARE = '0.1';
/** Decimal places of the reported scale factor (EntityResult.projection.factor / rawFactor; display only, the exact factor is applied). */
export const PY_TREND_FACTOR_PLACES = 4;
/** Prior-year books are "complete" when every one of the 12 PY months has P&L activity. */
export const PY_TREND_REQUIRED_ACTIVE_MONTHS = 12;

/** Why a selected prior-year method fell back to the run rate (warning TE_PY_TREND_FALLBACK, details.reason). */
export const PY_TREND_FALLBACK_REASONS = [
  'not_supported_entity',
  'py_unreadable',
  'py_books_missing',
  'py_books_incomplete',
  'py_same_months_not_positive',
  'py_same_months_small',
  'cy_recurring_not_positive',
] as const;
export type PyTrendFallbackReason = typeof PY_TREND_FALLBACK_REASONS[number];

export const PROJECTION_METHOD_LABELS: Record<ProjectionMethod, string> = {
  run_rate: 'Run rate (default)',
  prior_year_scaled: 'Prior-year seasonal (scaled)',
  prior_year_dollar: 'Prior-year seasonal (dollar)',
};

export const PY_TREND_FALLBACK_LABELS: Record<PyTrendFallbackReason, string> = {
  not_supported_entity: 'prior-year trends apply to individual-path businesses only (not C corporations)',
  py_unreadable: 'the prior-year books could not be read',
  py_books_missing: 'the prior year has no activity in the books',
  py_books_incomplete: 'the prior-year books are incomplete (not every month has activity)',
  py_same_months_not_positive: 'the prior year\'s same months have no positive ordinary income',
  py_same_months_small: 'the prior year\'s same months are too small a share of the prior full year',
  cy_recurring_not_positive: 'this year\'s recurring ordinary income to date is not positive',
};

/**
 * The prior calendar year of one company, month by month (index 0 = January), as the P&L provider
 * read it: recurring ordinary income (non-recurring items excluded) and whether the month had any
 * P&L activity at all.
 */
export interface PriorYearMonthlyFigures {
  taxYear: number;
  recurringOrdinary: string[];
  active: boolean[];
}
