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
    // The worst we allow (quadratic; cubic only when ^-anchored) over the
    // capped haystack must be instant.
    compileSafeRegex('a*a*b')!.test('a'.repeat(200));
    compileSafeRegex('^a*a*a*b')!.test('a'.repeat(200));
    expect(Date.now() - start).toBeLessThan(150);
  });
  it('counts per alternative, ignores a trailing quantifier, allows one more when ^-anchored, and does not treat {n} as nesting', () => {
    // Real-world rule shapes that must pass.
    for (const p of ['.*amazon.*|.*amzn.*', '^AMZN.*MKTP.*US.*', 'CHECK\\s*#?\\s*\\d+', '\\$\\d{1,3}(,\\d{3})*(\\.\\d{2})?', '(\\d{3}){2}', 'a*|b*|c*|d*', '(?:ab)*c\\d+', '^\\s*x\\s*y\\s*z']) {
      expect(checkRegexSafety(p).safe, p).toBe(true);
    }
    // Still refused: too many overlapping unbounded quantifiers in ONE alternative.
    for (const p of ['\\w*\\w*\\w*x', 'a*a*a*b', '^a*a*a*a*b', '(\\d+){4}', '(a\\d+)b\\s*c\\s*d\\s*e', 'x\\s*y\\s*z\\s*w|q']) {
      expect(checkRegexSafety(p).safe, p).toBe(false);
    }
    // Nesting / alternation-in-repeat still refused.
    expect(checkRegexSafety('(\\d+)+').safe).toBe(false);
    expect(checkRegexSafety('(foo|bar)+').safe).toBe(false);
  });
});
