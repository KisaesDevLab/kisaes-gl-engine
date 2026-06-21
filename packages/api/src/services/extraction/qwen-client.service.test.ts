// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../utils/errors.js';

// Fully mock the AI stack so this is a deterministic, network-free unit test
// of the wrapper's contract: it must build a temperature-0 JSON vision call,
// enforce the privacy gate BEFORE any image is sent, and surface a clear
// AppError when the local endpoint isn't configured.

const mocks = vi.hoisted(() => ({
  getRawConfig: vi.fn(),
  assertCloudVisionAllowed: vi.fn(),
  getProvider: vi.fn(),
  hasCredentials: vi.fn(),
  completeWithImage: vi.fn(),
  testConnection: vi.fn(),
  ollamaCtor: vi.fn(),
}));

vi.mock('../ai-config.service.js', () => ({
  getRawConfig: (...a: unknown[]) => mocks.getRawConfig(...a),
}));

vi.mock('../ai-orchestrator.service.js', () => ({
  assertCloudVisionAllowed: (...a: unknown[]) => mocks.assertCloudVisionAllowed(...a),
}));

vi.mock('../ai-providers/index.js', () => ({
  getProvider: (...a: unknown[]) => mocks.getProvider(...a),
  hasCredentials: (...a: unknown[]) => mocks.hasCredentials(...a),
}));

// EXTRACTION_OLLAMA_NATIVE defaults on, so the wrapper constructs a native
// OllamaProvider — mock the class so it delegates to the same fakes and so we
// can assert the base URL (with /v1 stripped) it was built with.
vi.mock('../ai-providers/ollama.provider.js', () => ({
  OllamaProvider: class {
    name = 'ollama';
    supportsVision = true;
    constructor(baseUrl: string, model: string) {
      mocks.ollamaCtor(baseUrl, model);
    }
    completeWithImage(...a: unknown[]) {
      return mocks.completeWithImage(...a);
    }
    testConnection(...a: unknown[]) {
      return mocks.testConnection(...a);
    }
  },
}));

import { extractImage, healthCheck } from './qwen-client.service.js';

const fakeProvider = {
  name: 'openai_compat',
  supportsVision: true,
  completeWithImage: (...a: unknown[]) => mocks.completeWithImage(...a),
  testConnection: (...a: unknown[]) => mocks.testConnection(...a),
};

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getRawConfig.mockResolvedValue({ openaiCompatBaseUrl: 'http://ollama:11434', openaiCompatModel: null });
  mocks.assertCloudVisionAllowed.mockResolvedValue(undefined);
  mocks.hasCredentials.mockReturnValue(true);
  mocks.getProvider.mockReturnValue(fakeProvider);
});

describe('qwen-client.extractImage', () => {
  it('sends a temperature-0 JSON vision call and returns raw + parsed', async () => {
    mocks.completeWithImage.mockResolvedValue({
      text: '{"page_confidence":0.9,"transactions":[]}',
      parsed: { page_confidence: 0.9, transactions: [] },
      parseError: undefined,
      model: 'qwen3.5:35b-a3b',
      durationMs: 1234,
    });

    const out = await extractImage({
      base64: 'QUJD',
      mimeType: 'image/png',
      systemPrompt: 'sys',
      userPrompt: 'extract',
    });

    expect(out.parsed).toEqual({ page_confidence: 0.9, transactions: [] });
    expect(out.model).toBe('qwen3.5:35b-a3b');

    const callArgs = mocks.completeWithImage.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['temperature']).toBe(0);
    expect(callArgs['responseFormat']).toBe('json');
    expect(callArgs['images']).toEqual([{ base64: 'QUJD', mimeType: 'image/png' }]);
  });

  it('routes through the native Ollama endpoint (strips /v1) with num_ctx + thinking', async () => {
    mocks.getRawConfig.mockResolvedValue({ openaiCompatBaseUrl: 'http://ollama:11434/v1', openaiCompatModel: null });
    mocks.completeWithImage.mockResolvedValue({
      text: '{}', parsed: {}, parseError: undefined, model: 'qwen3.5:35b-a3b', durationMs: 1,
    });

    await extractImage({ base64: 'QUJD', mimeType: 'image/png', systemPrompt: 'sys', userPrompt: 'extract' });

    // Native provider built from the base URL with the trailing /v1 removed.
    expect(mocks.ollamaCtor).toHaveBeenCalledWith('http://ollama:11434', 'qwen3.5:35b-a3b');
    // openai_compat factory NOT used on the native path.
    expect(mocks.getProvider).not.toHaveBeenCalled();
    const callArgs = mocks.completeWithImage.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['numCtx']).toBeGreaterThan(0);
    expect(callArgs['thinking']).toBeDefined();
    expect(callArgs['maxTokens']).toBeGreaterThanOrEqual(4096);
  });

  it('throws an actionable AppError when the endpoint is not configured', async () => {
    mocks.hasCredentials.mockReturnValue(false);
    await expect(
      extractImage({ base64: 'x', mimeType: 'image/png', systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(mocks.completeWithImage).not.toHaveBeenCalled();
  });

  it('enforces the privacy gate before any image is sent', async () => {
    mocks.assertCloudVisionAllowed.mockRejectedValue(AppError.badRequest('Cloud vision is disabled'));
    await expect(
      extractImage({ base64: 'x', mimeType: 'image/png', systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toBeInstanceOf(AppError);
    // The image must never reach the provider when the gate refuses.
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.completeWithImage).not.toHaveBeenCalled();
  });
});

describe('qwen-client.healthCheck', () => {
  it('reports not-ok with a clear error when no base URL is configured', async () => {
    mocks.getRawConfig.mockResolvedValue({ openaiCompatBaseUrl: null, openaiCompatModel: null });
    const res = await healthCheck();
    expect(res.ok).toBe(false);
    expect(res.baseUrl).toBeNull();
    expect(res.error).toMatch(/not configured/i);
    expect(mocks.testConnection).not.toHaveBeenCalled();
  });

  it('surfaces the provider testConnection result', async () => {
    mocks.testConnection.mockResolvedValue({ success: true, modelInfo: 'qwen3.5 available' });
    const res = await healthCheck();
    expect(res.ok).toBe(true);
    expect(res.modelInfo).toBe('qwen3.5 available');
    expect(res.baseUrl).toBe('http://ollama:11434');
  });
});
