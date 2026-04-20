// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Pure-function tests for check-amount spelling. The output is printed
// on paper checks, so regressions here corrupt issued instruments —
// worth over-testing the boundary cases (zero, hundreds/thousands
// carry, overflow guard).

import { describe, it, expect } from 'vitest';
import { numberToWords } from './number-to-words.js';

describe('numberToWords', () => {
  it('handles single-digit dollars', () => {
    expect(numberToWords(5.00)).toBe('Five and 00/100');
  });

  it('hyphenates twenty-one through ninety-nine', () => {
    expect(numberToWords(42.50)).toBe('Forty-Two and 50/100');
  });

  it('renders the hundreds carry without leaving stray "Zero"', () => {
    expect(numberToWords(100)).toBe('One Hundred and 00/100');
    expect(numberToWords(101)).toBe('One Hundred One and 00/100');
  });

  it('handles thousands and mixed groups', () => {
    expect(numberToWords(1500.00)).toBe('One Thousand Five Hundred and 00/100');
    expect(numberToWords(12345.67)).toBe('Twelve Thousand Three Hundred Forty-Five and 67/100');
  });

  it('spells zero dollars explicitly', () => {
    expect(numberToWords(0.99)).toBe('Zero and 99/100');
    expect(numberToWords(0)).toBe('Zero and 00/100');
  });

  it('refuses negative input and returns empty', () => {
    expect(numberToWords(-1)).toBe('');
  });

  it('refuses NaN and returns empty', () => {
    expect(numberToWords('not-a-number')).toBe('');
  });

  it('guards against amounts above 999,999,999.99', () => {
    expect(numberToWords(1_000_000_000)).toBe('Amount too large');
  });

  it('rounds cents to two decimals', () => {
    // Avoid the 0.005 boundary — JS floats represent 1.005 as
    // 1.0049999…, so checking exactly halfway is nondeterministic
    // across engines. Use 0.004 (definitely down) and 0.006
    // (definitely up) to exercise the rounding logic.
    expect(numberToWords(1.004)).toBe('One and 00/100');
    expect(numberToWords(1.006)).toBe('One and 01/100');
  });
});
