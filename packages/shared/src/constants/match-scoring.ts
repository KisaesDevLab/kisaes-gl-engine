// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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

// ─── Statement Match Engine (wave 1) ───────────────────────────
//
// Separate constants from the bank-feed pipeline above (which stays
// untouched): statement matching has a hard exact-amount
// precondition, so amount carries more weight and the date window is
// asymmetric (a ledger entry is written before the bank clears it —
// checks can clear months later, but a bank line rarely precedes the
// books by more than a couple of days).

// Composite weights for statement-line vs worksheet-line scoring.
// Amount is a precondition (exact to the cent, or ≤1% for
// suggest-only near matches), so its component is 1.0 or the
// near-match score below.
export const STATEMENT_MATCH_WEIGHTS = {
  amount: 0.55,
  date: 0.25,
  name: 0.2,
} as const;

// Asymmetric candidate window, anchored ledger-before-bank: the
// candidate's ledger txn_date must fall within
// [statementLineDate - LEDGER_BEFORE days, statementLineDate + LEDGER_AFTER days].
export const STATEMENT_MATCH_DATE_WINDOW = {
  ledgerBeforeBankDays: 90,
  ledgerAfterBankDays: 3,
} as const;

// Date score bands over |txn_date - statement line date| in days.
// Evaluated in order; beyond the last band the floor score applies
// (the 90-day window already bounds candidacy).
export const STATEMENT_MATCH_DATE_BANDS: ReadonlyArray<{ days: number; score: number }> = [
  { days: 2, score: 1.0 },
  { days: 7, score: 0.85 },
  { days: 30, score: 0.6 },
];
export const STATEMENT_MATCH_DATE_FLOOR_SCORE = 0.4;

// Near-amount (pool B) tolerance: ≤ this fraction of the statement
// amount → SUGGEST-only candidate flagged with the amount delta.
export const STATEMENT_MATCH_NEAR_AMOUNT_PCT = 0.01;
// Amount component used for pool-B candidates (pool A is 1.0).
export const STATEMENT_MATCH_NEAR_AMOUNT_SCORE = 0.85;

// AUTO tier: exact amount AND unambiguous AND (check number exact OR
// composite ≥ this). SUGGEST tier: composite ≥ the suggest floor, or
// ambiguous exact amounts, or a pool-B near match.
export const STATEMENT_MATCH_AUTO_THRESHOLD = 0.9;
export const STATEMENT_MATCH_SUGGEST_THRESHOLD = 0.6;

// Cap on candidates returned/persisted per statement line.
export const STATEMENT_MATCH_MAX_CANDIDATES = 3;

// ─── Statement Match Engine (wave 2): grouped matches ───────────
//
// One statement line ↔ many worksheet lines (a deposit clearing several
// receipts) and many statement lines ↔ one worksheet line (one booked
// monthly total vs N individual bank charges). Grouped matches are
// SUGGEST-ONLY — never auto-cleared — and a confirmed set must sum
// EXACTLY to the cent.

// Tighter date window than singles: grouped deposits are near-dated.
// Candidate ledger lines must fall within
// [statementLineDate - ledgerBeforeBankDays, statementLineDate + ledgerAfterBankDays]
// (and the mirror of that for many-to-one, anchored on the ledger date).
export const STATEMENT_MATCH_GROUP_DATE_WINDOW = {
  ledgerBeforeBankDays: 30,
  ledgerAfterBankDays: 3,
} as const;

// Subset-sum bounds: candidate pool capped at the N nearest-dated
// lines; subsets of 2..5 members; DFS node budget so a pathological
// pool can never stall a request.
export const STATEMENT_MATCH_GROUP_POOL_CAP = 40;
export const STATEMENT_MATCH_GROUP_MIN_SIZE = 2;
export const STATEMENT_MATCH_GROUP_MAX_SIZE = 5;
export const STATEMENT_MATCH_GROUP_MAX_EXPANSIONS = 200_000;

// Global budget across ALL group searches (A1 + A2 combined) in one
// matchStatement run. The per-call budget above bounds a single
// pathological pool, but a large worksheet can run hundreds of searches —
// without a shared cap the worst case is hundreds × 200k expansions in one
// request. When the shared budget runs out the remaining group searches
// are skipped (logged; singles are unaffected).
export const STATEMENT_MATCH_GROUP_MAX_EXPANSIONS_TOTAL = 1_000_000;

// One-to-many ambiguity: when 2+ distinct minimal sets exist, return up
// to this many for the picker (never auto — groups are suggest-only).
export const STATEMENT_MATCH_GROUP_MAX_SETS = 3;

// Many-to-one is stricter: member statement lines must be dated within
// this many days of each other, and the suggestion is only emitted when
// EXACTLY ONE set exists (ambiguous → skipped and counted).
export const STATEMENT_MATCH_GROUP_MEMBER_SPAN_DAYS = 7;
