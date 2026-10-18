// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// E6 canary: a session API key handed to the REAL app in desktop mode never
// leaves through an HTTP response, a log line, provider_test_history or an
// ai_config column, even when the (mocked) provider SDK echoes it in every
// error. Also: with no session key, no SDK client is ever built.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Express } from 'express';

const KEY = 'sk-ant-api03-canary-' + 'C'.repeat(40);
const OPENAI_KEY = 'sk-proj-canary-' + 'O'.repeat(40);

const sdk = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    constructor(opts: { apiKey: string }) { sdk.keys.push(opts.apiKey); }
    messages = {
      create: async () => { throw Object.assign(new Error(`401 authentication_error: invalid x-api-key ${sdk.keys.at(-1)}`), { status: 401 }); },
      stream: () => { throw new Error('unexpected'); },
    };
    models = { list: async () => { throw new Error(`403 forbidden for key ${sdk.keys.at(-1)} (Authorization: Bearer ${sdk.keys.at(-1)})`); } };
  },
}));
vi.mock('openai', () => ({
  default: class OpenAiMock {
    constructor(opts: { apiKey: string }) { sdk.keys.push(opts.apiKey); }
    chat = { completions: { create: async () => { throw Object.assign(new Error(`Incorrect API key provided: ${sdk.keys.at(-1)}.`), { status: 401 }); } } };
    models = { list: async () => { throw new Error(`Incorrect API key provided: ${sdk.keys.at(-1)}.`); } };
  },
}));

import { db } from '../db/index.js';
import { tenants, users, aiConfig } from '../db/schema/index.js';

const TOKEN = 'canary_' + 'k'.repeat(44);
const SLUG = 'canary-key-test';
let adminJwt = '';

async function cleanup(): Promise<void> {
  await db.delete(aiConfig);
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, SLUG));
  for (const t of rows) await db.delete(users).where(eq(users.tenantId, t.id));
  await db.delete(tenants).where(eq(tenants.slug, SLUG));
}

beforeAll(async () => {
  await cleanup();
  const [tenant] = await db.insert(tenants).values({ name: 'Canary', slug: SLUG }).returning();
  const [admin] = await db.insert(users).values({ tenantId: tenant!.id, email: `${SLUG}@example.com`, passwordHash: 'x', displayName: 'Owner', role: 'owner', isSuperAdmin: true }).returning();
  adminJwt = jwt.sign({ userId: admin!.id, tenantId: tenant!.id, role: 'owner', isSuperAdmin: true }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
});

afterAll(async () => {
  await cleanup();
});

interface Harness {
  call: (p: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; text: string; json: any }>;
  output: () => string;
  close: () => Promise<void>;
}

async function start(): Promise<Harness> {
  vi.resetModules();
  const profile = await import('../desktop/profile.js');
  profile.loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-canary-test'), CL_OFFLINE: 'off' });
  const { app } = await import('../app.js');
  const server = http.createServer(app as Express);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  (await import('../middleware/desktop-gate.js')).setDesktopBoundAddress('127.0.0.1', port);
  // Everything the process prints during the test.
  const lines: string[] = [];
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.map(String).join(' ')); }),
    vi.spyOn(console, 'warn').mockImplementation((...a) => { lines.push(a.map(String).join(' ')); }),
    vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.map(String).join(' ')); }),
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write),
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write),
  ];
  return {
    call: async (p, init = {}) => {
      const headers: Record<string, string> = { 'x-cl-token': TOKEN, authorization: `Bearer ${adminJwt}` };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, text, json };
    },
    output: () => lines.join('\n'),
    close: async () => {
      for (const s of spies) s.mockRestore();
      await new Promise<void>((r) => server.close(() => r()));
      profile._resetDesktopProfileForTests();
    },
  };
}

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
  sdk.keys.length = 0;
});

describe('canary session key', () => {
  it('without a session key no SDK client is built and the test answers "not configured"', async () => {
    h = await start();
    await h.call('/api/v1/ai/admin/config', { method: 'PUT', body: { categorizationProvider: 'anthropic', fallbackChain: ['anthropic'] } });
    const r = await h.call('/api/v1/ai/admin/test/anthropic', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ success: false, error: 'Anthropic API key not configured' });
    expect(sdk.keys).toEqual([]);
    const models = await h.call('/api/v1/ai/admin/models/openai');
    expect(models.json).toEqual({ models: [], error: 'OpenAI API key not configured' });
    expect(sdk.keys).toEqual([]);
  }, 120_000);

  it('never leaves via responses, logs, provider_test_history or ai_config', async () => {
    h = await start();
    const put = await h.call('/api/v1/desktop/session-secrets', { method: 'PUT', body: { ai: { anthropic: { apiKey: KEY }, openai: { apiKey: OPENAI_KEY } } } });
    expect(put.status, put.text).toBe(200);

    const cfg = await h.call('/api/v1/ai/admin/config');
    expect(cfg.json.hasAnthropicKey).toBe(true);
    expect(cfg.json.hasOpenaiKey).toBe(true);

    const test = await h.call('/api/v1/ai/admin/test/anthropic', { method: 'POST' });
    expect(test.status).toBe(200);
    expect(test.json.success).toBe(false);
    expect(test.json.error).toContain('[redacted]');
    expect(sdk.keys).toContain(KEY); // the SDK did get the key

    const models = await h.call('/api/v1/ai/admin/models/anthropic');
    expect(models.json.models).toEqual([]);
    expect(models.json.error).toContain('[redacted]');
    const oTest = await h.call('/api/v1/ai/admin/test/openai', { method: 'POST' });
    expect(oTest.json.success).toBe(false);
    const oModels = await h.call('/api/v1/ai/admin/models/openai');
    const fn = await h.call('/api/v1/ai/admin/test-function/categorization', { method: 'POST' });
    expect(fn.json.success).toBe(false);
    const status = await h.call('/api/v1/desktop/session-secrets');

    for (const r of [put, cfg, test, models, oTest, oModels, fn, status]) {
      expect(r.text).not.toContain(KEY);
      expect(r.text).not.toContain(OPENAI_KEY);
    }
    const out = h.output();
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(OPENAI_KEY);

    const rows = await db.select().from(aiConfig);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.anthropicApiKeyEncrypted).toBeNull();
    expect(rows[0]!.openaiApiKeyEncrypted).toBeNull();
    const history = JSON.stringify(rows[0]!.providerTestHistory);
    expect(history).toContain('[redacted]');
    expect(history).not.toContain(KEY);
    expect(history).not.toContain(OPENAI_KEY);

    // Storing a key through the config API is refused and stores nothing.
    const refused = await h.call('/api/v1/ai/admin/config', { method: 'PUT', body: { anthropicApiKey: KEY } });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('DESKTOP_KEYS_NOT_STORED');
    expect(refused.text).not.toContain(KEY);
    expect((await db.select().from(aiConfig))[0]!.anthropicApiKeyEncrypted).toBeNull();
  }, 120_000);
});
