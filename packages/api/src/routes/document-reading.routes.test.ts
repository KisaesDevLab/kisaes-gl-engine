// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-92d (document-assist-v1): POST /api/v1/document-reading/assist with the
// real consent service and database underneath; the AI provider is a stub
// (no network). Covers T13: a company that consented to receipt_ocr (by
// accepting the disclosure) has both document switches off and a cloud
// assist is refused; the switches write audit rows; the text never reaches
// ai_jobs or audit_log; the company of the request decides.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tenantId: '',
  userId: '',
  companyId: '',
  provider: 'anthropic' as string,
  ocrModel: null as string | null,
  ollamaBaseUrl: null as string | null,
  desktop: false,
  calls: [] as Array<{ kind: 'text' | 'image'; userPrompt: string; images: number }>,
  reply: {} as Record<string, unknown>,
}));

vi.mock('../middleware/auth.js', () => ({
  authenticate: (req: any, _res: any, next: any) => { req.tenantId = state.tenantId; req.userId = state.userId; next(); },
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware/company.js', () => ({
  companyContext: (req: any, _res: any, next: any) => { req.companyId = state.companyId; next(); },
}));
vi.mock('../middleware/document-draft-permission.js', () => ({
  requireAnyDocumentResource: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware/permission.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/permission.js')>();
  return { ...actual, requireResource: () => (_req: any, _res: any, next: any) => next() };
});
vi.mock('../desktop/profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop/profile.js')>();
  return { ...actual, isDesktop: () => state.desktop };
});
vi.mock('../services/ai-config.service.js', () => ({
  getConfig: async () => ({ isEnabled: true, ocrProvider: state.provider, categorizationProvider: state.provider, ocrModel: state.ocrModel }),
  getRawConfig: async () => ({ openaiCompatBaseUrl: null, ollamaBaseUrl: state.ollamaBaseUrl, cloudVisionEnabled: true, piiProtectionLevel: 'permissive' }),
  resolveTaskParams: () => ({ maxTokens: 2048, temperature: 0.1 }),
  resolveTaskExec: () => ({ fallbackChain: [], enabled: true, timeoutMs: 0 }),
}));
vi.mock('../services/ai-prompt.service.js', () => ({ getCustomSystemPrompt: async () => null }));
vi.mock('../services/ai-providers/index.js', async () => {
  // The real endpoint and model resolution; the provider itself is a stub.
  const actual = await vi.importActual<typeof import('../services/ai-providers/index.js')>('../services/ai-providers/index.js');
  const result = () => ({
    provider: state.provider, model: 'stub', text: JSON.stringify(state.reply), parsed: state.reply,
    inputTokens: 3, outputTokens: 2, durationMs: 1,
  });
  return {
    resolveSelfHostedTarget: actual.resolveSelfHostedTarget,
    getProvider: () => ({
      estimateCost: () => 0,
      complete: async (p: any) => { state.calls.push({ kind: 'text', userPrompt: p.userPrompt, images: 0 }); return result(); },
      completeWithImage: async (p: any) => { state.calls.push({ kind: 'image', userPrompt: p.userPrompt, images: p.images.length }); return result(); },
    }),
  };
});

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiConfig, aiJobs, aiUsageLog, auditLog, companies } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as aiConsent from '../services/ai-consent.service.js';
import { documentReadingRouter } from './document-reading.routes.js';
import { aiRouter } from './ai.routes.js';
import { billsRouter } from './bills.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let companyA = '';
let companyB = '';

// A marker that must never leave the request: not in ai_jobs, not in audit_log.
const SECRET_TEXT = 'ZZQ-PRIVATE-MEMO-7731 Acme Plumbing invoice 4411 total 1,234.50'; // gitleaks:allow (test canary)
/** A PNG signature and IHDR (width × height), padded to `total` bytes. */
function png(width: number, height: number, total = 64): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8; head[25] = 2;
  return Buffer.concat([head, Buffer.alloc(Math.max(0, total - head.length), 1)]);
}
const PNG = png(1200, 1600).toString('base64');

