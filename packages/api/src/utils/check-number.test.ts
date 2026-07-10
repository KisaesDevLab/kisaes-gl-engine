// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { parseCheckNumber } from './check-number.js';

describe('parseCheckNumber', () => {
  it('parses the common bank renderings', () => {
    expect(parseCheckNumber('CHECK 1234')).toBe(1234);
    expect(parseCheckNumber('CHECK #1234')).toBe(1234);
    expect(parseCheckNumber('Check No. 1234')).toBe(1234);
    expect(parseCheckNumber('CHK 1234')).toBe(1234);
    expect(parseCheckNumber('CK 1234')).toBe(1234);
    expect(parseCheckNumber('DRAFT 1234')).toBe(1234);
    expect(parseCheckNumber('check number 1234')).toBe(1234);
  });

  it('strips leading zeros', () => {
    expect(parseCheckNumber('CHECK 0001005')).toBe(1005);
  });

  it('matches a bare #1234 token', () => {
    expect(parseCheckNumber('PAID #4567')).toBe(4567);
    expect(parseCheckNumber('#4567')).toBe(4567);
  });

  it('returns null when there is no check number', () => {
    expect(parseCheckNumber('POS PURCHASE WALMART')).toBeNull();
    expect(parseCheckNumber('ACH DEBIT ACME')).toBeNull();
    expect(parseCheckNumber('')).toBeNull();
    expect(parseCheckNumber(null)).toBeNull();
    expect(parseCheckNumber(undefined)).toBeNull();
  });

  it('does not treat "checkcard" as a check (debit-card purchases)', () => {
    // \b after "check" requires a boundary, so "CHECKCARD" doesn't match the
    // check prefix; and there's no bare # token here either.
    expect(parseCheckNumber('CHECKCARD 9999 STARBUCKS')).toBeNull();
  });

  it('rejects implausibly large numbers (account/card runs)', () => {
    expect(parseCheckNumber('CHECK 123456789012')).toBeNull();
  });
});
