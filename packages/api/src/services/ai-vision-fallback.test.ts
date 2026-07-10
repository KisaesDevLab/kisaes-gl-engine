// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The OCR vision fallback chain: MiniCPM (primary) → qwen3.5 (local) →
// Anthropic (cloud, gated on cloud-vision). An attempt fails over on a thrown
// error OR a CompletionResult with parseError.

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  hasCredentials: vi.fn(),
  assertCloudVisionAllowed: vi.fn(),
}));

vi.mock('./ai-providers/index.js', () => ({
  getProvider: (...a: unknown[]) => mocks.getProvider(...a),
  hasCredentials: (...a: unknown[]) => mocks.hasCredentials(...a),
}));
vi.mock('./ai-orchestrator.service.js', () => ({
  assertCloudVisionAllowed: (...a: unknown[]) => mocks.assertCloudVisionAllowed(...a),
}));

import { completeVisionWithFallback } from './ai-vision-fallback.js';

const PARAMS = {
  systemPrompt: 'sys',
  userPrompt: 'extract',
  images: [{ base64: 'QUJD', mimeType: 'image/png' }],
  responseFormat: 'json' as const,
};
const CTX = { rawConfig: {} as never, ocrProvider: 'openai_compat', primaryModel: 'minicpm-v4.5:latest', task: 'ocr_receipt' };

// A provider whose completeWithImage resolves to a given result, or rejects.
function provider(result: unknown, opts?: { throws?: boolean }) {
  return {
    completeWithImage: vi.fn(async () => {
      if (opts?.throws) throw new Error('model unavailable');
      return result;
    }),
  };
}
const ok = (model: string) => ({ text: '{"x":1}', parsed: { x: 1 }, parseError: undefined, model, provider: 'p', inputTokens: 1, outputTokens: 1, durationMs: 1 });
const bad = (model: string) => ({ text: '', parsed: undefined, parseError: 'empty', model, provider: 'p', inputTokens: 1, outputTokens: 1, durationMs: 1 });

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.hasCredentials.mockReturnValue(false);
  mocks.assertCloudVisionAllowed.mockResolvedValue(undefined);
});

describe('completeVisionWithFallback', () => {
  it('returns the primary (MiniCPM) result without trying fallbacks', async () => {
    mocks.getProvider.mockReturnValueOnce(provider(ok('minicpm-v4.5:latest')));
    const res = await completeVisionWithFallback(PARAMS, CTX);
    expect(res.model).toBe('minicpm-v4.5:latest');
    expect(mocks.getProvider).toHaveBeenCalledTimes(1);
  });

  it('falls back to qwen (local) when the primary throws', async () => {
    mocks.getProvider
      .mockReturnValueOnce(provider(null, { throws: true })) // minicpm
      .mockReturnValueOnce(provider(ok('qwen3.5:35b-a3b'))); // qwen
    const res = await completeVisionWithFallback(PARAMS, CTX);
    expect(res.model).toBe('qwen3.5:35b-a3b');
    expect(mocks.getProvider).toHaveBeenNthCalledWith(2, 'openai_compat', expect.anything(), 'qwen3.5:35b-a3b');
  });

  it('falls back to qwen when the primary returns an unparseable result', async () => {
    mocks.getProvider
      .mockReturnValueOnce(provider(bad('minicpm-v4.5:latest')))
      .mockReturnValueOnce(provider(ok('qwen3.5:35b-a3b')));
    const res = await completeVisionWithFallback(PARAMS, CTX);
    expect(res.model).toBe('qwen3.5:35b-a3b');
  });

  it('falls back to Anthropic when both local fail AND cloud vision is allowed', async () => {
    mocks.hasCredentials.mockReturnValue(true);
    mocks.assertCloudVisionAllowed.mockResolvedValue(undefined);
    mocks.getProvider
      .mockReturnValueOnce(provider(bad('minicpm-v4.5:latest'))) // minicpm
      .mockReturnValueOnce(provider(bad('qwen3.5:35b-a3b'))) // qwen
      .mockReturnValueOnce(provider(ok('claude'))); // anthropic
    const res = await completeVisionWithFallback(PARAMS, CTX);
    expect(res.model).toBe('claude');
    expect(mocks.getProvider).toHaveBeenNthCalledWith(3, 'anthropic', expect.anything());
  });

  it('never attempts Anthropic when cloud vision is blocked (stays local)', async () => {
    mocks.hasCredentials.mockReturnValue(true);
    mocks.assertCloudVisionAllowed.mockRejectedValue(new Error('cloud vision disabled'));
    mocks.getProvider
      .mockReturnValueOnce(provider(bad('minicpm-v4.5:latest')))
      .mockReturnValueOnce(provider(bad('qwen3.5:35b-a3b')));
    const res = await completeVisionWithFallback(PARAMS, CTX);
    // Returns the last (unparseable) result so the caller surfaces ai_parse_failed.
    expect(res.parseError).toBe('empty');
    // Only the two local providers were built — no anthropic.
    expect(mocks.getProvider).toHaveBeenCalledTimes(2);
  });

  it('never attempts Anthropic when no Anthropic credentials exist', async () => {
    mocks.hasCredentials.mockReturnValue(false);
    mocks.getProvider
      .mockReturnValueOnce(provider(bad('minicpm-v4.5:latest')))
      .mockReturnValueOnce(provider(bad('qwen3.5:35b-a3b')));
    await completeVisionWithFallback(PARAMS, CTX);
    expect(mocks.assertCloudVisionAllowed).not.toHaveBeenCalled();
    expect(mocks.getProvider).toHaveBeenCalledTimes(2);
  });

  it('skips the qwen step when OCR_FALLBACK_MODEL equals the primary tag', async () => {
    mocks.getProvider.mockReturnValueOnce(provider(bad('qwen3.5:35b-a3b')));
    // primaryModel == qwen tag → local fallback is skipped (only 1 local attempt)
    const res = await completeVisionWithFallback(PARAMS, { ...CTX, primaryModel: 'qwen3.5:35b-a3b' });
    expect(res.parseError).toBe('empty');
    expect(mocks.getProvider).toHaveBeenCalledTimes(1);
  });
});
