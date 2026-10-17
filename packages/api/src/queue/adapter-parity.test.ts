// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Adapter parity suite: the same cases against every durable JobQueue
// backend, so BullMQ (server) and pg-boss (desktop) honor one contract:
//   - delivery: the handler receives deep-equal data;
//   - idempotency: a duplicate producer id while pending, active or completed
//     is a no-op;
//   - retries: a failing handler runs `attempts` times, isFinalAttempt only
//     on the last; attempts=1 never retries; failures are logged;
//   - concurrency: never more simultaneous handlers than the spec allows;
//   - shutdown: close() waits for an in-flight handler;
//   - health: ok with consumers counted; a dead backend reports !ok, bounded;
//   - the six real job types run with spy handlers.
//
// pg-boss runs against the test database in its own schema. BullMQ needs
// Redis (REDIS_URL): skipped locally when Redis is not reachable, REQUIRED
// in CI (the CI test job has Redis on :6390).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import RedisPkg from 'ioredis';
import type { JobContext, JobData, JobQueue, JobSpecTable } from './job-queue.js';
import { JOB_NAMES } from './job-queue.js';
import { JOB_SPECS } from './specs.js';
import { BullMqQueue } from './bullmq.adapter.js';
import { PgBossQueue, JobQueueUnavailableError } from './pgboss.adapter.js';
import { queueJobIds } from '../services/extraction/queue.js';

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);

interface TestJobs {
  echo: { n: number; s: string; nested: { list: string[]; nil: null; amount: string; flag: boolean } };
  flaky: { key: string };
  single: { key: string };
  slow: { key: string; ms: number };
  conc: { key: string; ms: number };
}

const common = { keepCompleted: 100, keepFailed: 100, activeTimeoutSeconds: 120, bullmqJobName: 'test', logCompleted: false };
const TEST_SPECS: JobSpecTable<TestJobs> = {
  echo: { ...common, attempts: 1, concurrency: () => 1, logLabel: 'test-echo' },
  // BullMQ backs off 200/400 ms; pg-boss rounds to its 1 s minimum delay.
  flaky: { ...common, attempts: 3, backoffMs: 200, concurrency: () => 1, logLabel: 'test-flaky' },
  single: { ...common, attempts: 1, concurrency: () => 1, logLabel: 'test-single' },
  slow: { ...common, attempts: 1, concurrency: () => 1, logLabel: 'test-slow' },
  conc: { ...common, attempts: 1, concurrency: () => 2, logLabel: 'test-conc' },
};

const DATABASE_URL = process.env['DATABASE_URL']!;
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6390';
const PGBOSS_SCHEMA = 'pgboss_parity';
const BULL_PREFIX = `parity-${crypto.randomBytes(4).toString('hex')}`;
const IN_CI = !!process.env['CI'];

async function redisReachable(url: string): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1_000, retryStrategy: () => null });
  r.on('error', () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

const REDIS_OK = await redisReachable(REDIS_URL);

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => crypto.randomUUID();

interface Backend {
  name: 'bullmq' | 'pgboss';
  enabled: boolean;
  make(): JobQueue<TestJobs>;
  makeReal(): JobQueue<JobData>;
  makeDead(): JobQueue<TestJobs>;
  /** How long a retry chain may take on this backend. */
  retryWindowMs: number;
}

const backends: Backend[] = [
  {
    name: 'bullmq',
    enabled: REDIS_OK || IN_CI,
    make: () => new BullMqQueue(TEST_SPECS, { prefix: BULL_PREFIX }),
    makeReal: () => new BullMqQueue(JOB_SPECS, { prefix: BULL_PREFIX }),
    makeDead: () =>
      new BullMqQueue(TEST_SPECS, {
        prefix: BULL_PREFIX,
        connection: () => {
          const r = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: null, lazyConnect: true });
          r.on('error', () => undefined);
          return r;
        },
      }),
    retryWindowMs: 5_000,
  },
  {
    name: 'pgboss',
    enabled: true,
    make: () => new PgBossQueue(TEST_SPECS, { connectionString: DATABASE_URL, schema: PGBOSS_SCHEMA, pollingIntervalSeconds: 0.5, stopTimeoutMs: 10_000 }),
    makeReal: () => new PgBossQueue(JOB_SPECS, { connectionString: DATABASE_URL, schema: PGBOSS_SCHEMA, pollingIntervalSeconds: 0.5, stopTimeoutMs: 10_000 }),
    makeDead: () => new PgBossQueue(TEST_SPECS, { connectionString: 'postgresql://nobody@127.0.0.1:1/none', schema: PGBOSS_SCHEMA, connectTimeoutMs: 1_000 }),
    retryWindowMs: 15_000,
  },
];

