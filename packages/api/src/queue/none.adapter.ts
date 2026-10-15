// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * QUEUE_BACKEND=none — the minimal "no background queue" backend.
 *
 * Every enqueue fails immediately with QueueUnavailableError instead of
 * constructing a BullMQ Queue (whose ioredis connection uses
 * maxRetriesPerRequest: null and would wait forever for a Redis that is not
 * there). Producers that already catch enqueue failures then run the work
 * in-process, exactly as they do on a server whose Redis is down.
 *
 * Used by api-only server installs that set QUEUE_BACKEND=none, and by
 * desktop mode when asked for explicitly (desktop defaults to the durable
 * pg-boss backend, queue/pgboss.adapter.ts). The server default stays BullMQ.
 */

import { queueBackend } from '../desktop/profile.js';
import type { JobQueue, QueueHealth, WorkerHandle } from './job-queue.js';

export class QueueUnavailableError extends Error {
  readonly code = 'QUEUE_UNAVAILABLE';
  readonly queue: string;
  constructor(queue: string) {
    super(`Background queue "${queue}" is not available (QUEUE_BACKEND=none); running in-process instead.`);
    this.name = 'QueueUnavailableError';
    this.queue = queue;
  }
}

/** True when enqueues must fail fast instead of touching Redis. */
export function queueDisabled(): boolean {
  return queueBackend() === 'none';
}

/** Throws QueueUnavailableError when the queue backend is `none`. */
export function assertQueueEnabled(queue: string): void {
  if (queueDisabled()) throw new QueueUnavailableError(queue);
}

/** JobQueue for QUEUE_BACKEND=none: enqueue rejects at once, work() consumes nothing. */
export class NoneQueue implements JobQueue<Record<string, unknown>> {
  readonly backend = 'none' as const;

  async enqueue(name: string): Promise<void> {
    throw new QueueUnavailableError(name);
  }

  async work(): Promise<WorkerHandle> {
    return { close: async () => undefined };
  }

  /** Nothing to reach: always ok, never a consumer. */
  async health(): Promise<QueueHealth> {
    return { ok: true, consumers: 0, latencyMs: 0 };
  }

  async close(): Promise<void> {}
}
