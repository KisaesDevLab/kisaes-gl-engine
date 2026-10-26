// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-92d (document-assist-v1): the assist service's gates and its failure
// paths, with the consent check, orchestrator and provider as stubs (no
// database, no network). The route test runs the real consent service.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  config: { isEnabled: true, ocrProvider: 'anthropic', categorizationProvider: 'anthropic', ocrModel: null } as Record<string, unknown>,
  exec: { enabled: true, timeoutMs: 0 },
  raw: { openaiCompatBaseUrl: null } as Record<string, unknown>,
  allowed: new Set<string>(['document_text_cloud', 'document_images_cloud']),
  consentReason: 'task_disabled' as string,
  visionAllowed: true,
  routed: false,
  reply: { parsed: { vendor: 'V', total: '10.00', confidence: 0.9 } } as Record<string, unknown>,
  throwFromProvider: null as Error | null,
  jobs: [] as unknown[][],
  completed: [] as unknown[][],
  failed: [] as unknown[][],
  calls: [] as string[],
}));

vi.mock('./ai-config.service.js', () => ({
  getConfig: async () => st.config,
  getRawConfig: async () => st.raw,
  resolveTaskParams: () => ({ maxTokens: 2048, temperature: 0.1 }),
  resolveTaskExec: () => st.exec,
}));
vi.mock('./ai-prompt.service.js', () => ({ getCustomSystemPrompt: async () => null }));
vi.mock('./pii-sanitizer.service.js', () => ({ sanitize: (t: string) => ({ text: t, detected: [] }) }));
vi.mock('./ai-consent.service.js', () => ({
  checkTenantTaskConsent: async (_t: string, task: string) =>
    (st.allowed.has(task) ? { allowed: true } : { allowed: false, reason: st.consentReason }),
}));
vi.mock('./ai-orchestrator.service.js', async () => {
  const { AppError } = await import('../utils/errors.js');
  return {
    isSelfHostedProvider: (p: string) => p === 'ollama',
    piiModeFor: () => 'standard',
    consentReasonMessage: (r: string) => `blocked: ${r}`,
    assertCloudVisionAllowed: async () => { if (!st.visionAllowed) throw AppError.badRequest('no'); },
    createJob: async (...a: unknown[]) => { st.jobs.push(a); return { id: 'job1' }; },
    completeJob: async (...a: unknown[]) => { st.completed.push(a); },
    failJob: async (...a: unknown[]) => { st.failed.push(a); },
    withAiMetadata: (o: object, meta: object) => ({ ...o, _ai: meta }),
  };
});
vi.mock('./ai-providers/vibe-router.provider.js', () => ({
  MYBOOKS_TASK_CLASSES: { BILL_EXTRACT: 'bill_extract' },
  routeFor: () => st.routed,
}));
vi.mock('./ai-providers/index.js', () => ({
  getProvider: () => ({
    complete: async () => {
      st.calls.push('text');
      if (st.throwFromProvider) throw st.throwFromProvider;
      return { provider: 'x', model: 'm', text: '', inputTokens: 1, outputTokens: 1, durationMs: 1, ...st.reply };
    },
    completeWithImage: async () => {
      st.calls.push('image');
      return { provider: 'x', model: 'm', text: '', inputTokens: 1, outputTokens: 1, durationMs: 1, ...st.reply };
    },
  }),
}));

import { assist, checkAssistInput } from './document-reading-assist.service.js';
import { AppError } from '../utils/errors.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString('base64');
const TEXT = 'SECRET-DOC-TEXT 42 Main St total 10.00';

async function code(p: Promise<unknown>): Promise<{ status: number; code?: string; details?: Record<string, unknown>; message: string }> {
  try { await p; } catch (e) {
    if (e instanceof AppError) return { status: e.statusCode, code: e.code, details: e.details, message: e.message };
    throw e;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  st.config = { isEnabled: true, ocrProvider: 'anthropic', categorizationProvider: 'anthropic', ocrModel: null };
  st.exec = { enabled: true, timeoutMs: 0 };
  st.raw = { openaiCompatBaseUrl: null };
  st.allowed = new Set(['document_text_cloud', 'document_images_cloud']);
  st.consentReason = 'task_disabled';
  st.visionAllowed = true;
  st.routed = false;
  st.reply = { parsed: { vendor: 'V', total: '10.00', confidence: 0.9 } };
  st.throwFromProvider = null;
  st.jobs = []; st.completed = []; st.failed = []; st.calls = [];
});

describe('checkAssistInput', () => {
  it('decodes PNGs and accepts text-only or image-only input', () => {
    expect(checkAssistInput({ text: 'a' })).toEqual([]);
    expect(checkAssistInput({ text: '', pageImages: [PNG] })).toHaveLength(1);
  });
  it('base64 with a data: prefix is not a PNG', () => {
    expect(() => checkAssistInput({ text: 'a', pageImages: [`data:image/png;base64,${PNG}`] })).toThrow(/PNG/);
  });
});

