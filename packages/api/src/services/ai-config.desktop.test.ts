// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// ai-config.service in desktop mode (E6): key fields are refused with 400
// DESKTOP_KEYS_NOT_STORED, provider choices are limited to the allowlist,
// `has*Key` and `fallbackChain` reflect the session store. Uses the shared
// test database (ai_config is a global table).

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { db } from '../db/index.js';
import { aiConfig } from '../db/schema/index.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import * as secrets from '../desktop/session-secrets.js';
import * as aiConfigService from './ai-config.service.js';

const TOKEN = 'cfgtest_' + 'c'.repeat(40);
const KEY = 'sk-ant-api03-cfg-' + 'K'.repeat(40);

beforeEach(async () => {
  await db.delete(aiConfig);
  secrets.clearAllSessionSecrets();
  loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-cfg-test') });
});

afterEach(() => {
  secrets.clearAllSessionSecrets();
  _resetDesktopProfileForTests();
});

afterAll(async () => {
  await db.delete(aiConfig);
});

describe('updateConfig in desktop mode', () => {
  it.each([
    ['anthropicApiKey', KEY],
    ['openaiApiKey', 'sk-' + 'o'.repeat(40)],
    ['geminiApiKey', 'AIza' + 'g'.repeat(35)],
    ['openaiCompatApiKey', 'compat-key-1234'],
    ['digitaloceanApiKey', 'do-key-1234'],
    ['glmOcrApiKey', 'glm-key-1234'],
    ['routerToken', 'router-token-1234'],
    ['anthropicApiKey', null],
  ])('refuses %s (%s) with 400 DESKTOP_KEYS_NOT_STORED and stores nothing', async (field, value) => {
    await expect(aiConfigService.updateConfig({ [field]: value, categorizationProvider: 'anthropic' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'DESKTOP_KEYS_NOT_STORED' });
    const rows = await db.select().from(aiConfig);
    expect(rows.every((r) => !r.anthropicApiKeyEncrypted && !r.openaiApiKeyEncrypted && !r.geminiApiKeyEncrypted
      && !r.openaiCompatApiKeyEncrypted && !r.digitaloceanApiKeyEncrypted && !r.glmOcrApiKeyEncrypted && !r.routerTokenEncrypted)).toBe(true);
    expect(rows.every((r) => r.categorizationProvider !== 'anthropic')).toBe(true);
  });

  it("'' is the no-change sentinel and still passes", async () => {
    const cfg = await aiConfigService.updateConfig({ anthropicApiKey: '', openaiApiKey: '', categorizationProvider: 'anthropic', categorizationModel: 'claude-x' });
    expect(cfg.categorizationProvider).toBe('anthropic');
    expect(cfg.hasAnthropicKey).toBe(false);
  });

  it.each([
    [{ categorizationProvider: 'gemini' }],
    [{ ocrProvider: 'openai_compat' }],
    [{ documentClassificationProvider: 'digitalocean' }],
    [{ chatProvider: 'gemini' }],
    [{ fallbackChain: ['anthropic', 'gemini'] }],
    [{ taskOptions: { categorization: { provider: 'gemini' } } }],
    [{ taskOptions: { ocr: { fallbackChain: ['openai_compat'] } } }],
  ])('refuses a provider outside the allowlist: %o', async (input) => {
    await expect(aiConfigService.updateConfig(input as Parameters<typeof aiConfigService.updateConfig>[0]))
      .rejects.toMatchObject({ statusCode: 400, code: 'AI_PROVIDER_NOT_AVAILABLE' });
  });

  it('refuses a public Ollama base URL (OLLAMA_HOST_NOT_LOCAL) and link-local ones; accepts local-network ones', async () => {
    await expect(aiConfigService.updateConfig({ ollamaBaseUrl: 'https://ollama.example.com' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'OLLAMA_HOST_NOT_LOCAL' });
    await expect(aiConfigService.updateConfig({ ollamaBaseUrl: 'http://169.254.169.254:11434' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'OLLAMA_URL_INVALID' });
    expect((await aiConfigService.updateConfig({ ollamaBaseUrl: 'http://192.168.1.20:11434' })).ollamaBaseUrl).toBe('http://192.168.1.20:11434');
    expect((await aiConfigService.updateConfig({ ollamaBaseUrl: '' })).ollamaBaseUrl).toBeNull();
  });

  it('accepts the allowlisted providers and the non-secret fields', async () => {
    const cfg = await aiConfigService.updateConfig({
      categorizationProvider: 'anthropic', ocrProvider: 'ollama', chatProvider: null,
      fallbackChain: ['anthropic', 'openai', 'ollama'], ollamaBaseUrl: 'http://localhost:11434',
      monthlyBudgetLimit: 5, trackUsage: true, piiProtectionLevel: 'strict',
      taskOptions: { categorization: { provider: 'openai', fallbackChain: ['ollama'] } },
    });
    expect(cfg.ocrProvider).toBe('ollama');
    expect(cfg.fallbackChain).toEqual(['anthropic', 'openai', 'ollama']);
  });
});

describe('getConfig in desktop mode', () => {
  it('has*Key follows the session store, the default chain drops gemini, and the stored columns are ignored', async () => {
    // A row with stored keys (e.g. a database that was once used by the server).
    const { encrypt } = await import('../utils/encryption.js');
    await db.insert(aiConfig).values({
      anthropicApiKeyEncrypted: encrypt('sk-ant-stale'), geminiApiKeyEncrypted: encrypt('AIza-stale'),
      piiProtectionLevel: 'strict', cloudVisionEnabled: false, disclosureVersion: 1,
    });
    let cfg = await aiConfigService.getConfig();
    expect(cfg.hasAnthropicKey).toBe(false);
    expect(cfg.hasGeminiKey).toBe(false);
    expect(cfg.hasOpenaiKey).toBe(false);
    expect(cfg.fallbackChain).toEqual(['anthropic', 'openai', 'ollama']);

    secrets.setAnthropicKey(KEY);
    cfg = await aiConfigService.getConfig();
    expect(cfg.hasAnthropicKey).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain(KEY);

    secrets.deleteSessionSecret('ai.anthropic');
    expect((await aiConfigService.getConfig()).hasAnthropicKey).toBe(false);
  });

  it('testProvider and listProviderModels answer 400 AI_PROVIDER_NOT_AVAILABLE for an unlisted provider', async () => {
    await expect(aiConfigService.testProvider('gemini')).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_AVAILABLE' });
    await expect(aiConfigService.listProviderModels('digitalocean')).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_AVAILABLE' });
    // An allowlisted provider without a session key is a normal failed test, not a 400.
    const r = await aiConfigService.testProvider('anthropic');
    expect(r).toEqual({ success: false, error: 'Anthropic API key not configured' });
  });
});
