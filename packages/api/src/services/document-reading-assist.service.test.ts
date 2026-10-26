// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-92d (document-assist-v1): the assist service's gates and its failure
// paths, with the consent check, orchestrator jobs and provider as stubs (no
// AI call, no network). The route test runs the real consent service.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const st = vi.hoisted(() => ({
  config: { isEnabled: true, ocrProvider: 'anthropic', categorizationProvider: 'anthropic', ocrModel: null } as Record<string, unknown>,
  exec: { enabled: true, timeoutMs: 0 },
  raw: { openaiCompatBaseUrl: null } as Record<string, unknown>,
  allowed: new Set<string>(['document_text_cloud', 'document_images_cloud']),
  consentReason: 'task_disabled' as string,
  optedIn: true,
  visionAllowed: true,
  visionOpts: [] as unknown[],
  routed: false,
  desktop: false,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  customPrompt: null as string | null,
  reply: { parsed: { vendor: 'V', total: '10.00', confidence: 0.9 } } as Record<string, unknown>,
  throwFromProvider: null as Error | null,
  hang: false,
  jobs: [] as unknown[][],
  completed: [] as unknown[][],
  failed: [] as unknown[][],
  calls: [] as string[],
  params: [] as Array<{ systemPrompt: string; userPrompt: string; signal?: AbortSignal }>,
  piiModes: [] as string[],
}));

