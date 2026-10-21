// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { nextRecurrenceDate } from './recurrence.js';

function series(start: string, frequency: string, interval: number, n: number, anchor: string | null = start): string[] {
  const out = [start];
  let d = start;
  for (let i = 1; i < n; i++) {
    d = nextRecurrenceDate(d, frequency, interval, anchor);
    out.push(d);
  }
  return out;
}

describe('nextRecurrenceDate', () => {
  it('monthly from Jan 31 keeps the month end for 14 months (leap and common years)', () => {
    expect(series('2027-01-31', 'monthly', 1, 15)).toEqual([
      '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30', '2027-07-31',
      '2027-08-31', '2027-09-30', '2027-10-31', '2027-11-30', '2027-12-31', '2028-01-31', '2028-02-29', '2028-03-31',
    ]);
    expect(series('2026-01-31', 'monthly', 1, 4)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('annual Feb 29 gives Feb 28 in common years and Feb 29 in leap years', () => {
    expect(series('2028-02-29', 'annually', 1, 6)).toEqual([
      '2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29', '2033-02-28',
    ]);
  });

  it('quarterly from May 31 and every 3 months', () => {
    expect(series('2026-05-31', 'quarterly', 1, 5)).toEqual(['2026-05-31', '2026-08-31', '2026-11-30', '2027-02-28', '2027-05-31']);
    expect(series('2026-01-31', 'monthly', 3, 4)).toEqual(['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
  });

  it('heals a date that drifted under the old arithmetic', () => {
    expect(nextRecurrenceDate('2026-03-03', 'monthly', 1, '2026-01-31')).toBe('2026-03-31');
    expect(nextRecurrenceDate('2026-02-10', 'monthly', 1, '2026-01-15')).toBe('2026-02-15');
  });

  it('without an anchor the date itself is the anchor', () => {
    expect(nextRecurrenceDate('2026-06-15', 'monthly', 1)).toBe('2026-07-15');
    expect(nextRecurrenceDate('2026-06-15', 'annually', 1)).toBe('2027-06-15');
    expect(nextRecurrenceDate('2026-06-15', 'nonsense', 1)).toBe('2026-07-15');
  });

  it('daily, weekly, biweekly and semimonthly are unchanged', () => {
    expect(nextRecurrenceDate('2026-06-15', 'daily', 3)).toBe('2026-06-18');
    expect(nextRecurrenceDate('2026-12-31', 'daily', 1)).toBe('2027-01-01');
    expect(nextRecurrenceDate('2026-06-15', 'weekly', 2)).toBe('2026-06-29');
    expect(nextRecurrenceDate('2026-06-25', 'biweekly', 1)).toBe('2026-07-09');
    expect(nextRecurrenceDate('2026-06-10', 'semimonthly', 9)).toBe('2026-06-15');
    expect(nextRecurrenceDate('2026-06-15', 'semimonthly', 1)).toBe('2026-07-01');
    expect(nextRecurrenceDate('2026-12-20', 'semimonthly', 1)).toBe('2027-01-01');
  });
});
