// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Threshold below which a bill/invoice is considered fully paid.
 * Amounts at or below this value are treated as rounding dust.
 * Used consistently across bill, invoice, and payment services.
 */
export const PAID_THRESHOLD = 0.01;

/**
 * Tolerance for transaction balance validation (sum of debits must equal sum of credits).
 * Differences below this threshold are accepted.
 */
export const BALANCE_TOLERANCE = 0.0001;
