// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * JOB_HANDLERS — what each background job does, shared by every consumer:
 * the worker package (server) and the in-process worker (desktop). Each
 * handler is the thin wiring the BullMQ processors used to carry around an
 * api service; the services own the work and record success or failure on
 * their own rows, so a handler only has to call them and let a throw fail
 * the attempt.
 *
 * Retries and dead-lettering stay where they were: the extract service
 * routes config/validation failures to review itself and rethrows transient
 * errors so the backend retries (ctx.isFinalAttempt is available to handlers
 * that need it; none of today's six does).
 */

import type { JobData, JobHandler, JobName } from './job-queue.js';
import { processRender, processExtractPage } from '../services/extraction/extraction.service.js';
import { runStatementParseJob } from '../services/ai-statement-parser.service.js';
import { runBillCaptureJob } from '../services/bill-capture.service.js';
import { generateReportPackRun } from '../services/report-pack-generate.service.js';
import { executeRun } from '../services/tax-estimator/tax-param-ai-check.service.js';

export type JobHandlers = { readonly [N in JobName]: JobHandler<JobData[N]> };

export const JOB_HANDLERS: JobHandlers = {
  // Rasterize an uploaded document to page images and enqueue one extract
  // job per page.
  'doc-render': async (data) => {
    await processRender(data.tenantId, data.jobId);
  },
  // One rendered page → local vision model → validate → persist or review.
  'doc-extract': async (data) => {
    await processExtractPage(data.tenantId, data.jobId, data.pageNo);
  },
  // Bank / credit-card statement: detect → OCR → extract → reconcile,
  // updating the ai_jobs row the upload UI polls.
  'statement-parse': async (data) => {
    await runStatementParseJob(data.tenantId, data.attachmentId, data.jobId);
  },
  // Bill-OCR pipeline for one uploaded vendor bill.
  'bill-capture': async (data) => {
    await runBillCaptureJob(data.tenantId, data.captureId);
  },
  // One report_pack_runs row: render, merge, upload.
  'report-pack': async (data) => {
    await generateReportPackRun(data.runId);
  },
  // One tax_param_ai_check_runs row (Tax Estimator AI parameter check).
  'tax-param-ai-check': async (data) => {
    await executeRun(data.runId);
  },
};
