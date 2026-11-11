// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Report column planner (U-119, ClientLedger A07 PR-B): the pure part of the
// report columns (U-201) — date windows, prior ranges, fiscal-year splits,
// captions, and the column definitions with $ change and % change derived
// in Decimal. Extracted from report-columns.service.ts so the standard
// column reports and the Report Builder plan their columns with the same
// code. No I/O.

import { dsum, exactStr, percent1, dec, type Dec } from '../report-exact.js';
import type { LineSum } from '../report-lens.js';

export const ZERO = () => dec(0);

export const MAX_PERIOD_RANGES = 36;
export const MAX_CONTACT_COLUMNS = 36;

export interface DateRange { from: string; to: string }

// ─── Dates (string math, UTC) ───────────────────────────────────

export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
/** Whole years back, Feb 29 -> Feb 28 (same rule as the comparative P&L). */
export function shiftYear(d: string, delta: number): string {
  const y = parseInt(d.slice(0, 4), 10) + delta;
  let md = d.slice(5);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (md === '02-29' && !leap) md = '02-28';
  return `${String(y).padStart(4, '0')}-${md}`;
}
/** prior=period: the same number of days just before; prior=year: a year back. */
export function priorRange(r: DateRange, prior: 'period' | 'year'): DateRange {
  if (prior === 'year') return { from: shiftYear(r.from, -1), to: shiftYear(r.to, -1) };
  const len = daysBetween(r.from, r.to) + 1;
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}
/** First day of the fiscal year containing `d`. */
export function fiscalYearStartOf(d: string, fyStartMonth: number): string {
  const y = parseInt(d.slice(0, 4), 10);
  const m = parseInt(d.slice(5, 7), 10);
  const fy = m < fyStartMonth ? y - 1 : y;
  return `${String(fy).padStart(4, '0')}-${String(fyStartMonth).padStart(2, '0')}-01`;
}

/** The longest fiscal year a start list may cover (a 53-week year is 371 days). */
export const MAX_FISCAL_YEAR_DAYS = 371;

/**
 * U-213 (report-fixes-v2): the fiscal year start for `d` from an explicit,
 * ascending list of fiscal year starts (`fiscal_year_start`, e.g. a retail
 * 52-53 week calendar): the latest start on or before `d`, or null when no
 * listed start covers `d` (none on or before it, or more than 371 days
 * before it). Without a list: the month rule (fiscalYearStartOf).
 */
