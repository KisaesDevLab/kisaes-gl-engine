// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q46 prior-year trend projection of the ORDINARY character (MODULE.md "Projection"). PURE.
//
//   prior_year_scaled: ordinary = YTD + PY remaining × clamp(CY recurring YTD ÷ PY same months, MIN, MAX)
//   prior_year_dollar: ordinary = YTD + PY remaining
//
// "Same months" = January..the current year's through month of the prior year; "remaining" = the
// prior year's months after it through December; both recurring (non-recurring excluded). A
// guardrail failure falls back to the run rate with TE_PY_TREND_FALLBACK (details.reason); a capped
// factor emits TE_PY_TREND_CAPPED. The thresholds are projection policy (projection-method.ts).

import {
  PY_TREND_FACTOR_MAX, PY_TREND_FACTOR_MIN, PY_TREND_MIN_SAME_MONTHS_SHARE, PY_TREND_REQUIRED_ACTIVE_MONTHS,
  type PriorYearMonthlyFigures, type PriorYearTrendMethod, type ProjectionMethod, type PyTrendFallbackReason,
} from '../projection-method.js';
import { ZERO, dAbs, dAdd, dCmp, dDiv, dIsPos, dMul, dSum, dec, type Dec } from '../decimal.js';
import type { EnginePriorYearTrend } from './types.js';

/** Split one company's prior-year monthly figures at the current year's through month (1–12). */
export function priorYearTrendFor(
  method: PriorYearTrendMethod, figures: PriorYearMonthlyFigures | null, throughMonth: number,
  unavailableReason: PyTrendFallbackReason | null = null,
): EnginePriorYearTrend {
  if (!figures || unavailableReason) return { method, priorYear: null, unavailableReason: unavailableReason ?? 'py_unreadable' };
  const t = Math.max(0, Math.min(PY_TREND_REQUIRED_ACTIVE_MONTHS, throughMonth));
  const rec = figures.recurringOrdinary;
  return {
    method,
    priorYear: {
      taxYear: figures.taxYear,
      throughMonth: t,
      sameMonthsOrdinary: dSum(rec.slice(0, t).map((v) => dec(v))),
      remainingOrdinary: dSum(rec.slice(t).map((v) => dec(v))),
      monthsWithActivity: figures.active.filter(Boolean).length,
    },
    unavailableReason: null,
  };
}

export interface PriorYearTrendOutcome {
  method: ProjectionMethod;
  applied: ProjectionMethod;
  fallbackReason: PyTrendFallbackReason | null;
  factor: Dec | null;
  rawFactor: Dec | null;
  capped: 'min' | 'max' | null;
  runRateOrdinary: Dec;
  projectedOrdinary: Dec;
}

export interface TrendEntityFigures {
  ytdOrdinary: Dec;
  recurringOrdinary: Dec;
  monthsElapsed: number;
  monthsRemaining: number;
}

/** Run-rate ordinary (income.ts projectAmount, repeated here to keep this module free of a cycle). */
function runRate(e: TrendEntityFigures): Dec {
  if (e.monthsElapsed <= 0 || e.monthsRemaining <= 0) return dec(e.ytdOrdinary);
  return dAdd(e.ytdOrdinary, dMul(dDiv(e.recurringOrdinary, String(e.monthsElapsed)), String(e.monthsRemaining)));
}

/** Apply the guardrails and the selected method; the run rate on any fallback. */
export function evaluatePriorYearTrend(e: TrendEntityFigures, t: EnginePriorYearTrend): PriorYearTrendOutcome {
  const rr = runRate(e);
  const fallback = (reason: PyTrendFallbackReason): PriorYearTrendOutcome => ({
    method: t.method, applied: 'run_rate', fallbackReason: reason, factor: null, rawFactor: null, capped: null, runRateOrdinary: rr, projectedOrdinary: rr,
  });
  // A closed year has nothing to project: YTD under every method, no warning.
  if (e.monthsRemaining <= 0) {
    return { method: t.method, applied: t.method, fallbackReason: null, factor: null, rawFactor: null, capped: null, runRateOrdinary: rr, projectedOrdinary: dec(e.ytdOrdinary) };
  }
  if (t.unavailableReason) return fallback(t.unavailableReason);
  const py = t.priorYear;
  if (!py) return fallback('py_unreadable');
  if (py.monthsWithActivity <= 0) return fallback('py_books_missing');
  if (py.monthsWithActivity < PY_TREND_REQUIRED_ACTIVE_MONTHS) return fallback('py_books_incomplete');
  if (t.method === 'prior_year_dollar') {
    return { method: t.method, applied: t.method, fallbackReason: null, factor: null, rawFactor: null, capped: null, runRateOrdinary: rr, projectedOrdinary: dAdd(e.ytdOrdinary, py.remainingOrdinary) };
  }
  const same = dec(py.sameMonthsOrdinary);
  const full = dAdd(same, py.remainingOrdinary);
  if (!dIsPos(same)) return fallback('py_same_months_not_positive');
  if (dCmp(dAbs(same), dMul(PY_TREND_MIN_SAME_MONTHS_SHARE, dAbs(full))) < 0) return fallback('py_same_months_small');
  if (!dIsPos(e.recurringOrdinary)) return fallback('cy_recurring_not_positive');
  const raw = dDiv(e.recurringOrdinary, same);
  let factor = raw;
  let capped: 'min' | 'max' | null = null;
  if (dCmp(raw, PY_TREND_FACTOR_MIN) < 0) { factor = PY_TREND_FACTOR_MIN; capped = 'min'; }
  else if (dCmp(raw, PY_TREND_FACTOR_MAX) > 0) { factor = PY_TREND_FACTOR_MAX; capped = 'max'; }
  return {
    method: t.method, applied: t.method, fallbackReason: null, factor: dec(factor), rawFactor: raw, capped, runRateOrdinary: rr,
    projectedOrdinary: dAdd(e.ytdOrdinary, dMul(py.remainingOrdinary, factor)),
  };
}

/** PY full year = same months + remaining (recurring ordinary). */
export function priorYearFullOrdinary(t: EnginePriorYearTrend): Dec {
  return t.priorYear ? dAdd(t.priorYear.sameMonthsOrdinary, t.priorYear.remainingOrdinary) : ZERO;
}
