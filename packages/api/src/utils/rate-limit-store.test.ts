// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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

describe('ResilientStore (RATE_LIMIT_REDIS=1)', () => {
  const originalFlag = process.env['RATE_LIMIT_REDIS'];
  const originalUrl = process.env['REDIS_URL'];
  afterEach(async () => {
    const { closeRateLimitStore } = await import('./rate-limit-store.js');
    await closeRateLimitStore();
    if (originalFlag === undefined) delete process.env['RATE_LIMIT_REDIS']; else process.env['RATE_LIMIT_REDIS'] = originalFlag;
    if (originalUrl === undefined) delete process.env['REDIS_URL']; else process.env['REDIS_URL'] = originalUrl;
  });

  it('with an UNREACHABLE redis: no unhandled rejection at construction, increments served from memory', async () => {
    process.env['RATE_LIMIT_REDIS'] = '1';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:1'; // nothing listens here
    const { closeRateLimitStore } = await import('./rate-limit-store.js');
    await closeRateLimitStore(); // drop any client from a previous test
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const store = getRateLimitStore('unreachable-test')!;
      expect(store).toBeDefined();
      store.init!({ windowMs: 60_000 } as any);
      // Let the constructor's SCRIPT LOAD promises settle (they reject).
      await new Promise((r) => setTimeout(r, 2600));
      const key = `k-${Date.now()}`;
      // MemoryStore returns its live client record (mutated by the next
      // increment), so snapshot the counts immediately.
      const aHits = (await store.increment(key)).totalHits;
      const bHits = (await store.increment(key)).totalHits;
      expect(aHits).toBe(1);
      expect(bHits).toBe(2);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 15_000);

  it('with the test redis (127.0.0.1:6390): counters go through redis', async () => {
    process.env['RATE_LIMIT_REDIS'] = '1';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6390';
    const { closeRateLimitStore } = await import('./rate-limit-store.js');
    await closeRateLimitStore();
    // Skip cleanly when the optional test-redis container isn't running.
    const net = await import('node:net');
    const reachable = await new Promise<boolean>((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port: 6390 });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 500);
    });
    if (!reachable) return;
    const store = getRateLimitStore(`redis-test-${Date.now()}`)!;
    store.init!({ windowMs: 60_000 } as any);
    // The store short-circuits to memory until the socket is up (and while
    // the breaker is open after a failure) — wait for "ready" so this test
    // really exercises the Redis path.
    const { rateLimitRedisReady } = await import('./rate-limit-store.js');
    for (let i = 0; i < 40 && !rateLimitRedisReady(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(rateLimitRedisReady()).toBe(true);
    const key = `k-${Date.now()}`;
    const a = await store.increment(key);
    const b = await store.increment(key);
    expect(a.totalHits).toBe(1);
    expect(b.totalHits).toBe(2);
    const got = await store.get!(key);
    expect(got?.totalHits).toBe(2);
    await store.resetKey(key);
    // rate-limit-redis reports a missing key as NaN hits (library quirk).
    const after = await store.get!(key);
    expect(after === undefined || !(after.totalHits > 0)).toBe(true);
  }, 15_000);

  it('with an UNREACHABLE redis the breaker short-circuits: increments do not wait out the command timeout', async () => {
    process.env['RATE_LIMIT_REDIS'] = '1';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
    const { closeRateLimitStore, rateLimitRedisReady } = await import('./rate-limit-store.js');
    await closeRateLimitStore();
    const store = getRateLimitStore('breaker-test')!;
    store.init!({ windowMs: 60_000 } as any);
    expect(rateLimitRedisReady()).toBe(false); // socket never comes up
    const key = `k-${Date.now()}`;
    const t0 = Date.now();
    const a = (await store.increment(key)).totalHits;
    const b = (await store.increment(key)).totalHits;
    const elapsed = Date.now() - t0;
    expect(a).toBe(1);
    expect(b).toBe(2);
    // Two increments that each waited for the 2 s command timeout would take
    // ≥ 4 s; the short-circuit answers from memory immediately.
    expect(elapsed).toBeLessThan(500);
  }, 15_000);
});
