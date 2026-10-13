// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// BullMQ wiring for the document-extraction pipeline — the first real BullMQ
// usage in the codebase (everything else runs on advisory-lock scheduler
// loops). Two queues:
//   doc-render   PDF → page PNGs (one job per uploaded document)
//   doc-extract  one job per page → local Qwen vision call
//
// Connections are created lazily so merely importing this module (e.g. from
// the API process, or in a unit test) doesn't open a Redis socket. The API
// only ever enqueues; the worker package creates the Workers that consume.

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import RedisPkg from 'ioredis';

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);
type RedisClient = InstanceType<typeof Redis>;

export const DOC_RENDER_QUEUE = 'doc-render';
export const DOC_EXTRACT_QUEUE = 'doc-extract';
export const STATEMENT_PARSE_QUEUE = 'statement-parse';
export const REPORT_PACK_QUEUE = 'report-pack';
export const BILL_CAPTURE_QUEUE = 'bill-capture';
/** AI parameter check runs (Tax Estimator, OPEN-QUESTIONS Q44). */
export const TAX_PARAM_AI_CHECK_QUEUE = 'tax-param-ai-check';

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

// BullMQ requires `maxRetriesPerRequest: null` on the connection it uses for
// blocking commands (BRPOPLPUSH etc.). Each Worker should get its OWN
// connection; the shared one here backs the Queue producers only.
export function makeRedisConnection(): RedisClient {
  const url = process.env['REDIS_URL'] || 'redis://redis:6379';
  return new Redis(url, { maxRetriesPerRequest: null });
}

// BullMQ custom job ids. BullMQ 5 throws "Custom Id cannot contain :" for any
// custom id containing ':' that doesn't split into exactly 3 parts (a legacy
// repeatable-job carve-out it plans to drop), so `stmt:<id>` / `pack:<id>` /
// `render:<id>` made EVERY enqueue throw and each caller silently fell back to
// in-process work. Use '-' only. Deterministic ids keep re-enqueues idempotent
// (BullMQ ignores an add whose id already exists).
export const queueJobIds = {
  statementParse: (jobId: string) => `stmt-${jobId}`,
  reportPack: (runId: string) => `pack-${runId}`,
  render: (jobId: string) => `render-${jobId}`,
  extract: (jobId: string, pageNo: number) => `extract-${jobId}-${pageNo}`,
  billCapture: (captureId: string, attempt: number) => `bcap-${captureId}-${attempt}`,
  taxParamAiCheck: (runId: string) => `taxai-${runId}`,
};

let sharedConnection: RedisClient | null = null;
function getSharedConnection(): RedisClient {
  if (!sharedConnection) sharedConnection = makeRedisConnection();
  return sharedConnection;
}

// Retry/backoff defaults: 3 attempts with exponential backoff. After the
// last attempt a failed job lands in BullMQ's failed set; the extract
// processor additionally routes a terminal failure into the review queue so
// it's visible to a human (brief — "dead-letter to review").
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

// Statement parse is ONE expensive unit of work (multi-page OCR + an LLM call)
// tracked by its own ai_jobs row, and re-running it would re-do the OCR and
// double the AI spend — so no auto-retry (attempts: 1).
const STATEMENT_PARSE_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: 500,
  removeOnFail: 1_000,
};

// A pack render is ONE expensive unit (N Puppeteer renders + a merge +
// upload) tracked by its own report_pack_runs row. Re-running would re-do
// every section and re-upload — so no auto-retry (attempts: 1).
const REPORT_PACK_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: 500,
  removeOnFail: 1_000,
};

let renderQueue: Queue<RenderJobData> | null = null;
let extractQueue: Queue<ExtractJobData> | null = null;
let statementParseQueue: Queue<StatementParseJobData> | null = null;
let reportPackQueue: Queue<ReportPackJobData> | null = null;
let billCaptureQueue: Queue<BillCaptureJobData> | null = null;
let taxParamAiCheckQueue: Queue<TaxParamAiCheckJobData> | null = null;

