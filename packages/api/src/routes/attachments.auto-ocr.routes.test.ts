// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-89 (bill-ocr-v2): an upload never starts OCR or AI processing in desktop
// mode; on the server the `attachments.autoOcr` setting and ?autoOcr=0
// decide. POST /attachments/:id/ocr honours the AI gates in desktop mode.
//
// Every AI entry point an upload could reach is a spy: the legacy OCR stub,
// the image classifier, the provider factory, and global fetch. The real
// attachment service and database run underneath.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const TMP_UPLOAD_DIR = vi.hoisted(() => {
  const dir = `${process.cwd()}/.tmp-auto-ocr-test-${process.pid}`;
  process.env['UPLOAD_DIR'] = dir;
  return dir;
});

const state = vi.hoisted(() => ({
  desktop: false,
  tenantId: '',
  aiEnabled: true,
  ocrFunctionEnabled: true,
  consentAllowed: true,
}));

const spies = vi.hoisted(() => ({
  processReceipt: vi.fn(async (..._a: unknown[]) => undefined),
  classifyAndRoute: vi.fn(async (..._a: unknown[]) => undefined),
  getProvider: vi.fn((..._a: unknown[]) => { throw new Error('no provider may be built on upload'); }),
}));

vi.mock('../desktop/profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop/profile.js')>();
  return { ...actual, isDesktop: () => state.desktop };
});
vi.mock('../middleware/auth.js', () => ({
  authenticate: (req: any, _res: any, next: any) => { req.tenantId = state.tenantId; req.userId = null; next(); },
}));
vi.mock('../middleware/permission.js', () => ({
  requireResource: () => (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware/audit.js', () => ({ auditLog: async () => undefined }));
vi.mock('../services/ocr.service.js', () => ({ processReceipt: spies.processReceipt }));
vi.mock('../services/ai-document-classifier.service.js', () => ({ classifyAndRoute: spies.classifyAndRoute }));
vi.mock('../services/ai-providers/index.js', () => ({ getProvider: spies.getProvider }));
vi.mock('../services/ai-config.service.js', () => ({
  // autoOcrOnUpload on: only the U-89 switch may stop the classifier.
  getConfig: async () => ({
    isEnabled: state.aiEnabled, autoOcrOnUpload: true,
    ocrProvider: 'anthropic', categorizationProvider: 'anthropic',
  }),
  resolveTaskExec: () => ({ enabled: state.ocrFunctionEnabled, fallbackChain: [], timeoutMs: 0 }),
}));
vi.mock('../services/ai-consent.service.js', () => ({
  checkTenantTaskConsent: async () => (state.consentAllowed ? { allowed: true } : { allowed: false, reason: 'not_opted_in' }),
}));

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, attachments, systemSettings } from '../db/schema/index.js';
import { attachmentsRouter } from './attachments.routes.js';
import { invalidateSystemProviderCache } from '../services/storage/storage-provider.factory.js';

const SLUG = 'auto-ocr-u89-test';
const SETTING = 'attachments.autoOcr';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let server: Server | null = null;
let port = 0;
const fetchSpy = vi.fn();
const realFetch = globalThis.fetch;

function send(method: string, path: string, body?: Buffer, contentType?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(body ? { 'Content-Length': String(body.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function uploadPng(query = '') {
  const b = '----u89boundary';
  const part = (name: string, value: string) =>
    `--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('attachableType', 'draft') + part('attachableId', crypto.randomUUID())),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="bill.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return send('POST', `/api/v1/attachments${query}`, body, `multipart/form-data; boundary=${b}`);
}

/** Lets fire-and-forget work (dynamic imports, DB reads) run to the end. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
}

async function setSetting(value: string | null) {
  await db.delete(systemSettings).where(eq(systemSettings.key, SETTING));
  if (value !== null) await db.insert(systemSettings).values({ key: SETTING, value });
}

beforeAll(async () => {
  fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
  invalidateSystemProviderCache();
  await db.delete(tenants).where(eq(tenants.slug, SLUG));
  const [t] = await db.insert(tenants).values({ name: 'Auto OCR U-89', slug: SLUG }).returning();
  state.tenantId = t!.id;

  globalThis.fetch = ((...a: Parameters<typeof fetch>) => { fetchSpy(...a); return realFetch(...a); }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/attachments', attachmentsRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: { message: err.message, code: err.code } });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await setSetting(null);
  if (state.tenantId) {
    await db.delete(attachments).where(eq(attachments.tenantId, state.tenantId));
    await db.delete(tenants).where(eq(tenants.id, state.tenantId));
  }
  fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
  invalidateSystemProviderCache();
});

beforeEach(async () => {
  state.desktop = false;
  state.aiEnabled = true;
  state.ocrFunctionEnabled = true;
  state.consentAllowed = true;
  spies.processReceipt.mockClear();
  spies.classifyAndRoute.mockClear();
  spies.getProvider.mockClear();
  fetchSpy.mockClear();
  await setSetting(null);
});

function expectNoAi() {
  expect(spies.processReceipt).not.toHaveBeenCalled();
  expect(spies.classifyAndRoute).not.toHaveBeenCalled();
  expect(spies.getProvider).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe('POST /attachments — desktop mode (U-89)', () => {
  it('an image upload starts no OCR, no classifier and no outbound AI call', async () => {
    state.desktop = true;
    const res = await uploadPng();
    expect(res.status).toBe(201);
    await settle();
    expectNoAi();
  });

  it('?autoOcr=1 cannot turn it on', async () => {
    state.desktop = true;
    const res = await uploadPng('?autoOcr=1');
    expect(res.status).toBe(201);
    await settle();
    expectNoAi();
  });

  it('a setting row of true cannot turn it on', async () => {
    state.desktop = true;
    await setSetting('true');
    const res = await uploadPng();
    expect(res.status).toBe(201);
    await settle();
    expectNoAi();
  });
});

describe('POST /attachments — server appliance', () => {
  it('no setting row: OCR and the classifier run as before', async () => {
    const res = await uploadPng();
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(spies.classifyAndRoute).toHaveBeenCalledTimes(1));
    expect(spies.processReceipt).toHaveBeenCalledTimes(1);
  });

  it('?autoOcr=0 skips both for one upload', async () => {
    const res = await uploadPng('?autoOcr=0');
    expect(res.status).toBe(201);
    await settle();
    expectNoAi();
  });

  it('?autoOcr sent twice: the first value counts (0 first skips both)', async () => {
    const res = await uploadPng('?autoOcr=0&autoOcr=1');
    expect(res.status).toBe(201);
    await settle();
    expectNoAi();
  });

  it("attachments.autoOcr = 'false' turns it off", async () => {
    await setSetting('false');
    const res = await uploadPng();
    expect(res.status).toBe(201);
    await settle();
    expectNoAi();
  });
});

describe('POST /attachments/:id/ocr — desktop gates (U-89)', () => {
  async function seeded(): Promise<string> {
    const res = await uploadPng('?autoOcr=0');
    return res.json.attachment.id as string;
  }

  it.each([
    ['ai_disabled', () => { state.aiEnabled = false; }],
    ['ai_function_disabled', () => { state.ocrFunctionEnabled = false; }],
    ['ai_consent_blocked', () => { state.consentAllowed = false; }],
  ])('%s: 400 with that code, nothing run', async (code, arrange) => {
    const id = await seeded();
    state.desktop = true;
    arrange();
    const res = await send('POST', `/api/v1/attachments/${id}/ocr`);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe(code);
    expectNoAi();
  });

  it('gates open: the explicit request runs', async () => {
    const id = await seeded();
    state.desktop = true;
    const res = await send('POST', `/api/v1/attachments/${id}/ocr`);
    expect(res.status).toBe(200);
    expect(spies.processReceipt).toHaveBeenCalledTimes(1);
  });

  it('server appliance: unchanged (no gate)', async () => {
    const id = await seeded();
    state.aiEnabled = false;
    const res = await send('POST', `/api/v1/attachments/${id}/ocr`);
    expect(res.status).toBe(200);
    expect(spies.processReceipt).toHaveBeenCalledTimes(1);
  });
});
