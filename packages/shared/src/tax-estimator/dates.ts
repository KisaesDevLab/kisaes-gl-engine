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
