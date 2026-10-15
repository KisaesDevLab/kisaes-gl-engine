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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  it('refuses a non-loopback bind without CL_LAN: one fatal JSON line, exit 78', async () => {
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
    e = spawnEngine({ DATABASE_URL: urlFor(DB_NAME) }, { logFile: true });
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

  it('logs to CL_LOG_FILE and scrubs the launch token from file and console', async () => {
    if (!dbReady) return;
    // The access log prints the URL, so a token in the query string must
    // come out redacted everywhere.
    expect((await call(port, `/api/v1/ping?probe=${TOKEN}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const log = readFileSync(e!.logFile!, 'utf8');
    expect(log).toContain('{"event":"listening"');
    expect(log).toContain('/api/v1/ping?probe=[redacted]');
    expect(log).not.toContain(TOKEN);
    expect(e!.stdout.join(' ')).not.toContain(TOKEN);
    expect(e!.stderr.join(' ')).not.toContain(TOKEN);
  });
});

describe('CL_LAN=1', () => {
  it('allows binding all interfaces', async () => {
    if (!dbReady) return;
    const e = spawnEngine({ DATABASE_URL: urlFor(DB_NAME), CL_BIND: '0.0.0.0:0', CL_LAN: '1' });
    try {
      const r = await e.ready;
      expect(r).toMatchObject({ host: '0.0.0.0' });
      if ('port' in r) expect((await call(r.port, '/api/v1/ping')).status).toBe(200);
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

