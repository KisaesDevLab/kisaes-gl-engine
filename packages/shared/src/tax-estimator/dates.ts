// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pure UTC date helpers for rolling parameter dates between tax years.
// String in, string out; no Date-local math, so no timezone drift.

import { PARAMETER_REGISTRY, type StatutoryDate } from './parameterKeys.js';

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

// ── Legal-holiday calendar and the statutory date roll (R6-01) ───────
//
// IRC §7503 / Treas. Reg. §301.7503-1(b): a "legal holiday" is a legal public holiday
// under 5 U.S.C. 6103(a) or a legal holiday in the District of Columbia (D.C. Code
// §1-612.02), which adds Emancipation Day (April 16) and Inauguration Day (January 20
// of every fourth year, 5 U.S.C. 6103(c)). Observance: a Saturday holiday is observed
// the preceding Friday and a Sunday holiday the following Monday (5 U.S.C. 6103(b),
// E.O. 11582; D.C. Code §1-612.02(b)); Inauguration Day moves only from Sunday to
// Monday (6103(c)). The seeds store OBSERVED dates, so a year roll never starts from
// a stored date: it starts from the statute (registry `roll` rule) and lands on the
// next business day under the target year's calendar built here.

const MONDAY = 1;
const THURSDAY = 4;
const FRIDAY = 5;
const LAST = -1;
const JAN = 1; const FEB_M = 2; const MAY = 5; const SEP = 9; const OCT = 10; const NOV = 11; const DEC = 12;
const INAUGURATION_BASE_YEAR = 1965;
const INAUGURATION_CYCLE = 4;
const MAX_UNBUMP_DAYS = 10;
/** Days of the month that estimated-tax statutes use (15th, 1st, 20th, 30th and the last day). */
const STATUTORY_DAYS_OF_MONTH: ReadonlySet<number> = new Set([1, 15, 20, 30]);

/** How a jurisdiction observes a fixed-date holiday that falls on a weekend. */
export type HolidayObservance = 'federal' | 'sunday_to_monday' | 'none';

export type HolidayRule =
  | { id: string; kind: 'fixed'; monthDay: string }
  | { id: string; kind: 'nth_weekday'; month: number; weekday: number; n: number }
  | { id: string; kind: 'inauguration' };

/** Federal legal public holidays (5 U.S.C. 6103(a), (c)) plus DC Emancipation Day (D.C. Code §1-612.02(a)). */
export const FEDERAL_HOLIDAY_RULES: readonly HolidayRule[] = [
  { id: 'new_years_day', kind: 'fixed', monthDay: '01-01' },
  { id: 'mlk_day', kind: 'nth_weekday', month: JAN, weekday: MONDAY, n: 3 },
  { id: 'inauguration_day', kind: 'inauguration' },
  { id: 'washingtons_birthday', kind: 'nth_weekday', month: FEB_M, weekday: MONDAY, n: 3 },
  { id: 'dc_emancipation_day', kind: 'fixed', monthDay: '04-16' },
  { id: 'memorial_day', kind: 'nth_weekday', month: MAY, weekday: MONDAY, n: LAST },
  { id: 'juneteenth', kind: 'fixed', monthDay: '06-19' },
  { id: 'independence_day', kind: 'fixed', monthDay: '07-04' },
  { id: 'labor_day', kind: 'nth_weekday', month: SEP, weekday: MONDAY, n: 1 },
  { id: 'columbus_day', kind: 'nth_weekday', month: OCT, weekday: MONDAY, n: 2 },
  { id: 'veterans_day', kind: 'fixed', monthDay: '11-11' },
  { id: 'thanksgiving', kind: 'nth_weekday', month: NOV, weekday: THURSDAY, n: 4 },
  { id: 'christmas', kind: 'fixed', monthDay: '12-25' },
];

