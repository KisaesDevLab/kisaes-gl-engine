// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PDF bill OCR × PII protection levels.
//
// The contract under test: at strict/standard, a PDF bill is processed
// entirely from LOCAL extraction (text layer, or rasterize + local OCR)
// and only sanitized TEXT reaches a cloud provider; raw pixels reach the
// cloud only in Permissive mode with cloud vision enabled; vision models
// (local or cloud) never receive a raw PDF — always rasterized PNG pages;
// and an unreadable scan fails with a clear, coded error instead of the
// generic cloud-vision message or a silent 'failed' status.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const setCalls: Array<Record<string, unknown>> = [];

const chain = (): any => {
  const p: any = Promise.resolve([]);
  for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'leftJoin', 'innerJoin', 'groupBy', 'values', 'returning', 'onConflictDoUpdate']) {
    p[m] = () => chain();
  }
  p.set = (payload: Record<string, unknown>) => { setCalls.push(payload); return chain(); };
  return p;
};

vi.mock('fs', () => ({ default: { readFileSync: () => Buffer.from('%PDF-1.7 fake bytes') } }));
vi.mock('./storage/cache.service.js', () => ({ ensureLocal: async () => '/tmp/x.pdf' }));
vi.mock('./ai-prompt.service.js', () => ({ getCustomSystemPrompt: async () => null }));
vi.mock('./pii-sanitizer.service.js', () => ({
  sanitize: (t: string) => ({ text: `[SANITIZED]${t}`, detected: ['phone'] }),
}));

const extractLocallyMock = vi.fn();
const extractTextFromPdfMock = vi.fn();
vi.mock('./local-ocr.service.js', () => ({
  extractLocally: (...a: unknown[]) => extractLocallyMock(...a),
  extractTextFromPdf: (...a: unknown[]) => extractTextFromPdfMock(...a),
}));

const renderPdfToPngPagesMock = vi.fn(async (..._a: unknown[]) => [
  { pageNo: 1, data: Buffer.from('png1'), mimeType: 'image/png' },
  { pageNo: 2, data: Buffer.from('png2'), mimeType: 'image/png' },
]);
vi.mock('./extraction/pdf-render.service.js', () => ({
  renderPdfToPngPages: (...a: unknown[]) => renderPdfToPngPagesMock(...a),
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      attachments: {
        findFirst: async () => ({
          id: 'a1', tenantId: 't1', companyId: 'c1',
          filePath: '/x.pdf', mimeType: 'application/pdf',
        }),
      },
      contacts: { findFirst: async () => null },
      accounts: { findFirst: async () => null },
    },
    select: () => chain(),
    update: () => chain(),
    insert: () => chain(),
  },
}));

const state = {
  selfHosted: false,
  cloudVisionAllowed: false,
};

vi.mock('./ai-config.service.js', () => ({
  getConfig: async () => ({ isEnabled: true, ocrProvider: 'anthropic', categorizationProvider: 'anthropic', ocrModel: null }),
  getRawConfig: async () => ({ openaiCompatBaseUrl: null }),
  resolveTaskParams: () => ({ maxTokens: 2048, temperature: 0.1 }),
  resolveTaskExec: () => ({ fallbackChain: [], enabled: true, timeoutMs: 0 }),
  resolveGlmOcrConfig: async () => ({
    enabled: false, baseUrl: '', model: 'glm-ocr', prompt: 'OCR:', timeoutMs: 5000,
    concurrency: 2, apiKey: null, forceOcr: false, renderDpi: 150,
  }),
}));

import { AppError } from '../utils/errors.js';

vi.mock('./ai-orchestrator.service.js', () => ({
  createJob: async () => ({ id: 'job1' }),
  completeJob: async () => undefined,
  failJob: async () => undefined,
  isSelfHostedProvider: () => state.selfHosted,
  assertCloudVisionAllowed: async () => {
    if (!state.cloudVisionAllowed) {
      throw AppError.badRequest('Cloud vision is disabled by PII protection settings.');
    }
  },
  piiModeFor: () => 'standard',
  withAiMetadata: (p: unknown) => p,
}));

const parsedBill = {
  vendor: 'ACME Supplies', vendor_invoice_number: '12345', bill_date: '2026-07-01',
  due_date: '2026-08-01', payment_terms: 'net_30', subtotal: '100.00', tax: '8.00',
  total: '108.00', line_items: [{ description: 'Widget A', amount: '100.00', quantity: '2' }],
  notes: null, confidence: 0.9,
};
const completionResult = (parsed: unknown) => ({
  provider: 'anthropic', model: 'claude-x', content: JSON.stringify(parsed), parsed,
  inputTokens: 10, outputTokens: 10, durationMs: 5,
});

