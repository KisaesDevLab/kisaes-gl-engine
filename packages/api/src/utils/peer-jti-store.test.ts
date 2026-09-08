// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  consumeJti, setPeerJtiClientForTests, closePeerJtiStore, JtiStoreUnavailableError, type JtiRedisLike,
} from './peer-jti-store.js';

// Fake with real SET NX EX semantics so the contract is testable without
// Redis; the last test runs against the real client to prove the wiring.
function fakeRedis(): JtiRedisLike & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    async set(key, _value, _mode, ttl, _nx) {
      const now = Date.now();
      const exp = keys.get(key);
      if (exp !== undefined && exp > now) return null;
      keys.set(key, now + ttl * 1000);
      return 'OK';
    },
  };
}

afterEach(async () => {
  await closePeerJtiStore();
});

describe('peer jti store', () => {
  it('first claim wins, second is a replay', async () => {
    setPeerJtiClientForTests(fakeRedis());
    const jti = crypto.randomUUID();
    expect(await consumeJti('https://pm.example', jti)).toBe(true);
    expect(await consumeJti('https://pm.example', jti)).toBe(false);
  });

  it('isolates issuers — the same jti under another issuer is fresh', async () => {
    setPeerJtiClientForTests(fakeRedis());
    const jti = crypto.randomUUID();
    expect(await consumeJti('https://a.example', jti)).toBe(true);
    expect(await consumeJti('https://b.example', jti)).toBe(true);
  });

  it('expires after the ttl', async () => {
    const fake = fakeRedis();
    setPeerJtiClientForTests(fake);
    const jti = crypto.randomUUID();
    expect(await consumeJti('https://pm.example', jti, 1)).toBe(true);
    // Age the key past its ttl instead of sleeping.
    for (const [k, v] of fake.keys) fake.keys.set(k, v - 2000);
    expect(await consumeJti('https://pm.example', jti, 1)).toBe(true);
  });

  it('fails CLOSED when the client throws', async () => {
    setPeerJtiClientForTests({ async set() { throw new Error('ECONNREFUSED'); } });
    await expect(consumeJti('https://pm.example', crypto.randomUUID())).rejects.toBeInstanceOf(JtiStoreUnavailableError);
  });

  it('works against the real Redis client', async () => {
    setPeerJtiClientForTests(null);
    const jti = crypto.randomUUID();
    expect(await consumeJti('https://real.example', jti, 5)).toBe(true);
    expect(await consumeJti('https://real.example', jti, 5)).toBe(false);
  });
});