const dow = (dateStr: string): number => { const { y, m, d } = parse(dateStr); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const isWeekend = (dateStr: string): boolean => { const w = dow(dateStr); return w === SATURDAY || w === SUNDAY; };

/** The n-th `weekday` (0 = Sunday) of `month` (1-12) in `year`; n = -1 is the last one. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  if (n === LAST) {
    const last = lastDayOfMonthUtc(year, month - 1);
    const back = (dow(last) - weekday + 7) % 7;
    return addDays(last, -back);
  }
  const first = `${pad(year, 4)}-${pad(month, 2)}-01`;
  const forward = (weekday - dow(first) + 7) % 7;
  return addDays(first, forward + (n - 1) * 7);
}

/** Observed date of a fixed-date holiday under a jurisdiction's weekend rule. */
export function observedHoliday(dateStr: string, policy: HolidayObservance): string {
  const w = dow(dateStr);
  if (w === SUNDAY && policy !== 'none') return addDays(dateStr, 1);
  if (w === SATURDAY && policy === 'federal') return addDays(dateStr, -1);
  return dateStr;
}

const isInaugurationYear = (year: number): boolean => (year - INAUGURATION_BASE_YEAR) % INAUGURATION_CYCLE === 0;

/** Observed date of one rule in one calendar year (null when the rule does not occur that year). */
function ruleDate(rule: HolidayRule, year: number, policy: HolidayObservance): string | null {
  switch (rule.kind) {
    case 'fixed': return observedHoliday(monthDayInYear(rule.monthDay, year), policy);
    case 'nth_weekday': return nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.n);
    case 'inauguration': {
      if (!isInaugurationYear(year)) return null;
      // 5 U.S.C. 6103(c): a Sunday January 20 moves to Monday; a Saturday one is not moved.
      return observedHoliday(`${pad(year, 4)}-01-20`, 'sunday_to_monday');
    }
    default: return null;
  }
}

/**
 * Observed holiday dates of `rules` whose date falls within calendar years `fromYear`..`toYear`
 * (a New Year's Day observed on the preceding December 31 belongs to the earlier year).
 */
export function holidayCalendar(rules: readonly HolidayRule[], fromYear: number, toYear: number, policy: HolidayObservance): string[] {
  const out = new Set<string>();
  for (let y = fromYear; y <= toYear + 1; y++) {
    for (const r of rules) {
      const d = ruleDate(r, y, policy);
      if (d === null) continue;
      const yy = yearOf(d);
      if (yy >= fromYear && yy <= toYear) out.add(d);
    }
  }
  return [...out].sort();
}

/** Federal + DC legal holidays (observed dates) that fall in calendar `year`. */
export function federalLegalHolidays(year: number): string[] {
  return holidayCalendar(FEDERAL_HOLIDAY_RULES, year, year, 'federal');
}

/**
 * The `holidays` parameter for a tax year: the legal holidays of the tax year AND the
 * following calendar year (the Q4 installment, the Q4 file-and-pay date, the return due
 * date and the farmer dates all fall in the following year).
 */
export function legalHolidaysForTaxYear(taxYear: number): string[] {
  return holidayCalendar(FEDERAL_HOLIDAY_RULES, taxYear, taxYear + 1, 'federal');
}

/** Statutory days → §7503 observed dates for `taxYear` under `holidays`. */
export function statutoryDatesForYear(dates: ReadonlyArray<StatutoryDate>, taxYear: number, holidays: readonly string[]): string[] {
  return dates.map((d) => nextBusinessDay(monthDayInYear(d.monthDay, taxYear + d.yearOffset), [...holidays]));
}

/**
 * Every federal `rollsWithYear` parameter derived for `taxYear` from its registry `roll`
 * rule: the computed legal-holiday calendar first, then each statutory date landed on the
 * next business day under that calendar. Shared by "create year from prior year" and the
 * missing-year fallback, which therefore never roll a stored (observed) date.
 */
export function deriveFederalDates(taxYear: number): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  const holidays = legalHolidaysForTaxYear(taxYear);
  for (const def of PARAMETER_REGISTRY) {
    if (!def.roll) continue;
    if (def.roll.kind === 'legal_holidays') { out.set(def.key, holidays); continue; }
    const dates = statutoryDatesForYear(def.roll.dates, taxYear, holidays);
    out.set(def.key, def.type === 'date' ? dates[0]! : dates);
  }
  return out;
}

/** Statutory month-days of a federal `rollsWithYear` key (hints for the state inference below). */
export function federalStatutoryMonthDays(key: string): string[] {
  const def = PARAMETER_REGISTRY.find((d) => d.key === key);
  return def?.roll?.kind === 'statutory' ? def.roll.dates.map((d) => d.monthDay) : [];
}

