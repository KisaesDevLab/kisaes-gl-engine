// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// E6 canary: a session API key or SMTP password handed to the REAL app in
// desktop mode never leaves through an HTTP response, a log line (console,
// stdout/stderr, and the scrubbed CL_LOG_FILE written by the log tee),
// provider_test_history, a failed ai_jobs row, or any text/json column of
// any table in the public schema, even when the (mocked) provider SDK and
// mail server echo it in every error. Also: with no session key, no SDK
// client is ever built.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import type { Express } from 'express';

const KEY = 'sk-ant-api03-canary-' + 'C'.repeat(40);
const OPENAI_KEY = 'sk-proj-canary-' + 'O'.repeat(40);
// No credential shape: only the registered-value layer of the scrubber
// can catch it.
const SMTP_PW = 'Mail-Canary-Pw-' + 'M'.repeat(12);
const CANARIES = [KEY, OPENAI_KEY, SMTP_PW];
const LOG_FILE = path.join(os.tmpdir(), `cl-canary-test-${process.pid}`, 'engine.log');

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
// A mail server that quotes the credentials it rejected.
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: { auth?: { user?: string; pass?: string } }) => ({
      options: opts,
      verify: async () => { throw Object.assign(new Error(`535 5.7.8 Authentication failed for ${opts.auth?.user}:${opts.auth?.pass}`), { responseCode: 535 }); },
      sendMail: async () => { throw new Error('unexpected'); },
    }),
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
import { tenants, users, aiConfig, aiJobs, companies, bankConnections, bankFeedItems } from '../db/schema/index.js';
import { createCompanyForTenant } from '../services/company.service.js';
import * as accountsService from '../services/accounts.service.js';

const TOKEN = 'canary_' + 'k'.repeat(44);
const SLUG = 'canary-key-test';
let adminJwt = '';
let tenantId = '';
let userId = '';

async function cleanup(): Promise<void> {
  await db.delete(aiConfig);
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, SLUG));
  if (rows.length === 0) return;
  // Every row the scenarios created carries the tenant id; delete them
  // over a few passes so foreign keys between those tables never block.
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'`);
  for (const t of rows) {
    const names = tables.rows.map((r) => r.table_name);
    for (let pass = 0; pass < 6 && names.length > 0; pass++) {
      for (const name of [...names]) {
        try {
          await db.execute(sql`DELETE FROM ${sql.identifier(name)} WHERE tenant_id = ${t.id}`);
          names.splice(names.indexOf(name), 1);
        } catch { /* still referenced by another table; next pass */ }
      }
    }
  }
  await db.delete(tenants).where(eq(tenants.slug, SLUG));
}

