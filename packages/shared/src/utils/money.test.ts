// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Pure-function tests for the shared money helpers. These back the
// decimal(19,4) invariant from CLAUDE.md rule #11 — every minor-unit
// conversion is scaled by 10,000 (not 100) so the round-trip preserves
// the four decimal places used for tax-rate math and fractional
// currencies. A drift here would silently corrupt ledger totals.

import { describe, it, expect } from 'vitest';
import {
  toMinorUnits, fromMinorUnits, formatCurrency, addDecimal, subtractDecimal,
} from './money.js';

describe('toMinorUnits / fromMinorUnits', () => {
  it('scales by 10,000 to preserve decimal(19,4)', () => {
    expect(toMinorUnits(10.50)).toBe(105000);
    expect(toMinorUnits('10.50')).toBe(105000);
    expect(fromMinorUnits(105000)).toBe(10.5);
  });

  it('round-trips common ledger values exactly', () => {
    for (const v of [0, 0.01, 1, 42.5, 1500.00, 999999.9999]) {
      expect(fromMinorUnits(toMinorUnits(v))).toBeCloseTo(v, 4);
    }
  });

  it('rounds at the 4th decimal place', () => {
    expect(toMinorUnits(0.00005)).toBe(1);
    expect(toMinorUnits(0.00004)).toBe(0);
  });

  it('accepts string input the way Postgres numeric hands it back', () => {
    expect(toMinorUnits('0.0001')).toBe(1);
    expect(toMinorUnits('0')).toBe(0);
  });
});

describe('addDecimal / subtractDecimal', () => {
  it('avoids float drift on the classic 0.1 + 0.2 case', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3000');
  });

  it('handles negative results', () => {
    expect(subtractDecimal('10.00', '25.50')).toBe('-15.5000');
  });

  it('is associative on values that would lose precision in float', () => {
    const a = addDecimal('0.1', '0.2');
    const b = addDecimal(a, '0.3');
    expect(b).toBe('0.6000');
  });

  it('returns values with exactly 4 decimal places', () => {
    expect(addDecimal('1', '2')).toBe('3.0000');
    expect(subtractDecimal('10', '5')).toBe('5.0000');
  });
});

describe('formatCurrency', () => {
  it('formats USD with two decimals by default', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
    expect(formatCurrency('0')).toBe('$0.00');
  });

  it('honors the currency argument', () => {
    const eur = formatCurrency(1000, 'EUR', 'en-US');
    // Intl output varies across ICU versions, but the amount must round-trip.
    expect(eur).toMatch(/1,000\.00/);
    expect(eur).toMatch(/€|EUR/);
  });
});