// ── State date roll: inferred from the prior list (no per-state statute registry) ──
//
// State rule sets carry observed dates and a state holiday list but no statutory
// month-days, so the roll INFERS them (every rolled state date is provisional and
// flagged "verify"): a holiday list is matched date by date to the federal rule set
// (floating rules first, then fixed dates with the jurisdiction's weekend observance
// read from the list itself); unmatched dates become fixed month-days. An observed
// due date is un-bumped to the statutory day by walking back over the preceding
// non-business days and picking the candidate that matches the federal statutory
// month-day for that rule, else the one statutory day of the month (1st, 15th, 20th,
// 30th or last), else the stored date itself.

/** Weekend-observance policy a jurisdiction evidently applies in its holiday list. */
export function inferHolidayObservance(dates: readonly string[]): HolidayObservance {
  const set = new Set(dates);
  let satShifted = false; let sunShifted = false; let sunKept = false;
  for (const d of dates) {
    const y = yearOf(d);
    for (const r of FEDERAL_HOLIDAY_RULES) {
      if (r.kind !== 'fixed') continue;
      for (const yy of [y, y + 1]) {
        const raw = monthDayInYear(r.monthDay, yy);
        if (dow(raw) === SATURDAY && d === addDays(raw, -1)) satShifted = true;
        if (dow(raw) === SUNDAY && d === addDays(raw, 1)) sunShifted = true;
      }
    }
    if (dow(d) === SUNDAY && set.has(d)) sunKept = true;
  }
  if (satShifted) return 'federal';
  if (sunKept && !sunShifted) return 'none';
  return 'sunday_to_monday';
}

/** Match one listed holiday date to a federal rule (floating first), else a fixed month-day of its own. */
function matchHolidayRule(d: string): HolidayRule {
  const y = yearOf(d);
  for (const r of FEDERAL_HOLIDAY_RULES) {
    if (r.kind === 'fixed') continue;
    for (const yy of [y - 1, y, y + 1]) {
      for (const policy of ['federal', 'none'] as const) if (ruleDate(r, yy, policy) === d) return r;
    }
  }
  for (const r of FEDERAL_HOLIDAY_RULES) {
    if (r.kind !== 'fixed') continue;
    for (const yy of [y, y + 1]) {
      const raw = monthDayInYear(r.monthDay, yy);
      if (d === raw || d === observedHoliday(raw, 'federal') || d === observedHoliday(raw, 'sunday_to_monday')) return r;
    }
  }
  const { m, d: day } = parse(d);
  const monthDay = `${pad(m, 2)}-${pad(day, 2)}`;
  return { id: `fixed:${monthDay}`, kind: 'fixed', monthDay };
}

/** Holiday rules a prior-year list evidently follows (deduplicated by rule id). */
export function inferHolidayRules(dates: readonly string[]): HolidayRule[] {
  const by = new Map<string, HolidayRule>();
  for (const d of dates) { const r = matchHolidayRule(d); if (!by.has(r.id)) by.set(r.id, r); }
  return [...by.values()];
}

/**
 * A jurisdiction's holiday list for tax year `toYear` (calendar years toYear and toYear+1)
 * regenerated from the rules its `priorDates` list evidently follows, under the
 * observance that list shows. Provisional: a state-specific holiday whose stored date was
 * itself an observed (shifted) date is carried by month-day.
 */
export function rollHolidayList(priorDates: readonly string[], toYear: number): string[] {
  if (priorDates.length === 0) return [];
  return holidayCalendar(inferHolidayRules(priorDates), toYear, toYear + 1, inferHolidayObservance(priorDates));
}

const isLastDayOfMonth = (dateStr: string): boolean => { const { y, m } = parse(dateStr); return dateStr === lastDayOfMonthUtc(y, m - 1); };
const monthDayOf = (dateStr: string): string => dateStr.slice(5);

/**
 * The statutory date an observed date stands for: `observed` itself, or one of the
 * non-business days (weekend / `priorHolidays`) immediately before it. `hints` are the
 * statutory 'MM-DD' values the rule is known to use (the federal registry's); a unique hint
 * match wins, else a unique statutory day of the month (1, 15, 20, 30, last), else `observed`.
 */
