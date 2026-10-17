// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * /health body. Pure: app.ts injects the real probes, tests inject fakes.
 *
 * Server mode returns the v1 body exactly as before: /health is
 * unauthenticated on the appliance, so it must not reveal the version,
 * commit, schema or database role to anonymous callers. Desktop mode
 * (every request already carried the launch token) returns v2: every v1
 * field keeps its meaning and position, and v2 appends:
 *
 *   mode            'server' | 'desktop'
 *   version         image/bundle version (VIBE_MYBOOKS_VERSION, ...)
 *   engineCommit    ENGINE_COMMIT or null
 *   schemaVersion   number of applied migrations, null if unreadable
 *   schemaTag       journal tag of the newest applied migration
 *   queueBackend    'bullmq' | 'pgboss' | 'none'
 *   online          null until a connectivity probe exists (never probed)
 *   lastOnlineCheck null, same
 *
 * and checks.db.superuser + checks.db.role {dangerous, warnings} (see
 * startup/db-role.ts). `redis` is 'disabled' when the install runs
 * without Redis by design (desktop); a disabled Redis never degrades the
 * status, and with QUEUE_BACKEND=none there is no queue to check. With
 * QUEUE_BACKEND=pgboss the queue check is the job queue's own probe.
 */

import type { RedisPingResult } from './health-redis.js';
import type { WorkerHeartbeatStatus } from './worker-heartbeat.js';
import type { DbRoleReport } from '../startup/db-role.js';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface HealthDeps {
  probeDb: () => Promise<ProbeResult>;
  redisPing: () => Promise<RedisPingResult>;
  readHeartbeats: () => Promise<WorkerHeartbeatStatus>;
  schemaInfo: () => Promise<{ version: number; tag: string | null } | null>;
  dbRole: () => Promise<DbRoleReport | null>;
  /** Same redaction app.ts has always applied (log detail, return a code). */
  redactErr: <T extends { ok: boolean; error?: string }>(name: string, c: T) => T;
  expectWorker: boolean;
  mode: 'server' | 'desktop';
  queueBackend: 'bullmq' | 'pgboss' | 'none';
  /** pgboss only: bounded reachability probe of the job queue. */
  queueProbe?: () => Promise<ProbeResult>;
  version: string;
  engineCommit: string | null;
  now?: () => Date;
}

export async function computeHealth(deps: HealthDeps): Promise<{ httpStatus: 200 | 503; body: Record<string, unknown> }> {
  const [db, redisRaw, workersRaw, queueRaw] = await Promise.all([
    deps.probeDb(),
    deps.redisPing(),
    deps.readHeartbeats(),
    deps.queueBackend === 'pgboss'
      ? (deps.queueProbe ?? (async () => ({ ok: false, latencyMs: 0, error: 'no queue probe' })))()
      : Promise.resolve(null),
  ]);

  const redis = deps.redactErr('redis', redisRaw);
  const workers = deps.redactErr('workers', workersRaw);
  const redisDisabled = redis.disabled === true;

  // BullMQ: queue health rides on Redis (unchanged). pgboss: its own probe.
  // none: nothing to check.
  const queue =
    deps.queueBackend === 'none'
      ? { ok: true, latencyMs: 0 }
      : queueRaw
        ? deps.redactErr('queue', queueRaw)
        : { ok: redis.ok, latencyMs: redis.latencyMs, error: redis.error };

  const workersCheckActive = deps.expectWorker;
  const workersOk = workersCheckActive ? workers.ok : true;

  const allOk = db.ok && (redisDisabled || redis.ok) && queue.ok && workersOk;
  const status = allOk ? 'ok' : 'degraded';

  const v2 = deps.mode === 'desktop';
  const [schema, role] = v2
    ? await Promise.all([
      db.ok ? deps.schemaInfo().catch(() => null) : Promise.resolve(null),
      db.ok ? deps.dbRole().catch(() => null) : Promise.resolve(null),
    ])
    : [null, null];

  const body: Record<string, unknown> = {
    status,
    db: db.ok ? 'ok' : 'fail',
    redis: redisDisabled ? 'disabled' : redis.ok ? 'ok' : 'fail',
    queue: queue.ok ? 'ok' : 'fail',
    workers: workersOk ? 'ok' : 'fail',
    timestamp: (deps.now ? deps.now() : new Date()).toISOString(),
    checks: {
      db: v2
        ? {
          ...db,
          superuser: role ? role.superuser : null,
          role: role ? { dangerous: role.dangerous, warnings: role.warnings } : null,
        }
        : db,
      redis,
      queue,
      workers: {
        ...workers,
        // Make the EXPECT_WORKER gating visible in the response body
        // so operators inspecting /health output understand why a
        // missing heartbeat isn't tripping degraded status.
        expected: workersCheckActive,
      },
    },
  };
  if (v2) {
    Object.assign(body, {
      mode: deps.mode,
      version: deps.version,
      engineCommit: deps.engineCommit,
      schemaVersion: schema?.version ?? null,
      schemaTag: schema?.tag ?? null,
      queueBackend: deps.queueBackend,
      online: null,
      lastOnlineCheck: null,
    });
  }
  return { httpStatus: allOk ? 200 : 503, body };
}
