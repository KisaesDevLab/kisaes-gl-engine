// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Monthly Breakdown must show a column for EVERY month in the selected
// range — it used to show only the last 6 months ending at end_date,
// whatever the start date was.

import { describe, it, expect } from 'vitest';
import { getRangePeriods } from './report-comparison.service.js';

describe('getRangePeriods', () => {
  it('returns one column per month for a full year', () => {
    const r = getRangePeriods('2026-01-01', '2026-12-31', 'month');
    expect(r).toHaveLength(12);
    expect(r[0]).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31', label: 'Jan 2026' });
    expect(r[1]!.endDate).toBe('2026-02-28');
    expect(r[11]).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31', label: 'Dec 2026' });
  });

  it('clips the first and last months to the range so the total matches the range', () => {
    const r = getRangePeriods('2026-03-15', '2026-10-15', 'month');
    expect(r.map((p) => p.label)).toEqual([
      'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026',
    ]);
    expect(r[0]!.startDate).toBe('2026-03-15');
    expect(r[7]!.endDate).toBe('2026-10-15');
  });

  it('spans a year boundary', () => {
    const r = getRangePeriods('2025-11-01', '2026-02-28', 'month');
    expect(r.map((p) => p.label)).toEqual(['Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026']);
  });

  it('returns a single column for a one-month range', () => {
    expect(getRangePeriods('2026-05-01', '2026-05-31', 'month')).toHaveLength(1);
  });

  it('caps very long ranges at the most recent 60 months', () => {
    const r = getRangePeriods('2010-01-01', '2026-12-31', 'month');
    expect(r).toHaveLength(60);
    expect(r[59]!.label).toBe('Dec 2026');
    expect(r[0]!.label).toBe('Jan 2022');
  });

  it('builds calendar quarters', () => {
    const r = getRangePeriods('2026-02-10', '2026-12-31', 'quarter');
    expect(r.map((p) => [p.startDate, p.endDate])).toEqual([
      ['2026-02-10', '2026-03-31'], ['2026-04-01', '2026-06-30'],
      ['2026-07-01', '2026-09-30'], ['2026-10-01', '2026-12-31'],
    ]);
  });
});