export function inferStatutoryDate(observed: string, priorHolidays: readonly string[], hints: readonly string[] = []): string {
  const hol = new Set(priorHolidays);
  const candidates = [observed];
  let d = observed;
  for (let i = 0; i < MAX_UNBUMP_DAYS; i++) {
    const prev = addDays(d, -1);
    if (!isWeekend(prev) && !hol.has(prev)) break;
    candidates.push(prev);
    d = prev;
  }
  if (candidates.length === 1) return observed;
  const byHint = candidates.filter((c) => hints.includes(monthDayOf(c)));
  if (byHint.length === 1) return byHint[0]!;
  const statutoryDays = candidates.filter((c) => STATUTORY_DAYS_OF_MONTH.has(parse(c).d) || isLastDayOfMonth(c));
  if (statutoryDays.length === 1) return statutoryDays[0]!;
  return observed;
}

/**
 * Roll one observed state date from tax year `fromYear` to `toYear`: infer its statutory
 * day, move that day by the year difference and land it on the next business day under the
 * target year's (regenerated) holiday list.
 */
export function rollObservedDate(
  observed: string, priorHolidays: readonly string[], fromYear: number, toYear: number, newHolidays: readonly string[], hints: readonly string[] = [],
): string {
  const statutory = inferStatutoryDate(observed, priorHolidays, hints);
  const target = monthDayInYear(monthDayOf(statutory), toYear + (yearOf(statutory) - fromYear));
  return nextBusinessDay(target, [...newHolidays]);
}

// ── State rule sets: every date-valued rule of one jurisdiction rolled to a tax year ──

const STATE_HOLIDAYS_KEY = 'holidays';
const STATE_DUE_DATES_KEY = 'installments.due_dates';
const STATE_Q4_KEY = 'installments.q4_file_and_pay_date';
const STATE_RETURN_DUE_KEY = 'return_due_date';
const STATE_FARMER_KEY = 'farmer.rule';
const STATE_RATE_SCHEDULE_KEY = 'penalty.rate_schedule';
/** Federal registry keys whose statutory month-days hint the matching state rule. */
const STATE_HINT_KEYS: Readonly<Record<string, string>> = {
  [STATE_DUE_DATES_KEY]: 'installments.due_dates',
  [STATE_Q4_KEY]: 'installments.q4_file_and_pay_date',
  [STATE_RETURN_DUE_KEY]: 'return_due_date',
  'farmer.rule.due_date': 'farmer.single_due_date',
  'farmer.rule.file_by': 'farmer.file_by_date',
};

interface RatePeriod { from: string; to: string; rate: number }

/**
 * One state's date-valued rules for tax year `toYear`, derived from its `fromYear` values
 * (key → rolled value, only for keys present and non-null): the holiday list is regenerated
 * from the rules it evidently follows, every observed due date is un-bumped to its statutory
 * day and re-landed under the new list, farmer dates likewise, and penalty rate legs keep
 * their calendar boundaries and rates (the rates must be re-read; everything is provisional).
 */
export function rollStateRuleDates(values: ReadonlyMap<string, unknown>, fromYear: number, toYear: number): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const ph = values.get(STATE_HOLIDAYS_KEY);
  const priorHolidays = Array.isArray(ph) ? ph.map(String) : [];
  const holidays = rollHolidayList(priorHolidays, toYear);
  const roll = (d: unknown, hintKey: string): unknown =>
    (typeof d === 'string' ? rollObservedDate(d, priorHolidays, fromYear, toYear, holidays, federalStatutoryMonthDays(STATE_HINT_KEYS[hintKey] ?? '')) : d);
  for (const [key, value] of values) {
    if (value === undefined) continue;
    if (key === STATE_HOLIDAYS_KEY && Array.isArray(value)) {
      out.set(key, holidays);
    } else if (key === STATE_DUE_DATES_KEY && Array.isArray(value)) {
      out.set(key, value.map((d) => roll(d, key)));
    } else if ((key === STATE_Q4_KEY || key === STATE_RETURN_DUE_KEY) && typeof value === 'string') {
      out.set(key, roll(value, key));
    } else if (key === STATE_RATE_SCHEDULE_KEY && Array.isArray(value)) {
      out.set(key, (value as RatePeriod[]).map((p) => ({ from: rollDateToYear(p.from, fromYear, toYear), to: rollDateToYear(p.to, fromYear, toYear), rate: p.rate })));
    } else if (key === STATE_FARMER_KEY && value && typeof value === 'object') {
      const f = value as { due_date?: unknown; file_by?: unknown };
      out.set(key, { ...f, due_date: roll(f.due_date, 'farmer.rule.due_date'), file_by: roll(f.file_by, 'farmer.rule.file_by') });
    }
  }
  return out;
}
