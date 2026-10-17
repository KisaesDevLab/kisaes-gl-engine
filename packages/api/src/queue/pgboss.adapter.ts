// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * QUEUE_BACKEND=pgboss — a durable, Postgres-only backend (desktop default;
 * also usable by a server that wants no Redis). Built on pg-boss (MIT).
 *
 * - pg-boss keeps its tables in its own schema (`pgboss`) and creates and
 *   migrates it on start. That needs only CREATE on the database, which the
 *   database owner has: no superuser, no extension.
 * - It has its own small pool (max 3) so job polling never competes with
 *   request traffic for the engine pool.
 * - Idempotent enqueue: the producer's job id ('stmt-<uuid>', ...) is mapped
 *   to a UUIDv5 and used as the pg-boss job id. Sending an id that already
 *   exists is a no-op (pg-boss inserts with ON CONFLICT DO NOTHING), exactly
 *   like BullMQ ignoring an add whose id exists. The parity suite pins this.
 * - Retries map attempts → retryLimit (attempts - 1) and backoffMs →
 *   retryBackoff + retryDelay; the handler's ctx.attempt comes from
 *   job.retryCount.
 * - Every failure to reach Postgres surfaces as a fast, clear rejection
 *   (connect timeout 5 s); nothing waits forever, unlike an ioredis producer
 *   with maxRetriesPerRequest: null.
 */

import crypto from 'node:crypto';
import { PgBoss, type Job, type SendOptions } from 'pg-boss';
import type {
  JobHandler,
  JobQueue,
  JobSpec,
  JobSpecTable,
  QueueHealth,
  WorkerHandle,
} from './job-queue.js';
import { PGBOSS_KEEP_SECONDS } from './specs.js';

/** Namespace of the job-id → UUIDv5 mapping. Never change it: ids already stored depend on it. */
export const ENGINE_JOB_NAMESPACE = '5f0c8a8e-3c1b-5d5e-9a51-6b9d2f1c4e7a';

/** RFC 4122 UUIDv5 (SHA-1, namespaced) of `name`. */
export function uuidV5(name: string, namespace: string = ENGINE_JOB_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The pg-boss job id of a producer job id in queue `name`. */
export function pgBossJobId(name: string, jobId: string): string {
  return uuidV5(`${name}/${jobId}`);
}

/** pg-boss could not be reached or started. Producers treat it like any enqueue failure. */
export class JobQueueUnavailableError extends Error {
  readonly code = 'QUEUE_UNAVAILABLE';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JobQueueUnavailableError';
  }
}

export interface PgBossQueueOptions {
  connectionString: string;
  /** Schema pg-boss owns. Default `pgboss`. */
  schema?: string;
  /** pg-boss pool size. Default 3. */
  max?: number;
  /** Idle poll interval of each consumer. Default 2 s (pg-boss minimum 0.5). */
  pollingIntervalSeconds?: number;
  /** Connect timeout for every pg-boss connection. Default 5000 ms. */
  connectTimeoutMs?: number;
  /** How long close() waits for in-flight handlers. Default 20000 ms. */
  stopTimeoutMs?: number;
  /** application_name on pg-boss connections. Default `mybooks-jobs`. */
  applicationName?: string;
}