describe('gates', () => {
  it('AI off → 400 ai_disabled; OCR function off → 400 ai_function_disabled; nothing called', async () => {
    st.config = { ...st.config, isEnabled: false };
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }))).toMatchObject({ status: 400, code: 'ai_disabled' });
    st.config = { ...st.config, isEnabled: true };
    st.exec = { enabled: false, timeoutMs: 0 };
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }))).toMatchObject({ status: 400, code: 'ai_function_disabled' });
    st.exec = { enabled: true, timeoutMs: 0 };
    st.config = { ...st.config, ocrProvider: null, categorizationProvider: null };
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }))).toMatchObject({ status: 400, code: 'ai_function_disabled' });
    expect(st.calls).toEqual([]);
    expect(st.jobs).toEqual([]);
  });

  it('cloud without document_text_cloud → 403 CONSENT_REQUIRED; stale consent carries its reason', async () => {
    st.allowed = new Set();
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' })))
      .toMatchObject({ status: 403, code: 'CONSENT_REQUIRED', details: { task: 'document_text_cloud' } });
    st.consentReason = 'consent_stale';
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' })))
      .toMatchObject({ status: 403, code: 'CONSENT_REQUIRED', details: { task: 'document_text_cloud', reason: 'consent_stale' } });
    expect(st.calls).toEqual([]);
  });

  it('cloud images: text switch alone is not enough; the cloud-vision gate also applies', async () => {
    st.allowed = new Set(['document_text_cloud']);
    expect(await code(assist('t', 'c', { text: TEXT, pageImages: [PNG], kindHint: 'bill' })))
      .toMatchObject({ status: 403, code: 'CONSENT_REQUIRED', details: { task: 'document_images_cloud' } });
    st.allowed = new Set(['document_text_cloud', 'document_images_cloud']);
    st.visionAllowed = false;
    expect(await code(assist('t', 'c', { text: TEXT, pageImages: [PNG], kindHint: 'bill' })))
      .toMatchObject({ status: 403, code: 'CLOUD_VISION_DISABLED' });
    expect(st.calls).toEqual([]);
  });

  it('Ollama: no switch, no cloud-vision gate; images go to the one local provider', async () => {
    st.config = { ...st.config, ocrProvider: 'ollama' };
    st.allowed = new Set();
    st.visionAllowed = false;
    const s = await assist('t', 'c', { text: TEXT, pageImages: [PNG], kindHint: 'check' });
    expect(s.reader).toBe('self_hosted');
    expect(st.calls).toEqual(['image']);
  });

  it('Ollama switched to the Vibe AI Router counts as cloud', async () => {
    st.config = { ...st.config, ocrProvider: 'ollama' };
    st.routed = true;
    st.allowed = new Set();
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }))).toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
  });
});

describe('privacy and failures', () => {
  it('the job keeps sizes and counts only; the reading is not stored', async () => {
    const s = await assist('t', 'c', { text: TEXT, pageImages: [PNG], kindHint: 'bill' });
    expect(s.total).toBe('10.00');
    const [, jobType, inputType, inputId, inputData, companyId] = st.jobs[0]!;
    expect(jobType).toBe('document_assist');
    expect(inputType).toBe('document_text');
    expect(String(inputId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(companyId).toBe('c');
    expect(inputData).toEqual({ kindHint: 'bill', textChars: TEXT.length, imageCount: 1, imageBytes: 24, selfHosted: false });
    const stored = JSON.stringify(st.completed[0]![2]);
    expect(stored).not.toContain('SECRET');
    expect(stored).not.toContain('10.00');
    expect(stored).not.toContain('"V"');
  });

  it('a non-JSON reply is 400 ai_parse_failed without an excerpt; the job stores the code only', async () => {
    st.reply = { parsed: undefined, parseError: 'excerpt: SECRET-DOC-TEXT' };
    const r = await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }));
    expect(r).toMatchObject({ status: 400, code: 'ai_parse_failed' });
    expect(r.message).not.toContain('SECRET');
    expect(st.failed[0]).toEqual(['job1', 'ai_parse_failed']);
  });

  it('a provider error is 400 ai_ocr_failed; its message is not stored', async () => {
    st.throwFromProvider = new Error('upstream said: SECRET-DOC-TEXT');
    const r = await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }));
    expect(r).toMatchObject({ status: 400, code: 'ai_ocr_failed' });
    expect(st.failed[0]).toEqual(['job1', 'provider_error']);
  });

  it('an AppError from the provider (offline) is passed through', async () => {
    st.throwFromProvider = new AppError(503, 'offline', 'OFFLINE_UNAVAILABLE');
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }))).toMatchObject({ status: 503, code: 'OFFLINE_UNAVAILABLE' });
  });

  it('never invents amounts: a missing or unreadable amount stays null', async () => {
    st.reply = { parsed: { vendor: 'V', total: 'about ten', line_items: [{ description: 'x', quantity: 2, unit_price: '5' }], confidence: 0.9 } };
    const s = await assist('t', 'c', { text: TEXT, kindHint: 'bill' });
    expect(s.total).toBeNull();
    expect(s.subtotal).toBeNull();
    expect(s.lineItems[0]).toMatchObject({ amount: null, quantity: '2', unitPrice: '5', confidence: 'low' });
  });
});