async function dropPgBossSchema(): Promise<void> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS ${PGBOSS_SCHEMA} CASCADE`);
  } finally {
    await c.end();
  }
}

beforeAll(dropPgBossSchema);
afterAll(dropPgBossSchema);

it('Redis is reachable for the BullMQ half (required in CI, optional locally)', () => {
  if (!IN_CI && !REDIS_OK) {
    console.warn(`[adapter-parity] BullMQ cases skipped: no Redis at ${REDIS_URL}`);
    return;
  }
  expect(REDIS_OK).toBe(true);
});

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`JobQueue parity: ${backend.name}`, () => {
    const open: Array<JobQueue<TestJobs> | JobQueue<JobData>> = [];
    function track<Q extends JobQueue<TestJobs> | JobQueue<JobData>>(q: Q): Q {
      open.push(q);
      return q;
    }
    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.all(open.splice(0).map((q) => q.close()));
    });

    it('delivers deep-equal data with the attempt context', async () => {
      const q = track(backend.make());
      const seen: Array<{ data: TestJobs['echo']; ctx: JobContext }> = [];
      await q.work('echo', async (data, ctx) => {
        seen.push({ data, ctx });
      });
      const data: TestJobs['echo'] = { n: 42, s: 'Ünïcode ✓', nested: { list: ['a', 'b'], nil: null, amount: '1234.5600', flag: false } };
      await q.enqueue('echo', data, { jobId: `echo-${key()}` });
      await waitFor(() => seen.length === 1, 10_000, 'echo');
      expect(seen[0]!.data).toEqual(data);
      expect(seen[0]!.ctx).toMatchObject({ attempt: 1, isFinalAttempt: true });
      expect(typeof seen[0]!.ctx.jobId).toBe('string');
    });

    it('a duplicate job id is a no-op while pending, active and after completion', async () => {
      const q = track(backend.make());
      const k = key();
      const jobId = `slow-${k}`;
      await q.enqueue('slow', { key: k, ms: 800 }, { jobId });
      await q.enqueue('slow', { key: k, ms: 800 }, { jobId }); // pending duplicate
      let runs = 0;
      let active = false;
      let done = false;
      await q.work('slow', async (data) => {
        runs += 1;
        active = true;
        await sleep(data.ms);
        active = false;
        done = true;
      });
      await waitFor(() => active, 10_000, 'slow job to start');
      await q.enqueue('slow', { key: k, ms: 800 }, { jobId }); // active duplicate
      await waitFor(() => done, 10_000, 'slow job to finish');
      await sleep(300);
      await q.enqueue('slow', { key: k, ms: 800 }, { jobId }); // completed duplicate
      await sleep(2_000);
      expect(runs).toBe(1);
    });

    it('retries a failing handler attempts-1 times; only the last attempt is final', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const q = track(backend.make());
      const ctxs: JobContext[] = [];
      await q.work('flaky', async (_data, ctx) => {
        ctxs.push(ctx);
        throw new Error('flaky boom');
      });
      await q.enqueue('flaky', { key: key() }, { jobId: `flaky-${key()}` });
      await waitFor(() => ctxs.length === 3, backend.retryWindowMs, 'three attempts');
      await sleep(2_500);
      expect(ctxs.map((c) => [c.attempt, c.isFinalAttempt])).toEqual([[1, false], [2, false], [3, true]]);
      const failedLines = err.mock.calls.filter(([m]) => typeof m === 'string' && /^\[test-flaky\] job \S+ failed: flaky boom$/.test(m));
      expect(failedLines).toHaveLength(3);
    });

    it('never retries an attempts=1 job', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const q = track(backend.make());
      const ctxs: JobContext[] = [];
      await q.work('single', async (_data, ctx) => {
        ctxs.push(ctx);
        throw new Error('single boom');
      });
      await q.enqueue('single', { key: key() }, { jobId: `single-${key()}` });
      await waitFor(() => ctxs.length === 1, 10_000, 'one attempt');
      await sleep(3_000);
      expect(ctxs).toHaveLength(1);
      expect(ctxs[0]!.isFinalAttempt).toBe(true);
    });

    it('a failed job does not block the next one', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const q = track(backend.make());
      const ok: string[] = [];
      await q.work('single', async (data) => {
        if (data.key.startsWith('bad')) throw new Error('bad job');
        ok.push(data.key);
      });
      const good = `good-${key()}`;
      await q.enqueue('single', { key: `bad-${key()}` }, { jobId: `single-${key()}` });
      await q.enqueue('single', { key: good }, { jobId: `single-${key()}` });
      await waitFor(() => ok.includes(good), 10_000, 'the good job');
    });

    it('honors the concurrency cap', async () => {
      const q = track(backend.make());
      let activeNow = 0;
      let maxActive = 0;
      let finished = 0;
      await q.work('conc', async (data) => {
        activeNow += 1;
        maxActive = Math.max(maxActive, activeNow);
        await sleep(data.ms);
        activeNow -= 1;
        finished += 1;
      });
      for (let i = 0; i < 6; i++) {
        const k = key();
        await q.enqueue('conc', { key: k, ms: 500 }, { jobId: `conc-${k}` });
      }
      await waitFor(() => finished === 6, 20_000, 'six concurrent jobs');
      expect(maxActive).toBe(2);
    });

    it('close() waits for an in-flight handler', async () => {
      const q = backend.make();
      let started = false;
      let finished = false;
      const handle = await q.work('slow', async (data) => {
        started = true;
        await sleep(data.ms);
        finished = true;
      });
      const k = key();
      await q.enqueue('slow', { key: k, ms: 1_500 }, { jobId: `slow-${k}` });
      await waitFor(() => started, 10_000, 'slow job to start');
      await handle.close();
      expect(finished).toBe(true);
      await q.close();
    });

    it('queue close() drains in-flight handlers too', async () => {
      const q = backend.make();
      let started = false;
      let finished = false;
      await q.work('slow', async (data) => {
        started = true;
        await sleep(data.ms);
        finished = true;
      });
      const k = key();
      await q.enqueue('slow', { key: k, ms: 1_500 }, { jobId: `slow-${k}` });
      await waitFor(() => started, 10_000, 'slow job to start');
      await q.close();
      expect(finished).toBe(true);
    });

    it('health is ok and counts consumers of the named queue', async () => {
      const q = track(backend.make());
      await q.work('echo', async () => undefined);
      const h = await q.health({ name: 'echo', timeoutMs: 3_000 });
      expect(h.ok).toBe(true);
      expect(h.consumers).toBeGreaterThanOrEqual(1);
    });

    it('health of an unreachable backend is !ok within its time budget', async () => {
      const q = backend.makeDead();
      const t0 = Date.now();
      const h = await q.health({ name: 'echo', timeoutMs: 1_500 });
      expect(h.ok).toBe(false);
      expect(Date.now() - t0).toBeLessThan(4_000);
      // A BullMQ queue whose Redis never answered may not finish closing.
      await Promise.race([q.close().catch(() => undefined), sleep(2_000)]);
    });

    it('runs all six real job types (handlers replaced by spies)', async () => {
      const q = track(backend.makeReal());
      const t = key();
      const samples: { [N in keyof JobData]: { data: JobData[N]; jobId: string } } = {
        'doc-render': { data: { jobId: key(), tenantId: t }, jobId: '' },
        'doc-extract': { data: { jobId: key(), tenantId: t, pageNo: 2 }, jobId: '' },
        'statement-parse': { data: { jobId: key(), tenantId: t, attachmentId: key() }, jobId: '' },
        'report-pack': { data: { runId: key(), tenantId: t }, jobId: '' },
        'bill-capture': { data: { captureId: key(), tenantId: t, attempt: 1 }, jobId: '' },
        'tax-param-ai-check': { data: { runId: key() }, jobId: '' },
      };
      samples['doc-render'].jobId = queueJobIds.render(samples['doc-render'].data.jobId);
      samples['doc-extract'].jobId = queueJobIds.extract(samples['doc-extract'].data.jobId, 2);
      samples['statement-parse'].jobId = queueJobIds.statementParse(samples['statement-parse'].data.jobId);
      samples['report-pack'].jobId = queueJobIds.reportPack(samples['report-pack'].data.runId);
      samples['bill-capture'].jobId = queueJobIds.billCapture(samples['bill-capture'].data.captureId, 1);
      samples['tax-param-ai-check'].jobId = queueJobIds.taxParamAiCheck(samples['tax-param-ai-check'].data.runId);

      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const got = new Map<string, unknown>();
      for (const name of JOB_NAMES) {
        await q.work(name, async (data: unknown) => {
          got.set(name, data);
        });
      }
      for (const name of JOB_NAMES) {
        const s = samples[name];
        await (q.enqueue as (n: string, d: unknown, o: { jobId: string }) => Promise<void>)(name, s.data, { jobId: s.jobId });
      }
      await waitFor(() => got.size === JOB_NAMES.length, 20_000, 'all six job types');
      for (const name of JOB_NAMES) expect(got.get(name)).toEqual(samples[name].data);
    });
  });
}

describe('pg-boss fails fast and clearly without Postgres', () => {
  it('enqueue rejects with JobQueueUnavailableError instead of hanging', async () => {
    const q = backends[1]!.makeDead();
    const t0 = Date.now();
    await expect(q.enqueue('echo', { n: 1, s: '', nested: { list: [], nil: null, amount: '0', flag: true } }, { jobId: 'echo-dead' }))
      .rejects.toBeInstanceOf(JobQueueUnavailableError);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await q.close();
  });
});
