// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { buildAccrualSchedule } from './accrual-schedule.js';

const sum = (lines: Array<{ amount: string }>) => lines.reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0) / 100;

describe('buildAccrualSchedule', () => {
  it('full month: equal amounts, the last absorbs rounding', () => {
    const s = buildAccrualSchedule({ totalAmount: '1000.00', startDate: '2026-01-15', months: 3, method: 'full_month' });
    expect(s.map((l) => l.periodStart)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(s.map((l) => l.amount)).toEqual(['333.33', '333.33', '333.34']);
    expect(sum(s)).toBe(1000);
  });

  it('mid month: half a month at each end, one extra calendar month', () => {
    const s = buildAccrualSchedule({ totalAmount: '1200', startDate: '2026-11-10', months: 12, method: 'mid_month' });
    expect(s).toHaveLength(13);
    expect(s[0]).toEqual({ periodStart: '2026-11-01', amount: '50.00' });
    expect(s[1]!.amount).toBe('100.00');
    expect(s[12]).toEqual({ periodStart: '2027-11-01', amount: '50.00' });
    expect(sum(s)).toBe(1200);
  });

  it('actual days: prorates the first month by days of service left', () => {
    // Service from April 16 → 15 of 30 days in April.
    const s = buildAccrualSchedule({ totalAmount: '600', startDate: '2026-04-16', months: 6, method: 'actual_days' });
    expect(s).toHaveLength(7);
    expect(s[0]!.amount).toBe('50.00');
    expect(s[6]!.amount).toBe('50.00');
    expect(sum(s)).toBe(600);
    // Starting on the 1st needs no extra month.
    expect(buildAccrualSchedule({ totalAmount: '600', startDate: '2026-04-01', months: 6, method: 'actual_days' })).toHaveLength(6);
  });

  it('never produces a negative month, even for tiny amounts', () => {
    const s = buildAccrualSchedule({ totalAmount: '0.05', startDate: '2026-01-01', months: 10, method: 'full_month' });
    expect(s.every((l) => Number(l.amount) >= 0)).toBe(true);
    expect(sum(s)).toBeCloseTo(0.05, 10);
  });

  it('rejects bad input', () => {
    expect(() => buildAccrualSchedule({ totalAmount: 0, startDate: '2026-01-01', months: 3, method: 'full_month' })).toThrow();
    expect(() => buildAccrualSchedule({ totalAmount: 10, startDate: '2026-01-01', months: 0, method: 'full_month' })).toThrow();
    expect(() => buildAccrualSchedule({ totalAmount: 10, startDate: '01/01/2026', months: 3, method: 'full_month' })).toThrow();
  });
});
