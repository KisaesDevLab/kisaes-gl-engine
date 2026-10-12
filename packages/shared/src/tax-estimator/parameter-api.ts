// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Wire contract for the tax-parameter admin and read APIs (Phase 1). Shared by
// api (producer) and web (consumer) so the two cannot drift.
import type { ParameterStatus } from './types.js';
import type { ParameterGroup, ParameterValueType, ParameterUnit } from './parameterKeys.js';

/** Where the effective value of a key came from. */
export const PARAMETER_SOURCES = ['seed', 'override', 'provisional', 'fallback'] as const;
export type ParameterSource = typeof PARAMETER_SOURCES[number];

export interface TaxParameterRowDTO {
  /** Concrete key, e.g. `brackets.mfj`. */
  key: string;
  label: string;
  group: ParameterGroup;
  type: ParameterValueType;
  unit: ParameterUnit;
  /** Effective value (JSON as stored). */
  value: unknown;
  status: ParameterStatus;
  source: ParameterSource;
  citation: string;
  /** Present for override / provisional rows. */
  reason?: string | null;
  /** The shipped seed value when it differs from `value` (override/provisional rows). */
  shippedValue?: unknown;
  /** Set on rows resolved through the missing-year fallback. */
  fallbackYear?: number | null;
  /** Sign-off record (in-app Verify): present when a super admin verified this row's current value. */
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verifiedByEmail?: string | null;
  verificationNote?: string | null;
}

export interface TaxParametersDTO {
  year: number;
  /** True when no row exists for `year` and the latest earlier year was used (all rows provisional). */
  isFallback: boolean;
  fallbackYear: number | null;
  completeness: { total: number; present: number; missing: string[] };
  parameters: TaxParameterRowDTO[];
}

export interface TaxParameterYearsDTO {
  /** Years with any row (seed, override or provisional), ascending. */
  years: number[];
  /** Years shipped with the app (seed files). */
  shippedYears: number[];
}

export interface SetTaxParameterOverrideInput {
  value: unknown;
  /** Required, 3+ chars. Audited. */
  reason: string;
}

export interface CreateYearFromPriorResult {
  year: number;
  fromYear: number;
  created: number;
  /** Date-valued keys that were rolled forward and are flagged "verify". */
  rolledDates: string[];
}

export interface TaxParameterDiffRowDTO {
  key: string;
  label: string;
  shippedValue: unknown;
  shippedStatus: ParameterStatus;
  shippedCitation: string;
  provisionalValue: unknown;
}

export interface TaxParameterChangeDTO {
  at: string;
  userId: string | null;
  userEmail: string | null;
  action: 'override_set' | 'override_reverted' | 'year_created' | 'shipped_adopted' | 'verified';
  year: number;
  key: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

/**
 * Result of a single or bulk Verify. `verified` lists the keys (state rules: `ST:key`) whose status
 * became verified. `changed` (R6-04, bulk only) lists keys whose value changed under the bulk
 * verify after it was read: they were NOT signed and must be reviewed again.
 */
export interface VerifyTaxParametersResult {
  verified: string[];
  changed?: string[];
}
