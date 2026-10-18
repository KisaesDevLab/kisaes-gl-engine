// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PUT/GET/DELETE /api/v1/desktop/session-secrets through the REAL app.ts in
// desktop mode: launch token + signed-in super admin, memory-only values,
// never echoed (not even in validation errors), egress wiring.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import { db } from '../db/index.js';
import { tenants, users } from '../db/schema/index.js';

const TOKEN = 'sstest_' + 'y'.repeat(44);
const SLUG = 'ss-routes-test';
const KEY = 'sk-ant-api03-canary-' + 'R'.repeat(40);
const OPENAI_KEY = 'sk-proj-canary-' + 'S'.repeat(40);

let adminJwt = '';
let staffJwt = '';

async function cleanup(): Promise<void> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, SLUG));
  for (const t of rows) await db.delete(users).where(eq(users.tenantId, t.id));
  await db.delete(tenants).where(eq(tenants.slug, SLUG));
}

async function seed(): Promise<void> {
  await cleanup();
  const [tenant] = await db.insert(tenants).values({ name: 'SS Tenant', slug: SLUG }).returning();
  const [admin] = await db.insert(users).values({
    tenantId: tenant!.id, email: `admin-${SLUG}@example.com`, passwordHash: 'x', displayName: 'Owner', role: 'owner', isSuperAdmin: true,
  }).returning();
  const [staff] = await db.insert(users).values({
    tenantId: tenant!.id, email: `staff-${SLUG}@example.com`, passwordHash: 'x', displayName: 'Staff', role: 'bookkeeper', isSuperAdmin: false,
  }).returning();
  const secret = process.env['JWT_SECRET']!;
  adminJwt = jwt.sign({ userId: admin!.id, tenantId: tenant!.id, role: 'owner', isSuperAdmin: true }, secret, { expiresIn: '5m' });
  staffJwt = jwt.sign({ userId: staff!.id, tenantId: tenant!.id, role: 'bookkeeper', isSuperAdmin: false }, secret, { expiresIn: '5m' });
}

async function loadApp(mode: 'desktop' | 'server'): Promise<Express> {
  vi.resetModules();
  const profile = await import('../desktop/profile.js');
  if (mode === 'desktop') {
    profile.loadDesktopProfile({
      CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-session-secrets-test'),
    });
  } else {
    profile.loadDesktopProfile({});
  }
  const { app } = await import('../app.js');
  return app;
}

interface Call {
  (p: string, init?: { method?: string; body?: unknown; jwt?: string; token?: string | null }): Promise<{ status: number; text: string; json: any }>;
}

