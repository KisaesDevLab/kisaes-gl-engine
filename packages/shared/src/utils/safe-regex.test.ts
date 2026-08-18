// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { checkRegexSafety, compileSafeRegex } from './safe-regex.js';

describe('checkRegexSafety', () => {
  it('accepts ordinary rule patterns', () => {
    for (const p of ['^AMZN', 'walmart|target', 'check\\s*#?\\d+', '(?:visa|mc) purchase', '[A-Z]{2,4}-\\d+', 'a+b*c?', '(ab)+c', 'x{2,5}y', '.*amazon.*', '(?:visa|mc)? purchase']) {
      expect(checkRegexSafety(p), p).toEqual({ safe: true });
    }
  });
  it('rejects nested quantifiers, backreferences and huge patterns', () => {
    for (const p of ['(a+)+$', '(.*)*', '(\\w+\\s?)*$', '((ab)*)+', '(a|aa)+$', '(a+){2,}', '(x)\\1', 'a'.repeat(201)]) {
      expect(checkRegexSafety(p).safe, p).toBe(false);
    }
  });
  it('treats quantifier characters inside classes as literals', () => {
    expect(checkRegexSafety('[+*]+').safe).toBe(true);
    expect(checkRegexSafety('([+*])+').safe).toBe(true);
  });
  it('compileSafeRegex returns null for unsafe/invalid, a RegExp otherwise, and stays fast on evil input', () => {
    expect(compileSafeRegex('(a+)+$')).toBeNull();
    expect(compileSafeRegex('[')).toBeNull();
    const re = compileSafeRegex('^amazon')!;
    expect(re.test('AMAZON MKTPLACE')).toBe(true);
    expect(compileSafeRegex('a*a*a*b')).toBeNull(); // 3 unbounded quantifiers → cubic
    const start = Date.now();
    // The worst we allow (quadratic) over the capped haystack must be instant.
    compileSafeRegex('a*a*b')!.test('a'.repeat(200));
    expect(Date.now() - start).toBeLessThan(100);
  });
});
