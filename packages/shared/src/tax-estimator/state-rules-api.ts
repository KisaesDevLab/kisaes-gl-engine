// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Wire contract for the state-rule admin and read APIs (Phase 2). Mirrors parameter-api.ts.
import type { ParameterStatus } from './types.js';
import type { ParameterSource } from './parameter-api.js';
import type { StateCode, StateRuleValueType } from './stateRuleKeys.js';

export interface StateRuleRowDTO {
  state: StateCode;
  key: string;
  label: string;
  type: StateRuleValueType;
  /** Effective value (JSON as stored; may be null for nullable rules). */
  value: unknown;
  status: ParameterStatus;
  source: ParameterSource;
  citation: string;
  reason?: string | null;
  /** The shipped seed value when it differs from `value` (override/provisional rows). */
  shippedValue?: unknown;
  /** Override / provisional rows: whether a shipped seed row exists for this rule (revert restores it; R6-07). */
  hasShipped?: boolean;
  /** Set on rows resolved through the missing-year fallback. */
  fallbackYear?: number | null;
  /** Sign-off record (in-app Verify): present when a super admin verified this row's current value. */
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verifiedByEmail?: string | null;
  verificationNote?: string | null;
}

export interface StateRulesDTO {
  year: number;
  state: StateCode;
  hasIncomeTax: boolean;
  /** True when the state has no rows for `year` and the latest earlier year was used (all rows provisional). */
  isFallback: boolean;
  fallbackYear: number | null;
  /** Every key required for this state (see requiredStateRuleKeys) is present. */
  complete: boolean;
  missing: string[];
  rules: StateRuleRowDTO[];
}

/**
 * `fallback` (R6-03): the state has no rows for the year and the estimator serves its latest
 * earlier year's rules (dates derived for the year, everything provisional) — exactly what
 * getStateRules returns. `missing`: no rows in any year.
 */
export const STATE_RULE_SET_STATUSES = ['complete', 'partial', 'missing', 'fallback'] as const;
export type StateRuleSetStatus = typeof STATE_RULE_SET_STATUSES[number];

export interface StateRuleSummaryDTO {
  state: StateCode;
  name: string;
  hasIncomeTax: boolean;
  status: StateRuleSetStatus;
  counts: { verified: number; unverified: number; provisional: number; override: number };
  /** The estimator applies the federal pattern for this state, flagged "verify" (same decision as the estimate: jurisdictionFromStateRules). */
  usesFederalFallback: boolean;
  /** Status `fallback`: the year whose rules are served. */
  fallbackYear: number | null;
}

export interface SetStateRuleOverrideInput {
  value: unknown;
  /** Required, 3+ chars. Audited. */
  reason: string;
}

export interface CreateStateYearFromPriorResult {
  year: number;
  fromYear: number;
  created: number;
  /** Jurisdictions created. */
  states: number;
  /** Jurisdictions left alone because they already had rows for `year` (R6-02: create is per state). */
  skipped: StateCode[];
  /** `ST:key` entries for date-valued keys derived for the new year and flagged "verify". */
  rolledDates: string[];
}

export interface StateRuleDiffRowDTO {
  state: StateCode;
  key: string;
  label: string;
  shippedValue: unknown;
  shippedStatus: ParameterStatus;
  shippedCitation: string;
  provisionalValue: unknown;
  /** The provisional copy equals the shipped value (R6-05). */
  same: boolean;
}

export interface StateRuleChangeDTO {
  at: string;
  userId: string | null;
  userEmail: string | null;
  action: 'override_set' | 'override_reverted' | 'year_created' | 'shipped_adopted' | 'verified';
  year: number;
  state: StateCode | null;
  key: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

/** Adopt-shipped identifies a row as `ST:key`. */
export const stateRuleRef = (state: string, key: string): string => `${state}:${key}`;

/**
 * Result of a single or bulk Verify. `verified` lists the keys (state rules: `ST:key`) whose status
 * became verified. `changed` (R6-04, bulk only) lists keys whose value changed under the bulk
 * verify after it was read: they were NOT signed and must be reviewed again.
 */
export interface VerifyStateRulesResult {
  verified: string[];
  changed?: string[];
}
