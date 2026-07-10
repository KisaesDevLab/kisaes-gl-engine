// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Regression: self-hosted image OCR must default to the dedicated OCR vision
// model (OCR_VISION_MODEL = minicpm-v4.5:latest) when the admin leaves the OCR
// model blank — so MiniCPM-V is the "first option" for image OCR without per-
// appliance config. An explicit config.ocrModel still wins.

import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getProvider: vi.fn() }));

vi.mock('fs', () => ({ default: { readFileSync: () => Buffer.from('img') } }));
vi.mock('./storage/cache.service.js', () => ({ ensureLocal: async () => '/tmp/x.jpg' }));
vi.mock('./pii-sanitizer.service.js', () => ({ sanitize: (t: string) => ({ text: t, detected: [] }) }));
vi.mock('./local-ocr.service.js', () => ({ extractLocally: async () => ({ kind: 'none' }) }));
vi.mock('./ai-prompt.service.js', () => ({ getCustomSystemPrompt: async () => null }));

// Chainable query stub: any drizzle builder method returns the same awaitable
// (resolving to []), so `db.select().from().where()...` works regardless of
// the exact chain.
const chain = (): any => {
  const p: any = Promise.resolve([]);
  for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'leftJoin', 'innerJoin', 'groupBy', 'set', 'values', 'returning', 'onConflictDoUpdate']) {
    p[m] = () => chain();
  }
  return p;
};

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      attachments: { findFirst: async () => ({ id: 'a1', tenantId: 't1', filePath: '/x.jpg', mimeType: 'image/jpeg' }) },
      contacts: { findFirst: async () => null },
    },
    select: () => chain(),
    update: () => chain(),
    insert: () => chain(),
  },
}));

vi.mock('./ai-config.service.js', () => ({
  getConfig: async () => ({ isEnabled: true, ocrProvider: 'openai_compat', categorizationProvider: 'openai_compat', ocrModel: null }),
  getRawConfig: async () => ({ openaiCompatBaseUrl: 'http://192.168.68.105:11434' }),
  resolveTaskParams: () => ({ maxTokens: 1024, temperature: 0.1 }),
  // processReceipt also checks the per-function "Enable this function"
  // toggle via resolveTaskExec; keep it enabled here.
  resolveTaskExec: () => ({ fallbackChain: [], enabled: true }),
}));

vi.mock('./ai-orchestrator.service.js', () => ({
  createJob: async () => ({ id: 'job1' }),
  completeJob: async () => undefined,
  failJob: async () => undefined,
  isSelfHostedProvider: () => true,
  assertCloudVisionAllowed: async () => undefined,
  piiModeFor: () => 'none',
  withAiMetadata: (p: unknown) => p,
}));

vi.mock('./ai-providers/index.js', () => ({
  getProvider: (...a: unknown[]) => {
    mocks.getProvider(...a);
    return { completeWithImage: async () => ({ parsed: { vendor: 'Test', confidence: 0.9 }, text: '{}', inputTokens: 1, outputTokens: 1, model: 'm', provider: 'openai_compat', durationMs: 1 }) };
  },
  // The vision-fallback helper imports hasCredentials too; return false so no
  // Anthropic step is added (the primary MiniCPM attempt succeeds first).
  hasCredentials: () => false,
}));

import { processReceipt } from './ai-receipt-ocr.service.js';

describe('self-hosted OCR model default', () => {
  it('passes OCR_VISION_MODEL (minicpm-v4.5:latest) to getProvider when ocrModel is blank', async () => {
    mocks.getProvider.mockClear();
    await processReceipt('t1', 'a1');
    expect(mocks.getProvider).toHaveBeenCalled();
    const [, , model] = mocks.getProvider.mock.calls[0]!;
    expect(model).toBe('minicpm-v4.5:latest');
  });
});