vi.mock('./ai-config.service.js', () => ({
  getConfig: async () => st.config,
  getRawConfig: async () => st.raw,
  resolveTaskParams: () => ({ maxTokens: 2048, temperature: 0.1 }),
  resolveTaskExec: () => st.exec,
}));
vi.mock('./ai-prompt.service.js', () => ({ getCustomSystemPrompt: async () => st.customPrompt }));
vi.mock('./pii-sanitizer.service.js', async () => {
  const actual = await vi.importActual<typeof import('./pii-sanitizer.service.js')>('./pii-sanitizer.service.js');
  return {
    pickMode: actual.pickMode,
    sanitize: (t: string, mode: string) => { st.piiModes.push(mode); return { text: t, detected: [] }; },
  };
});
vi.mock('./ai-consent.service.js', () => ({
  checkTenantTaskConsent: async (_t: string, task: string) =>
    (st.allowed.has(task) ? { allowed: true } : { allowed: false, reason: st.consentReason }),
  checkCompanyAiOptIn: async () => (st.optedIn ? { allowed: true } : { allowed: false, reason: 'company_not_opted_in' }),
}));
vi.mock('../desktop/profile.js', () => ({ isDesktop: () => st.desktop }));
vi.mock('./ai-orchestrator.service.js', async () => {
  const { AppError } = await import('../utils/errors.js');
  // The real URL and cloud-model rules; jobs and the vision gate are stubs.
  const actual = await vi.importActual<typeof import('./ai-orchestrator.service.js')>('./ai-orchestrator.service.js');
  return {
    isSelfHostedProvider: (p: string) => p === 'ollama',
    isLocalUrl: actual.isLocalUrl,
    isOllamaCloudModel: actual.isOllamaCloudModel,
    consentReasonMessage: (r: string) => `blocked: ${r}`,
    assertCloudVisionAllowed: async (_p: string, opts?: unknown) => {
      st.visionOpts.push(opts);
      if (!st.visionAllowed) throw AppError.badRequest('no');
    },
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
vi.mock('./ai-providers/index.js', () => {
  const answer = async (kind: string, p: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => {
    st.calls.push(kind);
    st.params.push(p);
    if (st.hang) {
      // A provider that honours the signal: it rejects only when aborted.
      await new Promise((_resolve, reject) => {
        p.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (st.throwFromProvider) throw st.throwFromProvider;
    return { provider: 'x', model: 'm', text: '', inputTokens: 7, outputTokens: 5, durationMs: 1, ...st.reply };
  };
  return {
    getProvider: () => ({
      complete: (p: any) => answer('text', p),
      completeWithImage: (p: any) => answer('image', p),
    }),
    resolveSelfHostedTarget: (p: string) => (p === 'ollama' ? { baseUrl: st.ollamaUrl, model: st.ollamaModel } : null),
  };
});

import {
  assist, assertDesktopDocumentTextConsent, checkAssistInput, pngDimensions,
  DOCUMENT_ASSIST_DEFAULT_TIMEOUT_MS, DOCUMENT_ASSIST_PROMPT_RULE, documentAssistSystemPrompt,
} from './document-reading-assist.service.js';
import { AppError } from '../utils/errors.js';

/** A PNG signature and IHDR chunk of the given size (CRC not checked), plus padding. */
function png(width: number, height: number, pad = 4): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(pad)]);
}
const PNG = png(800, 1000).toString('base64');
const PNG_BYTES = png(800, 1000).length;
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
  st.optedIn = true;
  st.visionAllowed = true;
  st.visionOpts = [];
  st.routed = false;
  st.desktop = false;
  st.ollamaUrl = 'http://localhost:11434';
  st.ollamaModel = 'llama3.2';
  st.customPrompt = null;
  st.reply = { parsed: { vendor: 'V', total: '10.00', confidence: 0.9 } };
  st.throwFromProvider = null;
  st.hang = false;
  st.jobs = []; st.completed = []; st.failed = []; st.calls = []; st.params = []; st.piiModes = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('checkAssistInput', () => {
  it('decodes PNGs and accepts text-only or image-only input', () => {
    expect(checkAssistInput({ text: 'a' })).toEqual([]);
    expect(checkAssistInput({ text: '', pageImages: [PNG] })).toHaveLength(1);
  });
  it('base64 with a data: prefix is not a PNG', () => {
    expect(() => checkAssistInput({ text: 'a', pageImages: [`data:image/png;base64,${PNG}`] })).toThrow(/PNG/);
  });

  // L3: the IHDR is read; a page larger than 4096 px on a side is refused.
  it('a PNG signature without a valid IHDR is 400 IMAGE_NOT_PNG', async () => {
    const sigOnly = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString('base64');
    const zeroWide = png(0, 100).toString('base64');
    for (const img of [sigOnly, zeroWide]) {
      const r = await code((async () => checkAssistInput({ text: 'a', pageImages: [PNG, img] }))());
      expect(r).toMatchObject({ status: 400, code: 'IMAGE_NOT_PNG', details: { index: 1 } });
    }
  });
  it('a page wider or higher than 4096 px is 400 IMAGE_TOO_LARGE; 4096 passes', async () => {
    for (const [w, h] of [[4097, 100], [100, 4097], [0x7fffffff, 0x7fffffff]] as const) {
      const r = await code((async () => checkAssistInput({ text: 'a', pageImages: [png(w, h).toString('base64')] }))());
      expect(r).toMatchObject({ status: 400, code: 'IMAGE_TOO_LARGE', details: { index: 0, maxSide: 4096 } });
    }
    expect(checkAssistInput({ text: 'a', pageImages: [png(4096, 4096).toString('base64')] })).toHaveLength(1);
  });
  it('pngDimensions reads the IHDR', () => {
    expect(pngDimensions(png(2550, 3300))).toEqual({ width: 2550, height: 3300 });
    expect(pngDimensions(Buffer.from('not a png at all, not a png at all'))).toBeNull();
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
    expect(st.visionOpts).toEqual([{ selfHosted: false }]);
    expect(st.calls).toEqual([]);
  });

  it('Ollama: no switch, no cloud-vision gate, no redaction; images go to the one local provider', async () => {
    st.config = { ...st.config, ocrProvider: 'ollama' };
    st.allowed = new Set();
    st.visionAllowed = false;
    const s = await assist('t', 'c', { text: TEXT, pageImages: [PNG], kindHint: 'check' });
    expect(s.reader).toBe('self_hosted');
    expect(st.calls).toEqual(['image']);
    expect(st.piiModes).toEqual(['none']);
  });

  it('Ollama still needs the company AI opt-in: 403 CONSENT_REQUIRED with the reason, nothing called', async () => {
    st.config = { ...st.config, ocrProvider: 'ollama' };
    st.optedIn = false;
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' })))
      .toMatchObject({ status: 403, code: 'CONSENT_REQUIRED', details: { reason: 'company_not_opted_in' } });
    expect(st.calls).toEqual([]);
    expect(st.jobs).toEqual([]);
  });

  it('Ollama switched to the Vibe AI Router counts as cloud', async () => {
    st.config = { ...st.config, ocrProvider: 'ollama' };
    st.routed = true;
    st.allowed = new Set();
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }))).toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
  });

  // M2: an Ollama cloud model is served by ollama.com.
  it.each(['gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud', 'deepseek-v3.1:671B-CLOUD', 'kimi-k2:cloud'])(
    'Ollama model %s counts as cloud: switches, cloud-vision gate and redaction apply',
    async (model) => {
      st.config = { ...st.config, ocrProvider: 'ollama' };
      st.ollamaModel = model;
      st.allowed = new Set();
      expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' })))
        .toMatchObject({ status: 403, code: 'CONSENT_REQUIRED', details: { task: 'document_text_cloud' } });
      expect(st.calls).toEqual([]);

      st.allowed = new Set(['document_text_cloud', 'document_images_cloud']);
      st.visionAllowed = false;
      expect(await code(assist('t', 'c', { text: TEXT, pageImages: [PNG], kindHint: 'bill' })))
        .toMatchObject({ status: 403, code: 'CLOUD_VISION_DISABLED' });
      expect(st.visionOpts).toEqual([{ selfHosted: false }]);

      st.visionAllowed = true;
      const s = await assist('t', 'c', { text: TEXT, kindHint: 'bill' });
      expect(s.reader).toBe('cloud');
      expect(st.piiModes).toEqual(['standard']);
    },
  );

  it('an Ollama model whose name only contains "cloud" stays local', async () => {
    st.config = { ...st.config, ocrProvider: 'ollama' };
    st.allowed = new Set();
    for (const model of ['cloudy-llama:7b', 'llama3.2', 'mycloudmodel']) {
      st.ollamaModel = model;
      expect((await assist('t', 'c', { text: TEXT, kindHint: 'bill' })).reader).toBe('self_hosted');
    }
  });

  // L1: the endpoint must be a local URL for a self-hosted reading.
  it('Ollama on a remote URL counts as cloud', async () => {
    st.config = { ...st.config, ocrProvider: 'ollama' };
    st.ollamaUrl = 'https://ollama.example.com';
    st.allowed = new Set();
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' })))
      .toMatchObject({ status: 403, code: 'CONSENT_REQUIRED', details: { task: 'document_text_cloud' } });
    st.ollamaUrl = 'http://192.168.1.20:11434';
    expect((await assist('t', 'c', { text: TEXT, kindHint: 'bill' })).reader).toBe('self_hosted');
  });
});

