// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-11: the Ollama adapter against a loopback stub server. Confirms the
// request the engine sends (base URL, /api/chat, model, no credentials,
// keep_alive, num_ctx, num_predict, think, json format, images) and the
// result mapping, in server mode and through the desktop session endpoint.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../../desktop/profile.js';
import * as secrets from '../../desktop/session-secrets.js';
import { getProvider, hasCredentials, executeWithFallback } from './index.js';

interface Captured { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }

const calls: Captured[] = [];
let server: http.Server;
let baseUrl = '';
let tags: string[] = ['qwen3:latest', 'llava:7b'];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: tags.map((name) => ({ name })) }));
        return;
      }
      if (req.url === '/api/chat') {
        if (body?.model === 'missing-model') {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'model not found' }));
          return;
        }
        res.end(JSON.stringify({
          message: { role: 'assistant', content: body?.messages?.[1]?.images ? '{"vendor":"ACME"}' : '{"ok":true}' },
          done: true, done_reason: body?.options?.num_predict === 1 ? 'length' : 'stop',
          prompt_eval_count: 21, eval_count: 4,
        }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { calls.length = 0; tags = ['qwen3:latest', 'llava:7b']; });
afterEach(() => { secrets.clearAllSessionSecrets(); _resetDesktopProfileForTests(); });

describe('Ollama adapter (server mode)', () => {
  it('posts /api/chat with the model, tuning options and no credentials', async () => {
    const p = getProvider('ollama', { ollamaBaseUrl: `${baseUrl}/` }, 'qwen3');
    const r = await p.complete({ systemPrompt: 'sys', userPrompt: 'user', responseFormat: 'json', maxTokens: 64, numCtx: 4096, thinking: 'off', temperature: 0.2 });
    expect(r).toMatchObject({ provider: 'ollama', model: 'qwen3', parsed: { ok: true }, inputTokens: 21, outputTokens: 4, truncated: false });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/api/chat');
    expect(c.headers['authorization']).toBeUndefined();
    expect(c.headers['x-api-key']).toBeUndefined();
    expect(c.body).toMatchObject({
      model: 'qwen3', stream: false, format: 'json', think: false, keep_alive: '30m',
      options: { num_predict: 64, num_ctx: 4096, temperature: 0.2 },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }],
    });
  });

  it('sends images on the user turn and maps a length stop to truncated', async () => {
    const p = getProvider('ollama', { ollamaBaseUrl: baseUrl }, 'llava');
    const r = await p.completeWithImage({ systemPrompt: 's', userPrompt: 'read', responseFormat: 'json', maxTokens: 1, images: [{ base64: 'QUJD', mimeType: 'image/png' }] });
    expect(calls[0]!.body.messages[1]).toEqual({ role: 'user', content: 'read', images: ['QUJD'] });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('{"vendor":"ACME"}');
  });

  it('testConnection checks /api/tags and that the model is installed; listModels sorts the tags', async () => {
    const ok = await getProvider('ollama', { ollamaBaseUrl: baseUrl }, 'qwen3').testConnection();
    expect(ok.success).toBe(true);
    expect(calls[0]!.url).toBe('/api/tags');
    const missing = await getProvider('ollama', { ollamaBaseUrl: baseUrl }, 'nope').testConnection();
    expect(missing).toMatchObject({ success: false, error: expect.stringContaining("model 'nope' is not installed") });
    expect(await getProvider('ollama', { ollamaBaseUrl: baseUrl }).listModels!()).toEqual(['llava:7b', 'qwen3:latest']);
  });

  it('a 404 from /api/chat names the missing model', async () => {
    await expect(getProvider('ollama', { ollamaBaseUrl: baseUrl }, 'missing-model').complete({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/model 'missing-model' not found on the Ollama server/);
  });

  it('a refused loopback port is a plain connection error (not offline)', async () => {
    const dead = getProvider('ollama', { ollamaBaseUrl: 'http://127.0.0.1:1' }, 'qwen3');
    const r = await dead.testConnection();
    expect(r.success).toBe(false);
    expect((r as { error?: string }).error).toBeTruthy();
  });
});

describe('Ollama adapter (desktop session endpoint)', () => {
  beforeEach(() => {
    loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 'ollama_' + 'o'.repeat(42), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-ollama-test'), CL_OFFLINE: 'on' });
  });

  it('uses the session base URL and model, with no key and even with CL_OFFLINE=on (local never counts as offline)', async () => {
    secrets.setOllamaBaseUrl(`${baseUrl}/v1/`, 'qwen3');
    expect(hasCredentials('ollama', {})).toBe(true);
    const r = await executeWithFallback({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' }, { ollamaBaseUrl: 'http://10.9.9.9:11434' }, ['ollama'], 'ollama');
    expect(r.parsed).toEqual({ ok: true });
    expect(r.model).toBe('qwen3');
    expect(calls[0]!.url).toBe('/api/chat');
    expect(calls[0]!.body.model).toBe('qwen3');
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('falls back to the stored base URL when no session endpoint was set', async () => {
    const p = getProvider('ollama', { ollamaBaseUrl: baseUrl }, 'qwen3');
    expect((await p.testConnection()).success).toBe(true);
  });
});
