// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-164 (feed-exact-v1): exact Bank Feed split math, no database.
//   - percentage splits: largest remainder in cents, equal remainders by
//     line order, exactly 100 or 400 SPLITS_DONT_BALANCE;
//   - fixed splits: cents half away from zero, must add up to |amount|;
//   - an amount with more than 2 decimals can't be split (AMOUNT_NOT_CENTS);
//   - 12-digit amounts stay exact.

import { describe, it, expect } from 'vitest';
import { percentsTotalExactly100 } from '@kis-books/shared';
import { computeSplitLines, type StagedSplitsConfig } from './bank-feed-splits.js';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';

function pct(...percents: Array<number | string>): StagedSplitsConfig {
  const ids = [A, B, C, A, B, C];
  return { kind: 'percentage', splits: percents.map((percent, i) => ({ accountId: ids[i]!, percent, tagId: null, memo: null })) };
}
function fixed(...amounts: string[]): StagedSplitsConfig {
  const ids = [A, B, C, A, B, C];
  return { kind: 'fixed', splits: amounts.map((amount, i) => ({ accountId: ids[i]!, amount, tagId: null, memo: null })) };
}
const amounts = (lines: ReturnType<typeof computeSplitLines>) => lines.map((l) => l.amount.toFixed(2));

function codeOf(fn: () => unknown): { code?: string; details?: Record<string, unknown> } {
  try { fn(); } catch (e) { return e as { code?: string; details?: Record<string, unknown> }; }
  throw new Error('expected a throw');
}

