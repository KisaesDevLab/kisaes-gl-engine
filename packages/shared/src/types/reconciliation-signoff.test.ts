// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  emptyReconSignoffEntry,
  emptyReconSignoffSummary,
  formatReconSignoffTime,
  reconSignoffBadge,
  reconSignoffShortText,
  reconSignoffStatusText,
  type ReconSignoffEntry,
} from './reconciliation-signoff.js';

const signed = (role: 'preparer' | 'reviewer'): ReconSignoffEntry => ({
  ...emptyReconSignoffEntry(role), state: 'signed', signerName: 'Kurt', signedAt: '2026-10-12T20:04:00Z',
});

describe('reconciliation sign-off helpers', () => {
  it('stamps the signing time in the requested zone, UTC when invalid', () => {
    expect(formatReconSignoffTime('2026-10-12T20:04:00Z', 'America/Chicago')).toBe('10/12/2026 3:04 PM CDT');
    expect(formatReconSignoffTime('2026-10-12T20:04:00Z', 'Not/AZone')).toBe('10/12/2026 8:04 PM UTC');
    expect(formatReconSignoffTime(null)).toBe('');
    expect(reconSignoffStatusText(signed('preparer'), 'UTC')).toBe('/s/ Kurt, 10/12/2026 8:04 PM UTC');
  });

  it('describes stale and unsigned entries', () => {
    const stale: ReconSignoffEntry = { ...signed('reviewer'), state: 'stale', invalidatedReason: 'data_changed', invalidatedDetail: 'cleared items' };
    expect(reconSignoffShortText(stale)).toBe('Stale — data changed after sign-off');
    expect(reconSignoffStatusText(stale, 'UTC')).toBe('Stale — Signed off by Kurt on 10/12/2026 8:04 PM UTC — data changed since (cleared items); re-sign required');
    expect(reconSignoffShortText({ ...stale, invalidatedReason: 'preparer_removed' })).toBe('Stale — preparer sign-off removed');
    expect(reconSignoffShortText(emptyReconSignoffEntry('preparer'))).toBe('Not signed');
  });

  it('derives the history badge', () => {
    const s = emptyReconSignoffSummary(true);
    expect(reconSignoffBadge(s)).toBe('unsigned');
    expect(reconSignoffBadge({ ...s, preparer: signed('preparer') })).toBe('prepared');
    expect(reconSignoffBadge({ ...s, preparer: signed('preparer'), reviewer: signed('reviewer') })).toBe('reviewed');
    expect(reconSignoffBadge({ ...s, preparer: signed('preparer'), reviewer: { ...signed('reviewer'), state: 'stale' } })).toBe('stale');
  });
});
