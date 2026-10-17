// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The BullMQ adapter must build exactly what the old producers and worker
// processors built: one producer Queue per name on one shared connection
// with the spec's defaultJobOptions, adds under the spec's BullMQ job name
// with the producer id, one Worker per queue on its own connection at the
// spec's concurrency, and the same completed/failed log lines. bullmq and
// ioredis are mocked here (no Redis needed); the parity suite runs the
// real thing against Redis.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Listener = (...args: unknown[]) => void;

const rec = vi.hoisted(() => ({
  redis: [] as Array<{ url: string; opts: unknown }>,
  queues: [] as Array<{ name: string; opts: Record<string, unknown>; adds: unknown[][] }>,
  workers: [] as Array<{
    name: string;
    processor: (job: unknown) => Promise<unknown>;
    opts: Record<string, unknown>;
    listeners: Map<string, Listener>;
    closed: boolean;
  }>,
  getWorkers: [] as unknown[],
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    constructor(url: string, opts: unknown) {
      rec.redis.push({ url, opts });
    }
    async quit() {
      return 'OK';
    }
  }
  return { default: FakeRedis };
});

vi.mock('bullmq', () => {
  class Queue {
    entry: { name: string; opts: Record<string, unknown>; adds: unknown[][] };
    constructor(name: string, opts: Record<string, unknown>) {
      this.entry = { name, opts, adds: [] };
      rec.queues.push(this.entry);
    }
    async add(...args: unknown[]) {
      this.entry.adds.push(args);
      return {};
    }
    async getWorkers() {
      return rec.getWorkers;
    }
    async close() {}
  }
  class Worker {
    entry: (typeof rec.workers)[number];
    constructor(name: string, processor: (job: unknown) => Promise<unknown>, opts: Record<string, unknown>) {
      this.entry = { name, processor, opts, listeners: new Map(), closed: false };
      rec.workers.push(this.entry);
    }
    on(ev: string, fn: Listener) {
      this.entry.listeners.set(ev, fn);
      return this;
    }
    async close() {
      this.entry.closed = true;
    }
  }
  return { Queue, Worker };
});

import { BullMqQueue } from './bullmq.adapter.js';
import { JOB_SPECS } from './specs.js';

describe('BullMqQueue', () => {
  beforeEach(() => {
    rec.redis.length = 0;
    rec.queues.length = 0;
    rec.workers.length = 0;
    rec.getWorkers = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it('producers: one shared connection, spec job options, BullMQ job name, producer id', async () => {
    const q = new BullMqQueue(JOB_SPECS);
    await q.enqueue('statement-parse', { jobId: 'j', tenantId: 't', attachmentId: 'a' }, { jobId: 'stmt-j' });
    await q.enqueue('statement-parse', { jobId: 'k', tenantId: 't', attachmentId: 'a' }, { jobId: 'stmt-k' });
    await q.enqueue('doc-render', { jobId: 'j', tenantId: 't' }, { jobId: 'render-j' });

    expect(rec.redis).toHaveLength(1);
    expect(rec.redis[0]!.opts).toEqual({ maxRetriesPerRequest: null });
    expect(rec.queues.map((x) => x.name)).toEqual(['statement-parse', 'doc-render']);
    expect(rec.queues[0]!.opts['defaultJobOptions']).toEqual({ attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 });
    expect(rec.queues[0]!.opts).not.toHaveProperty('prefix');
    expect(rec.queues[0]!.adds).toEqual([
      ['parse', { jobId: 'j', tenantId: 't', attachmentId: 'a' }, { jobId: 'stmt-j' }],
      ['parse', { jobId: 'k', tenantId: 't', attachmentId: 'a' }, { jobId: 'stmt-k' }],
    ]);
    expect(rec.queues[1]!.adds).toEqual([['render', { jobId: 'j', tenantId: 't' }, { jobId: 'render-j' }]]);
    await q.close();
  });

  it('workers: one per queue, own connection, spec concurrency, handler gets data + context', async () => {
    const q = new BullMqQueue(JOB_SPECS);
    const seen: unknown[] = [];
    const h = await q.work('doc-extract', async (data, ctx) => {
      seen.push({ data, ctx });
    });
    expect(rec.workers).toHaveLength(1);
    const w = rec.workers[0]!;
    expect(w.name).toBe('doc-extract');
    expect(w.opts['concurrency']).toBe(JOB_SPECS['doc-extract'].concurrency());
    expect(w.opts).not.toHaveProperty('prefix');
    expect(rec.redis).toHaveLength(1); // the worker's own connection

    await w.processor({ id: 'extract-j-1', data: { jobId: 'j', tenantId: 't', pageNo: 1 }, attemptsMade: 0, opts: { attempts: 3 } });
    await w.processor({ id: 'extract-j-1', data: { jobId: 'j', tenantId: 't', pageNo: 1 }, attemptsMade: 2, opts: { attempts: 3 } });
    expect(seen).toEqual([
      { data: { jobId: 'j', tenantId: 't', pageNo: 1 }, ctx: { jobId: 'extract-j-1', attempt: 1, isFinalAttempt: false } },
      { data: { jobId: 'j', tenantId: 't', pageNo: 1 }, ctx: { jobId: 'extract-j-1', attempt: 3, isFinalAttempt: true } },
    ]);
    await h.close();
    expect(w.closed).toBe(true);
  });

  it('log lines match the processors (completed only where they logged it)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const q = new BullMqQueue(JOB_SPECS);
    await q.work('report-pack', async () => undefined);
    await q.work('bill-capture', async () => undefined);
    const [pack, bill] = rec.workers;

    expect([...pack!.listeners.keys()].sort()).toEqual(['completed', 'failed']);
    expect([...bill!.listeners.keys()]).toEqual(['failed']);

    pack!.listeners.get('completed')!({ id: 'pack-r', finishedOn: 1_500, processedOn: 1_000, timestamp: 900 });
    pack!.listeners.get('failed')!({ id: 'pack-r' }, new Error('boom'));
    bill!.listeners.get('failed')!(undefined, new Error('nope'));
    expect(log).toHaveBeenCalledWith('[report-pack] job pack-r completed in worker (500 ms)');
    expect(err).toHaveBeenCalledWith('[report-pack] job pack-r failed: boom');
    expect(err).toHaveBeenCalledWith('[bill-capture] job ? failed: nope');
    await q.close();
  });

  it('health counts the consumers of the named queue and is bounded', async () => {
    const q = new BullMqQueue(JOB_SPECS);
    rec.getWorkers = [{}, {}];
    expect(await q.health({ name: 'report-pack' })).toMatchObject({ ok: true, consumers: 2 });
    expect(rec.queues.at(-1)!.name).toBe('report-pack');
    await q.close();
  });
});
