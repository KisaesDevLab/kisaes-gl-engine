// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  rollDateToYear, nextBusinessDay, daysBetween, addDays, daysInYear, yearOf, monthDayInYear, monthsOrFraction, isIsoDate,
  nthWeekdayOfMonth, observedHoliday, federalLegalHolidays, legalHolidaysForTaxYear, deriveFederalDates, statutoryDatesForYear,
  inferHolidayObservance, inferHolidayRules, rollHolidayList, inferStatutoryDate, rollObservedDate, federalStatutoryMonthDays,
} from './dates.js';
import { PARAMETER_REGISTRY } from './parameterKeys.js';

describe('rollDateToYear', () => {
  it('keeps month and day', () => {
    expect(rollDateToYear('2026-04-15', 2026, 2026)).toBe('2026-04-15');
    expect(rollDateToYear('2025-04-15', 2025, 2026)).toBe('2026-04-15');
    expect(rollDateToYear('2026-01-15', 2025, 2027)).toBe('2028-01-15');
  });
  it('Feb 29 -> Feb 28 in a non-leap target, kept in a leap target', () => {
    expect(rollDateToYear('2024-02-29', 2024, 2025)).toBe('2025-02-28');
    expect(rollDateToYear('2024-02-29', 2024, 2028)).toBe('2028-02-29');
    expect(rollDateToYear('2024-02-29', 2024, 2100)).toBe('2100-02-28');
  });
  it('rejects malformed input', () => {
    expect(() => rollDateToYear('04-15', 2025, 2026)).toThrow();
  });
});

describe('nextBusinessDay', () => {
  it('returns a weekday unchanged', () => {
    expect(nextBusinessDay('2026-04-15', [])).toBe('2026-04-15'); // Wednesday
  });
  it('skips Saturday and Sunday', () => {
    expect(nextBusinessDay('2026-06-13', [])).toBe('2026-06-15'); // Sat -> Mon
    expect(nextBusinessDay('2026-06-14', [])).toBe('2026-06-15'); // Sun -> Mon
  });
  it('skips holidays and a holiday followed by a weekend', () => {
    expect(nextBusinessDay('2026-04-15', ['2026-04-15'])).toBe('2026-04-16');
    expect(nextBusinessDay('2026-06-12', ['2026-06-12'])).toBe('2026-06-15'); // Fri holiday
  });
  it('crosses month and year ends', () => {
    expect(nextBusinessDay('2022-12-31', ['2023-01-02'])).toBe('2023-01-03');
  });
});

describe('day and month arithmetic (Phase 10)', () => {
  it('daysBetween / addDays / daysInYear / yearOf', () => {
    expect(daysBetween('2026-09-15', '2027-01-15')).toBe(122);
    expect(daysBetween('2027-01-15', '2026-09-15')).toBe(-122);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysInYear(2026)).toBe(365);
    expect(daysInYear(2028)).toBe(366);
    expect(daysInYear(2100)).toBe(365);
    expect(yearOf('2027-04-15')).toBe(2027);
  });
  it('monthDayInYear handles Feb 29', () => {
    expect(monthDayInYear('08-31', 2026)).toBe('2026-08-31');
    expect(monthDayInYear('02-29', 2027)).toBe('2027-02-28');
    expect(monthDayInYear('02-29', 2028)).toBe('2028-02-29');
    expect(() => monthDayInYear('2026-08-31', 2026)).toThrow();
  });
  it('monthsOrFraction counts whole months plus one for any remaining days', () => {
    expect(monthsOrFraction('2026-04-15', '2026-04-15')).toBe(0);
    expect(monthsOrFraction('2026-04-15', '2026-04-20')).toBe(1);
    expect(monthsOrFraction('2026-04-15', '2026-05-15')).toBe(1);
    expect(monthsOrFraction('2026-04-15', '2026-05-16')).toBe(2);
    expect(monthsOrFraction('2026-04-15', '2026-06-20')).toBe(3);
    expect(monthsOrFraction('2026-04-15', '2027-01-15')).toBe(9);
  });
  it('isIsoDate is strict about the calendar', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('04-15')).toBe(false);
  });
});

