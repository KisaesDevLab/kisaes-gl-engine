import { describe, it, expect, beforeEach } from 'vitest';
import {
  stashPendingRecoveryKey,
  peekPendingRecoveryKey,
  acknowledgePendingRecoveryKey,
  __clearPending,
} from './pending-recovery-key.service.js';

beforeEach(() => {
  __clearPending();
});

describe('pending-recovery-key.service', () => {
  it('returns null when nothing is pending', () => {
    expect(peekPendingRecoveryKey('nope')).toBeNull();
  });

  it('round-trips stash → peek', () => {
    stashPendingRecoveryKey('install-1', 'RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
    expect(peekPendingRecoveryKey('install-1')).toBe('RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
  });

  it('is addressable per installation ID', () => {
    stashPendingRecoveryKey('install-1', 'KEY-ONE');
    stashPendingRecoveryKey('install-2', 'KEY-TWO');
    expect(peekPendingRecoveryKey('install-1')).toBe('KEY-ONE');
    expect(peekPendingRecoveryKey('install-2')).toBe('KEY-TWO');
  });

  it('acknowledge removes the entry', () => {
    stashPendingRecoveryKey('install-1', 'KEY');
    expect(acknowledgePendingRecoveryKey('install-1')).toBe(true);
    expect(peekPendingRecoveryKey('install-1')).toBeNull();
  });

  it('acknowledge returns false when nothing was pending', () => {
    expect(acknowledgePendingRecoveryKey('nope')).toBe(false);
  });

  it('peek is non-destructive (does not clear the entry)', () => {
    stashPendingRecoveryKey('install-1', 'KEY');
    expect(peekPendingRecoveryKey('install-1')).toBe('KEY');
    expect(peekPendingRecoveryKey('install-1')).toBe('KEY');
    expect(peekPendingRecoveryKey('install-1')).toBe('KEY');
  });

  it('stashing the same key twice overwrites the first entry', () => {
    stashPendingRecoveryKey('install-1', 'FIRST');
    stashPendingRecoveryKey('install-1', 'SECOND');
    expect(peekPendingRecoveryKey('install-1')).toBe('SECOND');
  });
});