function post(body: unknown, path = '/api/v1/document-reading/assist'): Promise<{ status: number; json: any }> {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST', hostname: '127.0.0.1', port, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
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
    req.write(data);
    req.end();
  });
}

async function tasksOf(companyId: string): Promise<Record<string, boolean>> {
  const row = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  return row!.aiEnabledTasks as Record<string, boolean>;
}

beforeAll(async () => {
  const me = await authService.register({
    email: `doc-assist-${Date.now()}@example.com`, password: 'password123456',
    displayName: 'Doc Assist', companyName: 'Doc Assist A',
  });
  state.tenantId = me.user.tenantId;
  state.userId = me.user.id;
  companyA = (await db.query.companies.findFirst({ where: eq(companies.tenantId, state.tenantId) }))!.id;
  const [b] = await db.insert(companies).values({ tenantId: state.tenantId, businessName: 'Doc Assist B' }).returning();
  companyB = b!.id;

  // System AI on with the admin disclosure accepted (global table; the
  // suite runs in one fork, one file at a time).
  await db.delete(aiConfig);
  await db.insert(aiConfig).values({ isEnabled: true, adminDisclosureAcceptedAt: new Date(), adminDisclosureAcceptedBy: state.userId, disclosureVersion: 1 });
  // P17-style consent: accepting the disclosure turns receipt_ocr on.
  await aiConsent.acceptCompanyDisclosure(state.tenantId, companyA, state.userId);
  await aiConsent.acceptCompanyDisclosure(state.tenantId, companyB, state.userId);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/document-reading', documentReadingRouter);
  app.use('/api/v1/ai', aiRouter);
  app.use('/api/v1/bills', billsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await db.delete(aiConfig);
  if (state.tenantId) {
    await db.delete(aiUsageLog).where(eq(aiUsageLog.tenantId, state.tenantId));
    await db.delete(aiJobs).where(eq(aiJobs.tenantId, state.tenantId));
    await db.delete(auditLog).where(eq(auditLog.tenantId, state.tenantId));
  }
});

beforeEach(() => {
  state.provider = 'anthropic';
  state.ocrModel = null;
  state.ollamaBaseUrl = null;
  state.desktop = false;
  state.companyId = companyA;
  state.calls = [];
  state.reply = {
    vendor: 'Acme Plumbing', vendor_invoice_number: '4411', bill_date: '2026-07-01', total: 1234.5, subtotal: '1,200.00', tax: '34.50',
    line_items: [{ description: 'Pipe', amount: '1200.00', quantity: 3, unit_price: '400.00' }, { description: 'Note', amount: null }],
    confidence: 0.9,
  };
});

describe('T13: receipt_ocr consent does not enable document reading', () => {
  it('a company that accepted the disclosure has receipt_ocr on and both document switches off', async () => {
    const t = await tasksOf(companyA);
    expect(t['receipt_ocr']).toBe(true);
    expect(t['document_text_cloud']).toBe(false);
    expect(t['document_images_cloud']).toBe(false);
    const check = await aiConsent.checkTenantTaskConsent(state.tenantId, 'document_text_cloud', companyA);
    expect(check).toMatchObject({ allowed: false, reason: 'task_disabled' });
  });

  it('cloud assist is refused with 403 CONSENT_REQUIRED and no AI call or job', async () => {
    const r = await post({ text: SECRET_TEXT, kindHint: 'bill' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('CONSENT_REQUIRED');
    expect(r.json.error.details).toMatchObject({ task: 'document_text_cloud' });
    expect(state.calls).toHaveLength(0);
    const jobs = await db.select().from(aiJobs).where(and(eq(aiJobs.tenantId, state.tenantId), eq(aiJobs.jobType, 'document_assist')));
    expect(jobs).toHaveLength(0);
  });
});

describe('switches, consent and the reading', () => {
  it('turning document_text_cloud on writes a company_ai_tasks audit row; text-only assist then runs', async () => {
    await aiConsent.setCompanyTaskToggles(state.tenantId, companyA, { document_text_cloud: true }, state.userId);
    const audits = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, state.tenantId), eq(auditLog.entityType, 'company_ai_tasks'), eq(auditLog.entityId, companyA),
    ));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const last = audits[audits.length - 1]!;
    expect((last.afterData as Record<string, boolean>)['document_text_cloud']).toBe(true);
    expect((last.beforeData as Record<string, boolean>)['document_text_cloud']).toBe(false);
    // M3: what the owner agreed under.
    expect((last.afterData as Record<string, unknown>)['configuration']).toEqual({
      provider: null, providers: { categorization: null, ocr: null },
      piiProtectionLevel: 'strict', cloudVisionEnabled: false, disclosureVersion: 1, systemDisclosureVersion: 1,
    });

    const r = await post({ text: SECRET_TEXT, kindHint: 'bill' });
    expect(r.status).toBe(200);
    const s = r.json.suggestion;
    expect(s.reader).toBe('cloud');
    expect(s.usedImages).toBe(false);
    // Amounts are decimal strings as read, or null; nothing computed.
    expect(s.total).toBe('1234.5');
    expect(s.subtotal).toBe('1200.00');
    expect(s.tax).toBe('34.50');
    expect(s.lineItems[0]).toMatchObject({ amount: '1200.00', quantity: '3', unitPrice: '400.00' });
    expect(s.lineItems[1]).toMatchObject({ amount: null, unitPrice: null, confidence: 'low' });
    expect(s.dueDate).toBeNull();
    expect(state.calls).toEqual([expect.objectContaining({ kind: 'text', images: 0 })]);
    expect(state.calls[0]!.userPrompt).toContain('ZZQ-PRIVATE-MEMO-7731');
  });

  it('page images need document_images_cloud as well (403), then run', async () => {
    let r = await post({ text: SECRET_TEXT, pageImages: [PNG] });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { task: 'document_images_cloud' } });
    expect(state.calls).toHaveLength(0);

    await aiConsent.setCompanyTaskToggles(state.tenantId, companyA, { document_images_cloud: true }, state.userId);
    r = await post({ text: SECRET_TEXT, pageImages: [PNG, PNG] });
    expect(r.status).toBe(200);
    expect(r.json.suggestion.usedImages).toBe(true);
    expect(state.calls).toEqual([expect.objectContaining({ kind: 'image', images: 2 })]);
  });

  it('the request company decides: company B (receipt_ocr on, switches off) is refused', async () => {
    state.companyId = companyB;
    const r = await post({ text: SECRET_TEXT });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('CONSENT_REQUIRED');
  });

  it('a self-hosted provider (Ollama) needs neither switch', async () => {
    state.provider = 'ollama';
    state.companyId = companyB;
    const r = await post({ text: SECRET_TEXT, pageImages: [PNG] });
    expect(r.status).toBe(200);
    expect(r.json.suggestion.reader).toBe('self_hosted');
  });

  it('revoking consent turns both switches off, and stops a self-hosted assist too', async () => {
    await aiConsent.revokeCompanyConsent(state.tenantId, companyB, state.userId);
    const t = await tasksOf(companyB);
    expect(t['document_text_cloud']).toBe(false);
    expect(t['document_images_cloud']).toBe(false);
    state.provider = 'ollama';
    state.companyId = companyB;
    const r = await post({ text: SECRET_TEXT });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { reason: 'company_not_opted_in' } });
    expect(state.calls).toHaveLength(0);
    await aiConsent.acceptCompanyDisclosure(state.tenantId, companyB, state.userId);
    expect((await tasksOf(companyB))['document_text_cloud']).toBe(false);
  });

  it('the document text never reaches ai_jobs or audit_log', async () => {
    const jobs = await db.execute(sql`SELECT job_type, input_type, input_data::text AS i, output_data::text AS o, error_message
      FROM ai_jobs WHERE tenant_id = ${state.tenantId} AND job_type = 'document_assist'`);
    expect(jobs.rows.length).toBeGreaterThanOrEqual(3);
    for (const j of jobs.rows as Array<{ i: string | null; o: string | null; error_message: string | null }>) {
      for (const v of [j.i, j.o, j.error_message]) {
        expect(v ?? '').not.toContain('ZZQ');
        expect(v ?? '').not.toContain('Acme');
        expect(v ?? '').not.toContain('1234');
      }
    }
    const audits = await db.execute(sql`SELECT coalesce(before_data::text,'') || coalesce(after_data::text,'') AS t
      FROM audit_log WHERE tenant_id = ${state.tenantId}`);
    for (const a of audits.rows as Array<{ t: string }>) expect(a.t).not.toContain('ZZQ');
  });
});

