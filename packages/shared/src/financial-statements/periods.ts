// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Reporting periods for financial statements: resolving a period type
// (annual / fiscal quarter / month / year-to-date / custom range) to
// dates, planning the columns each statement shows, and composing the
// P&L activity of any date range from the TB engine's fiscal-year-to-date
// workpapers (ranges may cross fiscal year-ends).

import type { FsColumnMode, FsPeriodType, FsReportSettings } from './schemas.js';

// ─── Date helpers (UTC, YYYY-MM-DD) ───────────────────────────────

const parts = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { y, m, d };
};
const fmt = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function fsAddDays(iso: string, days: number): string {
  const dt = new Date(iso + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// First day of the month `months` after iso's month.
function monthStart(iso: string, months = 0): string {
  const { y, m } = parts(iso);
  const t = y * 12 + (m - 1) + months;
  return fmt(Math.floor(t / 12), (t % 12) + 1, 1);
}
function monthEnd(iso: string): string {
  const { y, m } = parts(iso);
  return fmt(y, m, lastDay(y, m));
}

// Same calendar day `years` later/earlier; month-ends stay month-ends
// (Feb 28 ↔ Feb 29).
export function fsShiftYears(iso: string, years: number): string {
  const { y, m, d } = parts(iso);
  const ny = y + years;
  const wasLast = d === lastDay(y, m);
  return fmt(ny, m, wasLast ? lastDay(ny, m) : Math.min(d, lastDay(ny, m)));
}

export function fsShiftMonths(iso: string, months: number): string {
  const { d, y, m } = parts(iso);
  const s = monthStart(iso, months);
  const p = parts(s);
  const wasLast = d === lastDay(y, m);
  return fmt(p.y, p.m, wasLast ? lastDay(p.y, p.m) : Math.min(d, lastDay(p.y, p.m)));
}

export function fsFiscalYearStart(iso: string, fyStartMonth: number): string {
  const { y, m } = parts(iso);
  return fmt(m < fyStartMonth ? y - 1 : y, fyStartMonth, 1);
}
export function fsFiscalYearEnd(iso: string, fyStartMonth: number): string {
  return fsAddDays(fsShiftYears(fsFiscalYearStart(iso, fyStartMonth), 1), -1);
}

// Whole calendar months covered, when the range is month-aligned.
export function fsWholeMonths(start: string, end: string): number | null {
  if (parts(start).d !== 1 || end !== monthEnd(end)) return null;
  const a = parts(start);
  const b = parts(end);
  return (b.y - a.y) * 12 + (b.m - a.m) + 1;
}

// ─── Period resolution (UI + normalization) ───────────────────────

export interface FsResolvedPeriod { type: FsPeriodType; start: string; end: string }

// `anchor` is any date inside the wanted period (for 'ytd' / 'custom' it
// is the end date; custom start comes from the caller).
export function fsResolvePeriod(type: FsPeriodType, anchor: string, fyStartMonth: number, customStart?: string): FsResolvedPeriod {
  switch (type) {
    case 'annual': {
      const start = fsFiscalYearStart(anchor, fyStartMonth);
      return { type, start, end: fsFiscalYearEnd(anchor, fyStartMonth) };
    }
    case 'quarter': {
      const fyS = fsFiscalYearStart(anchor, fyStartMonth);
      const a = parts(anchor);
      const f = parts(fyS);
      const offset = (a.y - f.y) * 12 + (a.m - f.m);
      const qStart = monthStart(fyS, Math.floor(offset / 3) * 3);
      return { type, start: qStart, end: monthEnd(monthStart(qStart, 2)) };
    }
    case 'month':
      return { type, start: monthStart(anchor), end: monthEnd(anchor) };
    case 'ytd':
      return { type, start: fsFiscalYearStart(anchor, fyStartMonth), end: anchor };
    case 'custom':
      return { type, start: customStart ?? fsFiscalYearStart(anchor, fyStartMonth), end: anchor };
  }
}

// Fiscal quarter (1-4) and fiscal year label (calendar year of the FY end).
export function fsFiscalQuarter(iso: string, fyStartMonth: number): { q: number; fy: number } {
  const fyS = fsFiscalYearStart(iso, fyStartMonth);
  const a = parts(iso);
  const f = parts(fyS);
  const offset = (a.y - f.y) * 12 + (a.m - f.m);
  return { q: Math.floor(offset / 3) + 1, fy: parts(fsFiscalYearEnd(iso, fyStartMonth)).y };
}

// Legacy reports (before periods) were fiscal-YTD through periodEnd;
// 'month_ytd' becomes 'period_ytd' with a month period.
export function normalizeFsSettings(s: FsReportSettings, fyStartMonth: number): FsReportSettings {
  let period = s.period;
  let mode: FsColumnMode = s.columns.mode;
  if (mode === 'month_ytd') {
    mode = 'period_ytd';
    if (!period) period = { type: 'month', start: monthStart(s.periodEnd) };
  }
  if (!period) {
    const fyS = fsFiscalYearStart(s.periodEnd, fyStartMonth);
    period = { type: s.periodEnd === fsFiscalYearEnd(s.periodEnd, fyStartMonth) ? 'annual' : 'ytd', start: fyS };
  }
  return { ...s, period, columns: { ...s.columns, mode } };
}

// Next period of the same kind (roll forward).
export function fsNextPeriod(type: FsPeriodType, start: string, end: string): { start: string; end: string } {
  if (type === 'quarter') return { start: monthStart(start, 3), end: monthEnd(monthStart(end, 3)) };
  if (type === 'month') return { start: monthStart(start, 1), end: monthEnd(monthStart(end, 1)) };
  return { start: fsShiftYears(start, 1), end: fsShiftYears(end, 1) };
}

// ─── Range composition ────────────────────────────────────────────

// Signed workpaper dates whose fiscal-YTD P&L sums to the activity in
// [start, end]. Per fiscal-year segment [a, b]: YTD(b) − YTD(a − 1),
// where YTD(a − 1) is dropped when a is the fiscal-year start.
export function fsRangeComposition(start: string, end: string, fyStartMonth: number): Array<{ date: string; sign: 1 | -1 }> {
  const out: Array<{ date: string; sign: 1 | -1 }> = [];
  let a = start;
  let guard = 0;
  while (a <= end && guard++ < 100) {
    const fyS = fsFiscalYearStart(a, fyStartMonth);
    const fyE = fsFiscalYearEnd(a, fyStartMonth);
    const b = end < fyE ? end : fyE;
    out.push({ date: b, sign: 1 });
    if (a !== fyS) out.push({ date: fsAddDays(a, -1), sign: -1 });
    a = fsAddDays(b, 1);
  }
  return out;
}

// ─── Column plan ──────────────────────────────────────────────────

export interface FsPlanRange { key: string; start: string; end: string; label: string; sublabel?: string }
export interface FsPlanPoint { key: string; date: string; label: string }

export interface FsPlan {
  period: FsResolvedPeriod;
  mode: FsColumnMode;
  isRanges: FsPlanRange[];     // income statement amount columns, in order
  bsPoints: FsPlanPoint[];     // balance sheet columns, in order
  cfRanges: FsPlanRange[];     // cash-flow columns, in order
  equityBlocks: FsPlanRange[]; // equity roll-forwards, chronological
  variance: boolean;           // $ / % change allowed (two comparable columns)
  // Workpaper dates the loader must fetch (points + range compositions).
  workpaperDates: string[];
}

const NUMBER_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty', 'Twenty-One', 'Twenty-Two', 'Twenty-Three', 'Twenty-Four'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const longDate = (iso: string) => { const p = parts(iso); return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`; };
const shortDate = (iso: string) => { const p = parts(iso); return `${MONTH_ABBR[p.m - 1]} ${p.d}, ${p.y}`; };

// "Year" / "Three Months" / "Period" — the span word for a range.
export function fsSpanWords(start: string, end: string, fyStartMonth: number): string {
  if (start === fsFiscalYearStart(end, fyStartMonth) && end === fsFiscalYearEnd(end, fyStartMonth)) return 'Year';
  const n = fsWholeMonths(start, end);
  if (n && n <= 24) return n === 12 ? 'Twelve Months' : `${NUMBER_WORDS[n]} Month${n === 1 ? '' : 's'}`;
  return 'Period';
}

// "For the Three Months Ended September 30, 2026" or
// "For the Period from July 15, 2026 to September 30, 2026".
export function fsRangePhrase(start: string, end: string, fyStartMonth: number): string {
  const w = fsSpanWords(start, end, fyStartMonth);
  if (w === 'Period') return `For the Period from ${longDate(start)} to ${longDate(end)}`;
  return `For the ${w} Ended ${longDate(end)}`;
}

export function fsPlanColumns(settings: FsReportSettings, fyStartMonth: number): FsPlan {
  const s = normalizeFsSettings(settings, fyStartMonth);
  const period: FsResolvedPeriod = { type: s.period!.type, start: s.period!.start, end: s.periodEnd };
  const mode = s.columns.mode;
  const yr = (iso: string) => String(parts(iso).y);
  const P: FsPlanRange = { key: 'P', start: period.start, end: period.end, label: '' };
  const py = (r: FsPlanRange, key: string): FsPlanRange => ({ ...r, key, start: fsShiftYears(r.start, -1), end: fsShiftYears(r.end, -1) });
  const ytdStart = fsFiscalYearStart(period.end, fyStartMonth);
  const YTD: FsPlanRange = { key: 'YTD', start: ytdStart, end: period.end, label: '' };
  const span = (r: FsPlanRange) => fsSpanWords(r.start, r.end, fyStartMonth);

  let isRanges: FsPlanRange[];
  let cfRanges: FsPlanRange[];
  let variance = false;
  const comparativeBs = mode === 'cy_py' || mode === 'period_ytd_py';

  switch (mode) {
    case 'cy_py': {
      const a = { ...P, label: yr(P.end) };
      const b = { ...py(P, 'P_py'), label: yr(fsShiftYears(P.end, -1)) };
      isRanges = [a, b];
      cfRanges = [a, b];
      variance = true;
      break;
    }
    case 'period_ytd':
    case 'month_ytd': {
      if (P.start === YTD.start) {
        isRanges = [{ ...P, label: '' }];
      } else {
        isRanges = [{ ...P, label: span(P) }, { ...YTD, label: span(YTD) === 'Year' ? 'Year to Date' : span(YTD) }];
      }
      cfRanges = isRanges;
      break;
    }
    case 'period_ytd_py': {
      const withYtd = P.start !== YTD.start;
      const cur = { ...P, label: span(P), sublabel: yr(P.end) };
      const prev = { ...py(P, 'P_py'), label: span(P), sublabel: yr(fsShiftYears(P.end, -1)) };
      isRanges = [cur, prev];
      if (withYtd) {
        const ytdLabel = span(YTD) === 'Year' ? 'Year to Date' : span(YTD);
        isRanges.push({ ...YTD, label: ytdLabel, sublabel: yr(YTD.end) }, { ...py(YTD, 'YTD_py'), label: ytdLabel, sublabel: yr(fsShiftYears(YTD.end, -1)) });
      } else {
        variance = true;
      }
      cfRanges = isRanges;
      break;
    }
    case 'side_by_side': {
      const slices: FsPlanRange[] = [];
      const step = s.columns.sideBy === 'quarter' ? 3 : 1;
      let i = 0;
      let cursor = monthStart(P.start);
      while (cursor <= P.end && i < 24) {
        const sliceEnd = monthEnd(monthStart(cursor, step - 1));
        const a = cursor < P.start ? P.start : cursor;
        const b = sliceEnd > P.end ? P.end : sliceEnd;
        const label = step === 3
          ? `Q${fsFiscalQuarter(a, fyStartMonth).q}`
          : MONTH_ABBR[parts(a).m - 1]!;
        const sublabel = step === 3 ? `FY${fsFiscalQuarter(a, fyStartMonth).fy}` : yr(a);
        slices.push({ key: `S${++i}`, start: a, end: b, label, sublabel });
        cursor = monthStart(cursor, step);
      }
      isRanges = [...slices, { ...P, label: 'Total' }];
      cfRanges = [{ ...P, label: '' }];
      break;
    }
    default:
      isRanges = [{ ...P, label: '' }];
      cfRanges = isRanges;
  }

  // Balance sheet: period end, plus the comparative point.
  const cmpDate = s.columns.bsCompare === 'same_date'
    ? fsShiftYears(period.end, -1)
    : fsAddDays(fsFiscalYearStart(period.end, fyStartMonth), -1);
  const sameMonthDay = parts(cmpDate).m === parts(period.end).m && parts(cmpDate).d === parts(period.end).d;
  const bsPoints: FsPlanPoint[] = comparativeBs
    ? [
      { key: 'end', date: period.end, label: sameMonthDay ? yr(period.end) : shortDate(period.end) },
      { key: 'cmp', date: cmpDate, label: sameMonthDay ? yr(cmpDate) : shortDate(cmpDate) },
    ]
    : [{ key: 'end', date: period.end, label: '' }];

  const seen = new Set<string>();
  const equityBlocks = [...cfRanges]
    .filter((r) => { const k = `${r.start}|${r.end}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.end === b.end ? a.start.localeCompare(b.start) : a.end.localeCompare(b.end)));
  // Contiguous comparative years read naturally oldest → newest; a PY
  // interim block before the current one is fine too.

  const dates = new Set<string>();
  for (const p of bsPoints) dates.add(p.date);
  for (const r of [...isRanges, ...cfRanges, ...equityBlocks]) {
    for (const c of fsRangeComposition(r.start, r.end, fyStartMonth)) dates.add(c.date);
  }
  for (const r of [...cfRanges, ...equityBlocks]) { dates.add(fsAddDays(r.start, -1)); dates.add(r.end); }

  return { period, mode, isRanges, bsPoints, cfRanges, equityBlocks, variance, workpaperDates: [...dates].sort() };
}

// ─── Date lines ───────────────────────────────────────────────────

export function fsPlanBalanceSheetDateLine(plan: FsPlan): string {
  if (plan.bsPoints.length < 2) return longDate(plan.period.end);
  const [a, b] = plan.bsPoints as [FsPlanPoint, FsPlanPoint];
  const pa = parts(a.date);
  const pb = parts(b.date);
  if (pa.m === pb.m && pa.d === pb.d) return `${longDate(a.date)} and ${pb.y}`;
  return `${longDate(a.date)} and ${longDate(b.date)}`;
}

// Heading for flow statements (income statement, equity, cash flows).
export function fsPlanFlowDateLine(plan: FsPlan, ranges: FsPlanRange[], fyStartMonth: number): string {
  const end = plan.period.end;
  const uniq = [...new Map(ranges.map((r) => [`${r.start}|${r.end}`, r])).values()];
  if (plan.mode === 'side_by_side') return fsRangePhrase(plan.period.start, end, fyStartMonth);
  // Shortest span first: "Three and Nine Months", "Three Months and Year".
  const cur = uniq.filter((r) => r.end === end).sort((a, b) => b.start.localeCompare(a.start));
  const hasPy = uniq.some((r) => r.end !== end && r.end === fsShiftYears(end, -1));
  const words = [...new Set(cur.map((r) => fsSpanWords(r.start, r.end, fyStartMonth)))];
  if (words.includes('Period')) {
    // Irregular ranges: spell out the (first) range.
    const r = cur[0] ?? uniq[0]!;
    return fsRangePhrase(r.start, r.end, fyStartMonth) + (hasPy ? ` and ${longDate(fsShiftYears(r.end, -1))}` : '');
  }
  let span: string;
  if (words.length === 1) span = words[0]!;
  else {
    // "Three and Nine Months" — drop the repeated "Months".
    const nums = words.map((w) => w.replace(/ Months?$/, ''));
    span = `${nums.join(' and ')} Months`;
    if (words.includes('Year')) span = words.join(' and ');
  }
  const plural = hasPy && words.length === 1 ? (span === 'Year' ? 'Years' : span) : span;
  const tail = hasPy ? ` and ${parts(fsShiftYears(end, -1)).y}` : '';
  return `For the ${plural} Ended ${longDate(end)}${tail}`;
}
