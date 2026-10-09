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
    // global table — no tenant column; suites share it by design
    await db.delete(aiConfig);
    mocks.getProvider.mockReset();
    mocks.getProvider.mockReturnValue({
      testConnection: vi.fn(async () => ({ success: true, modelInfo: 'pong' })),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    // global table — no tenant column; suites share it by design
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

describe('aiConfigService.testAll — each task is tested with its own model', () => {
  beforeEach(async () => {
    await db.delete(aiConfig);
    mocks.getProvider.mockReset();
    mocks.getProvider.mockImplementation((_name: string, _cfg: unknown, model?: string) => ({
      testConnection: vi.fn(async () => ({ success: true, modelInfo: model ?? 'provider-default' })),
    }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(aiConfig);
  });

  it('reports categorization on Haiku and OCR on Sonnet instead of copying one model to every row', async () => {
    await aiConfigService.updateConfig({
      categorizationProvider: 'anthropic', categorizationModel: 'claude-haiku-5-5',
      ocrProvider: 'anthropic', ocrModel: 'claude-sonnet-5-5',
      chatProvider: 'anthropic', chatModel: 'claude-sonnet-5-5',
      anthropicApiKey: 'sk-test',
    });
    const { rows } = await aiConfigService.testAll();
    const info = Object.fromEntries(rows.map((r) => [r.task, r.modelInfo]));
    expect(info['categorization']).toBe('claude-haiku-5-5');
    expect(info['ocr']).toBe('claude-sonnet-5-5');
    expect(info['chat']).toBe('claude-sonnet-5-5');
    // No model of its own → the provider default, not another task's model.
    expect(info['document_classification']).toBe('provider-default');
    expect(rows.every((r) => !String(r.modelInfo).includes('untested'))).toBe(true);
    // Haiku, Sonnet (shared by OCR + chat) and the default: three pings.
    expect(mocks.getProvider).toHaveBeenCalledTimes(3);
  });
});
