// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { computeHealth, type HealthDeps, type ProbeResult } from './health.js';
import type { RedisPingResult } from './health-redis.js';

const V1_KEYS = ['status', 'db', 'redis', 'queue', 'workers', 'timestamp', 'checks'];
const V2_KEYS = ['mode', 'version', 'engineCommit', 'schemaVersion', 'schemaTag', 'queueBackend', 'online', 'lastOnlineCheck'];

function deps(over: {
  db?: ProbeResult;
  redis?: RedisPingResult;
  workersOk?: boolean;
  expectWorker?: boolean;
  mode?: 'server' | 'desktop';
  queueBackend?: 'bullmq' | 'pgboss' | 'none';
  queueProbe?: ProbeResult;
}): HealthDeps {
  return {
    probeDb: async () => over.db ?? { ok: true, latencyMs: 3 },
    redisPing: async () => over.redis ?? { ok: true, latencyMs: 1 },
    readHeartbeats: async () =>
      over.workersOk === false
        ? { ok: false, count: 0, lastHeartbeatMs: null }
        : { ok: true, count: 1, lastHeartbeatMs: 1000 },
    schemaInfo: async () => ({ version: 216, tag: '0215_last' }),
    dbRole: async () => ({ superuser: false, dangerous: [], warnings: ['createrole'] }),
    redactErr: (_n, c) => (c.error ? { ...c, error: 'unavailable' } : c),
    expectWorker: over.expectWorker ?? true,
    mode: over.mode ?? 'server',
    queueBackend: over.queueBackend ?? 'bullmq',
    queueProbe: async () => over.queueProbe ?? { ok: true, latencyMs: 2 },
    version: 'v0.9.231',
    engineCommit: '13ebd2ba',
    now: () => new Date('2026-10-15T12:00:00.000Z'),
  };
}

describe('computeHealth — server mode keeps the exact v1 body', () => {
  it('all ok: 200, only the v1 fields, values unchanged', async () => {
    const { httpStatus, body } = await computeHealth(deps({}));
    expect(httpStatus).toBe(200);
    expect(Object.keys(body)).toEqual(V1_KEYS);
    expect(body).toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      queue: 'ok',
      workers: 'ok',
      timestamp: '2026-10-15T12:00:00.000Z',
      checks: {
        db: { ok: true, latencyMs: 3 },
        redis: { ok: true, latencyMs: 1 },
        queue: { ok: true, latencyMs: 1, error: undefined },
        workers: { ok: true, count: 1, lastHeartbeatMs: 1000, expected: true },
      },
    });
    for (const k of V2_KEYS) expect(body, k).not.toHaveProperty(k);
  });

  it('never reads the schema or the database role (unauthenticated endpoint)', async () => {
    const d = deps({});
    let calls = 0;
    d.schemaInfo = async () => {
      calls += 1;
      return { version: 1, tag: 'x' };
    };
    d.dbRole = async () => {
      calls += 1;
      return { superuser: true, dangerous: ['superuser'], warnings: [] };
    };
    const { body } = await computeHealth(d);
    expect(calls).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/superuser|schema|v0\.9\.231|13ebd2ba/);
  });

  it('redis down: 503 degraded, redis+queue fail (queue mirrors redis on bullmq)', async () => {
    const { httpStatus, body } = await computeHealth(deps({ redis: { ok: false, latencyMs: 2000, error: 'ECONNREFUSED 10.0.0.3:6379' } }));
    expect(httpStatus).toBe(503);
    expect(body).toMatchObject({ status: 'degraded', db: 'ok', redis: 'fail', queue: 'fail' });
    expect((body['checks'] as { redis: { error: string } }).redis.error).toBe('unavailable');
  });

  it('stale worker with EXPECT_WORKER: 503; without: 200', async () => {
    expect((await computeHealth(deps({ workersOk: false }))).httpStatus).toBe(503);
    expect((await computeHealth(deps({ workersOk: false, expectWorker: false }))).httpStatus).toBe(200);
  });

  it('db down: 503', async () => {
    const { httpStatus, body } = await computeHealth(deps({ db: { ok: false, latencyMs: 2000, error: 'unavailable' } }));
    expect(httpStatus).toBe(503);
    expect(body).toMatchObject({ status: 'degraded', db: 'fail' });
  });
});

