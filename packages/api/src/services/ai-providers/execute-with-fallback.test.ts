// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// First-ever coverage for the executeWithFallback orchestration path:
//   - a stale preferred-model override retries the SAME provider on its
//     default model before walking the fallback chain
//   - every attempt is recorded distinctly in providerErrors
//   - the chain skips the already-tried preferred provider
//   - no-credentials providers are recorded, not silently skipped
//   - the terminal ai_all_providers_failed error is console.warn-logged
//
// Provider classes are mocked at module level; errors carry status 404 so
// retryWithBackoff's don't-retry-4xx rule keeps the test fast (no backoff).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  anthropic: vi.fn<(model: string) => Promise<unknown>>(),
  openai: vi.fn<(model: string) => Promise<unknown>>(),
  gemini: vi.fn<(model: string) => Promise<unknown>>(),
  ollama: vi.fn<(model: string) => Promise<unknown>>(),
}));

vi.mock('../../utils/encryption.js', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
}));

vi.mock('./anthropic.provider.js', () => ({
  AnthropicProvider: class {
    name = 'anthropic';
    private model: string;
    constructor(_apiKey: string, model: string = 'claude-default') { this.model = model; }
    complete() { return mocks.anthropic(this.model); }
  },
}));
vi.mock('./openai.provider.js', () => ({
  OpenAiProvider: class {
    name = 'openai';
    private model: string;
    constructor(_apiKey: string, model: string = 'gpt-default') { this.model = model; }
    complete() { return mocks.openai(this.model); }
  },
}));
vi.mock('./gemini.provider.js', () => ({
  GeminiProvider: class {
    name = 'gemini';
    private model: string;
    constructor(_apiKey: string, model: string = 'gemini-default') { this.model = model; }
    complete() { return mocks.gemini(this.model); }
  },
}));
vi.mock('./ollama.provider.js', () => ({
  OllamaProvider: class {
    name = 'ollama';
    private model: string;
    constructor(_baseUrl?: string, model: string = 'llama-default') { this.model = model; }
    complete() { return mocks.ollama(this.model); }
  },
}));

import { executeWithFallback } from './index.js';

interface AggregateError extends Error {
  code?: string;
  providerErrors?: string[];
}

function ok(provider: string, model: string) {
  return Promise.resolve({
    text: '{"ok":true}', parsed: { ok: true },
    inputTokens: 1, outputTokens: 1, model, provider, durationMs: 1,
  });
}

// status 404 → retryWithBackoff throws immediately (4xx, non-429).
function err404(msg: string): Error & { status?: number } {
  const e: Error & { status?: number } = new Error(msg);
  e.status = 404;
  return e;
}

const PARAMS = { systemPrompt: 's', userPrompt: 'u' };
// anthropic + openai have credentials; gemini deliberately does NOT.
const CONFIG = {
  anthropicApiKeyEncrypted: 'k-anthropic',
  openaiApiKeyEncrypted: 'k-openai',
  geminiApiKeyEncrypted: null,
};

async function settle(p: Promise<unknown>): Promise<AggregateError> {
  try {
    await p;
    throw new Error('expected executeWithFallback to reject');
  } catch (err) {
    return err as AggregateError;
  }
}

describe('executeWithFallback', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.anthropic.mockReset();
    mocks.openai.mockReset();
    mocks.gemini.mockReset();
    mocks.ollama.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('retries the preferred provider on its DEFAULT model when the model override fails', async () => {
    mocks.anthropic.mockImplementation((model) =>
      model === 'stale-model' ? Promise.reject(err404(`model '${model}' was not found`)) : ok('anthropic', model),
    );

    const result = await executeWithFallback(PARAMS, CONFIG, ['anthropic', 'openai'], 'anthropic', 'stale-model');

    expect(result.provider).toBe('anthropic');
    expect(mocks.anthropic).toHaveBeenCalledTimes(2);
    expect(mocks.anthropic.mock.calls[0]![0]).toBe('stale-model');
    expect(mocks.anthropic.mock.calls[1]![0]).toBe('claude-default');
    // The healthy default-model retry succeeded — the chain is never walked.
    expect(mocks.openai).not.toHaveBeenCalled();
  });

  it('does NOT retry on the default model when no model override was supplied', async () => {
    mocks.anthropic.mockRejectedValue(err404('anthropic down'));
    mocks.openai.mockImplementation((model) => ok('openai', model));

    const result = await executeWithFallback(PARAMS, CONFIG, ['anthropic', 'openai'], 'anthropic');

    expect(result.provider).toBe('openai');
    expect(mocks.anthropic).toHaveBeenCalledTimes(1);
  });

  it('records every attempt distinctly and skips the preferred provider in the chain', async () => {
    mocks.anthropic.mockRejectedValue(err404('boom-anthropic'));
    mocks.openai.mockRejectedValue(err404('boom-openai'));

    const err = await settle(
      executeWithFallback(PARAMS, CONFIG, ['anthropic', 'openai', 'gemini'], 'anthropic', 'stale-model'),
    );

    expect(err.code).toBe('ai_all_providers_failed');
    const errors = err.providerErrors ?? [];
    // Model-override attempt and default-model retry are labelled apart.
    expect(errors).toContain('anthropic (model stale-model): boom-anthropic');
    expect(errors).toContain('anthropic (default model): boom-anthropic');
    expect(errors).toContain('openai: boom-openai');
    // Preferred provider is not attempted a third time by the chain loop:
    // exactly the two preferred-path attempts.
    expect(mocks.anthropic).toHaveBeenCalledTimes(2);
    // gemini never had credentials — recorded, not silently skipped.
    expect(errors).toContain('gemini: no credentials configured');
    expect(mocks.gemini).not.toHaveBeenCalled();
  });

  it('console.warns the joined per-provider detail before throwing ai_all_providers_failed', async () => {
    mocks.anthropic.mockRejectedValue(err404('boom-anthropic'));
    mocks.openai.mockRejectedValue(err404('boom-openai'));

    await settle(executeWithFallback(PARAMS, CONFIG, ['anthropic', 'openai'], 'anthropic'));

    const warnCall = warnSpy.mock.calls.find((c) => String(c[0]).includes('[ai] all providers failed:'));
    expect(warnCall).toBeDefined();
    expect(String(warnCall![1])).toContain('anthropic: boom-anthropic');
    expect(String(warnCall![1])).toContain('openai: boom-openai');
  });

  it('records a preferred provider with no credentials and falls through to the chain', async () => {
    const config = { ...CONFIG, anthropicApiKeyEncrypted: null };
    mocks.openai.mockImplementation((model) => ok('openai', model));

    const result = await executeWithFallback(PARAMS, config, ['anthropic', 'openai'], 'anthropic', 'stale-model');

    expect(result.provider).toBe('openai');
    expect(mocks.anthropic).not.toHaveBeenCalled();
  });

  it('propagates the message aggregate on the thrown error', async () => {
    mocks.anthropic.mockRejectedValue(err404('boom'));

    const err = await settle(executeWithFallback(PARAMS, CONFIG, ['anthropic'], 'anthropic'));

    expect(err.message).toContain('All AI providers failed.');
    expect(err.message).toContain('anthropic: boom');
  });
});
