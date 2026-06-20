// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { matchByName, normalizeForMatch, normalizeLoose } from './ai-name-match.js';

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

  it('does not false-match distinct names', () => {
    // "Office" alone must NOT match "Office Supplies" — no substring matching.
    expect(matchByName(accounts, (a) => a.name, 'Office')).toBeUndefined();
  });
});

describe('normalize helpers', () => {
  it('normalizeForMatch lowercases, trims, collapses whitespace', () => {
    expect(normalizeForMatch('  Foo   Bar ')).toBe('foo bar');
  });
  it('normalizeLoose strips punctuation', () => {
    expect(normalizeLoose('A/B - C!')).toBe('ab c');
  });
});
