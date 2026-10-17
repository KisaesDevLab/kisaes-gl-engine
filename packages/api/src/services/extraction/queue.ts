// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Background-job producers. Six queues:
//   doc-render          PDF → page PNGs (one job per uploaded document)
//   doc-extract         one job per page → local Qwen vision call
//   statement-parse     one bank/card statement → OCR → extract → reconcile
//   bill-capture        one uploaded vendor bill → bill OCR
//   report-pack         one report_pack_runs row → rendered pack
//   tax-param-ai-check  one Tax Estimator AI parameter check run
//
// Every enqueue goes through the process JobQueue (queue/index.ts), whose
// backend comes from QUEUE_BACKEND: BullMQ on Redis (server default), or
// `none` (fail fast; callers fall back to in-process work). Per-job retry,
// retention and concurrency live in queue/specs.ts. Nothing here opens a
// connection at import time; the API only ever enqueues, and the worker
// package (or the desktop in-process worker) consumes.

import { assertQueueEnabled, queueDisabled } from '../../queue/none.adapter.js';
import { getJobQueue, closeJobQueues } from '../../queue/index.js';
import {
  DOC_RENDER_QUEUE,
  DOC_EXTRACT_QUEUE,
  STATEMENT_PARSE_QUEUE,
  REPORT_PACK_QUEUE,
  BILL_CAPTURE_QUEUE,
  TAX_PARAM_AI_CHECK_QUEUE,
  type StatementParseJobData,
  type BillCaptureJobData,
  type TaxParamAiCheckJobData,
  type ReportPackJobData,
  type RenderJobData,
  type ExtractJobData,
} from '../../queue/job-queue.js';

export {
  DOC_RENDER_QUEUE,
  DOC_EXTRACT_QUEUE,
  STATEMENT_PARSE_QUEUE,
  REPORT_PACK_QUEUE,
  BILL_CAPTURE_QUEUE,
  TAX_PARAM_AI_CHECK_QUEUE,
};
export type {
  StatementParseJobData,
  BillCaptureJobData,
  TaxParamAiCheckJobData,
  ReportPackJobData,
  RenderJobData,
  ExtractJobData,
};
export { makeRedisConnection } from '../../queue/redis-connection.js';

// Producer job ids. BullMQ 5 throws "Custom Id cannot contain :" for any
// custom id containing ':' that doesn't split into exactly 3 parts (a legacy
// repeatable-job carve-out it plans to drop), so `stmt:<id>` / `pack:<id>` /
// `render:<id>` made EVERY enqueue throw and each caller silently fell back to
// in-process work. Use '-' only. Deterministic ids keep re-enqueues idempotent
// (the backend ignores an add whose id already exists).
export const queueJobIds = {
  statementParse: (jobId: string) => `stmt-${jobId}`,
  reportPack: (runId: string) => `pack-${runId}`,
  render: (jobId: string) => `render-${jobId}`,
  extract: (jobId: string, pageNo: number) => `extract-${jobId}-${pageNo}`,
  billCapture: (captureId: string, attempt: number) => `bcap-${captureId}-${attempt}`,
  taxParamAiCheck: (runId: string) => `taxai-${runId}`,
};

/** Enqueue a statement parse. jobId as the queue job id makes it idempotent. */
export async function enqueueStatementParse(data: StatementParseJobData): Promise<void> {
  assertQueueEnabled(STATEMENT_PARSE_QUEUE);
  await (await getJobQueue()).enqueue(STATEMENT_PARSE_QUEUE, data, { jobId: queueJobIds.statementParse(data.jobId) });
}

/** Enqueue a Bill Capture extraction. captureId+attempt as the queue job id. */
export async function enqueueBillCapture(data: BillCaptureJobData): Promise<void> {
  assertQueueEnabled(BILL_CAPTURE_QUEUE);
  await (await getJobQueue()).enqueue(BILL_CAPTURE_QUEUE, data, { jobId: queueJobIds.billCapture(data.captureId, data.attempt) });
}

/** Enqueue an AI parameter check run. runId as the queue job id ('-' only, never ':') makes it idempotent. */
export async function enqueueTaxParamAiCheck(data: TaxParamAiCheckJobData): Promise<void> {
  assertQueueEnabled(TAX_PARAM_AI_CHECK_QUEUE);
  await (await getJobQueue()).enqueue(TAX_PARAM_AI_CHECK_QUEUE, data, { jobId: queueJobIds.taxParamAiCheck(data.runId) });
}

/** Enqueue a report-pack render. runId as the queue job id makes it idempotent. */
export async function enqueueReportPack(data: ReportPackJobData): Promise<void> {
  assertQueueEnabled(REPORT_PACK_QUEUE);
  await (await getJobQueue()).enqueue(REPORT_PACK_QUEUE, data, { jobId: queueJobIds.reportPack(data.runId) });
}

// Report-pack background health for the UI: whether the queue is reachable
// and whether at least one worker is consuming it. When the worker is absent,
// createRun still generates inline in the API — this just surfaces that the
// dedicated worker isn't running. Bounded so a dead Redis can't hang the
// request. (`redisReachable` keeps its name for the existing UI contract.)
export async function getReportPackQueueHealth(
  timeoutMs = 2000,
): Promise<{ redisReachable: boolean; workerRunning: boolean }> {
  // QUEUE_BACKEND=none: there is no queue to ask (and no Redis to dial).
  if (queueDisabled()) return { redisReachable: false, workerRunning: false };
  try {
    const h = await (await getJobQueue()).health({ timeoutMs, name: REPORT_PACK_QUEUE });
    return { redisReachable: h.ok, workerRunning: h.ok && (h.consumers ?? 0) > 0 };
  } catch {
    return { redisReachable: false, workerRunning: false };
  }
}

/** Enqueue the render step for a freshly-created job. */
export async function enqueueRender(data: RenderJobData): Promise<void> {
  assertQueueEnabled(DOC_RENDER_QUEUE);
  // jobId as the queue job id makes the enqueue idempotent — re-enqueuing
  // the same document won't create a duplicate render job.
  await (await getJobQueue()).enqueue(DOC_RENDER_QUEUE, data, { jobId: queueJobIds.render(data.jobId) });
}

/** Enqueue the extract step for one rendered page. */
export async function enqueueExtract(data: ExtractJobData): Promise<void> {
  assertQueueEnabled(DOC_EXTRACT_QUEUE);
  await (await getJobQueue()).enqueue(DOC_EXTRACT_QUEUE, data, {
    jobId: queueJobIds.extract(data.jobId, data.pageNo),
  });
}

/** Close producer connections (graceful shutdown / test teardown). */
export async function closeQueues(): Promise<void> {
  await closeJobQueues();
}
