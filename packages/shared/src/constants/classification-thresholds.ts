// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Default thresholds for the VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 2
// 4-bucket workflow. Authoritative source: build plan §2.2.
//
//   Bucket 3 "High":   confidence ≥ 0.95 AND vendor code-consistency ≥ 0.95
//   Bucket 3 "Medium": 0.70 ≤ confidence < 0.95
//   Bucket 4 "Needs Review": confidence < 0.70 OR new vendor OR multi-account history
//
// These are stored as decimals in the [0, 1] range; the DB column
// (`confidence_score`) is DECIMAL(4,3), so three fractional digits
// is the maximum stored precision.
export interface ClassificationThresholds {
  bucket3HighConfidence: number;
  bucket3HighVendorConsistency: number;
  bucket3MediumConfidence: number;
  // Anything strictly below bucket3MediumConfidence is Bucket 4.
  // Named explicitly so tenant overrides can specify the floor
  // independently of the medium cutoff (for future-proofing; they
  // are equal by default).
  bucket4Floor: number;
}

export const CLASSIFICATION_THRESHOLDS_DEFAULT: ClassificationThresholds = {
  bucket3HighConfidence: 0.95,
  bucket3HighVendorConsistency: 0.95,
  bucket3MediumConfidence: 0.70,
  bucket4Floor: 0.70,
};

// `system_settings.key` value used to persist per-tenant overrides.
// The value is a JSONB blob conforming to a partial
// ClassificationThresholds — missing fields fall back to the
// defaults above.
export const PRACTICE_THRESHOLDS_SETTINGS_KEY = 'practice.classification_thresholds';
