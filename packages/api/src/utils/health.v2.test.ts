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
  queueBackend?: 'bullmq' | 'none';
}): HealthDeps {
  return {
    probeDb: async () => over.db ?? { ok: true, latencyMs: 3 },
    redisPing: async () => over.redis ?? { ok: true, latencyMs: 1 },
    readHeartbeats: async () =>
      over.workersOk === false
        ? { ok: false, count: 0, lastHeartbeatMs: null }
        : { ok: true, count: 1, lastHeartbeatMs: 1000 },
    schemaInfo: async () => ({ version: 216, tag: '0215_last' }),
    dbSuperuser: async () => false,
    redactErr: (_n, c) => (c.error ? { ...c, error: 'unavailable' } : c),
    expectWorker: over.expectWorker ?? true,
    mode: over.mode ?? 'server',
    queueBackend: over.queueBackend ?? 'bullmq',
    version: 'v0.9.231',
    engineCommit: '13ebd2ba',
    now: () => new Date('2026-10-15T12:00:00.000Z'),
  };
}

describe('computeHealth — server mode keeps v1 semantics', () => {
  it('all ok: 200, v1 fields first and unchanged, v2 fields appended', async () => {
    const { httpStatus, body } = await computeHealth(deps({}));
    expect(httpStatus).toBe(200);
    expect(Object.keys(body)).toEqual([...V1_KEYS, ...V2_KEYS]);
    expect(body).toMatchObject({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      queue: 'ok',
      workers: 'ok',
      timestamp: '2026-10-15T12:00:00.000Z',
      mode: 'server',
      version: 'v0.9.231',
      engineCommit: '13ebd2ba',
      schemaVersion: 216,
      schemaTag: '0215_last',
      queueBackend: 'bullmq',
      online: null,
      lastOnlineCheck: null,
    });
    expect(body['checks']).toEqual({
      db: { ok: true, latencyMs: 3, superuser: false },
      redis: { ok: true, latencyMs: 1 },
      queue: { ok: true, latencyMs: 1, error: undefined },
      workers: { ok: true, count: 1, lastHeartbeatMs: 1000, expected: true },
    });
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

  it('db down: 503 and no schema/superuser lookups', async () => {
    const d = deps({ db: { ok: false, latencyMs: 2000, error: 'unavailable' } });
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
    const d = deps({});
    d.schemaInfo = async () => {
      throw new Error('boom');
    };
    const { httpStatus, body } = await computeHealth(d);
    expect(httpStatus).toBe(200);
    expect(body['schemaVersion']).toBeNull();
  });
});

describe('computeHealth — desktop (no Redis)', () => {
  const desktop = { mode: 'desktop' as const, queueBackend: 'none' as const, expectWorker: false };

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

  it('db down still degrades', async () => {
    const { httpStatus } = await computeHealth(
      deps({ ...desktop, db: { ok: false, latencyMs: 2000, error: 'unavailable' }, redis: { ok: true, latencyMs: 0, disabled: true } }),
    );
    expect(httpStatus).toBe(503);
  });
});
