// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import RedisPkg from 'ioredis';
import { recordSecurityEvent } from './security-audit.js';

// ─── Peer-token jti replay store ────────────────────────────────
//
// Every Vibe PM peer token carries a unique `jti` and lives at most
// five minutes. A token must be accepted exactly once: the first
// request to present it wins, a second presentation is a replay. The
// store is a Redis `SET key 1 EX ttl NX` — atomic across replicas.
//
// Unlike passkey-challenge-store this does NOT degrade to a process-
// local map when Redis is unreachable. A memory fallback would make
// replay protection per-replica (and per-restart), which is exactly
// the hole a replayed bearer token exploits. When Redis is down the
// peer API refuses tokens (fail closed) — PM retries, nothing leaks.
// The dedicated client also means the rate-limit store's own
// degrade-to-memory policy never applies here.

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);
type RedisClient = InstanceType<typeof Redis>;

const PREFIX = 'peer:jti:';

/** Minimal surface the store needs — lets tests inject a fake. */
export interface JtiRedisLike {
  set(key: string, value: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<string | null>;
}

let sharedClient: RedisClient | null = null;
let override: JtiRedisLike | null = null;
let lastErrorLog = 0;

async function getClient(): Promise<JtiRedisLike> {
  if (override) return override;
  if (sharedClient) {
    // lazyConnect + no offline queue: the very first command would fail
    // before the socket is up. Connect explicitly once; after that a
    // dropped connection makes commands throw (= fail closed) while
    // ioredis reconnects in the background.
    if (sharedClient.status === 'wait') await sharedClient.connect();
    return sharedClient;
  }
  const url = process.env['REDIS_URL'] || 'redis://redis:6379';
  sharedClient = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    commandTimeout: 1000,
    lazyConnect: true,
  });
  sharedClient.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastErrorLog < 60_000) return;
    lastErrorLog = now;
    recordSecurityEvent({
      component: 'peer_jti_redis',
      reason: 'connection_error',
      details: { message: err.message },
    });
  });
  await sharedClient.connect();
  return sharedClient;
}

export class JtiStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Peer jti store unavailable');
    this.name = 'JtiStoreUnavailableError';
    this.cause = cause;
  }
}

/**
 * Claim a jti for an issuer. Returns true when this is the first time
 * the pair is seen (token accepted), false on replay. Throws
 * JtiStoreUnavailableError when Redis cannot answer — callers MUST treat
 * that as a rejection, never as "first time".
 */
export async function consumeJti(issuer: string, jti: string, ttlSec = 360): Promise<boolean> {
  const key = `${PREFIX}${issuer}:${jti}`;
  let result: string | null;
  try {
    result = await (await getClient()).set(key, '1', 'EX', ttlSec, 'NX');
  } catch (err) {
    recordSecurityEvent({
      component: 'peer_jti_redis',
      reason: 'command_failed',
      details: { message: err instanceof Error ? err.message : String(err) },
    });
    throw new JtiStoreUnavailableError(err);
  }
  return result === 'OK';
}

/** Test hook — swap the backing client (pass null to restore Redis). */
export function setPeerJtiClientForTests(client: JtiRedisLike | null): void {
  override = client;
}

/** Test hook — close the shared client so Vitest can exit cleanly. */
export async function closePeerJtiStore(): Promise<void> {
  override = null;
  if (!sharedClient) return;
  try {
    await sharedClient.quit();
  } catch {
    sharedClient.disconnect();
  }
  sharedClient = null;
}
