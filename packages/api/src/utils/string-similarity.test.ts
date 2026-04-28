// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { levenshtein, nameSimilarity, nameSimilarityFuzzy } from './string-similarity.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('returns length when one side is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts single-character substitution', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('counts single-character insertion', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
  });

  it('counts single-character deletion', () => {
    expect(levenshtein('cats', 'cat')).toBe(1);
  });

  it('handles transposition as two edits', () => {
    expect(levenshtein('ab', 'ba')).toBe(2);
  });

  it('is symmetric', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(levenshtein('sitting', 'kitten'));
  });
});

describe('nameSimilarity', () => {
  it('returns 1 for identical strings after normalization', () => {
    expect(nameSimilarity('Amazon', 'Amazon')).toBe(1);
  });

  it('returns 1 when normalization collapses both to the same form', () => {
    // Both run through cleanBankDescription's merchant map → 'Amazon'
    expect(nameSimilarity('AMZN MKTP US', 'amazon')).toBe(1);
  });

  it('returns close to 1 for one-character difference on a long name', () => {
    const sim = nameSimilarity('Acme Holdings LLC', 'Acme Holdngs LLC');
    expect(sim).toBeGreaterThan(0.9);
  });

  it('returns 0 for null or empty inputs', () => {
    expect(nameSimilarity(null, 'Amazon')).toBe(0);
    expect(nameSimilarity('Amazon', '')).toBe(0);
    expect(nameSimilarity(undefined, undefined)).toBe(0);
  });

  it('returns < 0.5 for entirely different names', () => {
    expect(nameSimilarity('Acme Industries', 'Globex Corp')).toBeLessThan(0.5);
  });

  it('is symmetric', () => {
    expect(nameSimilarity('Acme', 'Acme Inc')).toBeCloseTo(nameSimilarity('Acme Inc', 'Acme'), 5);
  });
});

describe('nameSimilarityFuzzy', () => {
  it('matches a window inside a longer descriptor', () => {
    // The customer name "Acme" should hit the window "acme" inside
    // "POS PURCHASE ACME LLC PAYMENT" via the substring scan, even
    // though direct levenshtein over the full strings would score low.
    const sim = nameSimilarityFuzzy('POS PURCHASE ACME LLC PAYMENT', 'Acme');
    expect(sim).toBeGreaterThan(0.7);
  });

  it('falls back to direct similarity when shorter is longer than longer', () => {
    const sim = nameSimilarityFuzzy('a', 'much longer string');
    // Doesn't blow up; produces some score.
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('returns 0 for empties', () => {
    expect(nameSimilarityFuzzy('', '')).toBe(0);
    expect(nameSimilarityFuzzy(null, 'name')).toBe(0);
  });
});