describe('percentage splits (largest remainder, ties by line order)', () => {
  it('100.00 three ways is 33.34 / 33.33 / 33.33 (the odd cent goes to the largest remainder)', () => {
    expect(amounts(computeSplitLines('100.0000', pct(33.334, 33.333, 33.333)))).toEqual(['33.34', '33.33', '33.33']);
    expect(amounts(computeSplitLines('100.0000', pct(33.333, 33.333, 33.334)))).toEqual(['33.33', '33.33', '33.34']);
    // Thirds to 47 places: the last line carries the extra digit, so it has the largest remainder.
    const third = '33.' + '3'.repeat(47);
    const last = '33.' + '3'.repeat(46) + '4';
    expect(amounts(computeSplitLines('100.0000', pct(third, third, last)))).toEqual(['33.33', '33.33', '33.34']);
  });

  it('equal remainders go to earlier lines first', () => {
    // 0.02 at 25 / 25 / 50: shares 0.5, 0.5, 1 cent; one cent left, line 1 wins the tie with line 2.
    const tie = computeSplitLines('0.02', pct(25, 25, 50));
    expect(tie.map((l) => [l.accountId, l.amount.toFixed(2)])).toEqual([[A, '0.01'], [C, '0.01']]);
    // 1.00 four ways at 25% each: no remainder at all.
    expect(amounts(computeSplitLines('1.00', pct(25, 25, 25, 25)))).toEqual(['0.25', '0.25', '0.25', '0.25']);
    // 0.03 at 50 / 50: 1.5 cents each, the first line gets the odd cent.
    expect(amounts(computeSplitLines('0.03', pct(50, 50)))).toEqual(['0.02', '0.01']);
  });

  it('the largest remainder wins over line order', () => {
    // 10.00 at 33.3 / 33.3 / 33.4: shares 333.0, 333.0, 334.0 cents, exact.
    expect(amounts(computeSplitLines('10.00', pct(33.3, 33.3, 33.4)))).toEqual(['3.33', '3.33', '3.34']);
    // 0.10 at 10 / 45 / 45: shares 1.0, 4.5, 4.5 cents: lines 2 and 3 tie on .5, one cent left, line 2 gets it.
    expect(amounts(computeSplitLines('0.10', pct(10, 45, 45)))).toEqual(['0.01', '0.05', '0.04']);
    // 0.07 at 60 / 40: shares 4.2 / 2.8 cents: the 0.8 remainder gets the cent.
    expect(amounts(computeSplitLines('0.07', pct(60, 40)))).toEqual(['0.04', '0.03']);
  });

  it('a 0.01 item split three ways posts one line; 0.00 lines are left off', () => {
    const lines = computeSplitLines('0.0100', pct('33.33', '33.33', '33.34'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.accountId).toBe(C);
    expect(lines[0]!.amount.toFixed(2)).toBe('0.01');
  });

  it('a deposit (negative amount) splits by its absolute value', () => {
    expect(amounts(computeSplitLines('-100.0000', pct('33.33', '33.33', '33.34')))).toEqual(['33.33', '33.33', '33.34']);
  });

  it('percentages must total exactly 100 as decimals', () => {
    const e = codeOf(() => computeSplitLines('100.00', pct('33.33', '33.33', '33.33')));
    expect(e.code).toBe('SPLITS_DONT_BALANCE');
    expect(e.details).toEqual({ kind: 'percentage', percentTotal: '99.99' });
    expect(codeOf(() => computeSplitLines('100.00', pct(33.333, 33.333, 33.333))).code).toBe('SPLITS_DONT_BALANCE');
    expect(codeOf(() => computeSplitLines('100.00', pct(60, 50))).code).toBe('SPLITS_DONT_BALANCE');
    // 0.1 + 0.2 is not 0.3 in floats; as decimals the total is exact.
    expect(amounts(computeSplitLines('10.00', pct(0.1, 0.2, 99.7)))).toEqual(['0.01', '0.02', '9.97']);
  });

  it('a 12-digit amount stays exact', () => {
    const lines = computeSplitLines('999999999999.99', pct('33.33', '33.33', '33.34'));
    // 99999999999999 cents x 33.33% = 33329999999999.6667 -> floor 33329999999999 (remainder .6667)
    // x 33.34% = 33339999999999.6666 -> floor (remainder .6666); 2 cents left: lines 1 and 2 (largest).
    expect(amounts(lines)).toEqual(['333300000000.00', '333300000000.00', '333399999999.99']);
    const sum = lines.reduce((s, l) => s.plus(l.amount), lines[0]!.amount.minus(lines[0]!.amount));
    expect(sum.toFixed(2)).toBe('999999999999.99');
  });

  it('always hands out every cent', () => {
    for (const total of ['1', '7', '101', '99999', '100000000000001']) {
      const lines = computeSplitLines(`${total}.00`, pct('12.5', '37.5', '50'));
      expect(lines.reduce((s, l) => s.plus(l.amount), lines[0]!.amount.minus(lines[0]!.amount)).toFixed(2)).toBe(total + '.00');
    }
  });
});

describe('fixed splits', () => {
  it('lines that add up post exactly', () => {
    expect(amounts(computeSplitLines('84.1700', fixed('50.00', '34.17')))).toEqual(['50.00', '34.17']);
  });

  it('50 + 30 against 84.17 is 400 SPLITS_DONT_BALANCE with the difference', () => {
    const e = codeOf(() => computeSplitLines('84.17', fixed('50.00', '30.00')));
    expect(e.code).toBe('SPLITS_DONT_BALANCE');
    expect(e.details).toEqual({ kind: 'fixed', difference: '4.17', splitTotal: '80.00', amount: '84.17' });
    // Too much: the difference is negative.
    expect(codeOf(() => computeSplitLines('10.00', fixed('6.00', '4.01'))).details?.['difference']).toBe('-0.01');
  });

  it('4-decimal rule amounts round to cents half away from zero, then must add up', () => {
    expect(amounts(computeSplitLines('100.00', fixed('33.3333', '66.6667')))).toEqual(['33.33', '66.67']);
    // 33.335 -> 33.34, 66.665 -> 66.67: 100.01 does not add up.
    expect(codeOf(() => computeSplitLines('100.00', fixed('33.335', '66.665'))).code).toBe('SPLITS_DONT_BALANCE');
    // Half away from zero on a negative line: -0.005 -> -0.01.
    expect(amounts(computeSplitLines('10.00', fixed('10.005', '-0.005')))).toEqual(['10.01', '-0.01']);
  });

  it('a negative line stays signed (posted on the other side)', () => {
    const lines = computeSplitLines('100.00', fixed('120.00', '-20.00'));
    expect(amounts(lines)).toEqual(['120.00', '-20.00']);
  });

  it('a 12-digit fixed split is exact', () => {
    expect(amounts(computeSplitLines('999999999999.99', fixed('999999999999.98', '0.01'))))
      .toEqual(['999999999999.98', '0.01']);
  });
});

describe('amounts with more than 2 decimals', () => {
  it('cannot be split (400 AMOUNT_NOT_CENTS)', () => {
    const e = codeOf(() => computeSplitLines('12.3456', fixed('12.34', '0.0056')));
    expect(e.code).toBe('AMOUNT_NOT_CENTS');
    expect(e.details).toEqual({ amount: '12.3456' });
    expect(codeOf(() => computeSplitLines('-0.0050', pct(50, 50))).code).toBe('AMOUNT_NOT_CENTS');
  });

  it('trailing zeros are whole cents', () => {
    expect(amounts(computeSplitLines('12.3400', fixed('12.00', '0.34')))).toEqual(['12.00', '0.34']);
  });
});

describe('percentsTotalExactly100 (rule create/update)', () => {
  it('reads each number as the decimal it prints as', () => {
    expect(percentsTotalExactly100([33.33, 33.33, 33.34])).toBe(true);
    expect(percentsTotalExactly100([0.1, 0.2, 99.7])).toBe(true);
    expect(percentsTotalExactly100([50, 50])).toBe(true);
    expect(percentsTotalExactly100([33.333, 33.333, 33.333])).toBe(false);
    expect(percentsTotalExactly100([33.33, 33.33, 33.33])).toBe(false);
    expect(percentsTotalExactly100([100 / 3, 100 / 3, 100 / 3])).toBe(false);
    expect(percentsTotalExactly100([1e-7, 100])).toBe(false);
  });
});
