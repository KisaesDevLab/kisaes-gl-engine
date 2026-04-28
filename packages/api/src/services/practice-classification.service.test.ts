// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { CLASSIFICATION_THRESHOLDS_DEFAULT } from '@kis-books/shared';
import { assignBucket, type AssignBucketInput } from './practice-classification.service.js';

// Default thresholds from the build plan:
//   high conf >= 0.95, high vendor consistency >= 0.95
//   medium conf 0.70-0.95
//   needs-review below 0.70 OR new vendor OR multi-account
const T = CLASSIFICATION_THRESHOLDS_DEFAULT;

function baseSignals(overrides: Partial<AssignBucketInput> = {}): AssignBucketInput {
  return {
    storedConfidence: 0.8,
    matchType: 'history',
    matchedRuleId: null,
    hasPotentialMatch: false,
    vendorConsistency: 1.0,
    isNewVendor: false,
    isMultiAccountHistory: false,
    overrideRate: 0.1,
    recurrenceCount: 10,
    ...overrides,
  };
}

describe('assignBucket — precedence', () => {
  it('rule precedence: matched_rule_id forces bucket=rule even with low confidence', () => {
    const out = assignBucket(
      baseSignals({ matchedRuleId: 'abc', storedConfidence: 0.1, matchType: 'rule' }),
      T,
    );
    expect(out.bucket).toBe('rule');
  });

  it('rule precedence: matchType=rule alone (no id) still bucket=rule', () => {
    const out = assignBucket(baseSignals({ matchType: 'rule', storedConfidence: 0.2 }), T);
    expect(out.bucket).toBe('rule');
  });

  it('potential_match precedence: hasPotentialMatch=true wins over auto_medium confidence', () => {
    const out = assignBucket(
      baseSignals({ hasPotentialMatch: true, storedConfidence: 0.85 }),
      T,
    );
    expect(out.bucket).toBe('potential_match');
  });

  it('potential_match: rule still beats potential match (rules are user intent)', () => {
    const out = assignBucket(
      baseSignals({
        hasPotentialMatch: true,
        matchedRuleId: 'xyz',
        matchType: 'rule',
        storedConfidence: 0.5,
      }),
      T,
    );
    expect(out.bucket).toBe('rule');
  });
});

describe('assignBucket — Bucket 4 needs_review', () => {
  it('new vendor drops to needs_review even at 1.0 confidence', () => {
    const out = assignBucket(baseSignals({ isNewVendor: true, storedConfidence: 1.0 }), T);
    expect(out.bucket).toBe('needs_review');
  });

  it('multi-account history drops to needs_review even at 1.0 confidence', () => {
    const out = assignBucket(
      baseSignals({ isMultiAccountHistory: true, storedConfidence: 1.0 }),
      T,
    );
    expect(out.bucket).toBe('needs_review');
  });

  it('confidence below bucket4Floor (0.70) is needs_review', () => {
    const out = assignBucket(baseSignals({ storedConfidence: 0.69 }), T);
    expect(out.bucket).toBe('needs_review');
  });

  it('confidence EXACTLY at bucket4Floor (0.70) escapes Bucket 4 when other signals clean', () => {
    const out = assignBucket(baseSignals({ storedConfidence: 0.7 }), T);
    expect(out.bucket).toBe('auto_medium');
  });
});

describe('assignBucket — Bucket 3 High', () => {
  it('conf=0.95 AND vendor consistency=0.95 → auto_high', () => {
    const out = assignBucket(
      baseSignals({ storedConfidence: 0.95, vendorConsistency: 0.95 }),
      T,
    );
    expect(out.bucket).toBe('auto_high');
  });

  it('conf=0.96 but vendor consistency=0.9 fails vendor check → auto_medium', () => {
    const out = assignBucket(
      baseSignals({ storedConfidence: 0.96, vendorConsistency: 0.9 }),
      T,
    );
    expect(out.bucket).toBe('auto_medium');
  });

  it('conf=0.94 (just below high) → auto_medium despite perfect vendor consistency', () => {
    const out = assignBucket(
      baseSignals({ storedConfidence: 0.94, vendorConsistency: 1.0 }),
      T,
    );
    expect(out.bucket).toBe('auto_medium');
  });

  it('null vendor consistency (no history) cannot satisfy high threshold', () => {
    const out = assignBucket(
      baseSignals({ storedConfidence: 0.99, vendorConsistency: null, isNewVendor: true }),
      T,
    );
    // isNewVendor forces needs_review first
    expect(out.bucket).toBe('needs_review');
  });
});