describe('Ollama cloud models and remote endpoints count as cloud (review M2, L1)', () => {
  it('an Ollama *-cloud model needs the switches (company B has them off)', async () => {
    state.provider = 'ollama';
    state.companyId = companyB;
    state.ocrModel = 'gpt-oss:120b-cloud';
    const r = await post({ text: SECRET_TEXT });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { task: 'document_text_cloud' } });
    expect(state.calls).toHaveLength(0);
  });

  it('a local Ollama model runs for company B; a cloud model with the switch on is redacted and reads as cloud', async () => {
    state.provider = 'ollama';
    state.companyId = companyB;
    state.ocrModel = 'llama3.2-vision:11b';
    let r = await post({ text: SECRET_TEXT });
    expect(r.status).toBe(200);
    expect(r.json.suggestion.reader).toBe('self_hosted');

    state.companyId = companyA; // document_text_cloud on
    state.ocrModel = 'qwen3-coder:480b-cloud';
    state.calls = [];
    r = await post({ text: `${SECRET_TEXT} card 4111 1111 1111 1111` });
    expect(r.status).toBe(200);
    expect(r.json.suggestion.reader).toBe('cloud');
    expect(state.calls[0]!.userPrompt).not.toContain('4111 1111 1111 1111');
  });

  it('a server Ollama on a public URL needs the switches; one on a private address does not', async () => {
    state.provider = 'ollama';
    state.companyId = companyB;
    state.ollamaBaseUrl = 'https://ollama.example.com';
    let r = await post({ text: SECRET_TEXT });
    expect(r.status).toBe(403);
    expect(r.json.error.details).toMatchObject({ task: 'document_text_cloud' });
    state.ollamaBaseUrl = 'http://10.0.0.5:11434';
    r = await post({ text: SECRET_TEXT });
    expect(r.status).toBe(200);
    expect(r.json.suggestion.reader).toBe('self_hosted');
  });
});

