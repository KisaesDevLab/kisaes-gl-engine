// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import RedisPkg from 'ioredis';
import { RedisStore, type SendCommandFn } from 'rate-limit-redis';
import type { Store } from 'express-rate-limit';
import { recordSecurityEvent } from './security-audit.js';

// ioredis v5 ships a CommonJS default export; TS sees it as a
// namespace through node's interop. Unwrap to the constructor and
// grab the instance type from it. Works under both `esModuleInterop`
// modes without shims.
const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);
type RedisClient = InstanceType<typeof Redis>;

// CLOUDFLARE_TUNNEL_PLAN Phase 5 — Redis-backed rate limiter store.
//
// With the default in-memory store, rate-limit counters evaporate on
// every container restart and don't coordinate across multiple api
// replicas. For single-container installs this is fine; for any
// deployment with autoscaling or just a restart-during-attack, the
// operator wants the counters to survive and to be shared across
// replicas.
//
// The store is opt-in: set RATE_LIMIT_REDIS=1 to enable. When off,
// `getRateLimitStore()` returns undefined and every limiter falls back
// to the default in-memory behaviour — which matches the existing
// single-container default and keeps the Vitest suite airgapped
// without special setup.
//
// We share a single ioredis connection across every limiter via a
// module-level cache. ioredis reconnects automatically on transient
// failures, and the rate-limit-redis store reads scripts via EVAL /
// EVALSHA so a short network blip doesn't lose counters.

let sharedClient: RedisClient | null = null;

function getClient(): RedisClient {
  if (sharedClient) return sharedClient;
  const url = process.env['REDIS_URL'] || 'redis://redis:6379';
  sharedClient = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // rate-limit-redis only runs small ops; a tight command timeout
    // keeps a wedged Redis from wedging the whole login path.
    commandTimeout: 500,
    lazyConnect: true,
  });
  sharedClient.on('error', (err: Error) => {
    // Log once per minute-ish rather than per-call; ioredis will keep
    // retrying in the background.
    console.warn('[rate-limit-redis] Redis error:', err.message);
    // Also emit a coalesced security-degradation audit row so super-
    // admins see that RATE_LIMIT_REDIS=1 is effectively fallback-in-
    // memory. Gated behind RATE_LIMIT_REDIS_ALERT so operators can
    // silence the alert if Redis flapping becomes background noise.
    if (process.env['RATE_LIMIT_REDIS_ALERT'] !== '0') {
      recordSecurityEvent({
        component: 'rate_limit_redis',
        reason: 'connection_error',
        details: { message: err.message },
      });
    }
  });
  return sharedClient;
}

/**
 * Build an express-rate-limit Store backed by Redis, or `undefined`
 * when the feature flag is off (the limiter falls back to its built-in
 * in-memory store in that case).
 *
 * `prefix` is namespaced into Redis keys so multiple limiters sharing
 * the same instance don't collide (`rl:login:...`, `rl:global:...`).
 */
export function getRateLimitStore(prefix: string): Store | undefined {
  if (process.env['RATE_LIMIT_REDIS'] !== '1') return undefined;
  const client = getClient();
  // The ioredis `call` signature and rate-limit-redis's
  // `sendCommand` expectation agree at runtime but the TS types don't
  // line up (variadic overloads vs. generic string[]). Cast once at
  // the boundary — rate-limit-redis's README documents the exact
  // usage pattern here.
  const callClient = client.call.bind(client) as unknown as (...a: string[]) => Promise<unknown>;
  return new RedisStore({
    sendCommand: callClient as unknown as SendCommandFn,
    prefix: `rl:${prefix}:`,
  });
}

/**
 * Test hook — close the shared client so Vitest can exit cleanly when
 * a test opts into Redis mode.
 */
export async function closeRateLimitStore(): Promise<void> {
  if (!sharedClient) return;
  try { await sharedClient.quit(); } catch { /* ignore */ }
  sharedClient = null;
}
