// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  _configurePassphraseLimiterForTests, _resetPassphraseLimiterForTests,
  assertPassphraseAttemptAllowed, clearPassphraseFailures, recordPassphraseFailure,
} from './passphrase-limiter.js';

beforeEach(() => {
  _resetPassphraseLimiterForTests();
  _configurePassphraseLimiterForTests({ maxFailures: 3, windowMs: 1000 });
});
afterAll(() => _resetPassphraseLimiterForTests());

describe('passphrase limiter (M3)', () => {
  it('allows attempts until the failures reach the limit inside the window, per user', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(() => assertPassphraseAttemptAllowed('u1', t0 + i)).not.toThrow();
      recordPassphraseFailure('u1', t0 + i);
    }
    let err: unknown;
    try {
      assertPassphraseAttemptAllowed('u1', t0 + 10);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'PASSPHRASE_RATE_LIMITED', statusCode: 429 });
    expect((err as { details: { retryAfterSec: number } }).details.retryAfterSec).toBe(1);
    expect(() => assertPassphraseAttemptAllowed('u2', t0 + 10)).not.toThrow();
  });

  it('forgets failures after the window and on a successful passphrase', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) recordPassphraseFailure('u1', t0);
    expect(() => assertPassphraseAttemptAllowed('u1', t0 + 999)).toThrow();
    expect(() => assertPassphraseAttemptAllowed('u1', t0 + 1000)).not.toThrow();
    for (let i = 0; i < 3; i++) recordPassphraseFailure('u1', t0 + 2000);
    clearPassphraseFailures('u1');
    expect(() => assertPassphraseAttemptAllowed('u1', t0 + 2001)).not.toThrow();
  });
});