const completeMock = vi.fn(async () => completionResult(parsedBill));
const completeWithImageMock = vi.fn(async () => completionResult(parsedBill));
vi.mock('./ai-providers/index.js', () => ({
  getProvider: () => ({ complete: completeMock, completeWithImage: completeWithImageMock }),
}));

const completeVisionWithFallbackMock = vi.fn(async (..._a: unknown[]) => completionResult(parsedBill));
vi.mock('./ai-vision-fallback.js', () => ({
  completeVisionWithFallback: (...a: unknown[]) => completeVisionWithFallbackMock(...a),
}));

import { extractBillFromAttachment } from './ai-bill-ocr.service.js';

beforeEach(() => {
  setCalls.length = 0;
  state.selfHosted = false;
  state.cloudVisionAllowed = false;
  vi.clearAllMocks();
});

describe('extractBillFromAttachment — PDF at strict/standard (cloud provider)', () => {
  it('text-layer PDF: local extraction feeds a sanitized TEXT completion, never pixels', async () => {
    extractLocallyMock.mockResolvedValueOnce({ kind: 'pdf_text', text: 'ACME invoice text', numPages: 1 });
    const result = await extractBillFromAttachment('t1', 'a1');
    expect(result.vendor).toBe('ACME Supplies');
    expect(completeMock).toHaveBeenCalledTimes(1);
    const prompt = (completeMock.mock.calls[0] as any)[0].userPrompt as string;
    expect(prompt).toContain('[SANITIZED]ACME invoice text');
    expect(completeWithImageMock).not.toHaveBeenCalled();
    expect(completeVisionWithFallbackMock).not.toHaveBeenCalled();
    expect(setCalls.some((c) => c['ocrStatus'] === 'complete')).toBe(true);
  });

  it('scanned PDF readable by local OCR: still text-only to the cloud, with a quality warning', async () => {
    extractLocallyMock.mockResolvedValueOnce({ kind: 'tesseract', text: 'scanned bill text', confidence: 0.8 });
    const result = await extractBillFromAttachment('t1', 'a1');
    expect(result.qualityWarnings).toContain('tesseract_local_ocr');
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeWithImageMock).not.toHaveBeenCalled();
    // extractLocally received the GLM engine config for its local-OCR choice.
    expect((extractLocallyMock.mock.calls[0] as any)[2]).toHaveProperty('glm');
  });

  it('unreadable scanned PDF: clear coded error, no pixels sent, attachment marked failed', async () => {
    extractLocallyMock.mockResolvedValueOnce({ kind: 'none', reason: 'extraction_empty' });
    await expect(extractBillFromAttachment('t1', 'a1')).rejects.toMatchObject({
      code: 'ocr_unreadable_at_pii_level',
    });
    expect(completeWithImageMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(setCalls.some((c) => c['ocrStatus'] === 'failed')).toBe(true);
  });
});

describe('extractBillFromAttachment — Permissive + cloud vision', () => {
  it('falls back to cloud vision with rasterized PNG pages, never the raw PDF', async () => {
    state.cloudVisionAllowed = true;
    extractLocallyMock.mockResolvedValueOnce({ kind: 'none', reason: 'extraction_empty' });
    const result = await extractBillFromAttachment('t1', 'a1');
    expect(result.qualityWarnings).toContain('cloud_vision_used');
    expect(renderPdfToPngPagesMock).toHaveBeenCalledTimes(1);
    const images = (completeWithImageMock.mock.calls[0] as any)[0].images as Array<{ mimeType: string }>;
    expect(images.length).toBe(2);
    expect(images.every((i) => i.mimeType === 'image/png')).toBe(true);
  });
});

describe('extractBillFromAttachment — self-hosted provider', () => {
  it('text-layer PDF goes through the local text path (no vision call)', async () => {
    state.selfHosted = true;
    extractTextFromPdfMock.mockResolvedValueOnce({ text: 'local text layer', numPages: 1, isTextBased: true });
    const result = await extractBillFromAttachment('t1', 'a1');
    expect(result.vendor).toBe('ACME Supplies');
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeVisionWithFallbackMock).not.toHaveBeenCalled();
  });

  it('scanned PDF goes to the local vision chain as rasterized PNG pages (Ollama cannot parse PDFs)', async () => {
    state.selfHosted = true;
    extractTextFromPdfMock.mockResolvedValueOnce({ text: '', numPages: 1, isTextBased: false });
    await extractBillFromAttachment('t1', 'a1');
    expect(completeVisionWithFallbackMock).toHaveBeenCalledTimes(1);
    const images = (completeVisionWithFallbackMock.mock.calls[0] as any)[0].images as Array<{ mimeType: string }>;
    expect(images.every((i) => i.mimeType === 'image/png')).toBe(true);
  });
});
