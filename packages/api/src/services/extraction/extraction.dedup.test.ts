// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Idempotency unit test: re-uploading identical bytes must return the
// existing job WITHOUT storing the original again or enqueuing a second
// render. Full DB-backed flow is covered by the Phase 8 integration test.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  storeBytes: vi.fn(),
  enqueueRender: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    query: { extractionJobs: { findFirst: (...a: unknown[]) => mocks.findFirst(...a) } },
  },
}));

vi.mock('./storage.service.js', () => ({
  originalKey: (t: string, j: string, e: string) => `documents/${t}/${j}/original${e}`,
  extForMime: () => '.pdf',
  storeBytes: (...a: unknown[]) => mocks.storeBytes(...a),
}));

vi.mock('./queue.js', () => ({
  enqueueRender: (...a: unknown[]) => mocks.enqueueRender(...a),
  enqueueExtract: vi.fn(),
}));

import { createJob } from './extraction.service.js';

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe('createJob idempotency', () => {
  it('returns the existing job and does no work on a duplicate upload', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'job-1', tenantId: 't1', fileHash: 'abc', status: 'pending' });

    const result = await createJob('t1', {
      docType: 'bank_statement',
      file: { buffer: Buffer.from('same-bytes'), mimeType: 'application/pdf', originalname: 's.pdf' },
    });

    expect(result.duplicate).toBe(true);
    expect(result.job.id).toBe('job-1');
    expect(mocks.storeBytes).not.toHaveBeenCalled();
    expect(mocks.enqueueRender).not.toHaveBeenCalled();
  });
});
