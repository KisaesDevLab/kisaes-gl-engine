// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { cleanBankDescription } from './bank-name-cleaner.js';

// Pure-JS Levenshtein distance using a single rolling row for
// O(min(a, b)) memory rather than O(a*b). Used by the Phase 3
// potential-match scorer to compare a bank-feed description
// against a customer/vendor name.
//
// Vendor names in this codebase are typically <40 chars, so the
// simple iterative implementation is fast enough — measured at
// <0.1ms per comparison on the kind of strings we get.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure `a` is the shorter — the rolling row is sized to a.
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const cols = a.length;
  const rows = b.length;
  const prev = new Array(cols + 1);
  const curr = new Array(cols + 1);

  for (let j = 0; j <= cols; j++) prev[j] = j;

  for (let i = 1; i <= rows; i++) {
    curr[0] = i;
    for (let j = 1; j <= cols; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost,     // substitution
      );
    }
    for (let j = 0; j <= cols; j++) prev[j] = curr[j];
  }
  return prev[cols];
}

// Similarity score in [0, 1]. 1.0 = identical after normalization;
// 0.0 = entirely disjoint. Normalization runs both inputs through
// `cleanBankDescription` first so "AMZN MKTP US*Q1234" matches
// "Amazon" via the existing merchant map. After normalization, the
// result is `1 - (levenshtein / max(len_a, len_b))` which is the
// standard Levenshtein-derived similarity.
//
// Empty inputs return 0 (we can't say two empty strings "match" in
// a way that should boost a candidate's score — and an empty input
// likely indicates a missing vendor field on the feed item).
export function nameSimilarity(rawA: string | null | undefined, rawB: string | null | undefined): number {
  if (!rawA || !rawB) return 0;
  const a = cleanBankDescription(rawA).toLowerCase().trim();
  const b = cleanBankDescription(rawB).toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return 1 - dist / maxLen;
}

// Substring-aware variant. The bank descriptor "AMZN MKTP US PAYMENT"
// should match the customer name "Amazon" even though the
// Levenshtein distance is large. Returns the maximum of:
//   - direct nameSimilarity(a, b)
//   - similarity computed against any contiguous N-word window of
//     `a` whose word count matches `b`'s
// This is the function the matchers actually call. Costs an extra
// O(words(a)) scans on top of one Levenshtein per comparison.
export function nameSimilarityFuzzy(rawA: string | null | undefined, rawB: string | null | undefined): number {
  if (!rawA || !rawB) return 0;
  const a = cleanBankDescription(rawA).toLowerCase().trim();
  const b = cleanBankDescription(rawB).toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;

  const direct = nameSimilarity(rawA, rawB);

  const aWords = a.split(/\s+/).filter(Boolean);
  const bWords = b.split(/\s+/).filter(Boolean);
  if (bWords.length === 0 || bWords.length > aWords.length) {
    return direct;
  }

  let best = direct;
  for (let i = 0; i + bWords.length <= aWords.length; i++) {
    const window = aWords.slice(i, i + bWords.length).join(' ');
    const dist = levenshtein(window, b);
    const sim = 1 - dist / Math.max(window.length, b.length);
    if (sim > best) best = sim;
  }
  return best;
}
