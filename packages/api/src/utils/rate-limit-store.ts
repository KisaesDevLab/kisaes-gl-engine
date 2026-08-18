// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import RedisPkg from 'ioredis';
import { RedisStore, type SendCommandFn } from 'rate-limit-redis';
import { MemoryStore, type Store, type Options, type ClientRateLimitInfo } from 'express-rate-limit';
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
  breakerOpenUntil = 0; // fresh client, fresh breaker
  sharedClient = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Small ops only, but the timeout also covers time spent in the
    // offline queue while the socket is still connecting — at boot ~28
    // limiters issue SCRIPT LOAD simultaneously before the connection is
    // up. 500 ms + lazyConnect made those time out and (because
    // rate-limit-redis stores the constructor's SCRIPT LOAD promise
    // without a handler) crash the process with an unhandled rejection.
    // Connect eagerly and allow 2 s; ResilientStore below falls back to
    // memory on any error, so a wedged Redis still can't wedge login.
    commandTimeout: 2000,
    lazyConnect: false,
  });
  sharedClient.on('error', (err: Error) => {
    // One line per reconnect attempt (~every 2 s during an outage); the
    // audit row below is what's coalesced. ioredis keeps retrying.
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
/**
 * Redis-backed store that degrades to a per-limiter MemoryStore when
 * Redis is unreachable / times out, instead of throwing into the request
 * path (express-rate-limit would surface that as a 500 on /login) or —
 * worse — crashing the process at boot. Redis errors are logged at most
 * once a minute; the security-audit row is written by getClient()'s error
 * handler. Counters silently continue in memory while degraded, exactly
 * the behaviour the appliance had before RATE_LIMIT_REDIS existed.
 */
// Short-circuit breaker shared by every ResilientStore: after a command
// failure, skip Redis for BREAKER_OPEN_MS and serve from memory directly.
// Without it every limiter in a request chain pays the 2 s command timeout
// (twice — rate-limit-redis reloads the script) while Redis is down: a
// login (global + auth + per-account limiter) stalled ~12 s. `client.status`
// tells us up front when the socket isn't ready, so nothing is even tried.
const BREAKER_OPEN_MS = 30_000;
let breakerOpenUntil = 0;
let breakerAuditAt = 0;
function redisUsable(client: RedisClient | null): boolean {
  if (Date.now() < breakerOpenUntil) return false;
  // enableReadyCheck is off, so 'connect' → 'ready' is immediate; accept both.
  return !!client && (client.status === 'ready' || client.status === 'connect');
}
function tripBreaker(reason: string, err: unknown): void {
  breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
  // Command timeouts don't surface as ioredis 'error' events, so the
  // degradation audit row is written from here as well (coalesced 1/min).
  const now = Date.now();
  if (process.env['RATE_LIMIT_REDIS_ALERT'] !== '0' && now - breakerAuditAt > 60_000) {
    breakerAuditAt = now;
    recordSecurityEvent({
      component: 'rate_limit_redis',
      reason: 'command_failed',
      details: { op: reason, message: (err as Error)?.message ?? String(err), fallbackMs: BREAKER_OPEN_MS },
    });
  }
}

class ResilientStore implements Store {
  localKeys = false;
  prefix: string;
  private readonly redis: RedisStore;
  private readonly memory = new MemoryStore();
  private lastWarnAt = 0;

  constructor(prefix: string, sendCommand: SendCommandFn) {
    this.prefix = prefix;
    this.redis = new RedisStore({ sendCommand, prefix });
    // rate-limit-redis kicks off SCRIPT LOAD in its constructor and parks
    // the promises on public fields with no rejection handler; if Redis
    // is slow/down at boot that rejection is unhandled → process exit.
    // Marking them handled here changes nothing else: the store still
    // awaits them and re-loads on failure.
    const r = this.redis as unknown as { incrementScriptSha?: Promise<unknown>; getScriptSha?: Promise<unknown> };
    r.incrementScriptSha?.catch(() => { /* handled in ResilientStore */ });
    r.getScriptSha?.catch(() => { /* handled in ResilientStore */ });
  }

  private warn(op: string, err: unknown): void {
    tripBreaker(op, err);
    const now = Date.now();
    if (now - this.lastWarnAt > 60_000) {
      this.lastWarnAt = now;
      console.warn(`[rate-limit-redis] ${op} failed for ${this.prefix} — serving from in-memory counters for ${BREAKER_OPEN_MS / 1000}s:`, (err as Error)?.message ?? err);
    }
  }

  init(options: Options): void {
    this.redis.init(options);
    this.memory.init(options);
  }
  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    if (!redisUsable(sharedClient)) return this.memory.get(key);
    try { return await this.redis.get(key); } catch (err) { this.warn('get', err); return this.memory.get(key); }
  }
  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (!redisUsable(sharedClient)) return this.memory.increment(key);
    try { return await this.redis.increment(key); } catch (err) { this.warn('increment', err); return this.memory.increment(key); }
  }
  async decrement(key: string): Promise<void> {
    if (!redisUsable(sharedClient)) { await this.memory.decrement(key); return; }
    try { await this.redis.decrement(key); } catch (err) { this.warn('decrement', err); await this.memory.decrement(key); }
  }
  async resetKey(key: string): Promise<void> {
    if (redisUsable(sharedClient)) {
      try { await this.redis.resetKey(key); } catch (err) { this.warn('resetKey', err); }
    }
    await this.memory.resetKey(key);
  }
  async resetAll(): Promise<void> {
    await this.memory.resetAll();
  }
  shutdown(): void {
    this.memory.shutdown();
  }
}

export function getRateLimitStore(prefix: string): Store | undefined {
  if (process.env['RATE_LIMIT_REDIS'] !== '1') return undefined;
  const client = getClient();
  // The ioredis `call` signature and rate-limit-redis's
  // `sendCommand` expectation agree at runtime but the TS types don't
  // line up (variadic overloads vs. generic string[]). Cast once at
  // the boundary — rate-limit-redis's README documents the exact
  // usage pattern here.
  const callClient = client.call.bind(client) as unknown as (...a: string[]) => Promise<unknown>;
  return new ResilientStore(`rl:${prefix}:`, callClient as unknown as SendCommandFn);
}

/**
 * Test hook — close the shared client so Vitest can exit cleanly when
 * a test opts into Redis mode.
 */
export async function closeRateLimitStore(): Promise<void> {
  breakerOpenUntil = 0;
  if (!sharedClient) return;
  try { await sharedClient.quit(); } catch { /* ignore */ }
  sharedClient = null;
}

/** Test/diagnostic hook: is the shared client connected and the breaker closed? */
export function rateLimitRedisReady(): boolean {
  return redisUsable(sharedClient);
}
