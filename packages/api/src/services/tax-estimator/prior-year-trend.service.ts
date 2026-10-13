// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q46 prior-year trend inputs (OPEN-QUESTIONS.md Q46). Reads one company's PRIOR calendar year
// month by month through the SAME P&L provider the current year uses (getTaxBasisPl: tax method,
// TB character + estimator treatment map, account and transaction non-recurring flags, Redis
// cache keyed by the GL stamp), so there is no second ledger query or treatment logic here.
// Only the recurring ORDINARY character and a per-month activity flag are kept; the split at the
// current year's through month and every guardrail are the pure engine's (engine/py-trend.ts).
import {
  DEFAULT_PROJECTION_METHOD, INCOME_CHARACTERS, PROJECTION_METHOD_LABELS, PY_TREND_FALLBACK_LABELS,
  evaluatePriorYearTrend, priorYearTrendFor,
  type PriorYearMonthlyFigures, type ProjectionMethod, type PyTrendFallbackReason, type TaxBasisMonth, type TaxEstimatorWarning,
} from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';
import { getTaxBasisPl, type TaxBasisPlOptions } from './pl-provider.service.js';
import { getYearInputs } from './entity-settings.service.js';
import { monthsBetween } from './periods.js';

/** What the estimate needs per company: the PY monthly figures, or why there are none. */
export interface PriorYearTrendInputs {
  figures: PriorYearMonthlyFigures | null;
  reason: PyTrendFallbackReason | null;
}

const nz = (v: string | null | undefined) => v != null && Number(v) !== 0;

/** A month "has activity" when any P&L figure the provider produced for it is non-zero. */
export function monthHasActivity(m: TaxBasisMonth): boolean {
  return nz(m.bookNetIncome) || INCOME_CHARACTERS.some((c) => nz(m.byCharacter[c]))
    || nz(m.ownerSehi) || nz(m.ownerRetirement) || nz(m.sehiAsW2Wages) || nz(m.guaranteedPayments) || nz(m.w2Wages);
}

/**
 * The prior calendar year (taxYear − 1, Jan..Dec) of one company, through the P&L provider. The
 * caller has already checked the company is in scope (the provider re-checks: D1 guard first).
 * A C corporation (entity-level path, own fiscal year) is not supported; an unreadable year
 * (provider error) is a fallback reason, never an estimate failure.
 */
export async function loadPriorYearTrendInputs(
  scope: FirmScope, tenantId: string, companyId: string, taxYear: number, entityType: string | null, opts: TaxBasisPlOptions = {},
): Promise<PriorYearTrendInputs> {
  if (entityType === 'c_corp') return { figures: null, reason: 'not_supported_entity' };
  const py = taxYear - 1;
  try {
    const pl = await getTaxBasisPl(scope, { tenantId, companyId, taxYear: py, throughMonth: `${py}-12` }, opts);
    if (pl.entityType === 'c_corp') return { figures: null, reason: 'not_supported_entity' };
    const byMonth = new Map(pl.months.map((m) => [m.month, m]));
    const months = monthsBetween(`${py}-01`, `${py}-12`);
    return {
      figures: {
        taxYear: py,
        recurringOrdinary: months.map((m) => byMonth.get(m)?.recurring.ordinary ?? '0.0000'),
        active: months.map((m) => { const x = byMonth.get(m); return x ? monthHasActivity(x) : false; }),
      },
      reason: null,
    };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return { figures: null, reason: 'py_unreadable' };
  }
}

/**
 * Readiness line (Q46): when the entity year selected a prior-year method and the estimate would
 * fall back to the run rate, the same TE_PY_TREND_FALLBACK warning the estimate carries. Null when
 * the run rate is selected or the trend applies.
 */
export async function priorYearTrendReadinessWarning(
  scope: FirmScope, c: { tenantId: string; companyId: string; companyName: string | null; entityType: string | null },
  taxYear: number, throughMonth: string | undefined, opts: TaxBasisPlOptions = {},
): Promise<TaxEstimatorWarning | null> {
  const year = await getYearInputs(scope, c.tenantId, c.companyId, taxYear);
  const method: ProjectionMethod = year.projectionMethod ?? DEFAULT_PROJECTION_METHOD;
  if (method === 'run_rate') return null;
  const name = c.companyName ?? 'A linked company';
  const warn = (reason: PyTrendFallbackReason): TaxEstimatorWarning => ({
    code: 'TE_PY_TREND_FALLBACK', severity: 'warning',
    message: `${name}: ${PROJECTION_METHOD_LABELS[method]} could not be used (${PY_TREND_FALLBACK_LABELS[reason]}); the run rate will be used for ordinary income.`,
    details: { companyId: c.companyId, method, reason },
  });
  const inputs = await loadPriorYearTrendInputs(scope, c.tenantId, c.companyId, taxYear, c.entityType, opts);
  if (inputs.reason) return warn(inputs.reason);
  let pl;
  try {
    pl = await getTaxBasisPl(scope, { tenantId: c.tenantId, companyId: c.companyId, taxYear, throughMonth }, opts);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return null; // the books readiness already reports why the current year cannot be read
  }
  const outcome = evaluatePriorYearTrend(
    { ytdOrdinary: pl.byCharacter.ordinary, recurringOrdinary: pl.recurring.ordinary, monthsElapsed: pl.monthsElapsed, monthsRemaining: pl.monthsRemaining },
    priorYearTrendFor(method, inputs.figures, pl.monthsElapsed),
  );
  return outcome.fallbackReason ? warn(outcome.fallbackReason) : null;
}
