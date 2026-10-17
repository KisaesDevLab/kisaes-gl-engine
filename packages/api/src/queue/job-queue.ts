// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * JobQueue — the backend-neutral background-job interface.
 *
 * Producers (services/extraction/queue.ts) enqueue through it and consumers
 * (the worker package, or the desktop in-process worker) register handlers
 * through it. Three backends implement it:
 *
 *   bullmq  Redis-backed BullMQ (server default; today's behavior)
 *   pgboss  Postgres-backed pg-boss (desktop default; no Redis)
 *   none    no queue: every enqueue fails fast so producers run in-process
 *
 * The per-job contract (retries, retention, concurrency, log lines) lives in
 * queue/specs.ts, one row per job name, so every backend reads the same table.
 *
 * This module holds only types and constants: it imports no backend library,
 * so importing it never evaluates bullmq, ioredis or pg-boss.
 */

export const DOC_RENDER_QUEUE = 'doc-render';
export const DOC_EXTRACT_QUEUE = 'doc-extract';
export const STATEMENT_PARSE_QUEUE = 'statement-parse';
export const REPORT_PACK_QUEUE = 'report-pack';
export const BILL_CAPTURE_QUEUE = 'bill-capture';
/** AI parameter check runs (Tax Estimator, OPEN-QUESTIONS Q48). */
export const TAX_PARAM_AI_CHECK_QUEUE = 'tax-param-ai-check';

export const JOB_NAMES = [
  DOC_RENDER_QUEUE,
  DOC_EXTRACT_QUEUE,
  STATEMENT_PARSE_QUEUE,
  REPORT_PACK_QUEUE,
  BILL_CAPTURE_QUEUE,
  TAX_PARAM_AI_CHECK_QUEUE,
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export interface StatementParseJobData {
  jobId: string;
  tenantId: string;
  attachmentId: string;
}

export interface BillCaptureJobData {
  captureId: string;
  tenantId: string;
  // Reprocess bumps this so the BullMQ job id is fresh (a completed id is
  // a silent no-op on re-add).
  attempt: number;
}

export interface TaxParamAiCheckJobData {
  runId: string;
}

export interface ReportPackJobData {
  runId: string;
  tenantId: string;
}

export interface RenderJobData {
  jobId: string;
  tenantId: string;
}

export interface ExtractJobData {
  jobId: string;
  tenantId: string;
  pageNo: number;
}

/** Payload type per job name. */
export interface JobData {
  'doc-render': RenderJobData;
  'doc-extract': ExtractJobData;
  'statement-parse': StatementParseJobData;
  'report-pack': ReportPackJobData;
  'bill-capture': BillCaptureJobData;
  'tax-param-ai-check': TaxParamAiCheckJobData;
}

export type QueueBackendName = 'bullmq' | 'pgboss' | 'none';

/**
 * How one job type is queued and consumed. Every backend maps the same row;
 * see queue/specs.ts for the values and how each backend interprets them.
 */
export interface JobSpec {
  /** Total tries including the first (1 = never retried). */
  attempts: number;
  /** Base delay of the exponential backoff between retries; unset = no backoff option. */
  backoffMs?: number;
  /** BullMQ `removeOnComplete` (count). pg-boss keeps by age instead (specs.ts). */
  keepCompleted: number;
  /** BullMQ `removeOnFail` (count). pg-boss keeps by age instead (specs.ts). */
  keepFailed: number;
  /**
   * How long one attempt may stay active before the backend treats it as
   * lost (pg-boss `expireInSeconds`). BullMQ uses lock renewal instead and
   * ignores this.
   */
  activeTimeoutSeconds: number;
  /** Max simultaneous handlers per consuming process. Read when the consumer starts. */
  concurrency: () => number;
  /** Job name passed to BullMQ `Queue.add` (kept byte-identical for the server). */
  bullmqJobName: string;
  /** Prefix of the operator log lines, e.g. `[report-pack] job … failed: …`. */
  logLabel: string;
  /** Whether a completed job logs `… completed in worker (N ms)`. */
  logCompleted: boolean;
}

/** A spec table: one JobSpec per job name of the payload map M. */
export type JobSpecTable<M> = { readonly [K in keyof M & string]: JobSpec };

export interface JobContext {
  /** Backend job id (BullMQ: the producer's id; pg-boss: its UUID). */
  jobId: string;
  /** 1-based attempt number. */
  attempt: number;
  /** True when a failure of this attempt is terminal (no retry follows). */
  isFinalAttempt: boolean;
}

export type JobHandler<D> = (data: D, ctx: JobContext) => Promise<void>;

export interface WorkerHandle {
  /** Stop taking new jobs and wait for in-flight handlers to finish. */
  close(): Promise<void>;
}

export interface QueueHealth {
  ok: boolean;
  /** Consumers attached to the queue (BullMQ counts every process; pg-boss counts this one). null = unknown. */
  consumers: number | null;
  latencyMs: number;
}

export interface JobQueue<M = JobData> {
  readonly backend: QueueBackendName;
  /**
   * Add a job. `jobId` is the producer's deterministic id ('-' only, never ':'):
   * enqueueing an id that is still known to the backend is a no-op.
   */
  enqueue<N extends keyof M & string>(name: N, data: M[N], opts: { jobId: string }): Promise<void>;
  /** Consume `name` with `handler` at the spec's concurrency. A throw fails the attempt. */
  work<N extends keyof M & string>(name: N, handler: JobHandler<M[N]>): Promise<WorkerHandle>;
  /** Bounded reachability probe; `name` selects the queue whose consumers are counted. */
  health(opts?: { timeoutMs?: number; name?: keyof M & string }): Promise<QueueHealth>;
  /** Close every worker (draining in-flight jobs) and every connection. */
  close(): Promise<void>;
}