export function pgBossSendOptions(spec: JobSpec): SendOptions {
  return {
    retryLimit: Math.max(0, spec.attempts - 1),
    retryDelay: spec.backoffMs !== undefined ? Math.max(1, Math.round(spec.backoffMs / 1000)) : 0,
    retryBackoff: spec.backoffMs !== undefined,
    expireInSeconds: spec.activeTimeoutSeconds,
    deleteAfterSeconds: PGBOSS_KEEP_SECONDS,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PgBossQueue<M> implements JobQueue<M> {
  readonly backend = 'pgboss' as const;
  private starting: Promise<PgBoss> | null = null;
  private readonly queuesReady = new Map<string, Promise<void>>();
  private readonly consumers = new Map<string, number>();
  private readonly handles = new Set<WorkerHandle>();
  private closed = false;

  constructor(
    private readonly specs: JobSpecTable<M>,
    private readonly options: PgBossQueueOptions,
  ) {}

  private spec(name: string): JobSpec {
    const spec = (this.specs as Record<string, JobSpec | undefined>)[name];
    if (!spec) throw new Error(`unknown job "${name}"`);
    return spec;
  }

  /** Start pg-boss once (creates/migrates its schema). A failed start is retried on the next call. */
  private start(): Promise<PgBoss> {
    if (this.closed) return Promise.reject(new JobQueueUnavailableError('The job queue is shut down.'));
    if (!this.starting) {
      const boss = new PgBoss({
        connectionString: this.options.connectionString,
        schema: this.options.schema ?? 'pgboss',
        max: this.options.max ?? 3,
        application_name: this.options.applicationName ?? 'mybooks-jobs',
        connectionTimeoutMillis: this.options.connectTimeoutMs ?? 5_000,
        // No cron schedules (recurring work uses the engine's own advisory-
        // locked schedulers), no instance registry rows, no telemetry.
        schedule: false,
        registerInstance: false,
        openTelemetry: { enabled: false },
      });
      boss.on('error', (err: unknown) => console.error(`[pg-boss] ${message(err)}`));
      this.starting = boss.start().then(
        () => boss,
        async (err: unknown) => {
          this.starting = null;
          await boss.stop({ graceful: false, close: true }).catch(() => undefined);
          throw new JobQueueUnavailableError(`Background job queue (pg-boss) could not start: ${message(err)}`, { cause: err });
        },
      );
    }
    return this.starting;
  }

  private ensureQueue(boss: PgBoss, name: string): Promise<void> {
    let ready = this.queuesReady.get(name);
    if (!ready) {
      const { retryLimit, retryDelay, retryBackoff, expireInSeconds, deleteAfterSeconds } = pgBossSendOptions(this.spec(name));
      ready = (async () => {
        if (await boss.getQueue(name)) return;
        await boss.createQueue(name, { retryLimit, retryDelay, retryBackoff, expireInSeconds, deleteAfterSeconds });
      })();
      ready.catch(() => this.queuesReady.delete(name));
      this.queuesReady.set(name, ready);
    }
    return ready;
  }

  async enqueue<N extends keyof M & string>(name: N, data: M[N], opts: { jobId: string }): Promise<void> {
    const spec = this.spec(name);
    const boss = await this.start();
    try {
      await this.ensureQueue(boss, name);
      // Options travel with every job, so a changed spec applies to new jobs
      // even though the queue row was created by an older version. A null
      // result means the id already exists: a no-op by design.
      await boss.send(name, data as object, { ...pgBossSendOptions(spec), id: pgBossJobId(name, opts.jobId) });
    } catch (err) {
      if (err instanceof JobQueueUnavailableError) throw err;
      throw new JobQueueUnavailableError(`Could not enqueue "${name}": ${message(err)}`, { cause: err });
    }
  }

  async work<N extends keyof M & string>(name: N, handler: JobHandler<M[N]>): Promise<WorkerHandle> {
    const spec = this.spec(name);
    const boss = await this.start();
    await this.ensureQueue(boss, name);

    const run = async (job: Job<M[N]>): Promise<void> => {
      const t0 = Date.now();
      const attempt = job.retryCount + 1;
      try {
        await handler(job.data, { jobId: job.id, attempt, isFinalAttempt: attempt >= spec.attempts });
      } catch (err) {
        // The service already recorded the failure on its own row; this is
        // operator-visible logging only (same line as the BullMQ worker).
        console.error(`[${spec.logLabel}] job ${job.id} failed: ${message(err)}`);
        throw err;
      }
      if (spec.logCompleted) {
        console.log(`[${spec.logLabel}] job ${job.id} completed in worker (${Date.now() - t0} ms)`);
      }
    };

    const workerId = await boss.work<M[N]>(
      name,
      {
        batchSize: 1,
        localConcurrency: Math.max(1, spec.concurrency()),
        pollingIntervalSeconds: this.options.pollingIntervalSeconds ?? 2,
      },
      async (jobs) => {
        for (const job of jobs) await run(job);
      },
    );
    this.consumers.set(name, (this.consumers.get(name) ?? 0) + 1);

    let closing: Promise<void> | null = null;
    const handle: WorkerHandle = {
      close: () => {
        if (!closing) {
          closing = (async () => {
            this.handles.delete(handle);
            this.consumers.set(name, Math.max(0, (this.consumers.get(name) ?? 1) - 1));
            await boss.offWork(name, { id: workerId, wait: true });
          })();
        }
        return closing;
      },
    };
    this.handles.add(handle);
    return handle;
  }

  async health(opts: { timeoutMs?: number; name?: keyof M & string } = {}): Promise<QueueHealth> {
    const timeoutMs = opts.timeoutMs ?? 2000;
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const version = await Promise.race([
        this.start().then((boss) => boss.schemaVersion()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('health timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
      const consumers = opts.name
        ? (this.consumers.get(opts.name) ?? 0)
        : [...this.consumers.values()].reduce((a, b) => a + b, 0);
      return { ok: typeof version === 'number', consumers, latencyMs: Date.now() - t0 };
    } catch {
      return { ok: false, consumers: null, latencyMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stop consuming, wait up to stopTimeoutMs for in-flight handlers, then
   * close pg-boss's pool. Run before the engine pool is closed.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const boss = this.starting ? await this.starting.catch(() => null) : null;
    this.handles.clear();
    this.consumers.clear();
    if (boss) await boss.stop({ graceful: true, close: true, timeout: this.options.stopTimeoutMs ?? 20_000 });
    this.starting = null;
  }
}
