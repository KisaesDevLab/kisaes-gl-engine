// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * JOB_SPECS — the one table of per-job queue behavior, shared by every
 * JobQueue backend. The values are moved verbatim from the former
 * DEFAULT_JOB_OPTIONS / STATEMENT_PARSE_JOB_OPTIONS / REPORT_PACK_JOB_OPTIONS
 * constants in services/extraction/queue.ts and the worker processors'
 * concurrency settings; queue/specs.test.ts pins the BullMQ options that come
 * out of it.
 *
 * How each backend reads a row:
 *
 *   field                BullMQ                          pg-boss
 *   attempts             attempts                        retryLimit = attempts - 1
 *   backoffMs            backoff {exponential, delay}    retryBackoff + retryDelay = backoffMs / 1000
 *   keepCompleted/Failed removeOnComplete / removeOnFail (no count-based retention; jobs are
 *                                                         kept PGBOSS_KEEP_SECONDS, see below)
 *   activeTimeoutSeconds (lock renewal; unused)          expireInSeconds
 *   concurrency          Worker concurrency              work() localConcurrency
 */

import { env } from '../config/env.js';
import type { JobData, JobSpec, JobSpecTable } from './job-queue.js';

// Retry/backoff defaults: 3 attempts with exponential backoff. After the
// last attempt a failed job lands in the backend's failed set; the extract
// service additionally routes config/validation failures into the review
// queue so they are visible to a human (brief — "dead-letter to review").
const RETRYING = { attempts: 3, backoffMs: 5_000, keepCompleted: 1_000, keepFailed: 5_000 } as const;

// Statement parse is ONE expensive unit of work (multi-page OCR + an LLM call)
// tracked by its own ai_jobs row, and re-running it would re-do the OCR and
// double the AI spend — so no auto-retry (attempts: 1). Bill capture uses the
// same options.
const SINGLE_SHOT_PARSE = { attempts: 1, keepCompleted: 500, keepFailed: 1_000 } as const;

// A pack render is ONE expensive unit (N Puppeteer renders + a merge +
// upload) tracked by its own report_pack_runs row. Re-running would re-do
// every section and re-upload — so no auto-retry (attempts: 1). An AI check
// run is many paid API calls tracked by its tax_param_ai_check_runs row; a
// retry would re-check (and re-bill) every row, so it uses the same options.
const SINGLE_SHOT_RUN = { attempts: 1, keepCompleted: 500, keepFailed: 1_000 } as const;

const HOUR = 3_600;

export const JOB_SPECS: JobSpecTable<JobData> = {
  'doc-render': {
    ...RETRYING,
    // Rendering is CPU/IO bound (poppler + image writes); a small cap keeps
    // a burst of uploads from saturating the box.
    concurrency: () => 2,
    activeTimeoutSeconds: HOUR,
    bullmqJobName: 'render',
    logLabel: 'doc-render',
    logCompleted: false,
  },
  'doc-extract': {
    ...RETRYING,
    // The model-call concurrency cap, so a heavy image-prefill model can't be
    // hammered with parallel calls.
    concurrency: () => env.EXTRACTION_EXTRACT_CONCURRENCY,
    activeTimeoutSeconds: HOUR,
    bullmqJobName: 'extract',
    logLabel: 'doc-extract',
    logCompleted: false,
  },
  'statement-parse': {
    ...SINGLE_SHOT_PARSE,
    concurrency: () => env.STATEMENT_PARSE_CONCURRENCY,
    activeTimeoutSeconds: 4 * HOUR,
    bullmqJobName: 'parse',
    logLabel: 'statement-parse',
    logCompleted: true,
  },
  'bill-capture': {
    ...SINGLE_SHOT_PARSE,
    // GLM-OCR is a single-slot engine.
    concurrency: () => env.BILL_CAPTURE_CONCURRENCY,
    activeTimeoutSeconds: HOUR,
    bullmqJobName: 'extract',
    logLabel: 'bill-capture',
    logCompleted: false,
  },
  'report-pack': {
    ...SINGLE_SHOT_RUN,
    concurrency: () => 1,
    activeTimeoutSeconds: 4 * HOUR,
    bullmqJobName: 'render',
    logLabel: 'report-pack',
    logCompleted: true,
  },
  'tax-param-ai-check': {
    ...SINGLE_SHOT_RUN,
    // Each run already checks two rows at a time, and the claim (queued →
    // running) is a compare-and-swap, so a watchdog cannot double-run it.
    concurrency: () => 1,
    activeTimeoutSeconds: 4 * HOUR,
    bullmqJobName: 'check',
    logLabel: 'tax-ai-check',
    logCompleted: true,
  },
};

export type { JobSpec };
