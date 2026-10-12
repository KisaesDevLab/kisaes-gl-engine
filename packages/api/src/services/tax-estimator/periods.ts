// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pure month / tax-year-window helpers shared by the P&L provider, the
// closed-month rule and readiness (TB10: month-granular, UTC). No I/O.

import type { EntityTaxType } from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';

export interface TaxYearWindow { start: string; end: string; startMonth: string; endMonth: string }

const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const monthEnd = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${pad2(lastDayOf(y, m))}`;
};

export function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

/** The (possibly partial) month containing `today`, UTC. */
export const currentMonth = (today = new Date()) => `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}`;

/** The last COMPLETE calendar month before `today` (never the current partial month). */
export const lastCompleteMonth = (today = new Date()) => prevMonth(currentMonth(today));

/**
 * Individuals and pass-throughs use the calendar year; C corps use the entity
 * fiscal year whose LABEL is `taxYear` (TB10: the FY containing its end date).
 */
export function taxYearWindow(taxYear: number, entityType: EntityTaxType | null, fiscalYearStartMonth: number): TaxYearWindow {
  if (entityType !== 'c_corp' || fiscalYearStartMonth <= 1) {
    return { start: `${taxYear}-01-01`, end: `${taxYear}-12-31`, startMonth: `${taxYear}-01`, endMonth: `${taxYear}-12` };
  }
  const startMonth = `${taxYear - 1}-${pad2(fiscalYearStartMonth)}`;
  const endMonth = `${taxYear}-${pad2(fiscalYearStartMonth - 1)}`;
  return { start: `${startMonth}-01`, end: monthEnd(endMonth), startMonth, endMonth };
}

export function monthsBetween(startMonth: string, endMonth: string): string[] {
  const out: string[] = [];
  let [y, m] = startMonth.split('-').map(Number) as [number, number];
  const [ey, em] = endMonth.split('-').map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad2(m)}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * A requested range end is validated against the window. Without one, the
 * fallback is the last COMPLETE calendar month capped to the window (the
 * provider first tries the last closed month — closed-month.service). The
 * current partial month is never a default; a window with no complete month
 * yet is a 422 (pass `through` explicitly).
 */
export function resolveThroughMonth(window: TaxYearWindow, requested: string | undefined, today = new Date()): string {
  if (requested) {
    if (requested < window.startMonth || requested > window.endMonth) {
      throw AppError.badRequest(`through must be between ${window.startMonth} and ${window.endMonth}`, 'TE_THROUGH_OUT_OF_RANGE');
    }
    return requested;
  }
  const last = lastCompleteMonth(today);
  if (last < window.startMonth) {
    throw AppError.unprocessableEntity(
      `No complete month in the tax year starting ${window.startMonth} yet; pass "through" explicitly.`, 'TE_NO_COMPLETE_MONTH',
    );
  }
  return last > window.endMonth ? window.endMonth : last;
}
