// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  EXCLUSION_REASONS,
  decodeVendorStatus,
  isValidExclusionReason,
} from './portal-1099.status.js';

const NEC = 600;

const baseInputs = {
  is1099Eligible: true,
  ytdTotal: 0,
  w9OnFile: false,
  exclusionReason: null,
  necThreshold: NEC,
};

describe('decodeVendorStatus', () => {
  it('returns excluded whenever an exclusion reason is set, regardless of YTD/W-9', () => {
    expect(
      decodeVendorStatus({
        ...baseInputs,
        ytdTotal: 50000,
        w9OnFile: false,
        exclusionReason: 'corporation',
      }),
    ).toBe('excluded');
    expect(
      decodeVendorStatus({
        ...baseInputs,
        ytdTotal: 0,
        w9OnFile: true,
        exclusionReason: 'foreign',
      }),
    ).toBe('excluded');
  });

  it('returns blocked when eligible, ≥ threshold, no W-9', () => {
    expect(
      decodeVendorStatus({ ...baseInputs, ytdTotal: 600, w9OnFile: false }),
    ).toBe('blocked');
    expect(
      decodeVendorStatus({ ...baseInputs, ytdTotal: 5000, w9OnFile: false }),
    ).toBe('blocked');
  });

  it('returns warning at 80% of threshold without W-9', () => {
    expect(
      decodeVendorStatus({ ...baseInputs, ytdTotal: 480, w9OnFile: false }),
    ).toBe('warning');
    expect(
      decodeVendorStatus({ ...baseInputs, ytdTotal: 599.99, w9OnFile: false }),
    ).toBe('warning');
  });

  it('returns compliant when W-9 is on file, regardless of YTD', () => {
    expect(
      decodeVendorStatus({ ...baseInputs, ytdTotal: 100000, w9OnFile: true }),
    ).toBe('compliant');
  });

  it('returns compliant when below 80% of threshold', () => {
    expect(
      decodeVendorStatus({ ...baseInputs, ytdTotal: 479, w9OnFile: false }),
    ).toBe('compliant');
  });

  it('returns compliant for non-1099-eligible vendors regardless of YTD', () => {
    expect(
      decodeVendorStatus({
        ...baseInputs,
        is1099Eligible: false,
        ytdTotal: 50000,
        w9OnFile: false,
      }),
    ).toBe('compliant');
  });
});

describe('isValidExclusionReason', () => {
  it('accepts every documented reason', () => {
    for (const r of EXCLUSION_REASONS) {
      expect(isValidExclusionReason(r)).toBe(true);
    }
  });

  it('rejects empty / unknown / non-string values', () => {
    expect(isValidExclusionReason('')).toBe(false);
    expect(isValidExclusionReason('made_up_reason')).toBe(false);
    expect(isValidExclusionReason(null)).toBe(false);
    expect(isValidExclusionReason(undefined)).toBe(false);
    expect(isValidExclusionReason(42)).toBe(false);
  });
});