describe('assignBucket — confidence adjustments', () => {
  it('new_vendor adjustment records in reasoning blob', () => {
    const out = assignBucket(
      baseSignals({ isNewVendor: true, storedConfidence: 0.99 }),
      T,
    );
    expect(out.reasoning.adjustments).toContainEqual({ reason: 'new_vendor', delta: -0.15 });
  });

  it('multi_account_history adjustment records in reasoning blob', () => {
    const out = assignBucket(
      baseSignals({ isMultiAccountHistory: true, storedConfidence: 0.99 }),
      T,
    );
    expect(out.reasoning.adjustments).toContainEqual({
      reason: 'multi_account_history',
      delta: -0.10,
    });
  });

  it('clamps adjusted confidence to [0, 1]', () => {
    const out = assignBucket(
      baseSignals({
        storedConfidence: 0.02,
        isNewVendor: true,
        isMultiAccountHistory: true,
      }),
      T,
    );
    expect(out.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(out.confidenceScore).toBeLessThanOrEqual(1);
  });

  it('rule bucket preserves stored confidence without adjustments', () => {
    const out = assignBucket(
      baseSignals({
        matchedRuleId: 'r1',
        matchType: 'rule',
        storedConfidence: 1.0,
        isNewVendor: true,
      }),
      T,
    );
    expect(out.confidenceScore).toBe(1.0);
    expect(out.bucket).toBe('rule');
  });
});

describe('assignBucket — tenant threshold overrides', () => {
  it('raised bucket3HighConfidence = 0.99 pushes a 0.96 row to auto_medium', () => {
    const overridden = {
      ...T,
      bucket3HighConfidence: 0.99,
    };
    const out = assignBucket(
      baseSignals({ storedConfidence: 0.96, vendorConsistency: 1.0 }),
      overridden,
    );
    expect(out.bucket).toBe('auto_medium');
  });

  it('relaxed bucket4Floor = 0.5 keeps a 0.6 row out of needs_review', () => {
    const overridden = { ...T, bucket4Floor: 0.5 };
    const out = assignBucket(baseSignals({ storedConfidence: 0.6 }), overridden);
    expect(out.bucket).toBe('auto_medium');
  });

  it('tightened bucket3HighVendorConsistency = 0.99 demotes 0.95-consistent vendor', () => {
    const overridden = { ...T, bucket3HighVendorConsistency: 0.99 };
    const out = assignBucket(
      baseSignals({ storedConfidence: 0.97, vendorConsistency: 0.95 }),
      overridden,
    );
    expect(out.bucket).toBe('auto_medium');
  });
});

describe('assignBucket — reasoning blob', () => {
  it('records matchType in every reasoning blob', () => {
    const out = assignBucket(baseSignals({ matchType: 'history' }), T);
    expect(out.reasoning.matchType).toBe('history');
  });

  it('records vendorConsistency as null when isNewVendor=true', () => {
    const out = assignBucket(
      baseSignals({ isNewVendor: true, vendorConsistency: null }),
      T,
    );
    expect(out.reasoning.vendorConsistency).toBeNull();
    expect(out.reasoning.isNewVendor).toBe(true);
  });

  it('final bucket in reasoning blob matches returned bucket', () => {
    const out = assignBucket(
      baseSignals({ storedConfidence: 0.5, isNewVendor: false }),
      T,
    );
    expect(out.reasoning.bucket).toBe(out.bucket);
  });
});
