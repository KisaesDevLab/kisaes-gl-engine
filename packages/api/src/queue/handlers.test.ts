// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Each shared job handler calls its api service with the job data exactly
// as the BullMQ processor did, and lets a service failure fail the attempt.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const svc = vi.hoisted(() => ({
  processRender: vi.fn(async () => undefined),
  processExtractPage: vi.fn(async () => undefined),
  runStatementParseJob: vi.fn(async () => undefined),
  runBillCaptureJob: vi.fn(async () => undefined),
  generateReportPackRun: vi.fn(async () => undefined),
  executeRun: vi.fn(async () => undefined),
}));

vi.mock('../services/extraction/extraction.service.js', () => ({
  processRender: svc.processRender,
  processExtractPage: svc.processExtractPage,
}));
vi.mock('../services/ai-statement-parser.service.js', () => ({ runStatementParseJob: svc.runStatementParseJob }));
vi.mock('../services/bill-capture.service.js', () => ({ runBillCaptureJob: svc.runBillCaptureJob }));
vi.mock('../services/report-pack-generate.service.js', () => ({ generateReportPackRun: svc.generateReportPackRun }));
vi.mock('../services/tax-estimator/tax-param-ai-check.service.js', () => ({ executeRun: svc.executeRun }));

import { JOB_HANDLERS } from './handlers.js';
import { JOB_NAMES, type JobContext } from './job-queue.js';

const ctx: JobContext = { jobId: 'x', attempt: 1, isFinalAttempt: false };

describe('JOB_HANDLERS', () => {
  beforeEach(() => vi.clearAllMocks());

  it('covers every job type', () => {
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual([...JOB_NAMES].sort());
  });

  it('doc-render → processRender(tenantId, jobId)', async () => {
    await JOB_HANDLERS['doc-render']({ jobId: 'j', tenantId: 't' }, ctx);
    expect(svc.processRender).toHaveBeenCalledWith('t', 'j');
  });

  it('doc-extract → processExtractPage(tenantId, jobId, pageNo)', async () => {
    await JOB_HANDLERS['doc-extract']({ jobId: 'j', tenantId: 't', pageNo: 4 }, ctx);
    expect(svc.processExtractPage).toHaveBeenCalledWith('t', 'j', 4);
  });

  it('statement-parse → runStatementParseJob(tenantId, attachmentId, jobId)', async () => {
    await JOB_HANDLERS['statement-parse']({ jobId: 'j', tenantId: 't', attachmentId: 'a' }, ctx);
    expect(svc.runStatementParseJob).toHaveBeenCalledWith('t', 'a', 'j');
  });

  it('bill-capture → runBillCaptureJob(tenantId, captureId)', async () => {
    await JOB_HANDLERS['bill-capture']({ captureId: 'c', tenantId: 't', attempt: 2 }, ctx);
    expect(svc.runBillCaptureJob).toHaveBeenCalledWith('t', 'c');
  });

  it('report-pack → generateReportPackRun(runId)', async () => {
    await JOB_HANDLERS['report-pack']({ runId: 'r', tenantId: 't' }, ctx);
    expect(svc.generateReportPackRun).toHaveBeenCalledWith('r');
  });

  it('tax-param-ai-check → executeRun(runId)', async () => {
    await JOB_HANDLERS['tax-param-ai-check']({ runId: 'r' }, ctx);
    expect(svc.executeRun).toHaveBeenCalledWith('r');
  });

  it('a service failure rejects the handler (the backend retries or fails the job)', async () => {
    svc.processExtractPage.mockRejectedValueOnce(new Error('model timeout'));
    await expect(JOB_HANDLERS['doc-extract']({ jobId: 'j', tenantId: 't', pageNo: 1 }, ctx)).rejects.toThrow('model timeout');
  });
});
