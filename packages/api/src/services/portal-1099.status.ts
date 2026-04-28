// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 14/15 — pure decoder for
// the 1099-status pill shown in the bookkeeper vendor table.
// Lifted out of the service module so it's unit-testable and so
// the rule precedence is in one place. Threshold values are
// passed as args (rather than imported) to keep the module pure.

export type VendorStatus = 'compliant' | 'warning' | 'blocked' | 'excluded';

export const EXCLUSION_REASONS = [
  'corporation',         // Corporation per W-9 — most common exemption
  'foreign',             // Foreign vendor (W-8 instead of W-9)
  'reimbursement_only',  // Only reimbursements / expense-passthrough; no service payments
  'tax_exempt',          // 501(c) / government / other exempt entity
  'employee',            // Misclassification fix — should be on W-2, not 1099
  'other',               // Anything else; note required
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const EXCLUSION_REASON_LABELS: Record<ExclusionReason, string> = {
  corporation: 'Corporation (per W-9)',
  foreign: 'Foreign vendor',
  reimbursement_only: 'Reimbursement only',
  tax_exempt: 'Tax-exempt entity',
  employee: 'Should be on W-2',
  other: 'Other',
};

export function isValidExclusionReason(value: unknown): value is ExclusionReason {
  return typeof value === 'string' && (EXCLUSION_REASONS as readonly string[]).includes(value);
}

export interface VendorStatusInputs {
  is1099Eligible: boolean;
  ytdTotal: number;
  w9OnFile: boolean;
  exclusionReason: string | null;
  necThreshold: number;
}

/**
 * Decide which pill the row gets. Order matters:
 *   1. excluded — operator-set hard override, regardless of YTD/W-9.
 *      This is what defends the firm at audit time.
 *   2. blocked — eligible, ≥ threshold, no W-9. Year-end reporting
 *      is impossible without the TIN.
 *   3. warning — eligible, ≥ 80% of threshold, no W-9. Pre-emptive
 *      nudge to collect the W-9 before the threshold is crossed.
 *   4. compliant — anyone else.
 *
 * Vendors with `is1099Eligible=false` and no exclusion reason fall
 * to 'compliant' — they're simply not in scope for 1099 reporting.
 */
export function decodeVendorStatus(inputs: VendorStatusInputs): VendorStatus {
  if (inputs.exclusionReason) return 'excluded';
  if (inputs.is1099Eligible && inputs.ytdTotal >= inputs.necThreshold && !inputs.w9OnFile) {
    return 'blocked';
  }
  if (
    inputs.is1099Eligible &&
    inputs.ytdTotal >= inputs.necThreshold * 0.8 &&
    !inputs.w9OnFile
  ) {
    return 'warning';
  }
  return 'compliant';
}
