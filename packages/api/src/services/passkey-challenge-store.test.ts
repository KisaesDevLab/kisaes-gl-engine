// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, afterAll } from 'vitest';
import {
  storeRegistrationChallenge,
  consumeRegistrationChallenge,
  storeAuthenticationChallenge,
  consumeAuthenticationChallenge,
  closePasskeyChallengeStore,
} from './passkey-challenge-store.js';

// These assertions describe the contract the WebAuthn flow depends on and
// hold for BOTH backends — Redis (GETDEL) and the in-memory fallback — so
// the test passes whether or not a Redis is reachable in the environment.

afterAll(async () => {
  await closePasskeyChallengeStore();
});

describe('passkey challenge store — single-use semantics', () => {
  it('returns a stored registration challenge exactly once', async () => {
    const userId = 'user-reg-1';
    const challenge = 'reg-challenge-AAAA_-';
    await storeRegistrationChallenge(userId, challenge);

    expect(await consumeRegistrationChallenge(userId)).toBe(challenge);
    // Burned — a second consume must miss.
    expect(await consumeRegistrationChallenge(userId)).toBeNull();
  });

  it('returns null for a registration challenge that was never stored', async () => {
    expect(await consumeRegistrationChallenge('user-never-stored')).toBeNull();
  });

  it('isolates registration challenges per user', async () => {
    await storeRegistrationChallenge('user-a', 'challenge-a');
    await storeRegistrationChallenge('user-b', 'challenge-b');

    expect(await consumeRegistrationChallenge('user-a')).toBe('challenge-a');
    // user-a's consume must not have burned user-b's challenge.
    expect(await consumeRegistrationChallenge('user-b')).toBe('challenge-b');
  });

  it('accepts a stored authentication challenge exactly once', async () => {
    const challenge = 'auth-challenge-BBBB_-';
    await storeAuthenticationChallenge(challenge);

    expect(await consumeAuthenticationChallenge(challenge)).toBe(true);
    // Single-use: the same challenge cannot be replayed.
    expect(await consumeAuthenticationChallenge(challenge)).toBe(false);
  });

  it('rejects an authentication challenge that was never issued', async () => {
    expect(await consumeAuthenticationChallenge('forged-challenge-CCCC_-')).toBe(false);
  });
});
