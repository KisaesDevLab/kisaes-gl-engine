// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Real-Redis test of the BullMQ producers. BullMQ 5 rejects a custom job id
// that contains ':' unless it splits into exactly 3 parts ("Custom Id cannot
// contain :"), so `stmt:<uuid>` / `pack:<uuid>` / `render:<uuid>` threw on
// every enqueue and the callers silently fell back to in-process work — the
// worker never saw a statement parse or report pack. Every producer must be
// accepted by BullMQ and must stay idempotent (same input → same job).

import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import {
  enqueueStatementParse,
  enqueueReportPack,
  enqueueRender,
  enqueueExtract,
  enqueueBillCapture,
  enqueueTaxParamAiCheck,
  closeQueues,
  makeRedisConnection,
  STATEMENT_PARSE_QUEUE,
  REPORT_PACK_QUEUE,
  DOC_RENDER_QUEUE,
  DOC_EXTRACT_QUEUE,
  BILL_CAPTURE_QUEUE,
  TAX_PARAM_AI_CHECK_QUEUE,
} from './queue.js';

const conn = makeRedisConnection();
const inspectors = new Map<string, Queue>();
function inspector(name: string): Queue {
  let q = inspectors.get(name);
  if (!q) {
    q = new Queue(name, { connection: conn as ConnectionOptions });
    inspectors.set(name, q);
  }
  return q;
}
const added: Array<{ queue: string; id: string }> = [];

afterAll(async () => {
  for (const { queue, id } of added) {
    await inspector(queue).remove(id).catch(() => undefined);
  }
  await Promise.all([...inspectors.values()].map((q) => q.close()));
  await closeQueues();
  await conn.quit().catch(() => undefined);
});

async function expectSingleJob(queue: string, id: string, data: Record<string, unknown>) {
  added.push({ queue, id });
  const job = await inspector(queue).getJob(id);
  expect(job, `job ${id} in ${queue}`).toBeTruthy();
  expect(job!.data).toMatchObject(data);
  expect(job!.id).not.toContain(':');
}

describe('BullMQ producers', () => {
  it('enqueues a statement parse (and re-enqueue is a no-op)', async () => {
    const data = { jobId: crypto.randomUUID(), tenantId: crypto.randomUUID(), attachmentId: crypto.randomUUID() };
    await expect(enqueueStatementParse(data)).resolves.toBeUndefined();
    await expect(enqueueStatementParse(data)).resolves.toBeUndefined();
    await expectSingleJob(STATEMENT_PARSE_QUEUE, `stmt-${data.jobId}`, data);
  });

  it('enqueues a report-pack run (and re-enqueue is a no-op)', async () => {
    const data = { runId: crypto.randomUUID(), tenantId: crypto.randomUUID() };
    await expect(enqueueReportPack(data)).resolves.toBeUndefined();
    await expect(enqueueReportPack(data)).resolves.toBeUndefined();
    await expectSingleJob(REPORT_PACK_QUEUE, `pack-${data.runId}`, data);
  });

  it('enqueues an AI parameter check run (and re-enqueue is a no-op)', async () => {
    const data = { runId: crypto.randomUUID() };
    await expect(enqueueTaxParamAiCheck(data)).resolves.toBeUndefined();
    await expect(enqueueTaxParamAiCheck(data)).resolves.toBeUndefined();
    await expectSingleJob(TAX_PARAM_AI_CHECK_QUEUE, `taxai-${data.runId}`, data);
  });

  it('enqueues a document render (and re-enqueue is a no-op)', async () => {
    const data = { jobId: crypto.randomUUID(), tenantId: crypto.randomUUID() };
    await expect(enqueueRender(data)).resolves.toBeUndefined();
    await expect(enqueueRender(data)).resolves.toBeUndefined();
    await expectSingleJob(DOC_RENDER_QUEUE, `render-${data.jobId}`, data);
  });

  it('enqueues a page extract keyed by job + page', async () => {
    const data = { jobId: crypto.randomUUID(), tenantId: crypto.randomUUID(), pageNo: 3 };
    await expect(enqueueExtract(data)).resolves.toBeUndefined();
    await expectSingleJob(DOC_EXTRACT_QUEUE, `extract-${data.jobId}-3`, data);
  });

  it('enqueues a bill capture keyed by capture + attempt', async () => {
    const data = { captureId: crypto.randomUUID(), tenantId: crypto.randomUUID(), attempt: 2 };
    await expect(enqueueBillCapture(data)).resolves.toBeUndefined();
    await expectSingleJob(BILL_CAPTURE_QUEUE, `bcap-${data.captureId}-2`, data);
  });
});
