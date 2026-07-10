// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// testProvider must test the TRUTH: the model(s) the provider is actually
// configured to run (the *_model column of every function assigned to it),
// not the provider's hardcoded default. Separate file from
// ai-config.service.test.ts because this one mocks ai-providers/index.js
// module-wide while that file exercises the real providers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db/index.js';
import { aiConfig } from '../db/schema/index.js';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
}));

vi.mock('./ai-providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai-providers/index.js')>();
  return {
    ...actual,
    getProvider: (...args: Parameters<typeof actual.getProvider>) => mocks.getProvider(...args),
  };
});

import * as aiConfigService from './ai-config.service.js';

describe('aiConfigService.testProvider — uses the configured task model', () => {
  beforeEach(async () => {
    await db.delete(aiConfig);
    mocks.getProvider.mockReset();
    mocks.getProvider.mockReturnValue({
      testConnection: vi.fn(async () => ({ success: true, modelInfo: 'pong' })),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(aiConfig);
  });

  it('passes the model configured for the function assigned to this provider', async () => {
    await aiConfigService.updateConfig({
      categorizationProvider: 'anthropic',
      categorizationModel: 'claude-configured-model',
      anthropicApiKey: 'sk-test',
    });

    const result = await aiConfigService.testProvider('anthropic');

    expect(result.success).toBe(true);
    expect(mocks.getProvider).toHaveBeenCalledTimes(1);
    const [providerName, , model] = mocks.getProvider.mock.calls[0]!;
    expect(providerName).toBe('anthropic');
    expect(model).toBe('claude-configured-model');
  });

  it('tests the first configured model and mentions the other distinct ones', async () => {
    await aiConfigService.updateConfig({
      categorizationProvider: 'anthropic',
      categorizationModel: 'claude-cat-model',
      ocrProvider: 'anthropic',
      ocrModel: 'claude-ocr-model',
      anthropicApiKey: 'sk-test',
    });

    const result = await aiConfigService.testProvider('anthropic');

    const [, , model] = mocks.getProvider.mock.calls[0]!;
    expect(model).toBe('claude-cat-model');
    expect(result.modelInfo).toContain('claude-ocr-model');
    expect(result.modelInfo).toContain('also configured');
  });

  it('keeps the provider default (model undefined) when no function is assigned to it', async () => {
    await aiConfigService.updateConfig({
      categorizationProvider: 'ollama',
      categorizationModel: 'llama3.2',
      ollamaBaseUrl: 'http://stub-host:11434',
      anthropicApiKey: 'sk-test',
    });

    await aiConfigService.testProvider('anthropic');

    const [providerName, , model] = mocks.getProvider.mock.calls[0]!;
    expect(providerName).toBe('anthropic');
    expect(model).toBeUndefined();
  });

  it('does not attribute a model to the wrong provider', async () => {
    await aiConfigService.updateConfig({
      categorizationProvider: 'openai',
      categorizationModel: 'gpt-cat-model',
      chatProvider: 'anthropic',
      chatModel: 'claude-chat-model',
      openaiApiKey: 'sk-openai',
      anthropicApiKey: 'sk-anthropic',
    });

    await aiConfigService.testProvider('anthropic');
    let [, , model] = mocks.getProvider.mock.calls[0]!;
    expect(model).toBe('claude-chat-model');

    mocks.getProvider.mockClear();
    await aiConfigService.testProvider('openai');
    [, , model] = mocks.getProvider.mock.calls[0]!;
    expect(model).toBe('gpt-cat-model');
  });
});