async function withServer<T>(app: Express, fn: (call: Call) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
  setDesktopBoundAddress('127.0.0.1', port);
  const call: Call = async (p, init = {}) => {
    const headers: Record<string, string> = {};
    if (init.token !== null) headers['x-cl-token'] = init.token ?? TOKEN;
    if (init.jwt) headers['authorization'] = `Bearer ${init.jwt}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, json };
  };
  try {
    return await fn(call);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  await cleanup();
});

afterEach(async () => {
  const secrets = await import('../desktop/session-secrets.js');
  secrets.clearAllSessionSecrets();
  (await import('../desktop/profile.js'))._resetDesktopProfileForTests();
});

const P = '/api/v1/desktop/session-secrets';

describe('desktop session-secrets routes', () => {
  it('needs the launch token, a session and the super admin role', async () => {
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      expect((await call(P, { token: null })).json.error.code).toBe('DESKTOP_TOKEN_REQUIRED');
      expect((await call(P)).status).toBe(401);
      expect((await call(P, { jwt: staffJwt })).status).toBe(403);
      expect((await call(P, { method: 'PUT', jwt: staffJwt, body: { ai: { anthropic: { apiKey: KEY } } } })).status).toBe(403);
      const secrets = await import('../desktop/session-secrets.js');
      expect(secrets.hasSessionSecret('ai.anthropic')).toBe(false);
    });
  }, 120_000);

  it('PUT stores in memory, GET shows presence + fingerprint, the value never appears', async () => {
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      const put = await call(P, {
        method: 'PUT', jwt: adminJwt,
        body: { ai: { anthropic: { apiKey: KEY }, ollama: { baseUrl: 'http://localhost:11434/', model: 'llama3.2' } }, smtp: { password: 'hunter2hunter2' } },
      });
      expect(put.status, put.text).toBe(200);
      expect(put.json).toEqual({
        'ai.anthropic': { present: true, fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{8}$/) },
        'ai.openai': { present: false },
        'ai.ollama.baseUrl': { present: true, fingerprint: expect.any(String) },
        'smtp.password': { present: true, fingerprint: expect.any(String) },
      });
      expect(put.text).not.toContain(KEY);
      expect(put.text).not.toContain('hunter2');

      const get = await call(P, { jwt: adminJwt });
      expect(get.status).toBe(200);
      expect(get.json).toEqual(put.json);
      expect(get.text).not.toContain(KEY);

      const secrets = await import('../desktop/session-secrets.js');
      expect(secrets.getSessionSecret('ai.anthropic')).toBe(KEY);
      expect(secrets.getSessionSecret('ai.ollama.baseUrl')).toBe('http://localhost:11434');
      expect(secrets.getSessionOllamaModel()).toBe('llama3.2');
      const { egressAllowlist } = await import('../desktop/egress-guard.js');
      expect(egressAllowlist().filter((e) => e.source === 'ai.anthropic')).toEqual([
        { source: 'ai.anthropic', host: 'api.anthropic.com', port: 443 },
      ]);

      // Nothing reached the database.
      const { aiConfig, companies } = await import('../db/schema/index.js');
      const rows = await db.select({ k: aiConfig.anthropicApiKeyEncrypted }).from(aiConfig);
      expect(rows.every((r) => !r.k)).toBe(true);
      const pw = await db.select({ p: companies.smtpPass }).from(companies);
      expect(pw.every((r) => r.p !== 'hunter2hunter2')).toBe(true);
    });
  }, 120_000);

  it('a partial PUT leaves the other names alone; DELETE forgets one; unknown name is 404', async () => {
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      await call(P, { method: 'PUT', jwt: adminJwt, body: { ai: { anthropic: { apiKey: KEY } } } });
      const put2 = await call(P, { method: 'PUT', jwt: adminJwt, body: { ai: { openai: { apiKey: OPENAI_KEY } } } });
      expect(put2.json['ai.anthropic'].present).toBe(true);
      expect(put2.json['ai.openai'].present).toBe(true);

      const del = await call(`${P}/ai.anthropic`, { method: 'DELETE', jwt: adminJwt });
      expect(del.status).toBe(200);
      expect(del.json['ai.anthropic']).toEqual({ present: false });
      expect(del.json['ai.openai'].present).toBe(true);
      const { egressAllowlist } = await import('../desktop/egress-guard.js');
      expect(egressAllowlist().some((e) => e.source === 'ai.anthropic')).toBe(false);
      expect(egressAllowlist().some((e) => e.source === 'ai.openai')).toBe(true);

      expect((await call(`${P}/ai.gemini`, { method: 'DELETE', jwt: adminJwt })).status).toBe(404);
      // Deleting an absent name is still 200 with the current status.
      expect((await call(`${P}/smtp.password`, { method: 'DELETE', jwt: adminJwt })).status).toBe(200);
    });
  }, 120_000);

  it('validation errors never echo a value; an invalid Ollama URL applies nothing from the body', async () => {
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      const long = 'sk-ant-' + 'L'.repeat(600);
      const tooLong = await call(P, { method: 'PUT', jwt: adminJwt, body: { ai: { anthropic: { apiKey: long } } } });
      expect(tooLong.status).toBe(400);
      expect(tooLong.json.error.code).toBe('VALIDATION_ERROR');
      expect(tooLong.text).not.toContain('LLLLLLLL');

      const unknown = await call(P, { method: 'PUT', jwt: adminJwt, body: { ai: { gemini: { apiKey: KEY } } } });
      expect(unknown.status).toBe(400);
      expect(unknown.text).not.toContain(KEY);

      const bad = await call(P, {
        method: 'PUT', jwt: adminJwt,
        body: { ai: { anthropic: { apiKey: KEY }, ollama: { baseUrl: 'http://169.254.169.254:11434' } } },
      });
      expect(bad.status).toBe(400);
      expect(bad.json.error.code).toBe('OLLAMA_URL_INVALID');
      expect(bad.text).not.toContain(KEY);
      const secrets = await import('../desktop/session-secrets.js');
      expect(secrets.hasSessionSecret('ai.anthropic')).toBe(false);
      expect(secrets.hasSessionSecret('ai.ollama.baseUrl')).toBe(false);

      const empty = await call(P, { method: 'PUT', jwt: adminJwt, body: {} });
      expect(empty.status).toBe(200);
    });
  }, 120_000);

  it('/info advertises the E6 capabilities', async () => {
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      const r = await call('/api/v1/desktop/info');
      expect(r.status).toBe(200);
      expect(r.json.capabilities).toEqual(expect.arrayContaining(['session-secrets-v1', 'ai-desktop-v1', 'smtp-session-v1']));
    });
  }, 120_000);

  it('server mode: the routes do not exist', async () => {
    const app = await loadApp('server');
    await withServer(app, async (call) => {
      const r = await call(P, { jwt: adminJwt, token: null });
      expect(r.status).toBe(404);
    });
  }, 120_000);
});
