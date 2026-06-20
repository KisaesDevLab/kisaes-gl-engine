// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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

let renderQueue: Queue<RenderJobData> | null = null;
let extractQueue: Queue<ExtractJobData> | null = null;

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

/** Enqueue the render step for a freshly-created job. */
export async function enqueueRender(data: RenderJobData): Promise<void> {
  // jobId as the BullMQ job id makes the enqueue idempotent — re-enqueuing
  // the same document won't create a duplicate render job.
  await getRenderQueue().add('render', data, { jobId: `render:${data.jobId}` });
}

/** Enqueue the extract step for one rendered page. */
export async function enqueueExtract(data: ExtractJobData): Promise<void> {
  await getExtractQueue().add('extract', data, {
    jobId: `extract:${data.jobId}:${data.pageNo}`,
  });
}

/** Close producer connections (graceful shutdown / test teardown). */
export async function closeQueues(): Promise<void> {
  await Promise.all([
    renderQueue?.close(),
    extractQueue?.close(),
  ]);
  renderQueue = null;
  extractQueue = null;
  if (sharedConnection) {
    await sharedConnection.quit().catch(() => undefined);
    sharedConnection = null;
  }
}
