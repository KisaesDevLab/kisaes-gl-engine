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
// Counted PER TOP-LEVEL ALTERNATION BRANCH (branches are tried one after
// another, so their costs add rather than multiply), EXCLUDING a quantifier
// that ends the branch (nothing after it can fail, so it never backtracks),
// and a `^`-anchored branch gets one extra (a single start position drops
// the polynomial degree by one). Measured on Node 24 over a 200-char
// non-matching haystack: `\w*\w*x` 16 ms, `^\w*\w*\w*x` 16 ms,
// `\w*\w*\w*x` ≈ 1 s, `^\w*\w*\w*\w*x` ≈ 0.9 s, `\w*\w*\w*\w*x` ≈ 38 s.
// 2 (+1 anchored) keeps the worst allowed case at ~16 ms per evaluation
// while letting the ordinary shapes through: `.*amazon.*|.*amzn.*`,
// `^AMZN.*MKTP.*US.*`, `CHECK\s*#?\s*\d+`, `\$\d{1,3}(,\d{3})*(\.\d{2})?`.
export const MAX_UNBOUNDED_QUANTIFIERS = 2;

export interface RegexSafetyResult { safe: boolean; reason?: string }

export function checkRegexSafety(pattern: string): RegexSafetyResult {
  if (typeof pattern !== 'string') return { safe: false, reason: 'Pattern must be a string' };
  if (pattern.length === 0) return { safe: false, reason: 'Pattern is empty' };
  if (pattern.length > MAX_PATTERN_LENGTH) return { safe: false, reason: `Pattern longer than ${MAX_PATTERN_LENGTH} characters` };

  // Group stack: does this group (so far) contain a quantifier / an alternation?
  const stack: Array<{ quant: boolean; alt: boolean; unb: number }> = [{ quant: false, alt: false, unb: 0 }];
  // Unbounded quantifiers per top-level branch; `lastUnboundedEnd` remembers
  // where the most recent top-level one ended so a branch-terminal one can be
  // discounted (see MAX_UNBOUNDED_QUANTIFIERS).
  let branchUnbounded = 0;
  let branchStart = 0;
  let overBudget = false;
  let lastTopLevelUnboundedEnd = -1;
  let i = 0;
  const isUnboundedAt = (idx: number): boolean => {
    const c = pattern[idx];
    if (c === '*' || c === '+') return true;
    if (c === '{') return /^\{\d+,\}/.test(pattern.slice(idx));
    return false;
  };
  // "Repeats" for the nesting rule: *, +, {n,}, {n,m}. An exact {n} is a
  // fixed-length repeat (`(,\d{3})*` is a plain thousands-separator idiom,
  // not star-height 2), so it neither nests nor counts as nested.
  const isRepeatAt = (idx: number): boolean => {
    const c = pattern[idx];
    if (c === '*' || c === '+') return true;
    if (c === '{') return /^\{\d+,\d*\}/.test(pattern.slice(idx));
    return false;
  };
  const isQuantAt = (idx: number): boolean => {
    const c = pattern[idx];
    if (c === '*' || c === '+') return true;
    if (c === '{') return /^\{\d+(,\d*)?\}/.test(pattern.slice(idx));
    return false;
  };
  const endBranch = () => {
    // A quantifier that closes the branch never backtracks — discount it;
    // a `^`-anchored branch is allowed one more.
    let n = branchUnbounded;
    if (n > 0 && lastTopLevelUnboundedEnd === i) n--;
    const budget = MAX_UNBOUNDED_QUANTIFIERS + (pattern[branchStart] === '^' ? 1 : 0);
    if (n > budget) overBudget = true;
    branchUnbounded = 0;
    branchStart = i + 1;
    lastTopLevelUnboundedEnd = -1;
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
    if (c === '(') { stack.push({ quant: false, alt: false, unb: 0 }); i++; continue; }
    if (c === '|') {
      stack[stack.length - 1]!.alt = true;
      if (stack.length === 1) endBranch();
      i++; continue;
    }
    if (c === ')') {
      const inner = stack.pop() ?? { quant: false, alt: false, unb: 0 };
      const parent = stack[stack.length - 1]!;
      let j = i + 1;
      // The group's own unbounded quantifiers roll up to the parent; an
      // exact repeat `(\d+){3}` multiplies them (it is `\d+\d+\d+`).
      let rolled = inner.unb;
      if (isQuantAt(j)) {
        if (isRepeatAt(j)) {
          if (inner.quant) return { safe: false, reason: 'Nested quantifiers (e.g. "(a+)+") are not allowed' };
          if (inner.alt) return { safe: false, reason: 'A repeated group may not contain alternation (e.g. "(a|aa)+")' };
          // A repeated group counts as a quantifier for its parent.
          parent.quant = true;
        } else {
          const m = /^\{(\d+)\}/.exec(pattern.slice(j));
          if (m) rolled *= Math.max(1, Math.min(Number(m[1]), 100));
          if (inner.quant) parent.quant = true;
        }
      } else if (inner.quant) {
        parent.quant = true;
      }
      parent.unb += rolled;
      if (stack.length === 1) branchUnbounded += rolled;
      const unb = isUnboundedAt(j);
      // step past the quantifier token(s)
      if (isQuantAt(j)) { if (pattern[j] === '{') { j = pattern.indexOf('}', j) + 1; } else j++; if (pattern[j] === '?') j++; }
      else if (pattern[j] === '?') j++;
      if (unb) {
        if (stack.length === 1) { branchUnbounded++; lastTopLevelUnboundedEnd = j; } else parent.unb++;
      }
      i = j; continue;
    }
    if (isQuantAt(i)) {
      if (isRepeatAt(i)) stack[stack.length - 1]!.quant = true;
      const unb = isUnboundedAt(i);
      if (c === '{') { i = pattern.indexOf('}', i) + 1; } else i++;
      if (pattern[i] === '?') i++; // lazy modifier
      if (unb) {
        if (stack.length === 1) { branchUnbounded++; lastTopLevelUnboundedEnd = i; } else stack[stack.length - 1]!.unb++;
      }
      continue;
    }
    i++;
  }
  endBranch();
  if (overBudget) {
    return { safe: false, reason: `At most ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers (*, +, {n,}) are allowed per alternative (one more if it starts with ^; a trailing one is free)` };
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
