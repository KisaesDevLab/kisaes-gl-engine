// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getRateLimitStore } from './rate-limit-store.js';

describe('getRateLimitStore', () => {
  const original = process.env['RATE_LIMIT_REDIS'];
  beforeEach(() => { delete process.env['RATE_LIMIT_REDIS']; });
  afterEach(() => {
    if (original === undefined) delete process.env['RATE_LIMIT_REDIS'];
    else process.env['RATE_LIMIT_REDIS'] = original;
  });

  it('returns undefined when the feature flag is off — limiters use in-memory default', () => {
    expect(getRateLimitStore('test')).toBeUndefined();
  });

  it('returns undefined when the feature flag is explicitly disabled', () => {
    process.env['RATE_LIMIT_REDIS'] = '0';
    expect(getRateLimitStore('test')).toBeUndefined();
  });

  // The positive path (RATE_LIMIT_REDIS=1 → real RedisStore instance)
  // opens a live connection via ioredis; covered by a deploy-time
  // smoke rather than here so Vitest stays airgapped.
});
