// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Desktop in-process worker: which job types it consumes, which worker-only
// schedulers it starts (only those the desktop profile enables), its stop
// order, and the AC1 path end to end — desktop producers → pg-boss →
// in-process handler — with spy handlers and no Redis.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import { startInProcessWorker, inProcessJobNames, WORKER_ONLY_SCHEDULERS, type WorkerScheduler } from './in-process-worker.js';
import { JOB_NAMES, type JobData, type JobQueue, type JobName, type WorkerHandle, type QueueHealth } from './job-queue.js';
import type { JobHandlers } from './handlers.js';
import { JOB_SPECS } from './specs.js';
import { PgBossQueue } from './pgboss.adapter.js';
import { _setJobQueueForTests, getJobQueue } from './index.js';
import { enqueueReportPack, enqueueStatementParse, enqueueBillCapture, enqueueTaxParamAiCheck } from '../services/extraction/queue.js';

function desktop(extra: Record<string, string> = {}): void {
  _resetDesktopProfileForTests();
  loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: 'w'.repeat(48),
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-in-process-worker-test'),
    ...extra,
  });
}

class RecordingQueue implements JobQueue {
  readonly backend = 'pgboss' as const;
  worked: string[] = [];
  closed: string[] = [];
  async enqueue(): Promise<void> {}
  async work(name: string): Promise<WorkerHandle> {
    this.worked.push(name);
    return { close: async () => void this.closed.push(name) };
  }
  async health(): Promise<QueueHealth> {
    return { ok: true, consumers: this.worked.length, latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

function spySchedulers(order: string[]): WorkerScheduler[] {
  return WORKER_ONLY_SCHEDULERS.map((s) => ({
    name: s.name,
    start: () => void order.push(`start:${s.name}`),
    stop: () => void order.push(`stop:${s.name}`),
  }));
}

const noopHandlers = Object.fromEntries(JOB_NAMES.map((n) => [n, async () => undefined])) as unknown as JobHandlers;

describe('in-process worker (desktop profile)', () => {
  beforeAll(() => desktop());
  afterAll(() => _resetDesktopProfileForTests());
  afterEach(() => vi.restoreAllMocks());

  it('desktop defaults to the pg-boss backend', async () => {
    _setJobQueueForTests(null, 'pgboss');
    const q = await getJobQueue();
    expect(q.backend).toBe('pgboss');
    expect(q).toBeInstanceOf(PgBossQueue);
    await q.close(); // never started: no connection was opened
  });

  it('consumes all six job types; doc-* only with DOCUMENT_EXTRACTION_V1', () => {
    expect(inProcessJobNames(true)).toEqual([...JOB_NAMES]);
    expect(inProcessJobNames(false)).toEqual(JOB_NAMES.filter((n) => n !== 'doc-render' && n !== 'doc-extract'));
  });

  it('starts only the worker-only schedulers the desktop profile enables, and stops them after the jobs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const order: string[] = [];
    const queue = new RecordingQueue();
    const w = await startInProcessWorker({ queue, handlers: noopHandlers, schedulers: spySchedulers(order), documentExtraction: true });

    expect(queue.worked).toEqual([...JOB_NAMES]);
    expect(w.schedulers).toEqual(['balanceValidation', 'reportPackSweep', 'classificationStateBackfill', 'tagBackfill']);
    expect(order).toEqual([
      'start:balanceValidation',
      'start:reportPackSweep',
      'start:classificationStateBackfill',
      'start:tagBackfill',
    ]);
    expect(order.join(' ')).not.toMatch(/plaid|portal/i);

    await w.stop();
    expect(queue.closed.sort()).toEqual([...JOB_NAMES].sort());
    expect(order.slice(4)).toEqual([
      'stop:balanceValidation',
      'stop:reportPackSweep',
      'stop:classificationStateBackfill',
      'stop:tagBackfill',
    ]);
  });

  it('a queue that cannot start leaves no half-registered consumers', async () => {
    const queue = new RecordingQueue();
    let n = 0;
    queue.work = async (name: string) => {
      if (++n === 3) throw new Error('pg-boss down');
      queue.worked.push(name);
      return { close: async () => void queue.closed.push(name) };
    };
    await expect(startInProcessWorker({ queue, handlers: noopHandlers, schedulers: [], documentExtraction: true })).rejects.toThrow('pg-boss down');
    expect(queue.closed.sort()).toEqual([...queue.worked].sort());
  });
});

describe('AC1 path: desktop producers → pg-boss → in-process handlers (no Redis)', () => {
  const SCHEMA = `pgboss_inproc_${crypto.randomBytes(3).toString('hex')}`;
  const url = process.env['DATABASE_URL']!;
  let queue: PgBossQueue<JobData>;

  async function dropSchema(): Promise<void> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await c.end();
    }
  }

  beforeAll(() => {
    desktop();
    queue = new PgBossQueue(JOB_SPECS, { connectionString: url, schema: SCHEMA, pollingIntervalSeconds: 0.5 });
    _setJobQueueForTests(queue, 'pgboss');
  });
  afterAll(async () => {
    await queue.close();
    _setJobQueueForTests(null, 'pgboss');
    _resetDesktopProfileForTests();
    await dropSchema();
  });

  it('enqueued jobs run in-process with the job data', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const got = new Map<JobName, unknown>();
    const handlers = Object.fromEntries(
      JOB_NAMES.map((n) => [n, async (data: unknown) => void got.set(n, data)]),
    ) as unknown as JobHandlers;
    const w = await startInProcessWorker({ handlers, schedulers: [], documentExtraction: false });
    try {
      const t = crypto.randomUUID();
      const pack = { runId: crypto.randomUUID(), tenantId: t };
      const stmt = { jobId: crypto.randomUUID(), tenantId: t, attachmentId: crypto.randomUUID() };
      const bill = { captureId: crypto.randomUUID(), tenantId: t, attempt: 1 };
      const tax = { runId: crypto.randomUUID() };
      const t0 = Date.now();
      await enqueueReportPack(pack);
      await enqueueStatementParse(stmt);
      await enqueueBillCapture(bill);
      await enqueueTaxParamAiCheck(tax);
      expect(Date.now() - t0).toBeLessThan(5_000);
      const until = Date.now() + 20_000;
      while (got.size < 4 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(got.get('report-pack')).toEqual(pack);
      expect(got.get('statement-parse')).toEqual(stmt);
      expect(got.get('bill-capture')).toEqual(bill);
      expect(got.get('tax-param-ai-check')).toEqual(tax);
    } finally {
      await w.stop();
    }
  });
});
