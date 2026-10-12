// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { rollDateToYear, nextBusinessDay, daysBetween, addDays, daysInYear, yearOf, monthDayInYear, monthsOrFraction, isIsoDate } from './dates.js';

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