export function fiscalYearStartIn(d: string, starts: readonly string[] | null | undefined, fyStartMonth: number): string | null {
  if (!starts || starts.length === 0) return fiscalYearStartOf(d, fyStartMonth);
  let best: string | null = null;
  for (const s of starts) if (s <= d && (best === null || s > best)) best = s;
  if (best === null || daysBetween(best, d) >= MAX_FISCAL_YEAR_DAYS) return null;
  return best;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(d: string): string {
  return `${MONTHS[parseInt(d.slice(5, 7), 10) - 1]} ${parseInt(d.slice(8, 10), 10)}, ${d.slice(0, 4)}`;
}
/** "Oct 2026", "2026", or "Jan 4, 2026 - Jan 31, 2026". */
export function rangeCaption(r: DateRange): string {
  const lastOfMonth = addDays(`${r.to.slice(0, 7)}-01`, 40).slice(0, 7);
  const monthEnd = addDays(`${lastOfMonth}-01`, -1);
  if (r.from.slice(8) === '01' && r.from.slice(0, 7) === r.to.slice(0, 7) && r.to === monthEnd) {
    return `${MONTHS[parseInt(r.from.slice(5, 7), 10) - 1]} ${r.from.slice(0, 4)}`;
  }
  if (r.from.slice(5) === '01-01' && r.to.slice(5) === '12-31' && r.from.slice(0, 4) === r.to.slice(0, 4)) return r.from.slice(0, 4);
  return `${fmtDay(r.from)} - ${fmtDay(r.to)}`;
}

/** Runs n over items with at most limit at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ─── Columns ─────────────────────────────────────────────────────

export type ColumnKind =
  | 'period' | 'total' | 'ytd' | 'as_of' | 'prior' | 'change' | 'pct_change'
  | 'contact' | 'no_contact' | 'others' | 'tag' | 'no_tag';

/** Query parameters that, added to the row drill, select the cell's lines on the General Ledger. */
export type Drill = Record<string, string>;

export interface ReportColumn {
  key: string;
  caption: string;
  kind: ColumnKind;
  /** 'amount' | 'percent' (pct_change). */
  valueType: 'amount' | 'percent';
  from: string | null;
  to: string | null;
  asOf?: string | null;
  /** Balance Sheet as-of columns (U-213): the fiscal year start where income splits into prior years and the current year. */
  fiscalYearStart?: string | null;
  contactId?: string | null;
  tagId?: string | null;
  tagNumber?: string | null;
  /** The column this prior / change / % change column compares with. */
  baseKey?: string | null;
  drill: Drill | null;
}

/** How a column's amounts are computed. */
export type ColSource =
  | { type: 'sums'; set: number; pick: (key: string | null) => boolean }
  | { type: 'sum_of'; cols: number[] }
  | { type: 'change'; cur: number; prior: number }
  | { type: 'pct'; cur: number; prior: number };

export interface ColDef { col: ReportColumn; src: ColSource }

/** One per distinct line window: per account, per key, natural amount. */
export interface SumSet {
  byAccount: Map<string, Map<string | null, Dec>>;
}

export function buildSumSet(rows: LineSum[], amountOf: (r: LineSum) => Dec | null): SumSet {
  const byAccount = new Map<string, Map<string | null, Dec>>();
  for (const r of rows) {
    const v = amountOf(r);
    if (v === null) continue;
    const m = byAccount.get(r.accountId) ?? new Map<string | null, Dec>();
    m.set(r.key, (m.get(r.key) ?? ZERO()).plus(v));
    byAccount.set(r.accountId, m);
  }
  return { byAccount };
}

/**
 * Evaluates every column for one value source (an account, a row of a
 * tag split, or a calculated row): `amount(set, pick)` gives a sums-backed
 * column's amount; sums, changes and percents derive from those.
 */
export function evalColumns(defs: ColDef[], amount: (set: number, pick: (k: string | null) => boolean) => Dec): Array<Dec | string | null> {
  const out: Array<Dec | string | null> = [];
  for (const d of defs) {
    const s = d.src;
    if (s.type === 'sums') out.push(amount(s.set, s.pick));
    else if (s.type === 'sum_of') out.push(dsum(s.cols.map((i) => out[i] as Dec)));
    else if (s.type === 'change') out.push((out[s.cur] as Dec).minus(out[s.prior] as Dec));
    else out.push(percent1((out[s.cur] as Dec).minus(out[s.prior] as Dec), (out[s.prior] as Dec).abs()));
  }
  return out;
}

export function toWire(values: Array<Dec | string | null>, defs: ColDef[]): Array<string | null> {
  return values.map((v, i) => (defs[i]!.src.type === 'pct' ? (v as string | null) : exactStr(v as Dec)));
}

/** Derived columns recomputed from summed amount columns (a rollup or a total). */
export function rederive(values: Array<Dec | string | null>, defs: ColDef[]): Array<Dec | string | null> {
  return defs.map((d, i) => {
    const s = d.src;
    if (s.type === 'change') return (values[s.cur] as Dec).minus(values[s.prior] as Dec);
    if (s.type === 'pct') return percent1((values[s.cur] as Dec).minus(values[s.prior] as Dec), (values[s.prior] as Dec).abs());
    return values[i]!;
  });
}

export function addValues(a: Array<Dec | string | null>, b: Array<Dec | string | null>, defs: ColDef[]): Array<Dec | string | null> {
  return defs.map((d, i) => (d.src.type === 'pct' ? null : (a[i] as Dec).plus(b[i] as Dec)));
}
export const zeroValues = (defs: ColDef[]): Array<Dec | string | null> => defs.map((d) => (d.src.type === 'pct' ? null : ZERO()));

export function isAmountCol(d: ColDef): boolean { return d.src.type !== 'pct'; }
/** True when any amount column of the row is non-zero. */
export function anyNonZero(values: Array<Dec | string | null>, defs: ColDef[]): boolean {
  return defs.some((d, i) => d.src.type !== 'pct' && d.src.type !== 'change' && !(values[i] as Dec).isZero());
}
