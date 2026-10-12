// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  dec, dAdd, dSub, dMul, dDiv, dCmp, dMin, dMax, dNeg, dAbs, dIsNeg, dIsZero, dIsPos, dSum,
  dRound, dRoundDollars, dRoundRate, dFloorZero, dClamp, percentToFraction, ZERO, ONE,
} from './decimal.js';

describe('dec (normalise)', () => {
  it('normalises strings and numbers', () => {
    expect(dec('0')).toBe('0');
    expect(dec('-0')).toBe('0');
    expect(dec('00123.4500')).toBe('123.45');
    expect(dec('.5')).toBe('0.5');
    expect(dec('-.5')).toBe('-0.5');
    expect(dec(0.9235)).toBe('0.9235');
    expect(dec(184500)).toBe('184500');
    expect(dec('1e3')).toBe('1000');
    expect(dec('1.5E-3')).toBe('0.0015');
  });
  it('rejects garbage and non-finite numbers', () => {
    expect(() => dec('abc')).toThrow();
    expect(() => dec('')).toThrow();
    expect(() => dec(Number.NaN)).toThrow();
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow();
  });
  it('exposes ZERO and ONE', () => {
    expect(ZERO).toBe('0');
    expect(ONE).toBe('1');
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(dAdd('0.1', '0.2')).toBe('0.3');
    expect(dSub('1', '0.9999')).toBe('0.0001');
    expect(dAdd('-5', '5')).toBe('0');
    expect(dSum(['1.25', '2.75', '-4'])).toBe('0');
  });
  it('multiplies exactly', () => {
    expect(dMul('128000', '0.9235')).toBe('118208');
    expect(dMul('118208', '0.029')).toBe('3428.032');
    expect(dMul('-2', '3.5')).toBe('-7');
    expect(dMul('0.25', '0')).toBe('0');
  });
  it('divides to 12 places, half-up, and handles signs', () => {
    expect(dDiv('1', '4')).toBe('0.25');
    expect(dDiv('0.25', '1.25')).toBe('0.2');
    expect(dDiv('1', '3')).toBe('0.333333333333');
    expect(dDiv('2', '3')).toBe('0.666666666667');
    expect(dDiv('-1', '3')).toBe('-0.333333333333');
    expect(dDiv('100', '8')).toBe('12.5');
    expect(() => dDiv('1', '0')).toThrow();
  });
  it('compares', () => {
    expect(dCmp('1.0', '1')).toBe(0);
    expect(dCmp('-1', '1')).toBe(-1);
    expect(dCmp('2', '1.99999')).toBe(1);
    expect(dMin('3', '2.5')).toBe('2.5');
    expect(dMax('3', '2.5')).toBe('3');
    expect(dMin('1', '2', '0.5')).toBe('0.5');
    expect(dMax('1', '2', '0.5')).toBe('2');
  });
  it('sign helpers', () => {
    expect(dNeg('5')).toBe('-5');
    expect(dNeg('-5')).toBe('5');
    expect(dNeg('0')).toBe('0');
    expect(dAbs('-5.5')).toBe('5.5');
    expect(dIsNeg('-0.0001')).toBe(true);
    expect(dIsNeg('0')).toBe(false);
    expect(dIsZero('0.000')).toBe(true);
    expect(dIsPos('0.01')).toBe(true);
    expect(dFloorZero('-3')).toBe('0');
    expect(dFloorZero('3')).toBe('3');
    expect(dClamp('5', '0', '3')).toBe('3');
    expect(dClamp('-5', '0', '3')).toBe('0');
    expect(dClamp('2', '0', '3')).toBe('2');
  });
});

describe('rounding', () => {
  it('rounds half-up (away from zero) to whole dollars', () => {
    expect(dRoundDollars('18085.824')).toBe('18086');
    expect(dRoundDollars('9042.912')).toBe('9043');
    expect(dRoundDollars('2.5')).toBe('3');
    expect(dRoundDollars('2.4999')).toBe('2');
    expect(dRoundDollars('-2.5')).toBe('-3');
    expect(dRoundDollars('-2.4')).toBe('-2');
    expect(dRoundDollars('240711.5')).toBe('240712');
    expect(dRoundDollars('0')).toBe('0');
    expect(dRoundDollars('-0.4')).toBe('0');
  });
  it('rounds to n places', () => {
    expect(dRound('1.23456', 2)).toBe('1.23');
    expect(dRound('1.235', 2)).toBe('1.24');
    expect(dRound('1.2', 4)).toBe('1.2');
    expect(dRound('-1.005', 2)).toBe('-1.01');
    expect(dRoundRate('0.1437632')).toBe('0.143763');
  });
});

describe('percentToFraction', () => {
  it('converts a 0-100 percent to a fraction', () => {
    expect(percentToFraction(50)).toBe('0.5');
    expect(percentToFraction('33.3333')).toBe('0.333333');
    expect(percentToFraction(100)).toBe('1');
    expect(percentToFraction(null)).toBe('0');
  });
});
