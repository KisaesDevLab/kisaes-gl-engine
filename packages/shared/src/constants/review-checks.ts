// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 6 — Review Checks
// registry. Constants surfaced here so the Phase-7 dashboard
// (Findings UI) reads them straight from the same source the
// engine uses.

export const FINDING_SEVERITIES = ['low', 'med', 'high', 'critical'] as const;
export type FindingSeverity = typeof FINDING_SEVERITIES[number];

export const FINDING_STATUSES = ['open', 'assigned', 'in_review', 'resolved', 'ignored'] as const;
export type FindingStatus = typeof FINDING_STATUSES[number];

// 'judgment' is added for Phase: AI expansion. Findings in this
// category are produced by AI handlers (e.g., `ai_personal_expense_review`)
// and are not run by the nightly scheduler — they fire only when a
// bookkeeper explicitly clicks "Run AI judgment" so AI cost stays
// bounded.
export const CHECK_CATEGORIES = ['close', 'data', 'compliance', 'judgment'] as const;
export type CheckCategory = typeof CHECK_CATEGORIES[number];

// Stock check keys per build plan §6.2. The 13th item from the
// build plan was `missing_required_class_location_customer`;
// we ship it as `missing_required_customer` (class/location
// deferred per plan §D5/§5).
export const STOCK_CHECK_KEYS = [
  'parent_account_posting',
  'missing_attachment_above_threshold',
  'uncategorized_stale',
  'auto_posted_by_rule_sampling',
  'tag_inconsistency_vs_history',
  'transaction_above_materiality',
  'duplicate_candidate',
  'round_dollar_above_threshold',
  'weekend_holiday_posting',
  'negative_non_liability',
  'closed_period_posting',
  'vendor_1099_threshold_no_w9',
  'missing_required_customer',
  // F2: receipt total disagrees with bank amount.
  'receipt_amount_mismatch',
  // F3: AI judgment — fires only when bookkeeper requests it.
  'ai_personal_expense_review',
] as const;
export type StockCheckKey = typeof STOCK_CHECK_KEYS[number];

// Cap on findings per orchestrator run to defend against
// runaway handlers — see plan §D8. Hit triggers
// `check_runs.truncated = true`.
export const MAX_FINDINGS_PER_RUN = 5000;

// Resume-runs throttle: don't re-run the same (tenant, company)
// pair within this window. The scheduler ticks every 30 min and
// uses this to decide whether to invoke. Per-tenant timezones
// could shift this; for v1 the window is a flat 24h since last
// completion.
export const RUN_THROTTLE_HOURS = 24;