describe('re-accepting a newer disclosure resets the document switches (review M3)', () => {
  afterAll(async () => {
    await db.update(aiConfig).set({ disclosureVersion: 1, ocrProvider: null, piiProtectionLevel: 'strict', cloudVisionEnabled: false });
  });

  it('the same version keeps a switch that is on', async () => {
    await aiConsent.setCompanyTaskToggles(state.tenantId, companyA, { document_text_cloud: true, report_summary: true }, state.userId);
    await aiConsent.acceptCompanyDisclosure(state.tenantId, companyA, state.userId);
    const t = await tasksOf(companyA);
    expect(t['document_text_cloud']).toBe(true);
    expect(t['report_summary']).toBe(true);
  });

  it('after a disclosure bump, re-accepting turns both document switches off; other choices stay', async () => {
    await aiConsent.setCompanyTaskToggles(state.tenantId, companyA, { document_text_cloud: true, document_images_cloud: true }, state.userId);
    await db.update(aiConfig).set({ disclosureVersion: 2, ocrProvider: 'anthropic', piiProtectionLevel: 'permissive', cloudVisionEnabled: true });
    // Stale until re-accepted.
    let r = await post({ text: SECRET_TEXT });
    expect(r.status).toBe(403);
    expect(r.json.error.details).toMatchObject({ reason: 'consent_stale' });

    await aiConsent.acceptCompanyDisclosure(state.tenantId, companyA, state.userId);
    const t = await tasksOf(companyA);
    expect(t['document_text_cloud']).toBe(false);
    expect(t['document_images_cloud']).toBe(false);
    expect(t['receipt_ocr']).toBe(true);
    expect(t['report_summary']).toBe(true);
    r = await post({ text: SECRET_TEXT });
    expect(r.status).toBe(403);
    expect(r.json.error.details).toMatchObject({ task: 'document_text_cloud' });

    // Turning it back on records the configuration it was agreed under.
    await aiConsent.setCompanyTaskToggles(state.tenantId, companyA, { document_text_cloud: true }, state.userId);
    const audits = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, state.tenantId), eq(auditLog.entityType, 'company_ai_tasks'), eq(auditLog.entityId, companyA),
    ));
    const underV2 = audits.filter((a) => (a.afterData as { configuration?: { systemDisclosureVersion?: number } })?.configuration?.systemDisclosureVersion === 2);
    expect(underV2).toHaveLength(1);
    expect((underV2[0]!.afterData as Record<string, unknown>)['configuration']).toEqual({
      provider: 'anthropic', providers: { categorization: null, ocr: 'anthropic' },
      piiProtectionLevel: 'permissive', cloudVisionEnabled: true, disclosureVersion: 2, systemDisclosureVersion: 2,
    });
  });
});

