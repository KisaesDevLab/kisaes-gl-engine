// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pure UTC date helpers for rolling parameter dates between tax years.
// String in, string out; no Date-local math, so no timezone drift.

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const MS_PER_DAY = 86_400_000;
const SATURDAY = 6;
const SUNDAY = 0;
const FEB = 2;
const FEB_29 = 29;
const FEB_28 = 28;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function parse(dateStr: string): { y: number; m: number; d: number } {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!mt) throw new Error(`Invalid date '${dateStr}', expected YYYY-MM-DD`);
  return { y: Number(mt[1]), m: Number(mt[2]), d: Number(mt[3]) };
}

/** Shift the calendar year, keeping month/day. Feb 29 becomes Feb 28 when the target year is not a leap year. */
export function rollDateToYear(dateStr: string, fromYear: number, toYear: number): string {
  const { y, m, d } = parse(dateStr);
  const ny = y + (toYear - fromYear);
  const nd = m === FEB && d === FEB_29 && !isLeap(ny) ? FEB_28 : d;
  return `${pad(ny, 4)}-${pad(m, 2)}-${pad(nd, 2)}`;
}

/** Advance past Saturdays, Sundays and listed holidays (returns the input when it is already a business day). */
export function nextBusinessDay(dateStr: string, holidays: string[]): string {
  const { y, m, d } = parse(dateStr);
  const hol = new Set(holidays);
  let t = Date.UTC(y, m - 1, d);
  for (;;) {
    const dt = new Date(t);
    const s = `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
    const dow = dt.getUTCDay();
    if (dow !== SATURDAY && dow !== SUNDAY && !hol.has(s)) return s;
    t += MS_PER_DAY;
  }
}

/**
 * Format a UTC calendar date from parts, normalising overflow (month index 12
 * rolls into the next year, day 0 is the last day of the previous month). The
 * engine builds every derived date (fiscal-year installment dates) through this
 * so no formatting literal lives under engine/.
 */
export function isoDateUtc(year: number, monthIndex0: number, day: number): string {
  const dt = new Date(Date.UTC(year, monthIndex0, day));
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

/** Last day of the month that contains `year` / `monthIndex0` (0 = January; overflow normalised). */
export function lastDayOfMonthUtc(year: number, monthIndex0: number): string {
  return isoDateUtc(year, monthIndex0 + 1, 0);
}

// ── Day / month arithmetic for the estimate schedule (Phase 10) ──────
// These live outside engine/ on purpose: the engine's no-literals guard
// forbids 365 / 366 / month numbers, so the calendar facts sit here.

const DAYS_NON_LEAP = 365;
const DAYS_LEAP = 366;
const MONTHS_PER_YEAR = 12;

/** Strict YYYY-MM-DD check (rejects 2026-02-30). */
export function isIsoDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const { y, m, d } = parse(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Calendar year of a YYYY-MM-DD date. */
export function yearOf(dateStr: string): number {
  return parse(dateStr).y;
}

/** 365 or 366. */
export function daysInYear(year: number): number {
  return isLeap(year) ? DAYS_LEAP : DAYS_NON_LEAP;
}

/** Signed day count from `from` to `to` (to − from); 0 when equal. */
export function daysBetween(from: string, to: string): number {
  const a = parse(from); const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / MS_PER_DAY);
}

/** `dateStr` plus `days` (negative allowed). */
export function addDays(dateStr: string, days: number): string {
  const { y, m, d } = parse(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

/** 'MM-DD' in `year` → 'YYYY-MM-DD' (Feb 29 → Feb 28 in a non-leap year). */
export function monthDayInYear(monthDay: string, year: number): string {
  const mt = /^(\d{2})-(\d{2})$/.exec(monthDay);
  if (!mt) throw new Error(`Invalid month-day '${monthDay}', expected MM-DD`);
  const m = Number(mt[1]);
  const d = m === FEB && Number(mt[2]) === FEB_29 && !isLeap(year) ? FEB_28 : Number(mt[2]);
  return `${pad(year, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/**
 * Months "or fraction of a month" from `from` to `to` (exclusive of `from`): whole
 * calendar months plus one for any remaining days; 0 when `to` ≤ `from`. The
 * per-month penalty pattern (HI, ME).
 */
export function monthsOrFraction(from: string, to: string): number {
  if (to <= from) return 0;
  const a = parse(from); const b = parse(to);
  const spanMonths = (b.y - a.y) * MONTHS_PER_YEAR + (b.m - a.m);
  const wholeMonths = b.d < a.d ? spanMonths - 1 : spanMonths;
  const partial = b.d === a.d ? 0 : 1;
  return Math.max(wholeMonths + partial, 1);
}
