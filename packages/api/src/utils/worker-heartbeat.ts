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
 * a 4-byte random suffix to disambiguate when two replicas share a
 * hostname.
 */

import RedisPkg from 'ioredis';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);
type RedisClient = InstanceType<typeof Redis>;

export const HEARTBEAT_KEY_PREFIX = 'mybooks:workers:heartbeat:';
export const HEARTBEAT_TTL_SECONDS = 30;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_THRESHOLD_MS = 30_000;
/** Hard cap on consecutive observed write failures before we log a warning. */
const FAILURE_LOG_THRESHOLD = 3;
/** Maximum keys we'll consider in a single readHeartbeats() pass. */
const READ_BATCH_SIZE = 100;
/** Hard cap on SCAN iterations to bound /health latency. */
const READ_SCAN_MAX_ITERATIONS = 50;
/** Timeout for stop()'s DEL — falls through to TTL reaper if it lapses. */
const STOP_DEL_TIMEOUT_MS = 1_000;

let writeClient: RedisClient | null = null;
let readClient: RedisClient | null = null;
/**
 * Module-level shutdown flag. Once set, `getWriteClient`/`getReadClient`
 * refuse to spawn a new client — preventing a `tick()` mid-flight from
 * resurrecting a connection after `closeWorkerHeartbeatClients()` has
 * already torn things down.
 */
let closing = false;

function makeClient(): RedisClient {
  const url = process.env['REDIS_URL'] || 'redis://redis:6379';
  const client = new Redis(url, {
    // No retries: with `enableOfflineQueue: false` the command rejects
    // immediately on a disconnected client. Retries would just delay
    // the rejection without queueing — pointless wall-clock burn that
    // could push past the 15s heartbeat interval.
    maxRetriesPerRequest: 0,
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

function getWriteClient(): RedisClient | null {
  if (closing) return null;
  if (!writeClient) writeClient = makeClient();
  return writeClient;
}

function getReadClient(): RedisClient | null {
  if (closing) return null;
  if (!readClient) readClient = makeClient();
  return readClient;
}

/**
 * Generate a stable worker identifier for this process.
 *
 * Hostname-based so it's identifiable in `KEYS mybooks:workers:heartbeat:*`
 * output; an 8-hex-char random suffix keeps it unique across replicas
 * that share the same hostname (Kubernetes deployments, etc.). Using
 * `randomBytes(4)` rather than `randomUUID().slice(0, 8)` gives a
 * full 32 bits of entropy without UUID v4's version bits cutting in.
 */
export function generateWorkerId(): string {
  return `${hostname()}-${randomBytes(4).toString('hex')}`;
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
  let consecutiveFailures = 0;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const client = getWriteClient();
    if (!client) return; // closing — give up cleanly
    try {
      await client.set(key, new Date().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      // Log on the threshold-th failure, then once every threshold
      // failures, so a wedged Redis doesn't fill stdout with one
      // line per 15s but operators still see *something*.
      if (consecutiveFailures === FAILURE_LOG_THRESHOLD ||
          consecutiveFailures % (FAILURE_LOG_THRESHOLD * 4) === 0) {
        console.warn(
          `[worker-heartbeat] ${consecutiveFailures} consecutive heartbeat-write failures: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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
      // Race the DEL against a short timeout — if Redis is wedged we'd
      // rather drop the key via TTL reaping (within 30s) than block
      // shutdown for the ioredis commandTimeout (2s × however many
      // queued ops). Worker shutdown deadline is ~10s; this keeps us
      // well under.
      const client = getWriteClient();
      if (!client) return;
      try {
        await Promise.race([
          client.del(key),
          new Promise<void>((_, rej) =>
            setTimeout(() => rej(new Error('stop del timeout')), STOP_DEL_TIMEOUT_MS),
          ),
        ]);
      } catch {
        // TTL will reap the key in HEARTBEAT_TTL_SECONDS — comment
        // here documents that this is the intentional fallback.
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
 *
 * Note: COUNT is a hint, not a guarantee. With ~5000 unrelated keys
 * per iteration × 50 iterations = ~250k keys scanned worst-case. If
 * the deployment has more total keys than that, some heartbeats may
 * be missed, producing a false `workers: fail`. Today nothing else
 * uses long-lived Redis keys at this scale; if that changes, we'll
 * need a registry sorted-set to track active worker IDs explicitly.
 *
 * MGET is chunked into batches of 100 to keep individual round-trips
 * bounded — a single MGET with thousands of keys would still work
 * but the wire payload would be unbounded.
 */
export async function readHeartbeats(): Promise<WorkerHeartbeatStatus> {
  const client = getReadClient();
  if (!client) {
    return { ok: false, count: 0, lastHeartbeatMs: null, error: 'heartbeat clients are closing' };
  }
  try {
    const keys: string[] = [];
    let cursor = '0';
    let iterations = 0;
    do {
      const [next, batch] = await client.scan(
        cursor,
        'MATCH',
        `${HEARTBEAT_KEY_PREFIX}*`,
        'COUNT',
        READ_BATCH_SIZE,
      );
      cursor = next;
      for (const k of batch) keys.push(k);
      iterations += 1;
    } while (cursor !== '0' && iterations < READ_SCAN_MAX_ITERATIONS);

    if (keys.length === 0) {
      return { ok: false, count: 0, lastHeartbeatMs: null };
    }

    // Chunk MGET — a single all-keys MGET works but the payload
    // grows unboundedly with replica count. Batches of 100 keep
    // each round-trip predictable.
    const now = Date.now();
    let freshest: number | null = null;
    for (let i = 0; i < keys.length; i += READ_BATCH_SIZE) {
      const chunk = keys.slice(i, i + READ_BATCH_SIZE);
      const values = await client.mget(...chunk);
      for (const v of values) {
        if (!v) continue;
        const t = Date.parse(v);
        if (Number.isNaN(t)) continue;
        const age = now - t;
        if (freshest === null || age < freshest) freshest = age;
      }
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
 *
 * Sets the module-level `closing` flag FIRST so any in-flight `tick()`
 * that returns to the event loop after this point sees `getWriteClient()
 * === null` and exits cleanly rather than spawning a fresh connection.
 * Quits both clients in parallel to halve worst-case shutdown latency
 * when Redis is wedged.
 */
export async function closeWorkerHeartbeatClients(): Promise<void> {
  closing = true;
  const w = writeClient;
  const r = readClient;
  writeClient = null;
  readClient = null;
  await Promise.all([
    w ? w.quit().catch(() => undefined) : Promise.resolve(),
    r ? r.quit().catch(() => undefined) : Promise.resolve(),
  ]);
}

/**
 * Test hook — reset the closing flag so subsequent tests can start
 * fresh clients. Production code never calls this.
 */
export function _resetHeartbeatClientsForTest(): void {
  closing = false;
  writeClient = null;
  readClient = null;
}
