// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { matchByName, normalizeForMatch, normalizeLoose, stripLeadingNumericToken } from './ai-name-match.js';

const accounts = [
  { id: '1', name: 'Office Supplies' },
  { id: '2', name: 'Utilities - Electric' },
  { id: '3', name: 'Meals & Entertainment' },
];

describe('matchByName', () => {
  it('matches exactly', () => {
    expect(matchByName(accounts, (a) => a.name, 'Office Supplies')?.id).toBe('1');
  });

  it('matches case- and whitespace-insensitively (canonical tier)', () => {
    expect(matchByName(accounts, (a) => a.name, '  office   supplies ')?.id).toBe('1');
  });

  it('matches across punctuation differences (loose tier)', () => {
    expect(matchByName(accounts, (a) => a.name, 'Utilities Electric')?.id).toBe('2');
    expect(matchByName(accounts, (a) => a.name, 'meals and entertainment')).toBeUndefined(); // "and" != "&", genuinely different tokens
    expect(matchByName(accounts, (a) => a.name, 'Meals  &  Entertainment')?.id).toBe('3');
  });

  it('returns undefined for blank or unmatched targets', () => {
    expect(matchByName(accounts, (a) => a.name, '')).toBeUndefined();
    expect(matchByName(accounts, (a) => a.name, null)).toBeUndefined();
    expect(matchByName(accounts, (a) => a.name, 'Rent Expense')).toBeUndefined();
  });

  it('strips a leading account-number token the model echoed (FIX 1 fallback)', () => {
    // "6100 Office Supplies" / "6100-Office Supplies" — the digits used to
    // defeat the loose match; now stripped before matching.
    expect(matchByName(accounts, (a) => a.name, '6100 Office Supplies')?.id).toBe('1');
    expect(matchByName(accounts, (a) => a.name, '6100-Office Supplies')?.id).toBe('1');
    expect(matchByName(accounts, (a) => a.name, '#5200 Utilities - Electric')?.id).toBe('2');
  });

  it('recovers a partial name via the guarded unique-substring tier', () => {
    // "Office" is a subset of exactly one account name → match. This is the
    // partial-name recovery FIX 1 wants; the guard below prevents false hits.
    expect(matchByName(accounts, (a) => a.name, 'Office')?.id).toBe('1');
    expect(matchByName(accounts, (a) => a.name, 'Supplies')?.id).toBe('1');
  });

  it('unique-substring tier stays ambiguity-safe (>1 candidate → no match)', () => {
    const ambiguous = [
      { id: 'a', name: 'Office Supplies' },
      { id: 'b', name: 'Office Rent' },
    ];
    // "Office" is a subset of BOTH → ambiguous → no match, never a coin flip.
    expect(matchByName(ambiguous, (a) => a.name, 'Office')).toBeUndefined();
    // A token in neither still misses.
    expect(matchByName(accounts, (a) => a.name, 'Rent Expense')).toBeUndefined();
    // Genuinely different token set ("and" vs "&") still misses.
    expect(matchByName(accounts, (a) => a.name, 'meals and entertainment')).toBeUndefined();
  });
});

describe('normalize helpers', () => {
  it('normalizeForMatch lowercases, trims, collapses whitespace', () => {
    expect(normalizeForMatch('  Foo   Bar ')).toBe('foo bar');
  });
  it('normalizeLoose strips punctuation', () => {
    expect(normalizeLoose('A/B - C!')).toBe('ab c');
  });
  it('stripLeadingNumericToken removes a leading number token only', () => {
    expect(stripLeadingNumericToken('6100 Office Supplies')).toBe('Office Supplies');
    expect(stripLeadingNumericToken('6100-Office Supplies')).toBe('Office Supplies');
    expect(stripLeadingNumericToken('#1099 Contractor')).toBe('Contractor');
    // A name that merely starts with digits (not a separated token) is intact.
    expect(stripLeadingNumericToken('401k Match')).toBe('401k Match');
    expect(stripLeadingNumericToken('Office Supplies')).toBe('Office Supplies');
  });
});
