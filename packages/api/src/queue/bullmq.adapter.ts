// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * QUEUE_BACKEND=bullmq — the Redis-backed backend (server default).
 *
 * This is the BullMQ wiring that used to live in services/extraction/queue.ts
 * (producers) and packages/worker/src/processors/*.ts (consumers), moved
 * behind the JobQueue interface with no behavior change:
 *   - connections are created lazily; one shared connection backs every
 *     producer Queue, and each Worker gets its own connection;
 *   - producer Queues use the spec's job options as defaultJobOptions and add
 *     jobs under the spec's BullMQ job name with the producer's job id;
 *   - one BullMQ Worker per queue at the spec's concurrency, with the same
 *     completed/failed log lines the processors printed.
 *
 * queue/index.ts loads this module with a dynamic import, so processes on
 * another backend never evaluate bullmq.
 */

import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq';
import { makeRedisConnection, type RedisClient } from './redis-connection.js';
import type {
  JobHandler,
  JobQueue,
  JobSpec,
  JobSpecTable,
  QueueHealth,
  WorkerHandle,
} from './job-queue.js';

/** The BullMQ job options a spec row stands for (pinned by specs.test.ts). */
export function bullmqJobOptions(spec: JobSpec): JobsOptions {
  const opts: JobsOptions = { attempts: spec.attempts };
  if (spec.backoffMs !== undefined) opts.backoff = { type: 'exponential', delay: spec.backoffMs };
  opts.removeOnComplete = spec.keepCompleted;
  opts.removeOnFail = spec.keepFailed;
  return opts;
}

export interface BullMqQueueOptions {
  /** Producer connection factory (tests). Default: makeRedisConnection. */
  connection?: () => RedisClient;
  /** BullMQ key prefix (tests). Default: BullMQ's own ('bull'). */
  prefix?: string;
}

export class BullMqQueue<M> implements JobQueue<M> {
  readonly backend = 'bullmq' as const;
  private shared: RedisClient | null = null;
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Set<Worker>();

  constructor(
    private readonly specs: JobSpecTable<M>,
    private readonly options: BullMqQueueOptions = {},
  ) {}

  private spec(name: string): JobSpec {
    const spec = (this.specs as Record<string, JobSpec | undefined>)[name];
    if (!spec) throw new Error(`unknown job "${name}"`);
    return spec;
  }

  private sharedConnection(): RedisClient {
    if (!this.shared) this.shared = (this.options.connection ?? makeRedisConnection)();
    return this.shared;
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.sharedConnection() as ConnectionOptions,
        defaultJobOptions: bullmqJobOptions(this.spec(name)),
        ...(this.options.prefix ? { prefix: this.options.prefix } : {}),
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<N extends keyof M & string>(name: N, data: M[N], opts: { jobId: string }): Promise<void> {
    const spec = this.spec(name);
    await this.queue(name).add(spec.bullmqJobName, data, { jobId: opts.jobId });
  }

  async work<N extends keyof M & string>(name: N, handler: JobHandler<M[N]>): Promise<WorkerHandle> {
    const spec = this.spec(name);
    const worker = new Worker<M[N]>(
      name,
      async (job: Job<M[N]>) => {
        const attempt = job.attemptsMade + 1;
        await handler(job.data, {
          jobId: job.id ?? '',
          attempt,
          isFinalAttempt: attempt >= (job.opts.attempts ?? 1),
        });
      },
      {
        connection: makeRedisConnection(),
        concurrency: spec.concurrency(),
        ...(this.options.prefix ? { prefix: this.options.prefix } : {}),
      },
    );

    if (spec.logCompleted) {
      // Operator-visible proof the worker (not the API fallback) ran the job.
      worker.on('completed', (job) => {
        console.log(`[${spec.logLabel}] job ${job.id} completed in worker (${(job.finishedOn ?? Date.now()) - (job.processedOn ?? job.timestamp)} ms)`);
      });
    }
    worker.on('failed', (job, err) => {
      // The service already recorded the failure on its own row; this is
      // operator-visible logging only.
      console.error(`[${spec.logLabel}] job ${job?.id ?? '?'} failed: ${err?.message ?? err}`);
    });

    this.workers.add(worker);
    return {
      close: async () => {
        this.workers.delete(worker);
        await worker.close();
      },
    };
  }

  // Bounded so a dead Redis can't hang the request.
  async health(opts: { timeoutMs?: number; name?: keyof M & string } = {}): Promise<QueueHealth> {
    const timeoutMs = opts.timeoutMs ?? 2000;
    const name = opts.name ?? (Object.keys(this.specs)[0] as string);
    const t0 = Date.now();
    try {
      const workers = await Promise.race([
        this.queue(name).getWorkers(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('health timeout')), timeoutMs);
          t.unref?.();
        }),
      ]);
      return { ok: true, consumers: Array.isArray(workers) ? workers.length : 0, latencyMs: Date.now() - t0 };
    } catch {
      return { ok: false, consumers: null, latencyMs: Date.now() - t0 };
    }
  }

  /** Close workers (draining), producer queues, then the shared connection. */
  async close(): Promise<void> {
    await Promise.all([...this.workers].map((w) => w.close()));
    this.workers.clear();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    if (this.shared) {
      await this.shared.quit().catch(() => undefined);
      this.shared = null;
    }
  }
}
