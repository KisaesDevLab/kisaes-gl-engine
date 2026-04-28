// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 3 §3.2 scoring constants.
// Surfaced here as named constants so a tuning change is one edit
// rather than a search across the matcher service.

// Composite-score weights per phase-3-plan.md §D6. Amount carries
// the most weight because a payment must equal its source
// transaction (modulo small bank fees); date and name are
// supporting signals. Sum to 1.0 — the composite is `Σ w_i · s_i`
// over the components.
export const MATCH_SCORE_WEIGHTS = {
  amount: 0.5,
  date: 0.3,
  name: 0.2,
} as const;

// Amount tolerance bands (build plan §3.2). Within `pct` of the
// candidate amount → that band's score. The bands are evaluated
// in order; first match wins. A negative diff (feed amount less
// than candidate amount) is allowed and scored at the same band
// as a positive diff of the same magnitude — partial payments
// still produce a candidate, with the partial-payment indicator
// surfaced in the UI per build plan §3.5.
export const AMOUNT_TOLERANCE_BANDS: ReadonlyArray<{ pct: number; score: number }> = [
  { pct: 0,    score: 1.00 },
  { pct: 0.01, score: 0.85 },
  { pct: 0.05, score: 0.60 },
];

// Date tolerance bands (build plan §3.2). Days difference between
// the feed-item date and the candidate's record date.
export const DATE_TOLERANCE_BANDS_DAYS: ReadonlyArray<{ days: number; score: number }> = [
  { days: 0, score: 1.00 },
  { days: 3, score: 0.85 },
  { days: 7, score: 0.60 },
];

// Composite-score floor for a candidate to qualify for Bucket 1.
// Below this, the candidate is dropped before persistence.
export const BUCKET1_QUALIFY_THRESHOLD = 0.80;

// Cap on candidates persisted per state row — see phase-3-plan.md §D7.
export const MAX_MATCH_CANDIDATES = 3;

// Two candidates whose composite scores are within this many
// points of each other trigger the "duplicate-possible" UI banner
// per build plan §3.5.
export const DUPLICATE_WARNING_DELTA = 0.05;
