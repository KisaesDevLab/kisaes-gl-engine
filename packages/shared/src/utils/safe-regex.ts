// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Guard rails for USER-AUTHORED regular expressions (conditional-rule
 * `matches_regex` conditions). JavaScript's backtracking engine cannot be
 * interrupted, so a pattern like `(a+)+$` evaluated over a batch of bank
 * descriptions can pin the event loop for minutes (ReDoS). We refuse:
 *
 *   - patterns longer than MAX_PATTERN_LENGTH,
 *   - nested unbounded quantifiers ("star height" > 1): a `*`, `+` or
 *     `{n,}`/`{n,m}` applied to a group that itself contains a quantifier,
 *     e.g. `(a+)+`, `(.*)*`, `(\w+\s?)*`, `((ab)*)+`,
 *   - alternation inside a quantified group (`(a|aa)+`), which is
 *     exponential when branches overlap,
 *   - more than MAX_UNBOUNDED_QUANTIFIERS unbounded quantifiers in total
 *     (`a*a*a*b` is cubic; each extra `*` adds a power),
 *   - backreferences (`\1`, `\k<name>`), which are also super-linear.
 *
 * Callers should additionally cap the haystack length (descriptions are
 * short) so even polynomial patterns stay cheap.
 */
export const MAX_PATTERN_LENGTH = 200;
// Bank descriptions / memos are short; capping the haystack bounds the cost
// of the polynomial patterns we still allow (≤ MAX_UNBOUNDED_QUANTIFIERS
// sequential `*`/`+` → at most quadratic over 200 chars = 40k steps).
export const MAX_REGEX_HAYSTACK = 200;
export const MAX_UNBOUNDED_QUANTIFIERS = 2;

export interface RegexSafetyResult { safe: boolean; reason?: string }

export function checkRegexSafety(pattern: string): RegexSafetyResult {
  if (typeof pattern !== 'string') return { safe: false, reason: 'Pattern must be a string' };
  if (pattern.length === 0) return { safe: false, reason: 'Pattern is empty' };
  if (pattern.length > MAX_PATTERN_LENGTH) return { safe: false, reason: `Pattern longer than ${MAX_PATTERN_LENGTH} characters` };

  // Group stack: does this group (so far) contain a quantifier / an alternation?
  const stack: Array<{ quant: boolean; alt: boolean }> = [{ quant: false, alt: false }];
  let unbounded = 0;
  let i = 0;
  const isUnboundedAt = (idx: number): boolean => {
    const c = pattern[idx];
    if (c === '*' || c === '+') return true;
    if (c === '{') return /^\{\d+,\}/.test(pattern.slice(idx));
    return false;
  };
  const isQuantAt = (idx: number): boolean => {
    const c = pattern[idx];
    if (c === '*' || c === '+') return true;
    if (c === '{') {
      // {n}, {n,}, {n,m} — a fixed {n} is bounded but still repeats a
      // group; treat any brace quantifier as a quantifier for nesting.
      return /^\{\d+(,\d*)?\}/.test(pattern.slice(idx));
    }
    return false;
  };
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next)) return { safe: false, reason: 'Backreferences are not allowed' };
      if (next === 'k' && pattern[i + 2] === '<') return { safe: false, reason: 'Backreferences are not allowed' };
      i += 2; continue;
    }
    if (c === '[') {
      // Skip a character class (quantifier chars inside are literal).
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') { if (pattern[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '(') { stack.push({ quant: false, alt: false }); i++; continue; }
    if (c === '|') { stack[stack.length - 1]!.alt = true; i++; continue; }
    if (c === ')') {
      const inner = stack.pop() ?? { quant: false, alt: false };
      const parent = stack[stack.length - 1]!;
      let j = i + 1;
      if (isQuantAt(j)) {
        if (inner.quant) return { safe: false, reason: 'Nested quantifiers (e.g. "(a+)+") are not allowed' };
        if (inner.alt) return { safe: false, reason: 'A repeated group may not contain alternation (e.g. "(a|aa)+")' };
        if (isUnboundedAt(j)) unbounded++;
        // A quantified group counts as a quantifier for its parent.
        parent.quant = true;
      } else if (inner.quant) {
        parent.quant = true;
      }
      if (inner.alt) parent.alt = parent.alt || false; // alternation stays scoped to its group
      // step past the quantifier token(s)
      if (isQuantAt(j)) { if (pattern[j] === '{') { j = pattern.indexOf('}', j) + 1; } else j++; if (pattern[j] === '?') j++; }
      else if (pattern[j] === '?') j++;
      i = j; continue;
    }
    if (isQuantAt(i)) {
      stack[stack.length - 1]!.quant = true;
      if (isUnboundedAt(i)) unbounded++;
      if (c === '{') { i = pattern.indexOf('}', i) + 1; } else i++;
      if (pattern[i] === '?') i++; // lazy modifier
      continue;
    }
    i++;
  }
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
    return { safe: false, reason: `At most ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers (*, +, {n,}) are allowed` };
  }
  return { safe: true };
}

const cache = new Map<string, RegExp | null>();

/**
 * Compile a user pattern (case-insensitive) if it passes the safety check;
 * returns null otherwise. Compiled objects are memoised (bounded).
 */
export function compileSafeRegex(pattern: string): RegExp | null {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  let re: RegExp | null = null;
  if (checkRegexSafety(pattern).safe) {
    try { re = new RegExp(pattern, 'i'); } catch { re = null; }
  }
  if (cache.size > 500) cache.clear();
  cache.set(pattern, re);
  return re;
}
