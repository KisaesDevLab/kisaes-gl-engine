// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Next date of a recurring schedule (U-63). Shared by the engine's runner
 * and the web schedule preview so both agree on every date.
 *
 * - daily / weekly / biweekly: `interval` days / weeks / fortnights later
 *   (UTC calendar-day arithmetic, so the container's time zone never shifts
 *   a date).
 * - semimonthly: the 1st and the 15th (interval ignored): on/after the 15th
 *   the next is the 1st of the next month, otherwise the 15th.
 * - monthly / quarterly / annually (and any unknown cadence, read as
 *   monthly): months counted from the ANCHOR, with the day clamped to the
 *   target month — Jan 31 → Feb 28 (29 in a leap year) → Mar 31 → Apr 30.
 *   Feb 29 yearly gives Feb 28 in common years and Feb 29 again in leap
 *   years. The result is the first anchored date strictly after `date`, so
 *   a date that drifted under the old arithmetic (Mar 3 from Jan 31) heals.
 *
 * Dates are `YYYY-MM-DD` strings in and out.
 */
export function nextRecurrenceDate(
  date: string,
  frequency: string,
  interval: number,
  anchor?: string | null,
): string {
  const step = Math.max(1, Math.floor(Number.isFinite(interval) ? interval : 1) || 1);
  const d = parseIsoDate(date);
  switch (frequency) {
    case 'daily': return addDays(d, step);
    case 'weekly': return addDays(d, 7 * step);
    case 'biweekly': return addDays(d, 14 * step);
    case 'semimonthly':
      return d.day >= 15 ? fmt(nextMonth(d.year, d.month), 1) : fmt({ year: d.year, month: d.month }, 15);
    case 'quarterly': return anchoredAfter(d, parseIsoDate(anchor || date), 3 * step);
    case 'annually': return anchoredAfter(d, parseIsoDate(anchor || date), 12 * step);
    case 'monthly':
    default:
      return anchoredAfter(d, parseIsoDate(anchor || date), step);
  }
}

interface YMD { year: number; month: number; day: number }

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(s: string): YMD {
  const m = ISO_RE.exec(s.slice(0, 10));
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${s}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function fmt(ym: { year: number; month: number }, day: number): string {
  return `${String(ym.year).padStart(4, '0')}-${String(ym.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(d: YMD, n: number): string {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return fmt({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1 }, t.getUTCDate());
}

/** The anchor moved forward `months` months, day clamped to the target month. */
function clampAddMonths(anchor: YMD, months: number): string {
  const idx = anchor.year * 12 + (anchor.month - 1) + months;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return fmt({ year, month }, Math.min(anchor.day, daysInMonth(year, month)));
}

function anchoredAfter(d: YMD, anchor: YMD, stepMonths: number): string {
  const date = fmt(d, d.day);
  const distance = (d.year - anchor.year) * 12 + (d.month - anchor.month);
  let k = Math.max(0, Math.floor(distance / stepMonths));
  let candidate = clampAddMonths(anchor, k * stepMonths);
  while (candidate <= date) {
    k += 1;
    candidate = clampAddMonths(anchor, k * stepMonths);
  }
  return candidate;
}