describe('computeHealth — desktop (v2, token-gated)', () => {
  const desktop = { mode: 'desktop' as const, queueBackend: 'none' as const, expectWorker: false };

  it('v1 fields first and unchanged, v2 fields appended', async () => {
    const { httpStatus, body } = await computeHealth(deps({ ...desktop, redis: { ok: true, latencyMs: 0, disabled: true } }));
    expect(httpStatus).toBe(200);
    expect(Object.keys(body)).toEqual([...V1_KEYS, ...V2_KEYS]);
    expect(body).toMatchObject({
      mode: 'desktop',
      version: 'v0.9.231',
      engineCommit: '13ebd2ba',
      schemaVersion: 216,
      schemaTag: '0215_last',
      queueBackend: 'none',
      online: null,
      lastOnlineCheck: null,
    });
    expect((body['checks'] as { db: unknown }).db).toEqual({
      ok: true,
      latencyMs: 3,
      superuser: false,
      role: { dangerous: [], warnings: ['createrole'] },
    });
  });

  it('Redis disabled and no worker: 200 ok with redis "disabled"', async () => {
    const { httpStatus, body } = await computeHealth(
      deps({ ...desktop, redis: { ok: true, latencyMs: 0, disabled: true }, workersOk: false }),
    );
    expect(httpStatus).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      db: 'ok',
      redis: 'disabled',
      queue: 'ok',
      workers: 'ok',
      mode: 'desktop',
      queueBackend: 'none',
    });
  });

  it('db down still degrades, and skips the schema/role lookups', async () => {
    const d = deps({ ...desktop, db: { ok: false, latencyMs: 2000, error: 'unavailable' }, redis: { ok: true, latencyMs: 0, disabled: true } });
    let schemaCalls = 0;
    d.schemaInfo = async () => {
      schemaCalls += 1;
      return { version: 1, tag: null };
    };
    const { httpStatus, body } = await computeHealth(d);
    expect(httpStatus).toBe(503);
    expect(body).toMatchObject({ db: 'fail', schemaVersion: null, schemaTag: null });
    expect(schemaCalls).toBe(0);
  });

  it('a failing schema read reports null and does not degrade', async () => {
    const d = deps({ ...desktop, redis: { ok: true, latencyMs: 0, disabled: true } });
    d.schemaInfo = async () => {
      throw new Error('boom');
    };
    const { httpStatus, body } = await computeHealth(d);
    expect(httpStatus).toBe(200);
    expect(body['schemaVersion']).toBeNull();
  });
});

describe('computeHealth — desktop on the pg-boss queue', () => {
  const desktop = {
    mode: 'desktop' as const,
    queueBackend: 'pgboss' as const,
    expectWorker: false,
    redis: { ok: true, latencyMs: 0, disabled: true as const },
  };

  it('queue ok when the job queue answers: 200', async () => {
    const { httpStatus, body } = await computeHealth(deps(desktop));
    expect(httpStatus).toBe(200);
    expect(body).toMatchObject({ status: 'ok', redis: 'disabled', queue: 'ok', queueBackend: 'pgboss' });
    expect((body['checks'] as Record<string, unknown>)['queue']).toEqual({ ok: true, latencyMs: 2 });
  });

  it('an unreachable job queue degrades with a redacted error', async () => {
    const { httpStatus, body } = await computeHealth(
      deps({ ...desktop, queueProbe: { ok: false, latencyMs: 2000, error: 'connect ECONNREFUSED 10.0.0.5:5432' } }),
    );
    expect(httpStatus).toBe(503);
    expect(body).toMatchObject({ status: 'degraded', queue: 'fail' });
    expect((body['checks'] as Record<string, { error?: string }>)['queue']!.error).toBe('unavailable');
  });

  it('the server (bullmq) never calls the queue probe', async () => {
    let called = false;
    const d = deps({});
    d.queueProbe = async () => {
      called = true;
      return { ok: false, latencyMs: 0 };
    };
    await computeHealth(d);
    expect(called).toBe(false);
  });
});
