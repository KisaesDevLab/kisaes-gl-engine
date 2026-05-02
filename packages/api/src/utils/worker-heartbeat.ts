// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Worker heartbeat — vibe-mybooks-compatibility-addendum §3.6.
 *
 * The worker container periodically writes a Redis key with a short
 * TTL; the API's `/health` handler reads the keys to populate a
 * `workers` sub-check. Together they let an operator distinguish
 * "API is up but worker died" from "everything is fine" without
 * shelling into the host.
 *
 * Key shape: `mybooks:workers:heartbeat:<workerId>` → `<iso8601>`
 * TTL: 30s (twice the 15s write interval, so a single missed tick
 * doesn't trip the alarm but a real outage does within 30s).
 *
 * `workerId` is generated once per process via `os.hostname()` (so
 * Docker container ID is the natural identifier; fans out cleanly if
 * the operator scales to multiple worker replicas in the future) with
 * a randomUUID suffix to disambiguate when two replicas share a
 * hostname.
 */

import RedisPkg from 'ioredis';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);
type RedisClient = InstanceType<typeof Redis>;

export const HEARTBEAT_KEY_PREFIX = 'mybooks:workers:heartbeat:';
export const HEARTBEAT_TTL_SECONDS = 30;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_THRESHOLD_MS = 30_000;

let writeClient: RedisClient | null = null;
let readClient: RedisClient | null = null;

function makeClient(): RedisClient {
  const url = process.env['REDIS_URL'] || 'redis://redis:6379';
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    commandTimeout: 2000,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  client.on('error', () => {
    // Suppress per-error logs — heartbeat write failures are best-effort
    // and the read side surfaces missing keys via /health.
  });
  return client;
}

function getWriteClient(): RedisClient {
  if (!writeClient) writeClient = makeClient();
  return writeClient;
}

function getReadClient(): RedisClient {
  if (!readClient) readClient = makeClient();
  return readClient;
}

/**
 * Generate a stable worker identifier for this process.
 *
 * Hostname-based so it's identifiable in `KEYS mybooks:workers:heartbeat:*`
 * output; a UUID suffix keeps it unique across replicas that share the
 * same hostname (Kubernetes deployments, etc.).
 */
export function generateWorkerId(): string {
  return `${hostname()}-${randomUUID().slice(0, 8)}`;
}

export interface HeartbeatHandle {
  workerId: string;
  /** Stop writing heartbeats and DEL this worker's key on graceful shutdown. */
  stop: () => Promise<void>;
}

/**
 * Begin the heartbeat write loop. Returns a handle whose `.stop()` is
 * idempotent — safe to call from multiple shutdown paths.
 */
export function startHeartbeat(workerId: string = generateWorkerId()): HeartbeatHandle {
  const key = `${HEARTBEAT_KEY_PREFIX}${workerId}`;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const client = getWriteClient();
      await client.set(key, new Date().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
    } catch {
      // Best effort — health probe will surface missing heartbeats.
    }
  };

  // Immediate write so /health doesn't show degraded for the first
  // 15 seconds after worker boot.
  void tick();
  const handle = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  // unref so the heartbeat doesn't keep the event loop alive past
  // the schedulers' shutdown window — process should exit cleanly
  // even if shutdown forgets to call .stop().
  if (typeof handle.unref === 'function') handle.unref();

  return {
    workerId,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      try {
        await getWriteClient().del(key);
      } catch {
        // Already disconnected — TTL will reap the key within 30s.
      }
    },
  };
}

export interface WorkerHeartbeatStatus {
  /** True iff at least one heartbeat exists with age < 30s. */
  ok: boolean;
  count: number;
  /** Age of the freshest heartbeat in ms (null if no keys present). */
  lastHeartbeatMs: number | null;
  error?: string;
}

/**
 * Read all worker-heartbeat keys and return the freshest age. Used by
 * `/health` to expose a `workers` sub-check.
 *
 * SCAN rather than KEYS — production-safe even at scale. Bounded by
 * the COUNT hint and a hard cap on iterations so a misbehaving Redis
 * (e.g. millions of unrelated keys) can't wedge the health probe.
 */
export async function readHeartbeats(): Promise<WorkerHeartbeatStatus> {
  const client = getReadClient();
  try {
    const keys: string[] = [];
    let cursor = '0';
    let iterations = 0;
    const MAX_ITERATIONS = 50;
    do {
      const [next, batch] = await client.scan(
        cursor,
        'MATCH',
        `${HEARTBEAT_KEY_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = next;
      for (const k of batch) keys.push(k);
      iterations += 1;
    } while (cursor !== '0' && iterations < MAX_ITERATIONS);

    if (keys.length === 0) {
      return { ok: false, count: 0, lastHeartbeatMs: null };
    }

    const values = await client.mget(...keys);
    const now = Date.now();
    let freshest: number | null = null;
    for (const v of values) {
      if (!v) continue;
      const t = Date.parse(v);
      if (Number.isNaN(t)) continue;
      const age = now - t;
      if (freshest === null || age < freshest) freshest = age;
    }

    const ok = freshest !== null && freshest < HEARTBEAT_STALE_THRESHOLD_MS;
    return { ok, count: keys.length, lastHeartbeatMs: freshest };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      lastHeartbeatMs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test hook — close shared clients so Vitest can exit cleanly.
 */
export async function closeWorkerHeartbeatClients(): Promise<void> {
  if (writeClient) {
    await writeClient.quit().catch(() => undefined);
    writeClient = null;
  }
  if (readClient) {
    await readClient.quit().catch(() => undefined);
    readClient = null;
  }
}
