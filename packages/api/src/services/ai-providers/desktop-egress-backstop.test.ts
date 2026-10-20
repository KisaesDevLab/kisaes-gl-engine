// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// E6 step 40: in desktop mode every cloud call passes the strict PII
// sanitizer backstop, and a provider error that echoes the session key is
// scrubbed before it reaches the caller or the warn log. The Anthropic SDK
// is mocked; no network. The last block checks the server path is untouched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  apiKeys: [] as string[],
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    messages = { create: mocks.create, stream: vi.fn() };
    models = { list: vi.fn(async () => ({ data: [] })) };
    constructor(opts: { apiKey: string }) {
      mocks.apiKeys.push(opts.apiKey);
    }
  },
}));

import { loadDesktopProfile, _resetDesktopProfileForTests } from '../../desktop/profile.js';
import * as secrets from '../../desktop/session-secrets.js';
import { _resetSecretScrubberForTests } from '../../utils/secret-scrubber.js';
import { getProvider, executeWithFallback } from './index.js';

const TOKEN = 'egresstest_' + 'e'.repeat(40);
const KEY = 'sk-ant-api03-canary-' + 'Z'.repeat(40);
const PII = 'Pay ACME from routing 021000021 account 123456789012, card 4111 1111 1111 1111, SSN 123-45-6789, call 555-123-4567';

function okResponse(text = '{"ok":true}') {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } };
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.apiKeys.length = 0;
  _resetSecretScrubberForTests();
  secrets.clearAllSessionSecrets();
});

afterEach(() => {
  secrets.clearAllSessionSecrets();
  _resetDesktopProfileForTests();
  vi.restoreAllMocks();
});

describe('desktop cloud calls', () => {
  beforeEach(() => {
    // CL_OFFLINE=off: no connectivity probe, so the mocked SDK is reached directly.
    loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-egress-test'), CL_OFFLINE: 'off' });
    secrets.setAnthropicKey(KEY);
  });

  it('builds the SDK client from the session key and applies the strict backstop to both prompts', async () => {
    mocks.create.mockResolvedValue(okResponse());
    const p = getProvider('anthropic', {}, 'claude-x');
    const result = await p.complete({ systemPrompt: `Context: ${PII}`, userPrompt: `Categorize: ${PII}`, responseFormat: 'json' });
    expect(result.parsed).toEqual({ ok: true });
    expect(result.inputTokens).toBe(12);
    expect(mocks.apiKeys).toEqual([KEY]);
    const body = mocks.create.mock.calls[0]![0] as { system: string; messages: Array<{ content: string }> };
    const sent = body.system + ' ' + body.messages[0]!.content;
    for (const raw of ['021000021', '123456789012', '4111 1111 1111 1111', '123-45-6789', '555-123-4567']) {
      expect(sent).not.toContain(raw);
    }
    expect(sent).toContain('ACME');
  });

  it('applies the backstop to the text of a vision call as well', async () => {
    mocks.create.mockResolvedValue(okResponse());
    const p = getProvider('anthropic', {});
    await p.completeWithImage({ systemPrompt: 's', userPrompt: `Read: ${PII}`, images: [{ base64: 'AAAA', mimeType: 'image/png' }] });
    const body = mocks.create.mock.calls[0]![0] as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    const text = body.messages[0]!.content.find((c) => c.type === 'text')!.text!;
    expect(text).not.toContain('4111 1111 1111 1111');
    expect(text).not.toContain('123-45-6789');
  });

  it('scrubs the session key out of a provider error before it reaches the caller or the log', async () => {
    mocks.create.mockRejectedValue(Object.assign(new Error(`401 authentication_error: invalid x-api-key "${KEY}"`), { status: 401 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = getProvider('anthropic', {});
    const direct = await p.complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e: Error) => e);
    expect(direct).toBeInstanceOf(Error);
    expect((direct as Error).message).toContain('[redacted]');
    expect((direct as Error).message).not.toContain(KEY);

    const err = await executeWithFallback({ systemPrompt: 's', userPrompt: 'u' }, {}, ['anthropic'], 'anthropic').catch((e: Error & { providerErrors?: string[] }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).toContain('[redacted]');
    expect(JSON.stringify((err as { providerErrors?: string[] }).providerErrors)).not.toContain(KEY);
    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('all providers failed');
    expect(logged).not.toContain(KEY);
  });

  it('a non-session key shape in an error is scrubbed by pattern too', async () => {
    mocks.create.mockRejectedValue(new Error('upstream said: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl and sk-ant-other-' + 'k'.repeat(30)));
    const p = getProvider('anthropic', {});
    const err = await p.complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/eyJhbGci|sk-ant-other/);
  });
});

describe('server mode (unchanged)', () => {
  it('sends the caller\'s text as-is and uses the stored key', async () => {
    const { encrypt } = await import('../../utils/encryption.js');
    mocks.create.mockResolvedValue(okResponse());
    const p = getProvider('anthropic', { anthropicApiKeyEncrypted: encrypt('sk-ant-stored-' + 'q'.repeat(30)) });
    await p.complete({ systemPrompt: 's', userPrompt: `Categorize: ${PII}` });
    const body = mocks.create.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(body.messages[0]!.content).toContain('4111 1111 1111 1111');
    expect(mocks.apiKeys).toEqual(['sk-ant-stored-' + 'q'.repeat(30)]);
  });
});
