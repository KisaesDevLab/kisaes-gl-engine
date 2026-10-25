// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Calendar-date arithmetic on YYYY-MM-DD strings (U-86). Pure UTC: the
 * result never depends on the process or browser time zone, so a term
 * window that crosses a daylight-saving change can't come out a day short
 * (the old `new Date(d).setDate(+n)` did, in a US time zone, across the
 * March change). The engine and the web forms use this one helper.
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real YYYY-MM-DD calendar day (2026-02-30 is not). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** `date` plus `days` calendar days (negative goes back). Throws on a malformed date. */
export function addCalendarDays(date: string, days: number): string {
  const m = ISO_DATE_RE.exec(date);
  if (!m || !isCalendarDate(date)) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  if (!Number.isInteger(days)) throw new RangeError(`Not a whole number of days: ${days}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}
