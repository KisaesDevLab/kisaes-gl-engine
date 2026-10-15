// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * In-process worker — desktop mode's replacement for the worker container.
 *
 * The desktop engine ships as one process (the worker package is not
 * bundled), so this module does inside the engine what packages/worker does
 * on the server:
 *
 *   1. consumes the background job queues through the JobQueue (pg-boss by
 *      default on desktop) with the shared handlers (queue/handlers.ts);
 *   2. starts the schedulers that only the worker container used to start,
 *      as far as the desktop feature profile (desktop/features.ts
 *      DESKTOP_SCHEDULERS) enables them.
 *
 * Job types: all six. doc-render and doc-extract follow DOCUMENT_EXTRACTION_V1
 * exactly like the worker container (nothing enqueues them when it is off).
 *
 * Recurring work is not queue-based: every scheduler is a setInterval /
 * setTimeout loop guarded by a Postgres advisory lock (withSchedulerLock), so
 * it runs here unchanged. index.ts starts this module after the HTTP server
 * listens and stops it on shutdown before the job queue and the DB pool close.
 */

import { env } from '../config/env.js';
import { schedulerEnabled, type SchedulerName } from '../desktop/features.js';
import { getJobQueue } from './index.js';
import { JOB_HANDLERS, type JobHandlers } from './handlers.js';
import {
  DOC_EXTRACT_QUEUE,
  DOC_RENDER_QUEUE,
  JOB_NAMES,
  type JobName,
  type JobQueue,
  type WorkerHandle,
} from './job-queue.js';
import {
  startBalanceValidationScheduler,
  stopBalanceValidationScheduler,
} from '../services/balance-validation.service.js';
import { startReportPackSweepScheduler, stopReportPackSweepScheduler } from '../services/report-pack-sweep.service.js';
import { startClassificationStateBackfill } from '../services/classification-state-backfill.service.js';
import { runChunkedTagBackfill } from '../services/tags/backfill-sweep.service.js';
import { startPlaidSyncScheduler, stopPlaidSyncScheduler } from '../services/plaid-sync-scheduler.service.js';
import {
  startPortalRecurringScheduler,
  stopPortalRecurringScheduler,
} from '../services/portal-recurring-scheduler.service.js';
import {
  startPortalReminderScheduler,
  stopPortalReminderScheduler,
} from '../services/portal-reminder-scheduler.service.js';

export interface WorkerScheduler {
  name: SchedulerName;
  start: () => void;
  stop?: () => void;
}

/** One-shot chunked tag backfill, logged like the worker container does. */
function startTagBackfillOnce(): void {
  void runChunkedTagBackfill()
    .then((r) => {
      if (r.skipped) console.log('[in-process-worker] tag-backfill sweep skipped (lock held elsewhere)');
      else if (r.chunks === 0) console.log('[in-process-worker] tag-backfill sweep found nothing to backfill');
      else console.log(`[in-process-worker] tag-backfill sweep done: chunks=${r.chunks} rows=${r.rowsUpdated}`);
    })
    .catch((err) => console.error('[in-process-worker] tag-backfill sweep failed:', err));
}

/**
 * The schedulers packages/worker starts and the API process does not.
 * Which of them run in desktop mode is decided by DESKTOP_SCHEDULERS.
 */
export const WORKER_ONLY_SCHEDULERS: readonly WorkerScheduler[] = [
  { name: 'balanceValidation', start: startBalanceValidationScheduler, stop: stopBalanceValidationScheduler },
  { name: 'reportPackSweep', start: startReportPackSweepScheduler, stop: stopReportPackSweepScheduler },
  { name: 'classificationStateBackfill', start: startClassificationStateBackfill },
  { name: 'tagBackfill', start: startTagBackfillOnce },
  { name: 'plaidSync', start: startPlaidSyncScheduler, stop: stopPlaidSyncScheduler },
  { name: 'portalRecurring', start: startPortalRecurringScheduler, stop: stopPortalRecurringScheduler },
  { name: 'portalReminders', start: startPortalReminderScheduler, stop: stopPortalReminderScheduler },
];

/** Job types consumed in-process: all six, doc-* only with DOCUMENT_EXTRACTION_V1. */
export function inProcessJobNames(documentExtraction: boolean = env.DOCUMENT_EXTRACTION_V1): JobName[] {
  return JOB_NAMES.filter((n) => (n !== DOC_RENDER_QUEUE && n !== DOC_EXTRACT_QUEUE) || documentExtraction);
}

export interface InProcessWorker {
  readonly jobs: readonly JobName[];
  readonly schedulers: readonly SchedulerName[];
  /** Stop consuming (waits for in-flight jobs) and stop the started schedulers. */
  stop(): Promise<void>;
}

export interface InProcessWorkerDeps {
  queue?: JobQueue;
  handlers?: JobHandlers;
  schedulers?: readonly WorkerScheduler[];
  documentExtraction?: boolean;
}

export async function startInProcessWorker(deps: InProcessWorkerDeps = {}): Promise<InProcessWorker> {
  const queue = deps.queue ?? (await getJobQueue());
  const handlers = deps.handlers ?? JOB_HANDLERS;
  const jobs = inProcessJobNames(deps.documentExtraction);

  const handles: WorkerHandle[] = [];
  try {
    for (const name of jobs) {
      // The registry is typed per name; the loop variable widens it.
      handles.push(await queue.work(name, handlers[name] as never));
    }
  } catch (err) {
    await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
    throw err;
  }

  const started: WorkerScheduler[] = [];
  for (const s of deps.schedulers ?? WORKER_ONLY_SCHEDULERS) {
    if (!schedulerEnabled(s.name)) continue;
    s.start();
    started.push(s);
  }

  console.log(
    `[in-process-worker] started on ${queue.backend}: jobs=${jobs.join(',') || '-'} schedulers=${started.map((s) => s.name).join(',') || '-'}`,
  );

  let stopping: Promise<void> | null = null;
  return {
    jobs,
    schedulers: started.map((s) => s.name),
    stop() {
      if (!stopping) {
        stopping = (async () => {
          await Promise.all(handles.map((h) => h.close().catch((err) => console.error('[in-process-worker] close error:', err))));
          for (const s of started) s.stop?.();
        })();
      }
      return stopping;
    },
  };
}
