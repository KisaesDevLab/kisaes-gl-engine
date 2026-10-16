// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Offline matrix (P02 plan §4.3, acceptance criterion AC2). Two layers:
//
//  1. The REAL app.ts in desktop mode, in this process, with the egress
//     guard installed: cloud AI and SMTP answer 503 OFFLINE_UNAVAILABLE in
//     under 2 s for CL_OFFLINE=on, an unresolvable host and a blackholed
//     host; /health reports the state; a host the owner did not enable is
//     refused by the guard without a DNS query.
//  2. The real engine spawned through bootstrap.ts: the guard is installed
//     at boot, and booting plus an idle period opens no connection beyond
//     loopback and the database.
//
// Nothing here reaches the internet: probes go to `.invalid` names (never
// resolve), a non-routable address, or are blocked before DNS.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const TOKEN = 'offmatrix_' + 'q'.repeat(40);
const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAST_MS = 2_000;

type Guard = typeof import('./egress-guard.js');

interface Loaded {
  app: Express;
  guard: Guard;
  port: number;
  server: http.Server;
  call: (method: string, p: string, body?: unknown) => Promise<{ status: number; json: any; ms: number }>;
}

async function loadDesktopApp(offline: 'on' | 'auto'): Promise<Loaded> {
  vi.resetModules();
  const profile = await import('./profile.js');
  profile.loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: TOKEN,
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-offline-matrix'),
    CL_OFFLINE: offline,
  });
  // Same order as bootstrap.ts: the guard goes in before the app loads.
  const guard = await import('./egress-guard.js');
  guard.installEgressGuard({ databaseUrl: process.env['DATABASE_URL'], offline: offline === 'on' });
  const { app } = await import('../app.js');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
  setDesktopBoundAddress('127.0.0.1', port);
  return {
    app,
    guard,
    port,
    server,
    call: async (method, p, body) => {
      const t0 = Date.now();
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: {
          'x-cl-token': TOKEN,
          authorization: `Bearer ${adminJwt}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json: any = text;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, ms: Date.now() - t0 };
    },
  };
}

async function unload(l: Loaded | undefined): Promise<void> {
  if (!l) return;
  l.server.closeAllConnections();
  await new Promise<void>((r) => l.server.close(() => r()));
  l.guard._uninstallEgressGuardForTests();
  const profile = await import('./profile.js');
  profile._resetDesktopProfileForTests();
}

// --- seed: a super admin and an AI config that uses Anthropic ---------

let adminJwt = '';
const SEED = `offline-matrix-${Date.now()}`;
let savedAi: Record<string, unknown> | null = null;

async function seed(): Promise<void> {
  const { db } = await import('../db/index.js');
  const { tenants, users, aiConfig } = await import('../db/schema/index.js');
  const { encrypt } = await import('../utils/encryption.js');
  const [tenant] = await db.insert(tenants).values({ name: 'Offline Matrix', slug: SEED }).returning();
  const [user] = await db.insert(users).values({
    tenantId: tenant!.id,
    email: `${SEED}@example.test`,
    passwordHash: 'x',
    displayName: 'Admin',
    role: 'owner',
    isSuperAdmin: true,
  }).returning();
  adminJwt = jwt.sign(
    { userId: user!.id, tenantId: tenant!.id, role: 'owner', isSuperAdmin: true },
    process.env['JWT_SECRET']!,
    { expiresIn: '10m' },
  );
  const svc = await import('../services/ai-config.service.js');
  await svc.getConfig(); // creates the singleton row if missing
  const row = await db.query.aiConfig.findFirst();
  savedAi = {
    categorizationProvider: row!.categorizationProvider,
    categorizationModel: row!.categorizationModel,
    anthropicApiKeyEncrypted: row!.anthropicApiKeyEncrypted,
    fallbackChain: row!.fallbackChain,
  };
  await db.update(aiConfig).set({
    categorizationProvider: 'anthropic',
    categorizationModel: null,
    anthropicApiKeyEncrypted: encrypt('sk-ant-offline-matrix-not-a-key'),
    fallbackChain: ['anthropic'],
  });
}

async function unseed(): Promise<void> {
  const { db } = await import('../db/index.js');
  const { tenants, users, aiConfig } = await import('../db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  if (savedAi) await db.update(aiConfig).set(savedAi);
  await db.delete(users).where(eq(users.email, `${SEED}@example.test`));
  await db.delete(tenants).where(eq(tenants.slug, SEED));
}

const SMTP_BODY = (host: string) => ({ host, port: 587, from: 'owner@example.test' });

beforeAll(async () => {
  await seed();
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await unseed();
}, 60_000);

// --- 1. in-process app --------------------------------------------------

describe('CL_OFFLINE=on', () => {
  let l: Loaded | undefined;
  beforeAll(async () => { l = await loadDesktopApp('on'); }, 180_000);
  afterAll(async () => { await unload(l); });

  it('cloud AI: 503 OFFLINE_UNAVAILABLE in < 2 s', async () => {
    const r = await l!.call('POST', '/api/v1/ai/admin/test-function/categorization');
    expect(r.status).toBe(503);
    expect(r.json.error).toMatchObject({ code: 'OFFLINE_UNAVAILABLE', feature: 'ai:anthropic' });
    expect(r.ms).toBeLessThan(FAST_MS);
  });

  it('SMTP test-send: 503 OFFLINE_UNAVAILABLE in < 2 s', async () => {
    const r = await l!.call('POST', '/api/v1/admin/test-smtp', { ...SMTP_BODY('smtp.example.test'), testEmail: 'x@example.test' });
    expect(r.status).toBe(503);
    expect(r.json.error).toMatchObject({ code: 'OFFLINE_UNAVAILABLE', feature: 'smtp' });
    expect(r.ms).toBeLessThan(FAST_MS);
  });

  it('/health: online false, never probed', async () => {
    // Only the connectivity fields: this in-process app shares the test
    // runner's env (worker/Redis checks), so the overall status is not the
    // point here; the spawned engine below checks a real desktop /health.
    const r = await l!.call('GET', '/health');
    expect(r.json).toMatchObject({ mode: 'desktop', online: false, lastOnlineCheck: null });
  });
});

describe('CL_OFFLINE=auto', () => {
  let l: Loaded | undefined;
  beforeAll(async () => { l = await loadDesktopApp('auto'); }, 180_000);
  afterAll(async () => { await unload(l); vi.unstubAllEnvs(); });

  it('fresh: /health online null (no probe at boot)', async () => {
    const r = await l!.call('GET', '/health');
    expect(r.json).toMatchObject({ online: null, lastOnlineCheck: null });
  });

  it('unresolvable AI host the owner enabled: 503 in < 2 s', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.cl-offline.invalid');
    l!.guard.setEgressAllowance('ai.anthropic', [{ host: 'api.cl-offline.invalid', port: 443 }]);
    const r = await l!.call('POST', '/api/v1/ai/admin/test-function/categorization');
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('OFFLINE_UNAVAILABLE');
    expect(r.ms).toBeLessThan(FAST_MS);
  });

  it('blackholed AI host (connect hangs): 503 in < 2 s, then /health shows offline', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://10.255.255.1');
    l!.guard.setEgressAllowance('ai.anthropic', [{ host: '10.255.255.1', port: 443 }]);
    const r = await l!.call('POST', '/api/v1/ai/admin/test-function/categorization');
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('OFFLINE_UNAVAILABLE');
    expect(r.ms).toBeLessThan(FAST_MS);
    const h = await l!.call('GET', '/health');
    expect(h.json.online).toBe(false);
    expect(typeof h.json.lastOnlineCheck).toBe('string');
  });

  it('unresolvable SMTP host the owner enabled: 503 in < 2 s', async () => {
    l!.guard.setEgressAllowance('smtp', [{ host: 'smtp.cl-offline.invalid', port: 587 }]);
    const r = await l!.call('POST', '/api/v1/admin/test-smtp', SMTP_BODY('smtp.cl-offline.invalid'));
    expect(r.status).toBe(503);
    expect(r.json.error).toMatchObject({ code: 'OFFLINE_UNAVAILABLE', feature: 'smtp' });
    expect(r.ms).toBeLessThan(FAST_MS);
  });

  it('a host the owner did not enable is refused by the guard (EGRESS_BLOCKED), with no DNS query', async () => {
    const dns = await import('node:dns');
    const before = l!.guard.egressAllowlist().length;
    const r = await l!.call('POST', '/api/v1/admin/test-smtp', SMTP_BODY('smtp.not-enabled.example'));
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('EGRESS_BLOCKED');
    expect(l!.guard.egressAllowlist().length).toBe(before);
    const err = await dns.promises.lookup('smtp.not-enabled.example').catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('EGRESS_BLOCKED');
  });

  it('background phone-homes are blocked in the loaded app (update check, breach lookup hosts)', async () => {
    for (const url of ['https://api.github.com/repos/x/y/releases/latest', 'https://api.pwnedpasswords.com/range/ABCDE']) {
      const err = await fetch(url).then(() => null, (e: { cause?: { code?: string } }) => e);
      expect(err?.cause?.code, url).toBe('EGRESS_BLOCKED');
    }
    const r = await l!.call('GET', '/api/v1/admin/updates/check');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('NOT_AVAILABLE_IN_DESKTOP');
  });
});

// --- 2. spawned engine ----------------------------------------------------

const BOOT_TIMEOUT_MS = 240_000;
// Plan §4.3: 60 s of idle. Override with CL_OFFLINE_MATRIX_IDLE_MS.
const IDLE_MS = Number(process.env['CL_OFFLINE_MATRIX_IDLE_MS'] ?? 60_000);
const baseUrl = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
const DB_NAME = `cl_offline_matrix_${process.pid}_${Date.now()}`;
const PASS_THROUGH = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

function urlFor(db: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor('postgres') });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

interface Engine {
  proc: ChildProcess;
  stderr: string[];
  ready: Promise<{ port: number } | { exitCode: number | null }>;
  dataDir: string;
  connectLog: string;
}

function spawnEngine(extra: Record<string, string>, entry = 'src/bootstrap.ts'): Engine {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cl-offline-matrix-'));
  const connectLog = path.join(dataDir, 'connects.jsonl');
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, {
    NODE_ENV: 'production',
    CL_MODE: 'desktop',
    CL_TOKEN: TOKEN,
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: dataDir,
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    PLAID_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    DATABASE_URL: urlFor(DB_NAME),
    CL_TEST_CONNECT_LOG: connectLog,
    ...extra,
  });
  const recorder = pathToFileURL(path.join(API_ROOT, 'src', 'desktop', '__fixtures__', 'connect-recorder.mjs')).href;
  const proc = spawn(process.execPath, ['--import', recorder, '--import', 'tsx', entry], {
    cwd: API_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (c: string) => stderr.push(...c.split('\n').filter((l) => l.trim() !== '')));
  const ready = new Promise<{ port: number } | { exitCode: number | null }>((resolve) => {
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('{"event":"listening"')) resolve({ port: (JSON.parse(line) as { port: number }).port });
      }
    });
    proc.on('exit', (code) => resolve({ exitCode: code }));
  });
  return { proc, stderr, ready, dataDir, connectLog };
}

async function stopEngine(e: Engine | undefined): Promise<void> {
  if (!e) return;
  if (e.proc.exitCode === null) {
    const exited = new Promise((r) => e.proc.once('exit', r));
    e.proc.kill();
    await exited;
  }
  rmSync(e.dataDir, { recursive: true, force: true });
}

const LOCAL = (host: unknown) =>
  typeof host === 'string' && (host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0');

describe('spawned engine (bootstrap.ts)', () => {
  let dbReady = false;
  beforeAll(async () => {
    try {
      await admin((c) => c.query(`CREATE DATABASE ${DB_NAME}`));
      dbReady = true;
    } catch (err) {
      console.warn(`[offline-matrix] skipping spawned-engine cases: ${(err as Error).message}`);
    }
  }, 60_000);
  afterAll(async () => {
    if (!dbReady) return;
    await admin(async (c) => {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DB_NAME]);
      await c.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    }).catch(() => undefined);
  }, 60_000);

  it('an invalid CL_EGRESS_ALLOW is a fatal config error (the guard is installed at boot)', async () => {
    const e = spawnEngine({ CL_EGRESS_ALLOW: 'not a host' });
    try {
      expect(await e.ready).toEqual({ exitCode: 78 });
      const fatal = e.stderr.find((l) => l.startsWith('{"event":"fatal"'));
      expect(JSON.parse(fatal!)).toMatchObject({ code: 'CL_EGRESS_ALLOW_INVALID' });
    } finally {
      await stopEngine(e);
    }
  }, 60_000);

  it('index.ts refuses to start in desktop mode without the egress guard', async () => {
    if (!dbReady) return;
    // The env bootstrap would derive (index.ts is started directly here).
    const e = spawnEngine({ PORT: '0', QUEUE_BACKEND: 'none', EXPECT_WORKER: 'false', HIBP_DISABLED: '1', SHARE_ENABLED: 'false' }, 'src/index.ts');
    try {
      expect(await e.ready).toEqual({ exitCode: 78 });
      const fatal = e.stderr.find((l) => l.startsWith('{"event":"fatal"'));
      expect(JSON.parse(fatal!)).toMatchObject({ code: 'EGRESS_GUARD_MISSING' });
    } finally {
      await stopEngine(e);
    }
  }, BOOT_TIMEOUT_MS);

  it(`boot + ${Math.round(IDLE_MS / 1000)} s idle: no connection beyond loopback and the database; /health online null`, async () => {
    if (!dbReady) return;
    // The recorder also starts one worker thread that tries 192.0.2.1:9.
    const e = spawnEngine({ CL_TEST_WORKER_PROBE: '1' });
    try {
      const r = await e.ready;
      expect(r).toHaveProperty('port');
      const port = (r as { port: number }).port;
      const h = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-cl-token': TOKEN } });
      expect(await h.json()).toMatchObject({ mode: 'desktop', online: null, lastOnlineCheck: null });

      await new Promise((res) => setTimeout(res, IDLE_MS));

      const entries = existsSync(e.connectLog)
        ? readFileSync(e.connectLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; host?: unknown; thread?: string; code?: string; guarded?: boolean })
        : [];
      // The recorder sits under the guard (main thread and workers), so it
      // proves the allowed traffic was local; it must have seen at least
      // the database connection.
      expect(entries.some((x) => x.kind === 'tcp')).toBe(true);
      const nonLocal = entries.filter((x) => (x.kind === 'tcp' || x.kind === 'dns') && !LOCAL(x.host));
      expect(nonLocal).toEqual([]);
      // Worker threads are watched too: the probe worker ran with the
      // recorder and was refused by the guard inside the worker.
      expect(entries.some((x) => x.kind === 'thread-start' && x.thread === 'worker')).toBe(true);
      expect(entries.filter((x) => x.kind === 'worker-probe')).toEqual([{ kind: 'worker-probe', code: 'EGRESS_BLOCKED', guarded: true }]);
      // ...and nothing else was even attempted and blocked.
      const blockedHosts = e.stderr
        .filter((l) => l.includes('"component":"egress-guard"'))
        .map((l) => (JSON.parse(l.slice(l.indexOf('{'))) as { host: string }).host);
      expect(blockedHosts).toEqual(['192.0.2.1']);
    } finally {
      await stopEngine(e);
    }
  }, BOOT_TIMEOUT_MS + IDLE_MS);
});
