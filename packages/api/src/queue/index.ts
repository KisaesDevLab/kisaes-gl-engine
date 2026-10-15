// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * getJobQueue() — the process-wide JobQueue for the configured backend
 * (QUEUE_BACKEND via desktop/profile.ts). Backend modules are loaded with a
 * dynamic import, so a process never evaluates the library of a backend it
 * does not use (desktop never loads bullmq; the server never loads pg-boss).
 */

import { queueBackend } from '../desktop/profile.js';
import type { JobQueue, QueueBackendName } from './job-queue.js';
import { NoneQueue } from './none.adapter.js';
import { JOB_SPECS } from './specs.js';

const instances = new Map<QueueBackendName, Promise<JobQueue>>();

async function create(backend: QueueBackendName): Promise<JobQueue> {
  switch (backend) {
    case 'none':
      return new NoneQueue();
    case 'bullmq': {
      const { BullMqQueue } = await import('./bullmq.adapter.js');
      return new BullMqQueue(JOB_SPECS);
    }
    default: {
      const never: never = backend;
      throw new Error(`unknown queue backend ${String(never)}`);
    }
  }
}

/**
 * The JobQueue of the current backend, created on first use. Keyed by
 * backend so a test that switches profiles never gets a stale instance.
 */
export function getJobQueue(): Promise<JobQueue> {
  const backend = queueBackend();
  let p = instances.get(backend);
  if (!p) {
    p = create(backend);
    // A failed creation must not stick: the next call tries again.
    const created = p;
    created.catch(() => {
      if (instances.get(backend) === created) instances.delete(backend);
    });
    instances.set(backend, p);
  }
  return p;
}

/** Close every JobQueue this process created (graceful shutdown, test teardown). */
export async function closeJobQueues(): Promise<void> {
  const all = [...instances.values()];
  instances.clear();
  await Promise.all(
    all.map(async (p) => {
      const q = await p.catch(() => null);
      await q?.close();
    }),
  );
}

/** Test hook: use `queue` for its backend until the next reset. */
export function _setJobQueueForTests(queue: JobQueue | null, backend: QueueBackendName = queue?.backend ?? 'none'): void {
  if (queue) instances.set(backend, Promise.resolve(queue));
  else instances.delete(backend);
}
