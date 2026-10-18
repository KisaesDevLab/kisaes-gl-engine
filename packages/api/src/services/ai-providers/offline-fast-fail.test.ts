// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Desktop offline fast-fail for cloud AI (ai-providers/index.ts): the real
// Anthropic/OpenAI SDK providers, pointed at an `.invalid` base URL or a
// non-routable address through ANTHROPIC_BASE_URL / OPENAI_BASE_URL, must
// fail with OFFLINE_UNAVAILABLE within 2 s, while a local Ollama (a
// loopback stub here) keeps working. No request leaves the machine.

import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../../desktop/profile.js';
import { OfflineUnavailableError, _resetConnectivityForTests } from '../../utils/offline.js';
import { encrypt } from '../../utils/encryption.js';
import * as secrets from '../../desktop/session-secrets.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { cloudAiTarget, executeWithFallback, getProvider } from './index.js';

const PARAMS = { systemPrompt: 's', userPrompt: 'u', maxTokens: 16, responseFormat: 'json' as const };

function desktop(offline?: 'auto' | 'on' | 'off') {
  loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: 'a'.repeat(48),
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-ai-offline-test'),
    ...(offline ? { CL_OFFLINE: offline } : {}),
  });
  // E6: desktop keys are per session; the stored columns in config() only
  // matter for the server-mode block.
  secrets.setAnthropicKey('sk-ant-test-not-a-real-key');
  secrets.setOpenaiKey('sk-test-not-a-real-key');
}

afterEach(() => {
  secrets.clearAllSessionSecrets();
});

function config(extra: Record<string, unknown> = {}) {
  return {
    anthropicApiKeyEncrypted: encrypt('sk-ant-test-not-a-real-key'),
    openaiApiKeyEncrypted: encrypt('sk-test-not-a-real-key'),
    ...extra,
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T | null; err: unknown }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t0, value, err: null };
  } catch (err) {
    return { ms: Date.now() - t0, value: null, err };
  }
}

async function ollamaStub(): Promise<{ url: string; calls: number; close: () => Promise<void> }> {
  const state = { calls: 0 };
  const srv = http.createServer((req, res) => {
    state.calls++;
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' }, done: true, prompt_eval_count: 3, eval_count: 2 }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get calls() { return state.calls; },
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.cl-offline.invalid');
  vi.stubEnv('OPENAI_BASE_URL', 'https://openai.cl-offline.invalid/v1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetConnectivityForTests();
  _resetDesktopProfileForTests();
});

describe('server mode is unchanged', () => {
  it('providers are not wrapped and no target is probed', () => {
    loadDesktopProfile({});
    expect(getProvider('anthropic', config())).toBeInstanceOf(AnthropicProvider);
  });
});

// The desktop cap check (review M3) reads ai_config and ai_usage_log before
// answering; the engine's pool is warm by then (authenticate ran), so warm
// it here too instead of timing a cold connection.
beforeAll(async () => {
  await db.execute(sql`select 1`);
});

describe('desktop, CL_OFFLINE=on', () => {
  it('cloud calls fail at once with OFFLINE_UNAVAILABLE and open no socket', async () => {
    desktop('on');
    const connect = vi.spyOn(net, 'connect');
    const { ms, err } = await timed(() => executeWithFallback(PARAMS, config(), ['anthropic', 'openai'], 'anthropic', 'claude-x'));
    expect(err).toBeInstanceOf(OfflineUnavailableError);
    expect((err as OfflineUnavailableError).feature).toBe('ai:anthropic');
    // Two local database reads (the monthly-cap check, review M3) precede
    // the offline answer; no probe, no socket.
    expect(ms).toBeLessThan(1_000);
    expect(connect).not.toHaveBeenCalled();
  });

  it('Ollama (local) still answers', async () => {
    desktop('on');
    const stub = await ollamaStub();
    try {
      const r = await executeWithFallback(PARAMS, config({ ollamaBaseUrl: stub.url }), ['anthropic', 'ollama'], 'anthropic');
      expect(r.provider).toBe('ollama');
      expect(r.parsed).toEqual({ ok: true });
    } finally {
      await stub.close();
    }
  });
});

describe('desktop, CL_OFFLINE=auto', () => {
  it('unresolvable provider hosts: OFFLINE_UNAVAILABLE in < 2 s across the whole fallback chain', async () => {
    desktop();
    const { ms, err } = await timed(() =>
      executeWithFallback(PARAMS, config(), ['anthropic', 'openai'], 'anthropic', 'claude-stale-model'),
    );
    expect(err).toBeInstanceOf(OfflineUnavailableError);
    expect(ms).toBeLessThan(2_000);
  });

  it('blackholed provider host (connect hangs): < 2 s', async () => {
    desktop();
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://10.255.255.1');
    const { ms, err } = await timed(() => executeWithFallback(PARAMS, config(), [], 'anthropic'));
    expect(err).toBeInstanceOf(OfflineUnavailableError);
    expect(ms).toBeLessThan(2_000);
  });

  it('vision calls that bypass executeWithFallback fail the same way', async () => {
    desktop();
    const provider = getProvider('openai', config());
    const { ms, err } = await timed(() =>
      provider.completeWithImage({ ...PARAMS, images: [{ base64: 'AAAA', mimeType: 'image/png' }] } as never),
    );
    expect(err).toBeInstanceOf(OfflineUnavailableError);
    expect((err as OfflineUnavailableError).feature).toBe('ai:openai');
    expect(ms).toBeLessThan(2_000);
  });

  it('offline cloud provider falls back to a working local Ollama', async () => {
    desktop();
    const stub = await ollamaStub();
    try {
      const { ms, value } = await timed(() =>
        executeWithFallback(PARAMS, config({ ollamaBaseUrl: stub.url }), ['anthropic', 'openai', 'ollama'], 'anthropic'),
      );
      expect(value?.provider).toBe('ollama');
      expect(stub.calls).toBe(1);
      expect(ms).toBeLessThan(2_000);
    } finally {
      await stub.close();
    }
  });

  it('when a non-network failure is also involved, the aggregate error is kept', async () => {
    desktop();
    // Ollama on a closed loopback port: refused (a local problem, not offline).
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const { err } = await timed(() =>
      executeWithFallback(PARAMS, config({ ollamaBaseUrl: `http://127.0.0.1:${port}` }), ['anthropic', 'ollama'], 'anthropic'),
    );
    expect(err).not.toBeInstanceOf(OfflineUnavailableError);
    expect((err as { code?: string }).code).toBe('ai_all_providers_failed');
    expect((err as { providerErrors?: string[] }).providerErrors?.[0]).toBe('anthropic: offline');
  }, 20_000);
});

describe('cloudAiTarget', () => {
  it('follows the SDK base-URL env vars and ignores local providers', () => {
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
    expect(cloudAiTarget('anthropic')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(cloudAiTarget('openai')).toEqual({ host: 'api.openai.com', port: 443 });
    vi.stubEnv('OPENAI_BASE_URL', 'http://proxy.example.test:8080/v1');
    expect(cloudAiTarget('openai')).toEqual({ host: 'proxy.example.test', port: 8080 });
    expect(cloudAiTarget('ollama')).toBeNull();
    expect(cloudAiTarget('openai_compat')).toBeNull();
  });
});
