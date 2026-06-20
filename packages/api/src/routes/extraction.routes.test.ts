// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Route-level test with the service, auth, audit, and env mocked so it runs
// without a database. Covers the feature gate, staff gate, validation, and
// the review write-back wiring. The full DB-backed upload→render→extract
// flow is the Phase 8 integration test.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const envState = vi.hoisted(() => ({ DOCUMENT_EXTRACTION_V1: true, MAX_FILE_SIZE_MB: 10 }));
const svc = vi.hoisted(() => ({
  createJob: vi.fn(),
  listJobs: vi.fn(),
  getJob: vi.fn(),
  getReviewItems: vi.fn(),
  submitReview: vi.fn(),
}));

vi.mock('../config/env.js', () => ({ env: envState }));
vi.mock('../middleware/audit.js', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { tenantId: string }).tenantId = 't1';
    (req as unknown as { userId: string }).userId = 'u1';
    (req as unknown as { userType: string }).userType = (req.headers['x-user-type'] as string) || 'owner';
    next();
  },
}));
vi.mock('../services/extraction/extraction.service.js', () => svc);

import { extractionRouter } from './extraction.routes.js';

let server: Server | null = null;
let port = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/extractions', extractionRouter);
  app.use((err: { statusCode?: number; status?: number; message: string; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.statusCode ?? err.status ?? 500;
    res.status(status).json({ error: { message: err.message, code: err.code } });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
  envState.DOCUMENT_EXTRACTION_V1 = true;
});

function request(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('extraction routes', () => {
  it('404s every route when the feature flag is off', async () => {
    envState.DOCUMENT_EXTRACTION_V1 = false;
    const res = await request('GET', '/api/v1/extractions');
    expect(res.status).toBe(404);
  });

  it('404s for client user type (staff-only surface)', async () => {
    const res = await request('GET', '/api/v1/extractions', undefined, { 'x-user-type': 'client' });
    expect(res.status).toBe(404);
  });

  it('lists jobs with total count', async () => {
    svc.listJobs.mockResolvedValue({ data: [{ id: 'j1' }], total: 1 });
    const res = await request('GET', '/api/v1/extractions?limit=10');
    expect(res.status).toBe(200);
    expect(res.json['total']).toBe(1);
    expect(svc.listJobs).toHaveBeenCalledWith('t1', expect.objectContaining({ limit: 10, offset: 0 }));
  });

  it('returns a job by id', async () => {
    svc.getJob.mockResolvedValue({ job: { id: 'j1' }, pages: [], records: [], review: [] });
    const res = await request('GET', '/api/v1/extractions/j1');
    expect(res.status).toBe(200);
    expect((res.json['job'] as Record<string, unknown>)['id']).toBe('j1');
  });

  it('400s an upload with no file', async () => {
    const res = await request('POST', '/api/v1/extractions');
    expect(res.status).toBe(400);
    expect((res.json['error'] as Record<string, unknown>)['code']).toBe('EXTRACT_NO_FILE');
  });

  it('submits a review correction and returns the updated record', async () => {
    svc.submitReview.mockResolvedValue({ before: { id: 'r1' }, after: { id: 'r1', validated: true } });
    const res = await request('POST', '/api/v1/extractions/j1/review/r1', { post: true, correction: { total: 100 } });
    expect(res.status).toBe(200);
    expect((res.json['record'] as Record<string, unknown>)['validated']).toBe(true);
    expect(svc.submitReview).toHaveBeenCalledWith('t1', 'j1', 'r1', expect.objectContaining({ post: true }), 'u1');
  });
});