describe('prompt', () => {
  it('the built-in prompt carries the assist rule', async () => {
    await assist('t', 'c', { text: TEXT, kindHint: 'bill' });
    expect(st.params[0]!.systemPrompt).toBe(documentAssistSystemPrompt);
    expect(documentAssistSystemPrompt.endsWith(DOCUMENT_ASSIST_PROMPT_RULE)).toBe(true);
  });
  // L5: a custom ocr_invoice prompt keeps the rule.
  it('a custom ocr_invoice prompt gets the assist rule appended', async () => {
    st.customPrompt = 'CUSTOM PROMPT';
    await assist('t', 'c', { text: TEXT, kindHint: 'bill' });
    expect(st.params[0]!.systemPrompt).toBe(`CUSTOM PROMPT\n${DOCUMENT_ASSIST_PROMPT_RULE}`);
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
    expect(inputData).toEqual({ kindHint: 'bill', textChars: TEXT.length, imageCount: 1, imageBytes: PNG_BYTES, selfHosted: false });
    const stored = JSON.stringify(st.completed[0]![2]);
    expect(stored).not.toContain('SECRET');
    expect(stored).not.toContain('10.00');
    expect(stored).not.toContain('"V"');
  });

  it('a non-JSON reply is 400 ai_parse_failed without an excerpt; the job stores the code and the usage', async () => {
    st.reply = { parsed: undefined, parseError: 'excerpt: SECRET-DOC-TEXT' };
    const r = await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }));
    expect(r).toMatchObject({ status: 400, code: 'ai_parse_failed' });
    expect(r.message).not.toContain('SECRET');
    // M1: tokens spent on a reply that failed afterwards are recorded.
    expect(st.failed[0]).toEqual(['job1', 'ai_parse_failed', { provider: 'x', model: 'm', inputTokens: 7, outputTokens: 5 }]);
  });

  it('a provider error is 400 ai_ocr_failed; its message is not stored; no usage (no reply)', async () => {
    st.throwFromProvider = new Error('upstream said: SECRET-DOC-TEXT');
    const r = await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }));
    expect(r).toMatchObject({ status: 400, code: 'ai_ocr_failed' });
    expect(st.failed[0]).toEqual(['job1', 'provider_error']);
  });

  it('an AppError from the provider (offline) is passed through', async () => {
    st.throwFromProvider = new AppError(503, 'offline', 'OFFLINE_UNAVAILABLE');
    expect(await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }))).toMatchObject({ status: 503, code: 'OFFLINE_UNAVAILABLE' });
  });

  // M1: every call has a timeout and an abort signal.
  it('the OCR timeout aborts the request: 400 ai_ocr_failed, job failed with "timeout"', async () => {
    st.exec = { enabled: true, timeoutMs: 50 };
    st.hang = true;
    const r = await code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }));
    expect(r).toMatchObject({ status: 400, code: 'ai_ocr_failed' });
    expect(r.message).toMatch(/too long/);
    expect(st.params[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(st.params[0]!.signal!.aborted).toBe(true);
    expect(st.failed[0]).toEqual(['job1', 'timeout']);
  });

  it('with no OCR timeout set, the call still ends after 60 s', async () => {
    vi.useFakeTimers();
    st.hang = true;
    const p = code(assist('t', 'c', { text: TEXT, kindHint: 'bill' }));
    await vi.advanceTimersByTimeAsync(DOCUMENT_ASSIST_DEFAULT_TIMEOUT_MS - 1);
    expect(st.failed).toEqual([]);
    expect(st.params[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ status: 400, code: 'ai_ocr_failed' });
    expect(st.params[0]!.signal!.aborted).toBe(true);
    expect(st.failed[0]).toEqual(['job1', 'timeout']);
    expect(DOCUMENT_ASSIST_DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  it('a successful call leaves the signal un-aborted (the timer is cancelled)', async () => {
    vi.useFakeTimers();
    await assist('t', 'c', { text: TEXT, kindHint: 'bill' });
    expect(vi.getTimerCount()).toBe(0);
    expect(st.params[0]!.signal!.aborted).toBe(false);
  });

  it('never invents amounts: a missing or unreadable amount stays null', async () => {
    st.reply = { parsed: { vendor: 'V', total: 'about ten', line_items: [{ description: 'x', quantity: 2, unit_price: '5' }], confidence: 0.9 } };
    const s = await assist('t', 'c', { text: TEXT, kindHint: 'bill' });
    expect(s.total).toBeNull();
    expect(s.subtotal).toBeNull();
    expect(s.lineItems[0]).toMatchObject({ amount: null, quantity: '2', unitPrice: '5', confidence: 'low' });
  });
});

// L2: desktop mode, the older document AI routes need document_text_cloud too.
describe('assertDesktopDocumentTextConsent', () => {
  it('server mode: a no-op', async () => {
    st.allowed = new Set();
    await expect(assertDesktopDocumentTextConsent('t', 'c')).resolves.toBeUndefined();
  });
  it('desktop + cloud OCR provider without the switch → 403 CONSENT_REQUIRED (document_text_cloud)', async () => {
    st.desktop = true;
    st.allowed = new Set();
    expect(await code(assertDesktopDocumentTextConsent('t', 'c')))
      .toMatchObject({ status: 403, code: 'CONSENT_REQUIRED', details: { task: 'document_text_cloud' } });
    st.allowed = new Set(['document_text_cloud']);
    await expect(assertDesktopDocumentTextConsent('t', 'c')).resolves.toBeUndefined();
  });
  it('desktop + local Ollama, AI off or no provider: passes to the route', async () => {
    st.desktop = true;
    st.allowed = new Set();
    st.config = { ...st.config, ocrProvider: 'ollama' };
    await expect(assertDesktopDocumentTextConsent('t', 'c')).resolves.toBeUndefined();
    st.ollamaModel = 'gpt-oss:20b-cloud';
    expect(await code(assertDesktopDocumentTextConsent('t', 'c'))).toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    st.config = { ...st.config, isEnabled: false };
    await expect(assertDesktopDocumentTextConsent('t', 'c')).resolves.toBeUndefined();
  });
});
