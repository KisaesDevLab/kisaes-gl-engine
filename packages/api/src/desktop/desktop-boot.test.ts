// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// End-to-end desktop boot: spawns the real `src/bootstrap.ts` (through tsx)
// with CL_MODE=desktop and NO Redis, against a fresh database created for
// this file, and talks to it over HTTP like the desktop supervisor does.
// Needs the test PostgreSQL (DATABASE_URL) with a role that may CREATE
// DATABASE; skipped with a message otherwise.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = crypto.randomBytes(32).toString('base64url');
const BOOT_TIMEOUT_MS = 240_000;

const baseUrl = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
function urlFor(db: string, user?: { name: string; password: string }): string {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
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
  stdout: string[];
  stderr: string[];
  /** Resolves with the ready line, or with the exit when startup fails. */
  ready: Promise<{ host: string; port: number } | { exitCode: number | null }>;
  dataDir: string;
  logFile?: string;
}

const PASS_THROUGH = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

function spawnEngine(extra: Record<string, string | undefined>, opts: { logFile?: boolean } = {}): Engine {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cl-desktop-boot-'));
  const logFile = opts.logFile ? path.join(dataDir, 'logs', 'engine.log') : undefined;
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
    BCRYPT_ROUNDS: '4',
  });
  if (logFile) env['CL_LOG_FILE'] = logFile;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/bootstrap.ts'], {
    cwd: API_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ready = new Promise<{ host: string; port: number } | { exitCode: number | null }>((resolve) => {
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        stdout.push(line);
        if (line.startsWith('{"event":"listening"')) {
          const parsed = JSON.parse(line) as { host: string; port: number };
          resolve({ host: parsed.host, port: parsed.port });
        }
      }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => {
      stderr.push(...chunk.split('\n').filter((l) => l.trim() !== ''));
    });
    proc.on('exit', (code) => resolve({ exitCode: code }));
  });
  return { proc, stdout, stderr, ready, dataDir, logFile };
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

function fatalLine(e: Engine): { event: string; code: string; message: string } | undefined {
  const line = e.stderr.find((l) => l.startsWith('{"event":"fatal"'));
  return line ? JSON.parse(line) : undefined;
}

async function call(
  port: number,
  p: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token !== null) headers['x-cl-token'] = init.token ?? TOKEN;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

// --- shared fresh database ------------------------------------------------

const DB_NAME = `cl_desktop_boot_${process.pid}_${Date.now()}`;
let dbReady = false;
let skipReason = '';

beforeAll(async () => {
  try {
    await admin((c) => c.query(`CREATE DATABASE ${DB_NAME}`));
    dbReady = true;
  } catch (err) {
    skipReason = `cannot create a scratch database: ${(err as Error).message}`;
    console.warn(`[desktop-boot] skipping DB-backed boots: ${skipReason}`);
  }
}, 60_000);

afterAll(async () => {
  if (!dbReady) return;
  await admin(async (c) => {
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [DB_NAME]);
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  }).catch(() => undefined);
}, 60_000);

// --- startup refusals (no database needed) --------------------------------

describe('desktop startup refusals', () => {
  it('refuses a non-loopback bind: one fatal JSON line, exit 78', async () => {
    const e = spawnEngine({ CL_BIND: '0.0.0.0:0', DATABASE_URL: urlFor('unused') });
    try {
      const r = await e.ready;
      expect(r).toEqual({ exitCode: 78 });
      expect(fatalLine(e)).toMatchObject({ event: 'fatal', code: 'CL_BIND_NOT_LOOPBACK' });
    } finally {
      await stopEngine(e);
    }
  }, BOOT_TIMEOUT_MS);

  it('refuses to start without CL_TOKEN and never echoes secrets', async () => {
    const e = spawnEngine({ CL_TOKEN: undefined, DATABASE_URL: urlFor('unused') });
    try {
      expect(await e.ready).toEqual({ exitCode: 78 });
      expect(fatalLine(e)?.code).toBe('CL_TOKEN_REQUIRED');
    } finally {
      await stopEngine(e);
    }
  }, BOOT_TIMEOUT_MS);

  it('missing engine secrets are reported by name only', async () => {
    const e = spawnEngine({ JWT_SECRET: undefined, DATABASE_URL: urlFor('unused') });
    try {
      expect(await e.ready).toEqual({ exitCode: 78 });
      expect(fatalLine(e)).toMatchObject({ code: 'ENV_MISSING', message: expect.stringContaining('JWT_SECRET') });
      expect(e.stderr.join('\n')).not.toContain(TOKEN);
    } finally {
      await stopEngine(e);
    }
  }, BOOT_TIMEOUT_MS);
});

