// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Test-only harness for desktop LAN mode (U-289..U-294): a fresh database
 * (migrated), the real app.ts in desktop mode with CL_LAN=1 and both launch
 * tokens, and a caller that speaks as the host app or as a workstation
 * device (what the host proxy would add). Imported by *.test.ts only.
 */

import { vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resetProcessEnv } from '../test-env.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
export const HOST_TOKEN = 'lanharness_host_' + 'h'.repeat(40);
export const LAN_TOKEN = 'lanharness_lan_' + 'w'.repeat(40);
export const DEVICE_A = 'a1'.repeat(32);
export const DEVICE_B = 'b2'.repeat(32);
export const OWNER = { email: 'owner@example.test', displayName: 'Pat Owner', password: 'correct horse battery' };

export type Who = 'host' | { device: string; peer?: string };

export interface CallInit {
  method?: string;
  body?: unknown;
  jwt?: string;
  headers?: Record<string, string>;
  company?: string;
}

export interface LanEngine {
  dbUrl: string;
  close: () => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: (who: Who, p: string, init?: CallInit) => Promise<{ status: number; json: any; cookies: string[] }>;
  /** Signs the owner in from `who`; returns the tokens. */
  login: (who: Who, cred?: { email: string; password: string }) => Promise<{ accessToken: string; refreshToken: string }>;
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
  /** The company tenant made by first run (empty when initialize is false). */
  company: string;
  /** A request with a ready body (multipart FormData); headers as call(). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callRaw: (who: Who, p: string, init: { method: string; jwt?: string; body: FormData }) => Promise<{ status: number; json: any }>;
  /** Signs the owner in from `who` and switches into the company; returns the access token. */
  signIn: (who: Who) => Promise<string>;
}

function urlFor(base: string, db: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

async function onDb<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Fresh DB + LAN-mode app; `initialize` runs first run with OWNER and one company. */
export async function startLanEngine(opts: { env?: Record<string, string>; initialize?: boolean } = {}): Promise<LanEngine> {
  const savedEnv = { ...process.env };
  const base = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
  const dbName = `cl_lan_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await onDb(urlFor(base, 'postgres'), (c) => c.query(`CREATE DATABASE ${dbName}`));
  const dbUrl = urlFor(base, dbName);
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  } finally {
    await pool.end();
  }

  vi.resetModules();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cl-lan-test-'));
  resetProcessEnv(savedEnv);
  process.env['DATABASE_URL'] = dbUrl;
  process.env['DATA_DIR'] = dataDir;
  process.env['CONFIG_DIR'] = path.join(dataDir, 'config');
  process.env['BCRYPT_ROUNDS'] = '4';
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const profile = await import('./profile.js');
  profile.loadDesktopProfile({
    CL_MODE: 'desktop', CL_TOKEN: HOST_TOKEN, CL_LAN: '1', CL_LAN_TOKEN: LAN_TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: dataDir,
  });
  const { app } = await import('../app.js');
  const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  setDesktopBoundAddress('127.0.0.1', port);

  const call: LanEngine['call'] = async (who, p, init = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (who === 'host') headers['x-cl-token'] = HOST_TOKEN;
    else {
      headers['x-cl-token'] = LAN_TOKEN;
      headers['x-forwarded-for'] = who.peer ?? '192.168.1.50';
      headers['x-cl-device'] = who.device;
    }
    if (init.jwt) headers['authorization'] = `Bearer ${init.jwt}`;
    if (init.company) headers['x-company-id'] = init.company;
    const method = init.method ?? 'GET';
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    return { status: r.status, json, cookies: r.headers.getSetCookie() };
  };

  const callRaw: LanEngine['callRaw'] = async (who, p, init) => {
    const headers: Record<string, string> = {};
    if (who === 'host') headers['x-cl-token'] = HOST_TOKEN;
    else {
      headers['x-cl-token'] = LAN_TOKEN;
      headers['x-forwarded-for'] = who.peer ?? '192.168.1.50';
      headers['x-cl-device'] = who.device;
    }
    if (init.jwt) headers['authorization'] = `Bearer ${init.jwt}`;
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: init.method, headers, body: init.body });
    const text = await r.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    return { status: r.status, json };
  };

  const login: LanEngine['login'] = async (who, cred = OWNER) => {
    const r = await call(who, '/api/v1/auth/login', { method: 'POST', body: { email: cred.email, password: cred.password } });
    if (r.status !== 200) throw new Error(`login ${r.status}: ${JSON.stringify(r.json)}`);
    // The refresh token travels in the kb_refresh cookie (or the body, on older engines).
    const cookie = r.cookies.map((c) => /^kb_refresh=([^;]+)/.exec(c)?.[1]).find((v) => v);
    return { accessToken: r.json.tokens.accessToken, refreshToken: r.json.tokens.refreshToken ?? decodeURIComponent(cookie ?? '') };
  };

  const query: LanEngine['query'] = async (text, params = []) =>
    onDb(dbUrl, async (c) => (await c.query(text, params as unknown[])).rows);

  let company = '';
  if (opts.initialize !== false) {
    const r = await call('host', '/api/v1/desktop/initialize', {
      method: 'POST',
      body: { admin: OWNER, company: { name: 'Lan Test Co', entityType: 'llc_single', industry: 'Retail' } },
    });
    if (r.status !== 201) throw new Error(`initialize ${r.status}: ${JSON.stringify(r.json)}`);
    company = r.json.companyTenantId;
  }

  const signIn: LanEngine['signIn'] = async (who) => {
    const t0 = await login(who);
    const r = await call(who, '/api/v1/auth/switch-tenant', { method: 'POST', jwt: t0.accessToken, body: { tenantId: company } });
    if (r.status !== 200) throw new Error(`switch ${r.status}: ${JSON.stringify(r.json)}`);
    return r.json.tokens.accessToken as string;
  };

  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const { pool: appPool, healthPool } = await import('../db/index.js');
    await appPool.end().catch(() => undefined);
    await healthPool.end().catch(() => undefined);
    profile._resetDesktopProfileForTests();
    resetProcessEnv(savedEnv);
    rmSync(dataDir, { recursive: true, force: true });
    await onDb(urlFor(base, 'postgres'), async (c) => {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [dbName]);
      await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
    }).catch(() => undefined);
  };

  return { dbUrl, close, call, callRaw, login, query, company, signIn };
}
