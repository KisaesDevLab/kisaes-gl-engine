// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { isCreditCardType, mapSignedCentsToFeed, centsToAmountString } from './statement-map.js';

describe('isCreditCardType', () => {
  it('treats CREDITCARD and LINEOFCREDIT as inverted-sign accounts', () => {
    expect(isCreditCardType('CREDITCARD')).toBe(true);
    expect(isCreditCardType('LINEOFCREDIT')).toBe(true);
    expect(isCreditCardType('CHECKING')).toBe(false);
    expect(isCreditCardType(null)).toBe(false);
    expect(isCreditCardType(undefined)).toBe(false);
  });
});

describe('mapSignedCentsToFeed — bank convention (out negative)', () => {
  it('maps money out → debit (spend)', () => {
    expect(mapSignedCentsToFeed(-42_50, false)).toEqual({ amount: '42.50', type: 'debit' });
  });
  it('maps money in → credit (deposit)', () => {
    expect(mapSignedCentsToFeed(1_000_00, false)).toEqual({ amount: '1000.00', type: 'credit' });
  });
});

describe('mapSignedCentsToFeed — credit-card convention (charge positive)', () => {
  it('maps a charge (positive) → debit (spend)', () => {
    expect(mapSignedCentsToFeed(42_50, true)).toEqual({ amount: '42.50', type: 'debit' });
  });
  it('maps a payment (negative) → credit', () => {
    expect(mapSignedCentsToFeed(-200_00, true)).toEqual({ amount: '200.00', type: 'credit' });
  });
});

describe('centsToAmountString', () => {
  it('formats absolute magnitude with 2 decimals', () => {
    expect(centsToAmountString(-1_234_56)).toBe('1234.56');
    expect(centsToAmountString(0)).toBe('0.00');
  });
});