// ── R6-01: legal-holiday calendar and the statutory roll ─────────────
// Expected lists below are the shipped federal seeds (2025.ts / 2026.ts `holidays`), which were
// read from the OPM schedules; the 2027/2028 figures are hand-checked from the statute.

const SHIPPED_2025_HOLIDAYS = ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-16', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'];
const SHIPPED_2026_HOLIDAYS = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-16', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-31'];

describe('R6-01 legal-holiday calendar (5 U.S.C. 6103, D.C. Code §1-612.02)', () => {
  it('floating holidays: n-th weekday and last weekday of a month', () => {
    expect(nthWeekdayOfMonth(2028, 1, 1, 3)).toBe('2028-01-17'); // MLK Day 2028
    expect(nthWeekdayOfMonth(2027, 1, 1, 3)).toBe('2027-01-18');
    expect(nthWeekdayOfMonth(2028, 5, 1, -1)).toBe('2028-05-29'); // Memorial Day 2028
    expect(nthWeekdayOfMonth(2027, 5, 1, -1)).toBe('2027-05-31');
    expect(nthWeekdayOfMonth(2028, 11, 4, 4)).toBe('2028-11-23'); // Thanksgiving 2028
    expect(nthWeekdayOfMonth(2026, 9, 1, 1)).toBe('2026-09-07'); // Labor Day 2026
  });

  it('fixed holidays observe Saturday → Friday and Sunday → Monday under the federal rule', () => {
    expect(observedHoliday('2026-07-04', 'federal')).toBe('2026-07-03'); // Saturday
    expect(observedHoliday('2027-07-04', 'federal')).toBe('2027-07-05'); // Sunday
    expect(observedHoliday('2027-07-04', 'sunday_to_monday')).toBe('2027-07-05');
    expect(observedHoliday('2026-07-04', 'sunday_to_monday')).toBe('2026-07-04'); // Saturday kept (RSMo §9.010 style)
    expect(observedHoliday('2027-07-04', 'none')).toBe('2027-07-04');
    expect(observedHoliday('2026-04-16', 'federal')).toBe('2026-04-16'); // Thursday
  });

  it('reproduces the shipped 2025 and 2026 holiday lists exactly (tax year + following year)', () => {
    expect(legalHolidaysForTaxYear(2025)).toEqual(SHIPPED_2025_HOLIDAYS);
    expect(legalHolidaysForTaxYear(2026)).toEqual(SHIPPED_2026_HOLIDAYS);
    expect(federalLegalHolidays(2027)).toEqual(SHIPPED_2026_HOLIDAYS.filter((d) => d.startsWith('2027')));
  });

  it('2028: New Year observed Fri Dec 31 2027, MLK Jan 17, Emancipation Day (Sunday Apr 16) observed Mon Apr 17, Veterans Day (Saturday) observed Fri Nov 10', () => {
    const h = federalLegalHolidays(2028);
    expect(h).toEqual(['2028-01-17', '2028-02-21', '2028-04-17', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-10-09', '2028-11-10', '2028-11-23', '2028-12-25']);
    expect(legalHolidaysForTaxYear(2027)).toContain('2027-12-31');
    expect(legalHolidaysForTaxYear(2027)).not.toContain('2028-01-01');
  });

  it('Inauguration Day: January 20 of every fourth year after 1965, Sunday → Monday only', () => {
    expect(federalLegalHolidays(2025)).toContain('2025-01-20'); // coincides with MLK Day (listed once)
    expect(federalLegalHolidays(2025).filter((d) => d === '2025-01-20')).toHaveLength(1);
    expect(federalLegalHolidays(2029)).toContain('2029-01-20'); // a Saturday: not moved to Friday (6103(c))
    expect(federalLegalHolidays(2029)).not.toContain('2029-01-19');
    expect(federalLegalHolidays(2030)).not.toContain('2030-01-20');
  });
});

describe('R6-01 statutory roll: deriveFederalDates', () => {
  it('every rollsWithYear key has a roll rule whose shape matches its type', () => {
    for (const def of PARAMETER_REGISTRY) {
      if (!def.rollsWithYear) { expect(def.roll).toBeUndefined(); continue; }
      expect(def.roll, def.key).toBeDefined();
      if (def.roll!.kind === 'statutory') expect(def.roll!.dates.length).toBe(def.type === 'date' ? 1 : 4);
      else expect(def.key).toBe('holidays');
    }
    expect(federalStatutoryMonthDays('installments.due_dates')).toEqual(['04-15', '06-15', '09-15', '01-15']);
    expect(federalStatutoryMonthDays('farmer.file_by_date')).toEqual(['03-01']);
    expect(federalStatutoryMonthDays('holidays')).toEqual([]);
  });

  it('TY2025 and TY2026 equal the shipped seed dates (observed dates computed from the statute)', () => {
    const d25 = deriveFederalDates(2025);
    expect(d25.get('installments.due_dates')).toEqual(['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15']); // June 15, 2025 is a Sunday
    expect(d25.get('installments.q4_file_and_pay_date')).toBe('2026-02-02'); // Jan 31, 2026 is a Saturday
    expect(d25.get('return_due_date')).toBe('2026-04-15');
    expect(d25.get('farmer.single_due_date')).toBe('2026-01-15');
    expect(d25.get('farmer.file_by_date')).toBe('2026-03-02'); // Mar 1, 2026 is a Sunday
    expect(d25.get('holidays')).toEqual(SHIPPED_2025_HOLIDAYS);
    const d26 = deriveFederalDates(2026);
    expect(d26.get('installments.due_dates')).toEqual(['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']);
    expect(d26.get('installments.q4_file_and_pay_date')).toBe('2027-02-01'); // Jan 31, 2027 is a Sunday
    expect(d26.get('return_due_date')).toBe('2027-04-15');
    expect(d26.get('farmer.single_due_date')).toBe('2027-01-15');
    expect(d26.get('farmer.file_by_date')).toBe('2027-03-01');
    expect(d26.get('holidays')).toEqual(SHIPPED_2026_HOLIDAYS);
    expect([...d26.keys()].sort()).toEqual(['farmer.file_by_date', 'farmer.single_due_date', 'holidays', 'installments.due_dates', 'installments.q4_file_and_pay_date', 'return_due_date']);
  });

  it('TY2027 (hand-checked): Q4 due Tue Jan 18 2028 (Sat 15 → Mon 17 is MLK Day), Q4 file-and-pay Mon Jan 31, return due Tue Apr 18 (Sat 15; Mon 17 is observed Emancipation Day)', () => {
    const d = deriveFederalDates(2027);
    expect(d.get('installments.due_dates')).toEqual(['2027-04-15', '2027-06-15', '2027-09-15', '2028-01-18']);
    expect(d.get('installments.q4_file_and_pay_date')).toBe('2028-01-31');
    expect(d.get('return_due_date')).toBe('2028-04-18');
    expect(d.get('farmer.single_due_date')).toBe('2028-01-18');
    expect(d.get('farmer.file_by_date')).toBe('2028-03-01'); // Wednesday
    expect(d.get('holidays')).toEqual([...federalLegalHolidays(2027), ...federalLegalHolidays(2028)]);
  });

  it('statutoryDatesForYear lands on the next business day under the given calendar', () => {
    expect(statutoryDatesForYear([{ monthDay: '04-15', yearOffset: 1 }], 2027, ['2028-04-17'])).toEqual(['2028-04-18']);
    expect(statutoryDatesForYear([{ monthDay: '04-15', yearOffset: 1 }], 2027, [])).toEqual(['2028-04-17']);
  });
});

// Shipped MO / AR state holiday lists (state-rules seeds MO.ts / AR.ts).
const MO_2025 = ['2025-01-01', '2025-01-20', '2025-02-12', '2025-02-17', '2025-05-08', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-05-08', '2026-05-25', '2026-06-19', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'];
const MO_2026 = ['2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-05-08', '2026-05-25', '2026-06-19', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-12', '2027-02-15', '2027-05-08', '2027-05-31', '2027-06-19', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-25'];
const AR_2025 = ['2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-07-04', '2025-09-01', '2025-11-11', '2025-11-27', '2025-12-24', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-11', '2026-11-26', '2026-12-24', '2026-12-25'];
const AR_2026 = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-11', '2026-11-26', '2026-12-24', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-07-05', '2027-09-06', '2027-11-11', '2027-11-25', '2027-12-24'];

describe('R6-01 state roll inferred from the prior list', () => {
  it('reads the weekend observance a list follows', () => {
    expect(inferHolidayObservance(MO_2025)).toBe('sunday_to_monday'); // RSMo §9.010: Saturday Jul 4, 2026 kept
    expect(inferHolidayObservance(AR_2025)).toBe('federal'); // AR Policy 52: Saturday Jul 4, 2026 → Fri Jul 3
    expect(inferHolidayObservance(['2027-07-04'])).toBe('none'); // a Sunday listed as is
    expect(inferHolidayObservance([])).toBe('sunday_to_monday');
  });

  it('matches floating and fixed federal rules, keeps state-specific days as fixed month-days', () => {
    const ids = inferHolidayRules(MO_2025).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['new_years_day', 'mlk_day', 'fixed:02-12', 'washingtons_birthday', 'fixed:05-08', 'memorial_day', 'juneteenth', 'independence_day', 'labor_day', 'columbus_day', 'veterans_day', 'thanksgiving', 'christmas']));
    expect(ids).not.toContain('inauguration_day'); // Jan 20, 2025 is matched as MLK Day (floating first)
    expect(ids).not.toContain('dc_emancipation_day');
    expect(inferHolidayRules(AR_2025).map((r) => r.id)).toContain('fixed:12-24');
  });

  it('regenerates the shipped MO 2026 list from the MO 2025 list (Sunday Jul 4, 2027 → Jul 5; Saturdays kept)', () => {
    expect(rollHolidayList(MO_2025, 2026)).toEqual(MO_2026);
  });

  it('regenerates the shipped AR 2026 list from AR 2025, plus the Saturday New Year 2028 observed on Fri Dec 31, 2027 that the seed omits', () => {
    // AR Policy 52 item 6 moves a Saturday holiday to the preceding Friday; the shipped list is framed by holiday year and leaves 2027-12-31 out.
    expect(rollHolidayList(AR_2025, 2026)).toEqual([...AR_2026, '2027-12-31']);
    expect(rollHolidayList([], 2026)).toEqual([]);
  });

  it('inferStatutoryDate un-bumps an observed date to the statutory day', () => {
    expect(inferStatutoryDate('2025-06-16', [], ['06-15'])).toBe('2025-06-15'); // Monday after Sunday the 15th
    expect(inferStatutoryDate('2026-02-02', [], ['01-31'])).toBe('2026-01-31'); // Monday after Saturday the 31st
    expect(inferStatutoryDate('2026-03-02', [], ['03-01'])).toBe('2026-03-01');
    expect(inferStatutoryDate('2026-02-17', AR_2025)).toBe('2026-02-15'); // Sun 15, Mon 16 (Presidents' Day) → 15th is the one statutory day
    expect(inferStatutoryDate('2026-03-16', AR_2025)).toBe('2026-03-15');
    expect(inferStatutoryDate('2026-04-15', [])).toBe('2026-04-15'); // a business day stands for itself
    expect(inferStatutoryDate('2026-02-02', [])).toBe('2026-02-02'); // Jan 31 (last day) and Feb 1 both statutory → keep the stored date
  });

  it('rollObservedDate reproduces the shipped MO and AR 2026 dates from the 2025 rows', () => {
    const moHol = rollHolidayList(MO_2025, 2026);
    const due = ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'].map((d) => rollObservedDate(d, MO_2025, 2025, 2026, moHol, federalStatutoryMonthDays('installments.due_dates')));
    expect(due).toEqual(['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']);
    expect(rollObservedDate('2026-02-02', MO_2025, 2025, 2026, moHol, ['01-31'])).toBe('2027-02-01');
    expect(rollObservedDate('2026-04-15', MO_2025, 2025, 2026, moHol, ['04-15'])).toBe('2027-04-15');
    expect(rollObservedDate('2026-03-02', MO_2025, 2025, 2026, moHol, ['03-01'])).toBe('2027-03-01');
    const arHol = rollHolidayList(AR_2025, 2026);
    expect(rollObservedDate('2026-02-17', AR_2025, 2025, 2026, arHol, ['01-15'])).toBe('2027-02-16'); // Mon Feb 15, 2027 is Presidents' Day
    expect(rollObservedDate('2026-03-16', AR_2025, 2025, 2026, arHol, ['03-01'])).toBe('2027-03-15');
  });
});