describe('desktop: the older document AI routes need document_text_cloud too (review L2)', () => {
  const missing = '00000000-0000-4000-8000-000000000000';

  it('desktop + cloud provider + switch off: 403 before the attachment lookup', async () => {
    state.desktop = true;
    state.companyId = companyB;
    let r = await post({ attachmentId: missing }, '/api/v1/ai/ocr/receipt');
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { task: 'document_text_cloud' } });
    r = await post({}, `/api/v1/bills/extract-from-attachment/${missing}`);
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { task: 'document_text_cloud' } });
  });

  it('server mode, a local Ollama on the desktop, or the switch on: the route runs as before (404 here)', async () => {
    state.companyId = companyB;
    let r = await post({ attachmentId: missing }, '/api/v1/ai/ocr/receipt');
    expect(r.status).toBe(404);
    state.desktop = true;
    state.provider = 'ollama';
    r = await post({ attachmentId: missing }, '/api/v1/ai/ocr/receipt');
    expect(r.status).toBe(404);
    state.provider = 'anthropic';
    state.companyId = companyA; // document_text_cloud on
    r = await post({}, `/api/v1/bills/extract-from-attachment/${missing}`);
    expect(r.status).toBe(404);
  });
});

describe('limits (checked before any gate)', () => {
  it.each([
    [{ text: 'x'.repeat(60_001) }, 'TEXT_TOO_LONG'],
    [{ text: 'x', pageImages: [PNG, PNG, PNG, PNG] }, 'TOO_MANY_IMAGES'],
    [{ text: 'x', pageImages: [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]).toString('base64')] }, 'IMAGE_NOT_PNG'],
    [{ text: 'x', pageImages: ['not base64!'] }, 'IMAGE_NOT_PNG'],
    [{ text: 'x', pageImages: [Buffer.concat([png(10, 10).subarray(0, 8), Buffer.alloc(56)]).toString('base64')] }, 'IMAGE_NOT_PNG'],
    [{ text: 'x', pageImages: [png(5000, 1000).toString('base64')] }, 'IMAGE_TOO_LARGE'],
    [{ text: '   ' }, 'NOTHING_TO_READ'],
  ])('%#: 400 %s', async (body, code) => {
    state.provider = 'ollama';
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(code);
    expect(state.calls).toHaveLength(0);
  });

  it('images over 2 MiB together are 400 IMAGES_TOO_LARGE; exactly 2 MiB passes the limit', async () => {
    state.provider = 'ollama';
    const big = (n: number) => png(2000, 2000, n).toString('base64');
    let r = await post({ text: 'x', pageImages: [big(1024 * 1024), big(1024 * 1024 + 1)] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('IMAGES_TOO_LARGE');
    r = await post({ text: 'x', pageImages: [big(1024 * 1024), big(1024 * 1024)] });
    expect(r.status).toBe(200);
  });

  it('an unknown kindHint is a validation error', async () => {
    const r = await post({ text: 'x', kindHint: 'invoice' });
    expect(r.status).toBe(400);
  });
});
