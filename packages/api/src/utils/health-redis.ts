// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import RedisPkg from 'ioredis';

// Lazy Redis client dedicated to the health-probe path. We deliberately
// do NOT reuse the rate-limit-store client because:
//   1. The rate-limit store is opt-in (RATE_LIMIT_REDIS=1) — the health
//      probe must work whether or not that flag is on.
//   2. Health-probe wedge protection (commandTimeout 1500ms) is tighter
//      than the rate-limit store's 500ms — but the rate-limit client
//      uses `lazyConnect: true` and doesn't actually connect until the
//      first store operation, so a fresh dedicated client gives us a
//      clean separate failure surface here.
//
// `lazyConnect: true` means the constructor doesn't open a socket until
// the first command — so importing this module is free, and
// `redisPing()` is the only thing that triggers the connect handshake.

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);
type RedisClient = InstanceType<typeof Redis>;

let sharedClient: RedisClient | null = null;

function getClient(): RedisClient {
  if (sharedClient) return sharedClient;
  const url = process.env['REDIS_URL'] || 'redis://redis:6379';
  sharedClient = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    commandTimeout: 1500,
    lazyConnect: true,
    // Don't queue commands while disconnected — the health probe
    // wants a fast failure, not a backlog of pings.
    enableOfflineQueue: false,
  });
  sharedClient.on('error', () => {
    // Suppress per-error logs from this client. The health probe
    // surfaces failures via the response body; routine reconnect
    // chatter would just add noise.
  });
  return sharedClient;
}

export interface RedisPingResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Single-shot Redis PING. Always resolves; never throws. The 2s outer
 * race matches the existing DB probe so the whole `/health` handler
 * has a bounded worst-case duration.
 */
export async function redisPing(): Promise<RedisPingResult> {
  const t0 = Date.now();
  try {
    const client = getClient();
    const result = await Promise.race([
      client.ping(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('redis probe timeout')), 2000),
      ),
    ]);
    const latencyMs = Date.now() - t0;
    return { ok: result === 'PONG', latencyMs };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test hook — close the shared client so Vitest can exit cleanly.
 */
export async function closeHealthRedis(): Promise<void> {
  if (sharedClient) {
    await sharedClient.quit().catch(() => undefined);
    sharedClient = null;
  }
}