function getRenderQueue(): Queue<RenderJobData> {
  if (!renderQueue) {
    renderQueue = new Queue<RenderJobData>(DOC_RENDER_QUEUE, {
      connection: getSharedConnection() as ConnectionOptions,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return renderQueue;
}

function getExtractQueue(): Queue<ExtractJobData> {
  if (!extractQueue) {
    extractQueue = new Queue<ExtractJobData>(DOC_EXTRACT_QUEUE, {
      connection: getSharedConnection() as ConnectionOptions,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return extractQueue;
}

function getStatementParseQueue(): Queue<StatementParseJobData> {
  if (!statementParseQueue) {
    statementParseQueue = new Queue<StatementParseJobData>(STATEMENT_PARSE_QUEUE, {
      connection: getSharedConnection() as ConnectionOptions,
      defaultJobOptions: STATEMENT_PARSE_JOB_OPTIONS,
    });
  }
  return statementParseQueue;
}

function getReportPackQueue(): Queue<ReportPackJobData> {
  if (!reportPackQueue) {
    reportPackQueue = new Queue<ReportPackJobData>(REPORT_PACK_QUEUE, {
      connection: getSharedConnection() as ConnectionOptions,
      defaultJobOptions: REPORT_PACK_JOB_OPTIONS,
    });
  }
  return reportPackQueue;
}

/** Enqueue a statement parse. jobId as the BullMQ job id makes it idempotent. */
export async function enqueueStatementParse(data: StatementParseJobData): Promise<void> {
  await getStatementParseQueue().add('parse', data, { jobId: queueJobIds.statementParse(data.jobId) });
}

function getBillCaptureQueue(): Queue<BillCaptureJobData> {
  if (!billCaptureQueue) {
    billCaptureQueue = new Queue<BillCaptureJobData>(BILL_CAPTURE_QUEUE, {
      connection: getSharedConnection() as ConnectionOptions,
      defaultJobOptions: STATEMENT_PARSE_JOB_OPTIONS,
    });
  }
  return billCaptureQueue;
}

/** Enqueue a Bill Capture extraction. captureId+attempt as the BullMQ job id. */
export async function enqueueBillCapture(data: BillCaptureJobData): Promise<void> {
  await getBillCaptureQueue().add('extract', data, { jobId: queueJobIds.billCapture(data.captureId, data.attempt) });
}

// An AI check run is many paid API calls tracked by its tax_param_ai_check_runs row; a retry
// would re-check (and re-bill) every row, so no auto-retry (attempts: 1).
function getTaxParamAiCheckQueue(): Queue<TaxParamAiCheckJobData> {
  if (!taxParamAiCheckQueue) {
    taxParamAiCheckQueue = new Queue<TaxParamAiCheckJobData>(TAX_PARAM_AI_CHECK_QUEUE, {
      connection: getSharedConnection() as ConnectionOptions,
      defaultJobOptions: REPORT_PACK_JOB_OPTIONS,
    });
  }
  return taxParamAiCheckQueue;
}

/** Enqueue an AI parameter check run. runId as the BullMQ job id ('-' only, never ':') makes it idempotent. */
export async function enqueueTaxParamAiCheck(data: TaxParamAiCheckJobData): Promise<void> {
  await getTaxParamAiCheckQueue().add('check', data, { jobId: queueJobIds.taxParamAiCheck(data.runId) });
}

/** Enqueue a report-pack render. runId as the BullMQ job id makes it idempotent. */
export async function enqueueReportPack(data: ReportPackJobData): Promise<void> {
  await getReportPackQueue().add('render', data, { jobId: queueJobIds.reportPack(data.runId) });
}

// Report-pack background health for the UI: whether Redis is reachable and
// whether at least one worker is consuming the queue. When the worker is
// absent, createRun still generates inline in the API — this just surfaces
// that the dedicated worker isn't running. Bounded so a dead Redis can't hang
// the request.
export async function getReportPackQueueHealth(
  timeoutMs = 2000,
): Promise<{ redisReachable: boolean; workerRunning: boolean }> {
  try {
    const workers = await Promise.race([
      getReportPackQueue().getWorkers(),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('health timeout')), timeoutMs);
        t.unref?.();
      }),
    ]);
    return { redisReachable: true, workerRunning: Array.isArray(workers) && workers.length > 0 };
  } catch {
    return { redisReachable: false, workerRunning: false };
  }
}

/** Enqueue the render step for a freshly-created job. */
export async function enqueueRender(data: RenderJobData): Promise<void> {
  // jobId as the BullMQ job id makes the enqueue idempotent — re-enqueuing
  // the same document won't create a duplicate render job.
  await getRenderQueue().add('render', data, { jobId: queueJobIds.render(data.jobId) });
}

/** Enqueue the extract step for one rendered page. */
export async function enqueueExtract(data: ExtractJobData): Promise<void> {
  await getExtractQueue().add('extract', data, {
    jobId: queueJobIds.extract(data.jobId, data.pageNo),
  });
}

/** Close producer connections (graceful shutdown / test teardown). */
export async function closeQueues(): Promise<void> {
  await Promise.all([
    renderQueue?.close(),
    extractQueue?.close(),
    statementParseQueue?.close(),
    reportPackQueue?.close(),
    billCaptureQueue?.close(),
    taxParamAiCheckQueue?.close(),
  ]);
  renderQueue = null;
  extractQueue = null;
  statementParseQueue = null;
  reportPackQueue = null;
  billCaptureQueue = null;
  taxParamAiCheckQueue = null;
  if (sharedConnection) {
    await sharedConnection.quit().catch(() => undefined);
    sharedConnection = null;
  }
}
