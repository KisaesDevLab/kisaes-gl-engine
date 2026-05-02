// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// vibe-distribution-plan D1: health response shape and 503 propagation.
// We don't import app.ts directly because that loads the full pipeline;
// instead we replicate the handler's exact body around mocked db + redis
// pings so we can assert each combination.

type ProbeResult = { ok: boolean; latencyMs: number; error?: string };

interface WorkerCheck {
  ok: boolean;
  count: number;
  lastHeartbeatMs: number | null;
  expected: boolean;
  error?: string;
}

interface FetchedHealth {
  status: number;
  body: {
    status: 'ok' | 'degraded';
    db: 'ok' | 'fail';
    redis: 'ok' | 'fail';
    queue: 'ok' | 'fail';
    workers: 'ok' | 'fail';
    timestamp: string;
    checks: { db: ProbeResult; redis: ProbeResult; queue: ProbeResult; workers: WorkerCheck };
  };
}

async function probeHealth(opts: {
  db: ProbeResult;
  redis: ProbeResult;
  workers?: { ok: boolean; count: number; lastHeartbeatMs: number | null; error?: string };
  expectWorker?: boolean;
}): Promise<FetchedHealth> {
  const app = express();
  app.get('/health', (_req, res) => {
    const db = opts.db;
    const redis = opts.redis;
    const queue = { ok: redis.ok, latencyMs: redis.latencyMs, error: redis.error };
    // Default workers state: a fresh heartbeat present.
    const workers = opts.workers ?? { ok: true, count: 1, lastHeartbeatMs: 1000 };
    const expectWorker = opts.expectWorker ?? true;
    const workersOk = expectWorker ? workers.ok : true;
    const allOk = db.ok && redis.ok && queue.ok && workersOk;
    const status = allOk ? 'ok' : 'degraded';
    const body = {
      status,
      db: db.ok ? 'ok' : 'fail',
      redis: redis.ok ? 'ok' : 'fail',
      queue: queue.ok ? 'ok' : 'fail',
      workers: workersOk ? 'ok' : 'fail',
      timestamp: new Date().toISOString(),
      checks: { db, redis, queue, workers: { ...workers, expected: expectWorker } },
    };
    if (allOk) res.json(body);
    else res.status(503).json(body);
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await r.json() as FetchedHealth['body'];
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { status: r.status, body };
}

describe('health handler shape (vibe-distribution-plan + addendum §3.6)', () => {
  it('all-ok: returns 200 + status:"ok" + db/redis/queue/workers:"ok"', async () => {
    const r = await probeHealth({
      db: { ok: true, latencyMs: 5 },
      redis: { ok: true, latencyMs: 2 },
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.db).toBe('ok');
    expect(r.body.redis).toBe('ok');
    expect(r.body.queue).toBe('ok');
    expect(r.body.workers).toBe('ok');
    expect(r.body.checks).toHaveProperty('db');
    expect(r.body.checks).toHaveProperty('redis');
    expect(r.body.checks).toHaveProperty('queue');
    expect(r.body.checks).toHaveProperty('workers');
  });

  it('worker stale: returns 503 + workers:"fail" while db/redis are ok', async () => {
    const r = await probeHealth({
      db: { ok: true, latencyMs: 4 },
      redis: { ok: true, latencyMs: 2 },
      workers: { ok: false, count: 1, lastHeartbeatMs: 45_000 }, // >30s old
    });
    expect(r.status).toBe(503);
    expect(r.body.status).toBe('degraded');
    expect(r.body.db).toBe('ok');
    expect(r.body.redis).toBe('ok');
    expect(r.body.workers).toBe('fail');
    expect(r.body.checks.workers.expected).toBe(true);
    expect(r.body.checks.workers.lastHeartbeatMs).toBe(45_000);
  });

  it('EXPECT_WORKER=false: missing heartbeat does NOT degrade overall status', async () => {
    const r = await probeHealth({
      db: { ok: true, latencyMs: 4 },
      redis: { ok: true, latencyMs: 2 },
      workers: { ok: false, count: 0, lastHeartbeatMs: null },
      expectWorker: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.workers).toBe('ok');
    expect(r.body.checks.workers.expected).toBe(false);
    expect(r.body.checks.workers.count).toBe(0);
  });

  it('redis down: returns 503 + status:"degraded" + redis:"fail" + queue:"fail" + db:"ok"', async () => {
    const r = await probeHealth({
      db: { ok: true, latencyMs: 4 },
      redis: { ok: false, latencyMs: 2000, error: 'redis probe timeout' },
    });
    expect(r.status).toBe(503);
    expect(r.body.status).toBe('degraded');
    expect(r.body.db).toBe('ok');
    expect(r.body.redis).toBe('fail');
    // queue mirrors redis until BullMQ wiring lands
    expect(r.body.queue).toBe('fail');
    expect(r.body.checks.redis.error).toBe('redis probe timeout');
  });

  it('db down, redis up: returns 503 + db:"fail" + redis:"ok"', async () => {
    const r = await probeHealth({
      db: { ok: false, latencyMs: 2000, error: 'db probe timeout' },
      redis: { ok: true, latencyMs: 1 },
    });
    expect(r.status).toBe(503);
    expect(r.body.status).toBe('degraded');
    expect(r.body.db).toBe('fail');
    expect(r.body.redis).toBe('ok');
    expect(r.body.queue).toBe('ok');
  });

  it('both down: returns 503 with both flagged', async () => {
    const r = await probeHealth({
      db: { ok: false, latencyMs: 2000, error: 'db probe timeout' },
      redis: { ok: false, latencyMs: 2000, error: 'redis probe timeout' },
    });
    expect(r.status).toBe(503);
    expect(r.body.db).toBe('fail');
    expect(r.body.redis).toBe('fail');
    expect(r.body.queue).toBe('fail');
  });

  it('exposes a parseable timestamp', async () => {
    const r = await probeHealth({
      db: { ok: true, latencyMs: 1 },
      redis: { ok: true, latencyMs: 1 },
    });
    expect(() => new Date(r.body.timestamp).toISOString()).not.toThrow();
  });
});
