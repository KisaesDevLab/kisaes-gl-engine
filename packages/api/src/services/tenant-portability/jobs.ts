// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * In-process job registry for archive export and import (U-05). Jobs live
 * in memory only: after an engine restart a job id is 404 JOB_UNKNOWN, and
 * no other endpoint depends on job ids (S5). Finished jobs are kept for
 * JOB_RETENTION_MS.
 */

import crypto from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { errorSummaryForLog } from '../../utils/log-safe.js';
import { ArchiveError } from './errors.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobState<R = unknown> {
  id: string;
  kind: 'export' | 'import';
  tenantId: string | null;
  userId: string;
  status: JobStatus;
  /** 0-100. */
  progress: number;
  step: string;
  result?: R;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  createdAt: number;
  finishedAt?: number;
  /**
   * Ids and paths the job is working on (tenant ids, the archive id, an
   * uploaded file): the sweeps never touch a resource of a queued or
   * running job (M2).
   */
  resources: Set<string>;
}

export interface JobProgress {
  set(step: string, progress: number): void;
  /** Registers a resource (tenant id, archive id or file path) the sweeps must leave alone while the job runs. */
  claim(resource: string): void;
}

const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const jobs = new Map<string, JobState>();
/** The tail of the per-kind chain: a new job of a kind runs after the previous one of that kind (M3). */
const tails: Record<JobState['kind'], Promise<void>> = { export: Promise.resolve(), import: Promise.resolve() };

function sweep(): void {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, j] of jobs) if (j.finishedAt && j.finishedAt < cutoff) jobs.delete(id);
}

/** Every resource claimed by a queued or running job, plus their tenant ids (lower-cased). */
export function activeJobResources(): Set<string> {
  const out = new Set<string>();
  for (const j of jobs.values()) {
    if (j.status !== 'queued' && j.status !== 'running') continue;
    if (j.tenantId) out.add(j.tenantId.toLowerCase());
    for (const r of j.resources) out.add(r.toLowerCase());
  }
  return out;
}

/** Starts a job; the runner reports progress and returns the result. `resources` are claimed up front. */
export function startJob<R>(
  kind: JobState['kind'],
  tenantId: string | null,
  userId: string,
  runner: (progress: JobProgress) => Promise<R>,
  resources: string[] = [],
): JobState<R> {
  sweep();
  const job: JobState<R> = {
    id: crypto.randomUUID(), kind, tenantId, userId, status: 'queued', progress: 0, step: 'queued', createdAt: Date.now(),
    resources: new Set(resources),
  };
  jobs.set(job.id, job);
  const progress: JobProgress = {
    set(step, p) {
      job.step = step;
      job.progress = Math.max(0, Math.min(100, Math.round(p)));
    },
    claim(resource) {
      job.resources.add(resource);
    },
  };
  // One running job per kind (M3): a job waits, `queued`, for the previous
  // job of its kind to finish. Exports and imports still overlap each other.
  // The chain never rejects, so a failed job does not block the next one.
  const run = async (): Promise<void> => {
    job.status = 'running';
    try {
      const result = await runner(progress);
      job.status = 'succeeded';
      job.progress = 100;
      job.step = 'done';
      job.result = result;
    } catch (err: unknown) {
      job.status = 'failed';
      if (err instanceof AppError) {
        job.error = { code: err.code ?? 'INTERNAL_ERROR', message: err.message, details: err.details };
      } else {
        // Never echo arbitrary error text (it may carry file paths or SQL params).
        job.error = { code: 'INTERNAL_ERROR', message: 'The job failed. See the engine log.' };
        console.error(`[tenant-archive] ${kind} job ${job.id} failed: ${errorSummaryForLog(err)}`);
      }
    } finally {
      job.finishedAt = Date.now();
    }
  };
  // Runs on the next tick at the earliest so the caller can return the id first.
  tails[kind] = tails[kind].then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(run);
  return job;
}

/** The job, or 404 JOB_UNKNOWN. Only the user who started it (or a super admin) may read it. */
export function getJob(jobId: string, userId: string, isSuperAdmin: boolean): JobState {
  const job = jobs.get(jobId);
  if (!job || (job.userId !== userId && !isSuperAdmin)) throw new ArchiveError('JOB_UNKNOWN', 'No such job. It may have finished before an engine restart; start it again.');
  return job;
}

export function jobView(job: JobState): Record<string, unknown> {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    step: job.step,
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/** Waits for a job to finish (tests and in-process callers). */
export async function waitForJob(jobId: string, timeoutMs = 120_000): Promise<JobState> {
  const t0 = Date.now();
  for (;;) {
    const j = jobs.get(jobId);
    if (!j) throw new ArchiveError('JOB_UNKNOWN', 'No such job.');
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    if (Date.now() - t0 > timeoutMs) throw new Error('job timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function _resetJobsForTests(): void {
  jobs.clear();
}
