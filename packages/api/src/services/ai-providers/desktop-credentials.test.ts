// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Desktop credential resolution and provider allowlist (E6, U-09/U-11,
// Q-33). No database: the profile is switched in-process and the session
// store is driven directly. The last block checks the server path is the
// stored-column behaviour, unchanged.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../../desktop/profile.js';
import * as secrets from '../../desktop/session-secrets.js';
import { _resetSecretScrubberForTests } from '../../utils/secret-scrubber.js';
import { encrypt } from '../../utils/encryption.js';
import {
  resolveCredential, hasCredentials, getProvider, desktopFallbackChain, assertDesktopProvider, executeWithFallback,
} from './index.js';
import { OllamaProvider } from './ollama.provider.js';
import { AnthropicProvider } from './anthropic.provider.js';

const TOKEN = 'credtest_' + 'c'.repeat(40);
const SESSION_KEY = 'sk-ant-api03-session-' + 'S'.repeat(40);
const STORED = { anthropicApiKeyEncrypted: encrypt('sk-ant-stored-' + 'D'.repeat(30)), openaiApiKeyEncrypted: encrypt('sk-stored-openai-' + 'E'.repeat(30)), geminiApiKeyEncrypted: encrypt('AIza' + 'G'.repeat(35)), ollamaBaseUrl: 'http://10.0.0.9:11434' };

function desktop(): void {
  loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-cred-test') });
}

beforeEach(() => {
  secrets.clearAllSessionSecrets();
  _resetSecretScrubberForTests();
});

afterEach(() => {
  secrets.clearAllSessionSecrets();
  _resetDesktopProfileForTests();
});

describe('desktop mode', () => {
  beforeEach(desktop);

  it('ignores stored key columns: no session key means no credential', () => {
    expect(resolveCredential('anthropic', STORED)).toBeNull();
    expect(resolveCredential('openai', STORED)).toBeNull();
    expect(hasCredentials('anthropic', STORED)).toBe(false);
    expect(hasCredentials('openai', STORED)).toBe(false);
    expect(() => getProvider('anthropic', STORED)).toThrow(/Anthropic API key not configured/);
  });

  it('uses the session key and never the stored one', () => {
    secrets.setAnthropicKey(SESSION_KEY);
    expect(resolveCredential('anthropic', STORED)).toEqual({ apiKey: SESSION_KEY });
    expect(hasCredentials('anthropic', STORED)).toBe(true);
    const p = getProvider('anthropic', STORED, 'claude-x');
    // Wrapped for the offline fast-fail; the inner adapter is Anthropic.
    expect(p.name).toBe('anthropic');
    expect(resolveCredential('anthropic', {})).toEqual({ apiKey: SESSION_KEY });
  });

  it('Ollama needs no key; the session endpoint and model win over the stored base URL', () => {
    expect(hasCredentials('ollama', {})).toBe(true);
    expect(resolveCredential('ollama', STORED)).toEqual({ baseUrl: 'http://10.0.0.9:11434', model: undefined });
    secrets.setOllamaBaseUrl('http://localhost:11434', 'qwen3');
    expect(resolveCredential('ollama', STORED)).toEqual({ baseUrl: 'http://localhost:11434', model: 'qwen3' });
    const p = getProvider('ollama', STORED);
    expect(p).toBeInstanceOf(OllamaProvider);
    expect((p as unknown as { baseUrl: string; model: string }).baseUrl).toBe('http://localhost:11434');
    expect((p as unknown as { model: string }).model).toBe('qwen3');
    // A caller's explicit model still wins.
    expect((getProvider('ollama', STORED, 'llava') as unknown as { model: string }).model).toBe('llava');
  });

  it.each(['gemini', 'openai_compat', 'digitalocean', 'vibe_router', 'nope'])('%s is not available', (name) => {
    expect(resolveCredential(name, { ...STORED, openaiCompatBaseUrl: 'http://localhost:11434/v1', digitaloceanApiKeyEncrypted: encrypt('do-' + 'x'.repeat(20)) })).toBeNull();
    expect(hasCredentials(name, STORED)).toBe(false);
    expect(() => assertDesktopProvider(name)).toThrow(expect.objectContaining({ code: 'AI_PROVIDER_NOT_AVAILABLE', statusCode: 400 }));
    expect(() => getProvider(name, STORED)).toThrow(expect.objectContaining({ code: 'AI_PROVIDER_NOT_AVAILABLE' }));
  });

  it('filters the fallback chain to the allowlist', () => {
    expect(desktopFallbackChain(['anthropic', 'openai', 'gemini', 'ollama', 'openai_compat'])).toEqual(['anthropic', 'openai', 'ollama']);
  });

  it('executeWithFallback never touches an unlisted provider and names it in the aggregate error', async () => {
    await expect(
      executeWithFallback({ systemPrompt: 's', userPrompt: 'u' }, STORED, ['gemini', 'digitalocean', 'openai'], 'gemini'),
    ).rejects.toMatchObject({
      code: 'ai_all_providers_failed',
      providerErrors: ['gemini: not available in the desktop edition (AI_PROVIDER_NOT_AVAILABLE)', 'openai: no credentials configured'],
    });
  });
});

describe('server mode (unchanged)', () => {
  it('reads the stored, encrypted columns and keeps every provider', () => {
    expect(resolveCredential('anthropic', STORED)).toEqual({ apiKey: 'sk-ant-stored-' + 'D'.repeat(30) });
    expect(resolveCredential('gemini', STORED)).toEqual({ apiKey: 'AIza' + 'G'.repeat(35) });
    expect(resolveCredential('anthropic', {})).toBeNull();
    expect(resolveCredential('ollama', STORED)).toEqual({ baseUrl: 'http://10.0.0.9:11434' });
    expect(resolveCredential('openai_compat', { openaiCompatBaseUrl: 'http://box:8000/v1', openaiCompatModel: 'm' })).toEqual({ baseUrl: 'http://box:8000/v1', model: 'm', apiKey: undefined });
    expect(hasCredentials('gemini', STORED)).toBe(true);
    expect(hasCredentials('openai_compat', {})).toBe(false);
    expect(getProvider('anthropic', STORED)).toBeInstanceOf(AnthropicProvider);
    expect(desktopFallbackChain(['anthropic', 'gemini', 'ollama'])).toEqual(['anthropic', 'gemini', 'ollama']);
    expect(() => assertDesktopProvider('gemini')).not.toThrow();
    // A session key set by mistake on the server is ignored.
    secrets.setAnthropicKey(SESSION_KEY);
    expect(resolveCredential('anthropic', {})).toBeNull();
  });
});