// --- a running desktop engine ---------------------------------------------

describe('desktop engine on port 0', () => {
  let e: Engine | undefined;
  let port = 0;

  beforeAll(async () => {
    if (!dbReady) return;
    e = spawnEngine({ DATABASE_URL: urlFor(DB_NAME), ENGINE_COMMIT: 'abc1234def' }, { logFile: true });
    const r = await e.ready;
    if (!('port' in r)) {
      throw new Error(`engine did not start (exit ${r.exitCode}):\n${e.stderr.slice(-30).join('\n')}`);
    }
    expect(r.host).toBe('127.0.0.1');
    port = r.port;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stopEngine(e);
  }, 60_000);

  it('prints exactly one ready line with the real port', () => {
    if (!dbReady) return;
    expect(port).toBeGreaterThan(0);
    expect(e!.stdout.filter((l) => l.startsWith('{"event":"listening"'))).toHaveLength(1);
  });

  it('answers on that port only with the token', async () => {
    if (!dbReady) return;
    expect((await call(port, '/api/v1/ping')).status).toBe(200);
    expect((await call(port, '/api/v1/ping', { token: null })).status).toBe(401);
  });

  it('/health: 200 without Redis, v2 fields, and it needs the token too', async () => {
    if (!dbReady) return;
    const journal = JSON.parse(
      readFileSync(path.join(API_ROOT, 'src', 'db', 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    for (const p of ['/health', '/api/health', '/api/v1/health']) {
      const r = await call(port, p);
      expect(r.status, p).toBe(200);
      expect(r.json).toMatchObject({
        status: 'ok',
        db: 'ok',
        redis: 'disabled',
        queue: 'ok',
        workers: 'ok',
        mode: 'desktop',
        engineCommit: 'abc1234def',
        schemaVersion: journal.entries.length,
        schemaTag: journal.entries[journal.entries.length - 1]!.tag,
        queueBackend: 'pgboss',
        online: null,
        lastOnlineCheck: null,
      });
      expect(typeof r.json.version).toBe('string');
      expect(typeof r.json.checks.db.superuser).toBe('boolean');
      expect((await call(port, p, { token: null })).status).toBe(401);
    }
  });

  it('logs to CL_LOG_FILE and scrubs the launch token from file and console', async () => {
    if (!dbReady) return;
    // Desktop access log prints the path only, so the query string (and a
    // token in it) never reaches the log.
    expect((await call(port, `/api/v1/ping?probe=${TOKEN}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const log = readFileSync(e!.logFile!, 'utf8');
    expect(log).toContain('{"event":"listening"');
    expect(log).toContain('GET /api/v1/ping HTTP');
    expect(log).not.toContain('probe=');
    expect(log).not.toContain(TOKEN);
    expect(e!.stdout.join(' ')).not.toContain(TOKEN);
    expect(e!.stderr.join(' ')).not.toContain(TOKEN);
  });
});

describe('desktop first run: info and initialize', () => {
  let e: Engine | undefined;
  let port = 0;
  const owner = { email: 'owner@example.com', displayName: 'Pat Owner', password: 'correct horse battery' };
  let workspaceTenantId = '';
  let companyTenantId = '';

  beforeAll(async () => {
    if (!dbReady) return;
    e = spawnEngine({ DATABASE_URL: urlFor(DB_NAME) });
    const r = await e.ready;
    if (!('port' in r)) throw new Error(`engine did not start (exit ${r.exitCode}): ${e.stderr.slice(-30).join(' | ')}`);
    port = r.port;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stopEngine(e);
  }, 60_000);

  it('info reports a fresh desktop install', async () => {
    if (!dbReady) return;
    const r = await call(port, '/api/v1/desktop/info');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      mode: 'desktop',
      queueBackend: 'pgboss',
      offline: 'auto',
      lan: false,
      dataDirExists: true,
      initialized: false,
      workspaceTenantId: null,
    });
    expect(typeof r.json.dbSuperuser).toBe('boolean');
    expect(r.json.capabilities).toContain('register-exact-v1');
    expect(r.json.capabilities).toEqual(expect.arrayContaining(['check-edit-v1', 'line-billable-v1', 'rules-evaluate-v1']));
  });

  it('rejects an invalid first-run body', async () => {
    if (!dbReady) return;
    const r = await call(port, '/api/v1/desktop/initialize', {
      method: 'POST',
      body: { admin: { ...owner, password: 'short' }, company: { name: 'Acme' } },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');
    const noAdmin = await call(port, '/api/v1/desktop/initialize', { method: 'POST', body: { company: { name: 'Acme' } } });
    expect(noAdmin.status).toBe(400);
  });

  it('creates the workspace, the owner and the first company, writes no secrets, then refuses a second run', async () => {
    if (!dbReady) return;
    const r = await call(port, '/api/v1/desktop/initialize', {
      method: 'POST',
      body: { admin: owner, company: { name: 'Acme Plumbing LLC' } },
    });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({
      workspaceTenantId: expect.any(String),
      userId: expect.any(String),
      companyTenantId: expect.any(String),
      warnings: [],
    });
    workspaceTenantId = r.json.workspaceTenantId;
    companyTenantId = r.json.companyTenantId;

    // No .env and no installation sentinel; only the non-secret marker.
    expect(existsSync(path.join(e!.dataDir, 'config', '.env'))).toBe(false);
    expect(existsSync(path.join(e!.dataDir, '.sentinel'))).toBe(false);
    expect(existsSync(path.join(e!.dataDir, 'config', '.initialized'))).toBe(true);

    const again = await call(port, '/api/v1/desktop/initialize', {
      method: 'POST',
      body: { admin: { ...owner, email: 'other@example.com' } },
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('ALREADY_INITIALIZED');
    const info = (await call(port, '/api/v1/desktop/info')).json;
    expect(info).toMatchObject({ initialized: true, workspaceTenantId });
  });

  it('the owner signs in to the workspace, opens the company and reads its chart of accounts (token + JWT)', async () => {
    if (!dbReady) return;
    const login = await call(port, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: owner.email, password: owner.password },
    });
    expect(login.status).toBe(200);
    const wsJwt = login.json.tokens.accessToken as string;
    // The workspace has no books: open a company first.
    const fenced = await call(port, '/api/v1/accounts', { headers: { authorization: `Bearer ${wsJwt}` } });
    expect(fenced.status).toBe(409);
    expect(fenced.json.error.code).toBe('WORKSPACE_TENANT');
    const sw = await call(port, '/api/v1/auth/switch-tenant', {
      method: 'POST',
      headers: { authorization: `Bearer ${wsJwt}` },
      body: { tenantId: companyTenantId },
    });
    expect(sw.status).toBe(200);
    const jwt = sw.json.tokens.accessToken as string;
    const accounts = await call(port, '/api/v1/accounts', { headers: { authorization: `Bearer ${jwt}` } });
    expect(accounts.status).toBe(200);
    // The JWT alone is not enough: the transport token is still required.
    const noToken = await call(port, '/api/v1/accounts', { token: null, headers: { authorization: `Bearer ${jwt}` } });
    expect(noToken.status).toBe(401);
    expect(noToken.json.error.code).toBe('DESKTOP_TOKEN_REQUIRED');
  });

  it('the appliance setup wizard is not available', async () => {
    if (!dbReady) return;
    const r = await call(port, '/api/setup/initialize', { method: 'POST', body: {} });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('NOT_AVAILABLE_IN_DESKTOP');
  });
});

describe('database role (non-superuser owner)', () => {
  const role = { name: `cl_np_${process.pid}`, password: crypto.randomBytes(12).toString('hex') };
  const npDb = `cl_np_db_${process.pid}_${Date.now()}`;
  let roleReady = false;

  beforeAll(async () => {
    if (!dbReady) return;
    try {
      await admin(async (c) => {
        await c.query(`CREATE ROLE ${role.name} LOGIN PASSWORD '${role.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
        await c.query(`CREATE DATABASE ${npDb} OWNER ${role.name}`);
      });
      roleReady = true;
    } catch (err) {
      console.warn(`[desktop-boot] skipping non-superuser boot: ${(err as Error).message}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (!roleReady) return;
    await admin(async (c) => {
      await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [npDb]);
      await c.query(`DROP DATABASE IF EXISTS ${npDb}`);
      await c.query(`DROP ROLE IF EXISTS ${role.name}`);
    }).catch(() => undefined);
  }, 60_000);

  it('a NOSUPERUSER database owner migrates a fresh database and boots under CL_REQUIRE_NON_SUPERUSER=1', async () => {
    if (!roleReady) return;
    const e = spawnEngine({ DATABASE_URL: urlFor(npDb, role), CL_REQUIRE_NON_SUPERUSER: '1' });
    try {
      const r = await e.ready;
      if (!('port' in r)) throw new Error(`engine did not start (exit ${r.exitCode}): ${e.stderr.slice(-30).join(' | ')}`);
      const info = await call(r.port, '/api/v1/desktop/info');
      expect(info.json.dbSuperuser).toBe(false);
      expect(e.stderr.join(' ')).not.toContain('DB_SUPERUSER');
      expect(e.stderr.join(' ')).not.toContain(role.password);
    } finally {
      await stopEngine(e);
    }
  }, BOOT_TIMEOUT_MS);

  it('a superuser role is refused under CL_REQUIRE_NON_SUPERUSER=1 (and only warned about otherwise)', async () => {
    if (!dbReady) return;
    const isSuper = await admin(async (c) =>
      (await c.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0]?.rolsuper === true,
    );
    if (!isSuper) return; // the test role is not a superuser: nothing to refuse
    const e = spawnEngine({ DATABASE_URL: urlFor(DB_NAME), CL_REQUIRE_NON_SUPERUSER: '1' });
    try {
      expect(await e.ready).toEqual({ exitCode: 78 });
      expect(fatalLine(e)?.code).toBe('DB_SUPERUSER_FORBIDDEN');
    } finally {
      await stopEngine(e);
    }
  }, BOOT_TIMEOUT_MS);
});

describe('CL_LAN=1', () => {
  it('is refused until LAN mode has TLS: one fatal JSON line, exit 78', async () => {
    const e = spawnEngine({ DATABASE_URL: urlFor('unused'), CL_BIND: '0.0.0.0:0', CL_LAN: '1' });
    try {
      expect(await e.ready).toEqual({ exitCode: 78 });
      expect(fatalLine(e)).toMatchObject({ event: 'fatal', code: 'CL_LAN_UNSUPPORTED' });
    } finally {
      await stopEngine(e);
    }
  }, BOOT_TIMEOUT_MS);
});

describe('bind failure', () => {
  it('a port already in use is a BIND_FAILED fatal line, exit 1', async () => {
    if (!dbReady) return;
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = (blocker.address() as net.AddressInfo).port;
    const e = spawnEngine({ DATABASE_URL: urlFor(DB_NAME), CL_BIND: `127.0.0.1:${busy}` });
    try {
      expect(await e.ready).toEqual({ exitCode: 1 });
      expect(fatalLine(e)?.code).toBe('BIND_FAILED');
    } finally {
      await stopEngine(e);
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  }, BOOT_TIMEOUT_MS);
});

