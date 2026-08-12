// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  stashPendingRecoveryKey,
  peekPendingRecoveryKey,
  acknowledgePendingRecoveryKey,
  hasPendingRecoveryKey,
  __clearPending,
} from './pending-recovery-key.service.js';

beforeEach(() => {
  __clearPending();
});

describe('pending-recovery-key.service', () => {
  it('returns null when nothing is pending', () => {
    expect(peekPendingRecoveryKey('nope', 'whatever')).toBeNull();
  });

  it('round-trips stash → peek with the claim token', () => {
    const token = stashPendingRecoveryKey('install-1', 'RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(peekPendingRecoveryKey('install-1', token)).toBe('RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
  });

  it('refuses peek without the correct claim token (installationId is public)', () => {
    stashPendingRecoveryKey('install-1', 'KEY');
    expect(peekPendingRecoveryKey('install-1', '')).toBeNull();
    expect(peekPendingRecoveryKey('install-1', 'wrong-token')).toBeNull();
    expect(peekPendingRecoveryKey('install-1', 'a'.repeat(64))).toBeNull();
  });

  it('is addressable per installation ID', () => {
    const t1 = stashPendingRecoveryKey('install-1', 'KEY-ONE');
    const t2 = stashPendingRecoveryKey('install-2', 'KEY-TWO');
    expect(peekPendingRecoveryKey('install-1', t1)).toBe('KEY-ONE');
    expect(peekPendingRecoveryKey('install-2', t2)).toBe('KEY-TWO');
    // Tokens are not interchangeable across installations.
    expect(peekPendingRecoveryKey('install-1', t2)).toBeNull();
  });

  it('hasPending exposes existence only, without a token', () => {
    expect(hasPendingRecoveryKey('install-1')).toBe(false);
    stashPendingRecoveryKey('install-1', 'KEY');
    expect(hasPendingRecoveryKey('install-1')).toBe(true);
  });

  it('acknowledge removes the entry, and requires the token', () => {
    const token = stashPendingRecoveryKey('install-1', 'KEY');
    expect(acknowledgePendingRecoveryKey('install-1', 'wrong')).toBe(false);
    expect(peekPendingRecoveryKey('install-1', token)).toBe('KEY');
    expect(acknowledgePendingRecoveryKey('install-1', token)).toBe(true);
    expect(peekPendingRecoveryKey('install-1', token)).toBeNull();
  });

  it('acknowledge returns false when nothing was pending', () => {
    expect(acknowledgePendingRecoveryKey('nope', 'token')).toBe(false);
  });

  it('peek is non-destructive (does not clear the entry)', () => {
    const token = stashPendingRecoveryKey('install-1', 'KEY');
    expect(peekPendingRecoveryKey('install-1', token)).toBe('KEY');
    expect(peekPendingRecoveryKey('install-1', token)).toBe('KEY');
    expect(peekPendingRecoveryKey('install-1', token)).toBe('KEY');
  });

  it('stashing the same key twice overwrites the first entry and rotates the token', () => {
    const t1 = stashPendingRecoveryKey('install-1', 'FIRST');
    const t2 = stashPendingRecoveryKey('install-1', 'SECOND');
    expect(peekPendingRecoveryKey('install-1', t1)).toBeNull();
    expect(peekPendingRecoveryKey('install-1', t2)).toBe('SECOND');
  });
});