beforeAll(async () => {
  await cleanup();
  const [tenant] = await db.insert(tenants).values({ name: 'Canary', slug: SLUG }).returning();
  tenantId = tenant!.id;
  const [admin] = await db.insert(users).values({ tenantId, email: `${SLUG}@example.com`, passwordHash: 'x', displayName: 'Owner', role: 'owner', isSuperAdmin: true }).returning();
  userId = admin!.id;
  adminJwt = jwt.sign({ userId, tenantId, role: 'owner', isSuperAdmin: true }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  fs.rmSync(path.dirname(LOG_FILE), { recursive: true, force: true });
});

afterAll(async () => {
  await cleanup();
  fs.rmSync(path.dirname(LOG_FILE), { recursive: true, force: true });
});

interface Harness {
  call: (p: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; text: string; json: any }>;
  /** Everything the app printed, BEFORE the log tee scrubbed it. */
  output: () => string;
  /** What the log tee wrote to CL_LOG_FILE. */
  logFile: () => string;
  close: () => Promise<void>;
}

async function start(): Promise<Harness> {
  vi.resetModules();
  const profile = await import('../desktop/profile.js');
  profile.loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-canary-test'), CL_OFFLINE: 'off', CL_LOG_FILE: LOG_FILE });
  const { app } = await import('../app.js');
  const server = http.createServer(app as Express);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  (await import('../middleware/desktop-gate.js')).setDesktopBoundAddress('127.0.0.1', port);
  // Everything the process prints during the test, wired as in the
  // desktop process: console -> stdout/stderr -> log tee (scrub, copy to
  // CL_LOG_FILE) -> the real stream (a silent sink here). `lines` records
  // each chunk BEFORE the tee scrubs it, so the app itself is held to
  // never printing a secret, and the file shows what the tee kept.
  const lines: string[] = [];
  const sinks = [
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write),
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write),
  ];
  const logTee = await import('../desktop/log-tee.js');
  logTee.installLogTee(profile.desktopProfile());
  const raw: Array<() => void> = [];
  for (const stream of [process.stdout, process.stderr]) {
    const teed = stream.write;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (teed as (...a: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof stream.write;
    raw.push(() => { stream.write = teed; });
  }
  const consoleTo = (stream: NodeJS.WriteStream) => (...a: unknown[]) => { stream.write(format(...a) + '\n'); };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(consoleTo(process.stdout)),
    vi.spyOn(console, 'info').mockImplementation(consoleTo(process.stdout)),
    vi.spyOn(console, 'warn').mockImplementation(consoleTo(process.stderr)),
    vi.spyOn(console, 'error').mockImplementation(consoleTo(process.stderr)),
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
    logFile: () => (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : ''),
    close: async () => {
      for (const s of spies) s.mockRestore();
      for (const r of raw) r();
      logTee._uninstallLogTeeForTests();
      for (const s of sinks) s.mockRestore();
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
    const file = h.logFile();
    expect(file).not.toContain(KEY);
    expect(file).not.toContain(OPENAI_KEY);

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

  it('a failed AI job (provider 401 echoing the key) keeps the key out of the response, ai_jobs and the logs', async () => {
    h = await start();
    const put = await h.call('/api/v1/desktop/session-secrets', { method: 'PUT', body: { ai: { anthropic: { apiKey: KEY } } } });
    expect(put.status, put.text).toBe(200);
    // AI on, Anthropic only, disclosure accepted, company consent: the
    // categorize call reaches the (mocked) SDK, which answers 401 + key.
    await db.delete(aiConfig);
    await db.insert(aiConfig).values({
      isEnabled: true,
      categorizationProvider: 'anthropic',
      fallbackChain: ['anthropic'],
      adminDisclosureAcceptedAt: new Date(),
      adminDisclosureAcceptedBy: userId,
      taskOptions: { categorization: { fallbackChain: ['anthropic'] } },
    });
    const company = (await db.select().from(companies).where(eq(companies.tenantId, tenantId)))[0]
      ?? (await createCompanyForTenant(tenantId, 'Canary Co'))!;
    await db.update(companies).set({ aiEnabled: true, aiDisclosureVersion: 1, aiEnabledTasks: { categorization: true } }).where(eq(companies.id, company.id));
    const cash = await accountsService.create(tenantId, { name: 'Canary Cash', accountType: 'asset', accountNumber: '1099' });
    const [conn] = await db.insert(bankConnections).values({ tenantId, companyId: company.id, accountId: cash.id, institutionName: 'Canary Bank' }).returning();
    const [item] = await db.insert(bankFeedItems).values({
      tenantId, companyId: company.id, bankConnectionId: conn!.id, providerTransactionId: `canary-${Date.now()}`,
      feedDate: '2026-05-01', amount: '12.34', description: 'CANARY COFFEE SHOP', status: 'pending',
    }).returning();

    const r = await h.call('/api/v1/ai/categorize', { method: 'POST', body: { feedItemId: item!.id } });
    expect(r.status, r.text).toBeGreaterThanOrEqual(400);
    expect(sdk.keys).toContain(KEY); // the call did reach the provider stub
    expect(r.text).not.toContain(KEY);

    const jobs = await db.select().from(aiJobs).where(eq(aiJobs.tenantId, tenantId));
    const failed = jobs.filter((j) => j.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const j of jobs) expect(JSON.stringify(j)).not.toContain(KEY);
    expect(failed.some((j) => (j.errorMessage ?? '').includes('[redacted]'))).toBe(true);

    expect(h.output()).not.toContain(KEY);
    expect(h.logFile()).not.toContain(KEY);
  }, 120_000);

  it('the SMTP session password never leaves via the SMTP test, the logs or the database', async () => {
    h = await start();
    const put = await h.call('/api/v1/desktop/session-secrets', {
      method: 'PUT',
      body: { smtp: { password: SMTP_PW, host: '10.0.0.25', port: 587, security: 'starttls' } },
    });
    expect(put.status, put.text).toBe(200);
    expect(put.json['smtp.password'].present).toBe(true);

    // The body's password is ignored in desktop mode; the session one is
    // used, and the mocked server quotes it back in its 535.
    const r = await h.call('/api/v1/company/smtp/test', {
      method: 'POST',
      body: { host: '10.0.0.25', port: 587, username: 'owner', password: 'body-password-ignored', from: 'owner@example.test' },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json.success).toBe(false);
    expect(r.json.error).toContain('[redacted]');
    const status = await h.call('/api/v1/desktop/session-secrets');
    for (const res of [put, r, status]) expect(res.text).not.toContain(SMTP_PW);

    // A line that does carry the password is scrubbed on its way to the file.
    process.stderr.write(`smtp debug: ${SMTP_PW}\n`);
    const raw = h.output();
    expect(raw.split(SMTP_PW).length - 1).toBe(1); // only the line above
    const file = h.logFile();
    expect(file).toContain('smtp debug: [redacted]');
    expect(file).not.toContain(SMTP_PW);
  }, 120_000);

  it('no canary is stored in any text or json column of any table in the public schema', async () => {
    const cols = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT c.table_name, c.column_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY')
      ORDER BY c.table_name, c.column_name`);
    expect(cols.rows.length).toBeGreaterThan(100);
    const byTable = new Map<string, string[]>();
    for (const c of cols.rows) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
    const hits: string[] = [];
    for (const [table, columns] of byTable) {
      for (const column of columns) {
        const res = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM ${sql.identifier(table)}
          WHERE strpos(${sql.identifier(column)}::text, ${KEY}) > 0
             OR strpos(${sql.identifier(column)}::text, ${OPENAI_KEY}) > 0
             OR strpos(${sql.identifier(column)}::text, ${SMTP_PW}) > 0`);
        if ((res.rows[0]?.n ?? 0) > 0) hits.push(`${table}.${column}`);
      }
    }
    expect(hits).toEqual([]);
    // And the whole CL_LOG_FILE written across the scenarios.
    const file = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    expect(file.length).toBeGreaterThan(0);
    for (const c of CANARIES) expect(file).not.toContain(c);
  }, 120_000);
});
