// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-89 (bill-ocr-v2): in desktop mode a Bill Capture upload never starts AI.
// Every capture waits at `ready` with extraction_skipped_reason
// 'manual_only'; POST /:id/reprocess is the explicit request and applies the
// bill-reading gates (AI on, OCR function on, consent). On the server the
// upload-time behavior is unchanged.
//
// The reader and the queue are spies; the real capture service and database
// run underneath.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  desktop: false,
  tenantId: '',
  userId: '',
  companyId: '',
  gate: { ok: true } as { ok: true } | { ok: false; reason: 'ai_disabled' | 'ai_function_disabled' | 'ai_consent_blocked' },
}));

const spies = vi.hoisted(() => ({
  availability: vi.fn(async (..._a: unknown[]) => state.gate),
  extract: vi.fn(async (..._a: unknown[]) => { throw new Error('no read may run on upload'); }),
  enqueue: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('../desktop/profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop/profile.js')>();
  return { ...actual, isDesktop: () => state.desktop };
});
vi.mock('../middleware/auth.js', () => ({
  authenticate: (req: any, _res: any, next: any) => { req.tenantId = state.tenantId; req.userId = state.userId; next(); },
}));
vi.mock('../middleware/company.js', () => ({
  companyContext: (req: any, _res: any, next: any) => { req.companyId = state.companyId; next(); },
}));
vi.mock('../middleware/permission.js', () => ({
  requireResource: () => (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware/feature-flag.js', () => ({
  requireFeatureFlag: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../services/ai-bill-ocr.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai-bill-ocr.service.js')>();
  return { ...actual, billOcrAvailability: spies.availability, extractBillFromAttachment: spies.extract };
});
vi.mock('../services/extraction/queue.js', () => ({ enqueueBillCapture: spies.enqueue }));

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { billCaptures, companies } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import { billCapturesRouter } from './bill-captures.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let seq = 0;

/** Distinct bytes per upload so the same-bytes dedupe never kicks in. */
function pdf(): Buffer {
  seq += 1;
  return Buffer.from(`%PDF-1.4\n% u89 desktop ${Date.now()} ${seq}\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n`);
}

function raw(method: string, path: string, body?: Buffer, contentType?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, hostname: '127.0.0.1', port, path: `/api/v1/bill-captures${path}`,
      headers: body ? { 'Content-Type': contentType ?? 'application/json', 'Content-Length': body.length } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function upload(files: Array<{ name: string; type: string; data: Buffer }>) {
  const boundary = `----u89cap${Date.now()}`;
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return raw('POST', '', Buffer.concat(parts), `multipart/form-data; boundary=${boundary}`);
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
}

async function row(id: string) {
  return db.query.billCaptures.findFirst({ where: and(eq(billCaptures.tenantId, state.tenantId), eq(billCaptures.id, id)) });
}

beforeAll(async () => {
  const me = await authService.register({
    email: `capture-desktop-${Date.now()}@example.com`, password: 'password123456',
    displayName: 'Capture Desktop', companyName: 'Capture Desktop Co',
  });
  state.tenantId = me.user.tenantId;
  state.userId = me.user.id;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, state.tenantId) });
  state.companyId = company!.id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/bill-captures', billCapturesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  if (state.tenantId) {
    await db.execute(sql`DELETE FROM bill_captures WHERE tenant_id = ${state.tenantId}`);
    await db.execute(sql`DELETE FROM attachments WHERE tenant_id = ${state.tenantId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${state.tenantId}`);
  }
});

beforeEach(() => {
  state.desktop = false;
  state.gate = { ok: true };
  spies.availability.mockClear();
  spies.extract.mockClear();
  spies.enqueue.mockClear();
});

describe('POST /bill-captures — desktop mode (U-89)', () => {
  it('every upload waits at ready / manual_only; no read starts, even with AI available', async () => {
    state.desktop = true;
    const r = await upload([
      { name: 'a.pdf', type: 'application/pdf', data: pdf() },
      { name: 'b.pdf', type: 'application/pdf', data: pdf() },
    ]);
    expect(r.status).toBe(201);
    expect(r.json.captures).toHaveLength(2);
    await settle();
    for (const c of r.json.captures) {
      expect(c.status).toBe('ready');
      const stored = await row(c.id);
      expect(stored?.status).toBe('ready');
      expect(stored?.extractionSkippedReason).toBe('manual_only');
    }
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.extract).not.toHaveBeenCalled();
  });

  it.each([
    ['ai_disabled'], ['ai_function_disabled'], ['ai_consent_blocked'],
  ] as const)('reprocess with %s: 400 with that code, the capture is unchanged', async (reason) => {
    state.desktop = true;
    const up = await upload([{ name: 'gate.pdf', type: 'application/pdf', data: pdf() }]);
    const id = up.json.captures[0].id as string;
    state.gate = { ok: false, reason };
    const r = await raw('POST', `/${id}/reprocess`);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(reason);
    const stored = await row(id);
    expect(stored?.status).toBe('ready');
    expect(stored?.extractionSkippedReason).toBe('manual_only');
    expect(spies.enqueue).not.toHaveBeenCalled();
  });

  it('reprocess with the gates open is the explicit request: the read is queued', async () => {
    state.desktop = true;
    const up = await upload([{ name: 'ask.pdf', type: 'application/pdf', data: pdf() }]);
    const id = up.json.captures[0].id as string;
    expect(spies.enqueue).not.toHaveBeenCalled();
    const r = await raw('POST', `/${id}/reprocess`);
    expect(r.status).toBe(202);
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    const stored = await row(id);
    expect(stored?.status).toBe('received');
    expect(stored?.extractionSkippedReason).toBeNull();
  });
});

describe('POST /bill-captures — server appliance (unchanged)', () => {
  it('AI available: the upload queues a read', async () => {
    const r = await upload([{ name: 'srv.pdf', type: 'application/pdf', data: pdf() }]);
    expect(r.status).toBe(201);
    expect(r.json.captures[0].status).toBe('received');
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
  });

  it('AI off: ready with the gate reason, as before', async () => {
    state.gate = { ok: false, reason: 'ai_disabled' };
    const r = await upload([{ name: 'srv-off.pdf', type: 'application/pdf', data: pdf() }]);
    expect(r.json.captures[0].status).toBe('ready');
    expect((await row(r.json.captures[0].id))?.extractionSkippedReason).toBe('ai_disabled');
    expect(spies.enqueue).not.toHaveBeenCalled();
  });
});
