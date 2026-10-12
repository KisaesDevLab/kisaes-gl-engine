// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { allocateAdjustment, splitActualsAndRemaining, splitCents, toCents, sumMonthly } from './allocation.js';

const base = { startMonth: 1, endMonth: 12 } as const;

describe('allocateAdjustment', () => {
  it('monthly puts the amount in every active month', () => {
    const m = allocateAdjustment({ ...base, amount: '100', cadence: 'monthly', startMonth: 4, endMonth: 6 }, 2026);
    expect(m).toEqual([0, 0, 0, 100, 100, 100, 0, 0, 0, 0, 0, 0]);
  });

  it('quarterly splits each quarter ÷3, never into the quarter-end month', () => {
    const m = allocateAdjustment({ ...base, amount: '300', cadence: 'quarterly' }, 2026);
    expect(m).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const odd = allocateAdjustment({ ...base, amount: '100', cadence: 'quarterly' }, 2026);
    expect(odd.slice(0, 3)).toEqual([33.34, 33.33, 33.33]);
    expect(sumMonthly(odd.slice(0, 3))).toBe(100);
  });

  it('quarterly respects a partial active range', () => {
    const m = allocateAdjustment({ amount: 300, cadence: 'quarterly', startMonth: 2, endMonth: 5 }, 2026);
    expect(m).toEqual([0, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('annual spreads the year total across the active range and is cent-exact', () => {
    const m = allocateAdjustment({ ...base, amount: '1000', cadence: 'annual' }, 2026);
    expect(m).toHaveLength(12);
    expect(sumMonthly(m)).toBe(1000);
    expect(m[0]).toBe(83.34);
    expect(m[11]).toBe(83.33);
    const ranged = allocateAdjustment({ amount: '900', cadence: 'annual', startMonth: 7, endMonth: 12 }, 2026);
    expect(ranged).toEqual([0, 0, 0, 0, 0, 0, 150, 150, 150, 150, 150, 150]);
  });

  it('one_time lands in the start month only', () => {
    const m = allocateAdjustment({ amount: '5000.25', cadence: 'one_time', startMonth: 12, endMonth: 12 }, 2026);
    expect(m[11]).toBe(5000.25);
    expect(sumMonthly(m)).toBe(5000.25);
  });

  it('keeps negative totals exact', () => {
    const m = allocateAdjustment({ ...base, amount: '-100', cadence: 'annual', startMonth: 1, endMonth: 3 }, 2026);
    expect(m.slice(0, 3)).toEqual([-33.34, -33.33, -33.33]);
    expect(sumMonthly(m)).toBe(-100);
  });

  it('GL-linked: actuals through the closed month, manual plan afterwards', () => {
    const m = allocateAdjustment(
      { ...base, amount: '100', cadence: 'monthly', glLinked: true }, 2026,
      { throughMonth: 3, glActuals: [10, 20, '30.50'] },
    );
    expect(m.slice(0, 4)).toEqual([10, 20, 30.5, 100]);
    expect(sumMonthly(m)).toBe(60.5 + 900);
  });

  it('GL-linked with no manual amount uses the actuals run-rate for remaining months', () => {
    const m = allocateAdjustment(
      { ...base, amount: null, cadence: 'monthly', glLinked: true }, 2026,
      { throughMonth: 2, glActuals: [100, 200] },
    );
    expect(m.slice(0, 3)).toEqual([100, 200, 150]);
    expect(m[11]).toBe(150);
  });

  it('R7-05: a non-recurring GL-linked adjustment with no manual amount is actuals only (never run-rated)', () => {
    // one-time 30,000 recovery in March, through September: no phantom 10,000 for Oct–Dec
    const actuals = [0, 0, 30000, 0, 0, 0, 0, 0, 0];
    const m = allocateAdjustment({ ...base, amount: null, cadence: 'monthly', glLinked: true, nonRecurring: true }, 2026, { throughMonth: 9, glActuals: actuals });
    expect(m.slice(9)).toEqual([0, 0, 0]);
    expect(sumMonthly(m)).toBe(30000);
  });

  it('R7-05: a non-recurring GL-linked adjustment with a plan keeps the plan for the remaining months', () => {
    const m = allocateAdjustment({ ...base, amount: '100', cadence: 'monthly', glLinked: true, nonRecurring: true }, 2026, { throughMonth: 2, glActuals: [500, 0] });
    expect(m.slice(0, 3)).toEqual([500, 0, 100]);
    expect(sumMonthly(m)).toBe(500 + 1000);
  });
});

describe('splitActualsAndRemaining', () => {
  it('returns YTD actuals, remaining and total', () => {
    const r = splitActualsAndRemaining(new Array(12).fill(10), 2, [1, 2]);
    expect(r.actualsYtd).toBe(3);
    expect(r.remaining).toBe(100);
    expect(r.total).toBe(103);
  });
  it('falls back to the plan when no actuals are supplied', () => {
    expect(splitActualsAndRemaining(new Array(12).fill(10), 6).total).toBe(120);
  });
});

describe('helpers', () => {
  it('splitCents distributes the remainder to the earliest parts', () => {
    expect(splitCents(10, 3)).toEqual([4, 3, 3]);
    expect(splitCents(0, 3)).toEqual([0, 0, 0]);
  });
  it('toCents parses decimal strings without float drift', () => {
    expect(toCents('0.1')).toBe(10);
    expect(toCents('1234.5678')).toBe(123457);
    expect(toCents('-2.005')).toBe(-201);
    expect(toCents(null)).toBe(0);
  });
});
