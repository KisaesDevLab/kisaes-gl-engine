// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Desktop workspace tenant (G-E1) and its guards (MT20). Loads the REAL
// app.ts in desktop mode against fresh databases copied from a migrated
// template, and talks to it over HTTP like the desktop app does. Needs the
// test PostgreSQL (DATABASE_URL) with a role that may CREATE DATABASE;
// skipped with a message otherwise. The last block checks that the same
// helpers are no-ops on the server (CL_MODE unset).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resetProcessEnv } from '../test-env.js';

const API_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(API_SRC, 'db', 'migrations');
const TOKEN = 'wstest_' + 'z'.repeat(44);
const baseUrl = process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test';
const stamp = `${process.pid}_${Date.now()}`;
const TEMPLATE = `cl_ws_tmpl_${stamp}`;
const DB = {
  main: `cl_ws_main_${stamp}`, empty: `cl_ws_empty_${stamp}`, fail: `cl_ws_fail_${stamp}`, conc: `cl_ws_conc_${stamp}`,
  audit: `cl_ws_audit_${stamp}`,
};
const OWNER = { email: 'Owner@Example.com', displayName: 'Pat Owner', password: 'correct horse battery' };

function urlFor(db: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

async function onDb<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let dbReady = false;
const savedEnv = { ...process.env };

beforeAll(async () => {
  try {
    await onDb('postgres', (c) => c.query(`CREATE DATABASE ${TEMPLATE}`));
  } catch (err) {
    console.warn(`[workspace.test] skipping DB-backed tests: ${(err as Error).message}`);
    return;
  }
  const pool = new pg.Pool({ connectionString: urlFor(TEMPLATE), max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  } finally {
    await pool.end();
  }
  for (const name of Object.values(DB)) {
    await onDb('postgres', (c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`));
  }
  dbReady = true;
}, 300_000);

afterAll(async () => {
  resetProcessEnv(savedEnv);
  vi.resetModules();
  await onDb('postgres', async (c) => {
    for (const name of [...Object.values(DB), TEMPLATE]) {
      await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [name]);
      await c.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  }).catch(() => undefined);
}, 120_000);

interface Engine {
  port: number;
  dataDir: string;
  close: () => Promise<void>;
  call: (p: string, init?: { method?: string; body?: unknown; jwt?: string; headers?: Record<string, string> }) => Promise<{ status: number; json: any }>;
}

/** Fresh module graph, desktop profile, the real app.ts on DB `dbName`. */
async function startDesktop(dbName: string): Promise<Engine> {
  vi.resetModules();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cl-ws-test-'));
  // In place, never `process.env = {...}` (see test-env.ts).
  resetProcessEnv(savedEnv);
  process.env['DATABASE_URL'] = urlFor(dbName);
  process.env['DATA_DIR'] = dataDir;
  process.env['CONFIG_DIR'] = path.join(dataDir, 'config');
  process.env['BCRYPT_ROUNDS'] = '4';
  const profile = await import('./profile.js');
  profile.loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: dataDir });
  const { app } = await import('../app.js');
  const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  setDesktopBoundAddress('127.0.0.1', port);
  const call: Engine['call'] = async (p, init = {}) => {
    const headers: Record<string, string> = { 'x-cl-token': TOKEN, ...(init.headers ?? {}) };
    if (init.jwt) headers['authorization'] = `Bearer ${init.jwt}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const { pool } = await import('../db/index.js');
    await pool.end().catch(() => undefined);
    profile._resetDesktopProfileForTests();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { port, dataDir, close, call };
}

async function firmRowCount(c: pg.Client): Promise<number> {
  const r = await c.query(`SELECT
    (SELECT COUNT(*) FROM firms) + (SELECT COUNT(*) FROM firm_users) + (SELECT COUNT(*) FROM tenant_firm_assignments) AS n`);
  return Number(r.rows[0].n);
}

async function login(e: Engine): Promise<{ jwt: string; json: any }> {
  const r = await e.call('/api/v1/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { jwt: r.json.tokens.accessToken as string, json: r.json };
}

async function switchTo(e: Engine, jwt: string, tenantId: string): Promise<string> {
  const r = await e.call('/api/v1/auth/switch-tenant', { method: 'POST', jwt, body: { tenantId } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.tokens.accessToken as string;
}

// --- initialize with a company, then everything a session can do ----------

describe('desktop workspace: initialize with a company', () => {
  let e: Engine;
  let ws = '';
  let company = '';
  let ownerId = '';
  let wsJwt = '';
  let coJwt = '';

  beforeAll(async () => {
    if (!dbReady) return;
    e = await startDesktop(DB.main);
  }, 120_000);

  afterAll(async () => {
    if (e) await e.close();
  });

  it('info has no workspace before first run', async () => {
    if (!dbReady) return;
    const r = await e.call('/api/v1/desktop/info');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ initialized: false, workspaceTenantId: null });
  });

  it('an unknown chart-of-accounts template is a 400 and writes nothing', async () => {
    if (!dbReady) return;
    const r = await e.call('/api/v1/desktop/initialize', {
      method: 'POST',
      body: { admin: OWNER, company: { name: 'Acme', businessType: 'no-such-template' } },
    });
    expect(r.status).toBe(400);
    const n = await onDb(DB.main, async (c) => Number((await c.query('SELECT COUNT(*) AS n FROM tenants')).rows[0].n));
    expect(n).toBe(0);
  });

  it('creates the workspace, the owner and the company; no firm rows; second run 409', async () => {
    if (!dbReady) return;
    const r = await e.call('/api/v1/desktop/initialize', {
      method: 'POST',
      body: { admin: OWNER, company: { name: 'Acme Plumbing LLC', entityType: 'llc_single', industry: 'Plumbing' } },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toEqual({
      workspaceTenantId: expect.any(String),
      userId: expect.any(String),
      companyTenantId: expect.any(String),
      warnings: [],
      recoveryKey: expect.stringMatching(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){4}$/),
    });
    ws = r.json.workspaceTenantId;
    company = r.json.companyTenantId;
    ownerId = r.json.userId;
    // U-23: only the SHA-256 of the normalised key is stored.
    const keyHash = crypto.createHash('sha256').update(String(r.json.recoveryKey).replace(/-/g, '')).digest('hex');
    await onDb(DB.main, async (c) => {
      expect((await c.query('SELECT recovery_key_hash FROM users')).rows).toEqual([{ recovery_key_hash: keyHash }]);
    });

    await onDb(DB.main, async (c) => {
      const wsRows = (await c.query('SELECT id, name, slug FROM tenants WHERE is_workspace')).rows;
      expect(wsRows).toHaveLength(1);
      expect(wsRows[0]).toMatchObject({ id: ws, name: 'Workspace' });
      expect(wsRows[0].slug).toMatch(/^workspace-[0-9a-f]{8}$/);
      expect((await c.query('SELECT 1 FROM companies WHERE tenant_id = $1', [ws])).rowCount).toBe(0);
      const owner = (await c.query('SELECT tenant_id, email, role, is_super_admin FROM users')).rows;
      expect(owner).toEqual([{ tenant_id: ws, email: 'owner@example.com', role: 'owner', is_super_admin: true }]);
      const access = (await c.query('SELECT tenant_id, role, is_active FROM user_tenant_access ORDER BY role, tenant_id')).rows;
      expect(access).toEqual(expect.arrayContaining([
        { tenant_id: ws, role: 'owner', is_active: true },
        { tenant_id: company, role: 'owner', is_active: true },
      ]));
      expect(access).toHaveLength(2);
      const co = (await c.query('SELECT business_name, entity_type, industry FROM companies WHERE tenant_id = $1', [company])).rows;
      expect(co).toEqual([{ business_name: 'Acme Plumbing LLC', entity_type: 'llc_single', industry: 'Plumbing' }]);
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM accounts WHERE tenant_id = $1', [company])).rows[0].n)).toBeGreaterThan(10);
      expect(await firmRowCount(c)).toBe(0);
    });
    expect(existsSync(path.join(e.dataDir, 'config', '.initialized'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(e.dataDir, 'config', '.initialized'), 'utf8'))).toMatchObject({
      via: 'desktop/initialize',
      workspaceTenantId: ws,
    });
    expect(existsSync(path.join(e.dataDir, 'config', '.env'))).toBe(false);
    expect(existsSync(path.join(e.dataDir, '.sentinel'))).toBe(false);

    const again = await e.call('/api/v1/desktop/initialize', {
      method: 'POST',
      body: { admin: { ...OWNER, email: 'other@example.com' } },
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('ALREADY_INITIALIZED');
    const info = await e.call('/api/v1/desktop/info');
    expect(info.json).toMatchObject({ initialized: true, workspaceTenantId: ws });
  });

  it('login lands in the workspace, which still appears in accessibleTenants', async () => {
    if (!dbReady) return;
    const l = await login(e);
    wsJwt = l.jwt;
    expect(l.json.accessibleTenants.map((t: { tenantId: string }) => t.tenantId).sort()).toEqual([ws, company].sort());
    const me = await e.call('/api/v1/auth/me', { jwt: wsJwt });
    expect(me.status).toBe(200);
    expect(me.json.activeTenantId).toBe(ws);
    expect(me.json.companies).toEqual([]);
  });

  it('the workspace fence: books routes are 409 WORKSPACE_TENANT, auth routes pass', async () => {
    if (!dbReady) return;
    for (const [method, p] of [
      ['GET', '/api/v1/accounts'],
      ['POST', '/api/v1/company/create'],
      ['PUT', '/api/v1/company'],
      ['POST', '/api/v1/transactions'],
      ['GET', '/api/v1/accounts?x=/api/v1/auth/'],
      ['GET', '/api/v1/auth/../accounts'],
      ['GET', '/api/v1/tenant-settings'],
      ['GET', '/api/v2/me'],
      ['GET', '/api/v1/admin/tenants'],
    ] as const) {
      const r = await e.call(p, { method, jwt: wsJwt, body: method === 'GET' ? undefined : {} });
      expect(r.status, `${method} ${p}`).toBe(409);
      expect(r.json.error.code, `${method} ${p}`).toBe('WORKSPACE_TENANT');
    }
    expect((await e.call('/api/v1/auth/me', { jwt: wsJwt })).status).toBe(200);
    const prefs = await e.call('/api/v1/auth/me/preferences', { method: 'PUT', jwt: wsJwt, body: { theme: 'dark' } });
    expect(prefs.status, JSON.stringify(prefs.json)).toBe(200);
    expect((await e.call('/api/v1/auth/create-tenant/eligibility', { jwt: wsJwt })).json).toMatchObject({ enabled: false, allowed: true });
  });

  it('the fence covers API keys and download tokens too', async () => {
    if (!dbReady) return;
    const { db } = await import('../db/index.js');
    const { apiKeys } = await import('../db/schema/index.js');
    const raw = { ws: crypto.randomBytes(24).toString('hex'), co: crypto.randomBytes(24).toString('hex') };
    const hash = (k: string) => crypto.createHash('sha256').update(k).digest('hex');
    await db.insert(apiKeys).values([
      { tenantId: ws, userId: ownerId, name: 'ws', keyPrefix: 'ws', keyHash: hash(raw.ws), role: 'owner' },
      { tenantId: company, userId: ownerId, name: 'co', keyPrefix: 'co', keyHash: hash(raw.co), role: 'owner' },
    ]);
    const wsKey = await e.call('/api/v1/accounts', { headers: { 'x-api-key': raw.ws } });
    expect(wsKey.status).toBe(409);
    expect(wsKey.json.error.code).toBe('WORKSPACE_TENANT');
    expect((await e.call('/api/v1/accounts', { headers: { 'x-api-key': raw.co } })).status).toBe(200);

    const { issueDownloadToken } = await import('../utils/download-token.js');
    const claims = { userId: ownerId, userRole: 'owner', isSuperAdmin: true, companyId: null };
    const dlWs = issueDownloadToken({ ...claims, tenantId: ws }).token;
    const r = await e.call(`/api/v1/accounts?_dl=${dlWs}`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('WORKSPACE_TENANT');
    const dlCo = issueDownloadToken({ ...claims, tenantId: company }).token;
    expect((await e.call(`/api/v1/accounts?_dl=${dlCo}`)).status).toBe(200);
  });

  it('after switching to the company the owner reads the chart of accounts', async () => {
    if (!dbReady) return;
    coJwt = await switchTo(e, wsJwt, company);
    const accounts = await e.call('/api/v1/accounts', { jwt: coJwt });
    expect(accounts.status).toBe(200);
    // Back to the workspace is allowed too (switch-tenant is an auth route).
    expect((await e.call('/api/v1/accounts', { jwt: await switchTo(e, coJwt, ws) })).status).toBe(409);
  });

  it('switch-tenant to a tenant that does not exist is 404 TENANT_NOT_FOUND', async () => {
    if (!dbReady) return;
    for (const tenantId of [crypto.randomUUID(), 'not-a-uuid']) {
      const r = await e.call('/api/v1/auth/switch-tenant', { method: 'POST', jwt: wsJwt, body: { tenantId } });
      expect(r.status, tenantId).toBe(404);
      expect(r.json.error.code).toBe('TENANT_NOT_FOUND');
    }
  });

  it('create-tenant from the workspace: owner access row, no firm rows', async () => {
    if (!dbReady) return;
    const r = await e.call('/api/v1/auth/create-tenant', { method: 'POST', jwt: wsJwt, body: { companyName: 'Second Co' } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    await onDb(DB.main, async (c) => {
      const a = (await c.query('SELECT role FROM user_tenant_access WHERE tenant_id = $1 AND user_id = $2', [r.json.tenantId, ownerId])).rows;
      expect(a).toEqual([{ role: 'owner' }]);
      expect(await firmRowCount(c)).toBe(0);
    });
  });

  it('register and create-client are not available', async () => {
    if (!dbReady) return;
    const reg = await e.call('/api/v1/auth/register', {
      method: 'POST',
      body: { email: 'x@example.com', password: 'another long password', displayName: 'X', companyName: 'X' },
    });
    expect(reg.status).toBe(404);
    expect(reg.json.error.code).toBe('NOT_AVAILABLE_IN_DESKTOP');
    const cc = await e.call('/api/v1/auth/create-client', { method: 'POST', jwt: coJwt, body: { companyName: 'Client' } });
    expect(cc.status).toBe(404);
    expect(cc.json.error.code).toBe('NOT_AVAILABLE_IN_DESKTOP');
    const setup = await import('../services/setup.service.js');
    await expect(setup.createAdminUser({ email: 'a@example.com', password: 'p'.repeat(12), displayName: 'A', companyName: 'A' }))
      .rejects.toThrow(/desktop mode/);
  });

  it('invite homes a new user in the workspace (readonly) with the company role; never into the workspace', async () => {
    if (!dbReady) return;
    const r = await e.call('/api/v1/company/invite-user', {
      method: 'POST',
      jwt: coJwt,
      body: { email: 'Bookkeeper@Example.com', displayName: 'Book Keeper', role: 'bookkeeper' },
    });
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
    await onDb(DB.main, async (c) => {
      const u = (await c.query(`SELECT id, tenant_id FROM users WHERE email = 'bookkeeper@example.com'`)).rows[0];
      expect(u.tenant_id).toBe(ws);
      const a = (await c.query('SELECT tenant_id, role FROM user_tenant_access WHERE user_id = $1 ORDER BY role', [u.id])).rows;
      expect(a).toEqual([{ tenant_id: company, role: 'bookkeeper' }, { tenant_id: ws, role: 'readonly' }]);
    });
    const auth = await import('../services/auth.service.js');
    await expect(auth.inviteUser(ws, { email: 'n@example.com', displayName: 'N', role: 'readonly' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'WORKSPACE_TENANT' });
  });

  it('refresh in the workspace keeps the workspace role (readonly), not the company role', async () => {
    if (!dbReady) return;
    const auth = await import('../services/auth.service.js');
    const invited = await auth.inviteUser(company, { email: 'accountant@example.com', displayName: 'Acc', role: 'accountant' });
    const l = await auth.login({ email: 'accountant@example.com', password: invited.temporaryPassword! } as Parameters<typeof auth.login>[0]);
    const roleOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).role as string;
    expect(roleOf(l.tokens.accessToken)).toBe('readonly');
    const t = await auth.refresh(l.tokens.refreshToken);
    expect(roleOf(t.accessToken)).toBe('readonly');
    // The owner keeps owner in the workspace.
    const o = await auth.login({ email: OWNER.email, password: OWNER.password } as Parameters<typeof auth.login>[0]);
    expect(roleOf((await auth.refresh(o.tokens.refreshToken)).accessToken)).toBe('owner');
  });

  it('attachment download from a workspace session is fenced (409 WORKSPACE_TENANT)', async () => {
    if (!dbReady) return;
    const r = await e.call(`/api/v1/attachments/${crypto.randomUUID()}/download`, { jwt: wsJwt });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('WORKSPACE_TENANT');
    // From the company it is an ordinary lookup (404: no such attachment).
    const co = await e.call(`/api/v1/attachments/${crypto.randomUUID()}/download`, { jwt: coJwt });
    expect(co.status).toBe(404);
  });

  it('admin create-user homes the user in the workspace; the workspace is not a valid target', async () => {
    if (!dbReady) return;
    const ok = await e.call('/api/v1/admin/users/create', {
      method: 'POST',
      jwt: coJwt,
      body: { email: 'Clerk@Example.com', password: 'a long clerk password', displayName: 'Clerk', tenantId: company, role: 'readonly' },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBeLessThan(300);
    await onDb(DB.main, async (c) => {
      const u = (await c.query(`SELECT id, tenant_id FROM users WHERE email = 'clerk@example.com'`)).rows[0];
      expect(u.tenant_id).toBe(ws);
      const a = (await c.query('SELECT tenant_id, role FROM user_tenant_access WHERE user_id = $1 ORDER BY tenant_id = $2', [u.id, ws])).rows;
      expect(a).toEqual([{ tenant_id: company, role: 'readonly' }, { tenant_id: ws, role: 'readonly' }]);
    });
    const bad = await e.call('/api/v1/admin/users/create', {
      method: 'POST',
      jwt: coJwt,
      body: { email: 'nope@example.com', password: 'a long clerk password', tenantId: ws, role: 'readonly' },
    });
    expect(bad.status).toBe(409);
    expect(bad.json.error.code).toBe('WORKSPACE_TENANT');
  });

  it('MT20: admin tenant routes refuse the workspace and the destructive ones refuse companies', async () => {
    if (!dbReady) return;
    // Bodies pass each route's validation, so the guard is what answers.
    const bodies: Record<string, unknown> = {
      firm: { firmId: null },
      'suspense-consolidation': { accountIds: [crypto.randomUUID()] },
      'retained-earnings': { accountId: crypto.randomUUID() },
      'system-accounts/ar': { accountId: null },
      'apply-coa-template': { templateSlug: 'default' },
      'delete-transactions-range': { startDate: '2026-01-01', endDate: '2026-01-31' },
    };
    const bodyFor = (p: string) => bodies[Object.keys(bodies).find((k) => p.endsWith(`/${k}`)) ?? ''] ?? {};
    const sub = (id: string): Array<[string, string]> => [
      ['GET', `/tenants/${id}`],
      ['POST', `/tenants/${id}/firm`],
      ['GET', `/tenants/${id}/retained-earnings`],
      ['POST', `/tenants/${id}/retained-earnings`],
      ['GET', `/tenants/${id}/system-accounts`],
      ['PUT', `/tenants/${id}/system-accounts/ar`],
      ['GET', `/tenants/${id}/suspense-consolidation`],
      ['POST', `/tenants/${id}/suspense-consolidation`],
      ['POST', `/tenants/${id}/disable`],
      ['POST', `/tenants/${id}/enable`],
      ['POST', `/tenants/${id}/apply-coa-template`],
      ['DELETE', `/tenants/${id}`],
      ['DELETE', `/tenants/${id}/chart-of-accounts`],
      ['DELETE', `/tenants/${id}/transactions`],
      ['DELETE', `/tenants/${id}/companies/${crypto.randomUUID()}`],
      ['DELETE', `/tenants/${id}/payroll-import-history`],
      ['GET', `/tenants/${id}/transactions-range-count?startDate=2026-01-01&endDate=2026-01-31`],
      ['POST', `/tenants/${id}/delete-transactions-range`],
    ];
    for (const [method, p] of sub(ws)) {
      const r = await e.call(`/api/v1/admin${p}`, { method, jwt: coJwt, body: method === 'GET' ? undefined : bodyFor(p) });
      expect(r.status, `${method} ${p}`).toBe(409);
      expect(r.json.error.code, `${method} ${p}`).toBe('WORKSPACE_TENANT');
    }
    const expected: Record<string, [number, string]> = {
      [`DELETE /tenants/${company}`]: [409, 'USE_SAFE_DELETE'],
      [`POST /tenants/${company}/disable`]: [409, 'USE_SAFE_DELETE'],
      [`DELETE /tenants/${company}/chart-of-accounts`]: [404, 'NOT_AVAILABLE_IN_DESKTOP'],
      [`DELETE /tenants/${company}/transactions`]: [404, 'NOT_AVAILABLE_IN_DESKTOP'],
      [`DELETE /tenants/${company}/payroll-import-history`]: [404, 'NOT_AVAILABLE_IN_DESKTOP'],
      [`POST /tenants/${company}/delete-transactions-range`]: [404, 'NOT_AVAILABLE_IN_DESKTOP'],
    };
    for (const [key, [status, code]] of Object.entries(expected)) {
      const [method, p] = key.split(' ') as [string, string];
      const r = await e.call(`/api/v1/admin${p}`, { method, jwt: coJwt, body: method === 'GET' ? undefined : bodyFor(p) });
      expect(r.status, key).toBe(status);
      expect(r.json.error.code, key).toBe(code);
    }
    const del = await e.call(`/api/v1/admin/tenants/${company}/companies/${crypto.randomUUID()}`, { method: 'DELETE', jwt: coJwt });
    expect(del.status).toBe(404);
    expect(del.json.error.code).toBe('NOT_AVAILABLE_IN_DESKTOP');
    // A read-only company route still works.
    expect((await e.call(`/api/v1/admin/tenants/${company}`, { jwt: coJwt })).status).toBe(200);
    // Nothing was disabled or deleted.
    await onDb(DB.main, async (c) => {
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM users WHERE is_active = false')).rows[0].n)).toBe(0);
      expect((await c.query('SELECT 1 FROM tenants WHERE id = $1', [company])).rowCount).toBe(1);
    });
  });

  it('MT20: .vmx and /api/v1/backup are unmounted, passphrase-strength stays', async () => {
    if (!dbReady) return;
    for (const [method, p] of [
      ['GET', '/api/v1/tenant-export/export'],
      ['POST', '/api/v1/tenant-export/import'],
      ['POST', '/api/v1/backup/create'],
      ['POST', '/api/v1/backup/restore'],
      ['GET', '/api/v1/backup'],
    ] as const) {
      const r = await e.call(p, { method, jwt: coJwt, body: method === 'GET' ? undefined : {} });
      expect(r.status, `${method} ${p}`).toBe(404);
      expect(r.json.error.code, `${method} ${p}`).toBe('NOT_AVAILABLE_IN_DESKTOP');
    }
    const s = await e.call('/api/v1/backup/passphrase-strength', { method: 'POST', jwt: coJwt, body: { passphrase: 'short' } });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ valid: false });
  });

  it('a second workspace violates the unique index', async () => {
    if (!dbReady) return;
    await onDb(DB.main, async (c) => {
      await expect(c.query(`INSERT INTO tenants (name, slug, is_workspace) VALUES ('W2', 'workspace-second', true)`))
        .rejects.toMatchObject({ code: '23505' });
      const flags = (await c.query('SELECT is_workspace, COUNT(*)::int AS n FROM tenants GROUP BY is_workspace ORDER BY is_workspace')).rows;
      expect(flags).toEqual([{ is_workspace: false, n: 2 }, { is_workspace: true, n: 1 }]);
    });
  });

  it('the boot invariant check passes for this install', async () => {
    if (!dbReady) return;
    const { checkWorkspaceInvariant } = await import('./workspace.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await checkWorkspaceInvariant()).toMatchObject({ ok: true, workspaces: 1, users: 4 }); // owner, bookkeeper, accountant, admin-created clerk
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// --- initialize without a company -----------------------------------------

describe('desktop workspace: concurrent initialize', () => {
  let e: Engine;

  beforeAll(async () => {
    if (!dbReady) return;
    e = await startDesktop(DB.conc);
  }, 120_000);

  afterAll(async () => {
    if (e) await e.close();
  });

  it('exactly one of several simultaneous calls creates the owner; the setup lock is not left behind', async () => {
    if (!dbReady) return;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        e.call('/api/v1/desktop/initialize', {
          method: 'POST',
          body: { admin: { ...OWNER, email: `owner${i}@example.com` } },
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201), JSON.stringify(results.map((r) => r.json))).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(['SETUP_BUSY', 'ALREADY_INITIALIZED']).toContain(r.json?.error?.code);
    }
    await onDb(DB.conc, async (c) => {
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM users')).rows[0].n)).toBe(1);
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM tenants WHERE is_workspace')).rows[0].n)).toBe(1);
      // No pooled connection still holds the session lock.
      const free = (await c.query('SELECT pg_try_advisory_lock(4242424242::bigint) AS locked')).rows[0].locked;
      expect(free).toBe(true);
      await c.query('SELECT pg_advisory_unlock(4242424242::bigint)');
    });
    // A later call is answered by the emptiness check, not by a stuck lock.
    const again = await e.call('/api/v1/desktop/initialize', { method: 'POST', body: { admin: OWNER } });
    expect(again.json?.error?.code).toBe('ALREADY_INITIALIZED');
  });
});

describe('desktop workspace: initialize without a company', () => {
  let e: Engine;
  let ws = '';

  beforeAll(async () => {
    if (!dbReady) return;
    e = await startDesktop(DB.empty);
  }, 120_000);

  afterAll(async () => {
    if (e) await e.close();
  });

  it('creates only the workspace and the owner', async () => {
    if (!dbReady) return;
    const r = await e.call('/api/v1/desktop/initialize', { method: 'POST', body: { admin: OWNER } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ companyTenantId: null, warnings: [] });
    ws = r.json.workspaceTenantId;
    await onDb(DB.empty, async (c) => {
      expect((await c.query('SELECT id FROM tenants')).rows).toEqual([{ id: ws }]);
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM companies')).rows[0].n)).toBe(0);
      expect((await c.query('SELECT role FROM user_tenant_access')).rows).toEqual([{ role: 'owner' }]);
      expect(await firmRowCount(c)).toBe(0);
    });
    const l = await login(e);
    const me = await e.call('/api/v1/auth/me', { jwt: l.jwt });
    expect(me.json).toMatchObject({ activeTenantId: ws, companies: [] });
    expect(me.json.accessibleTenants.map((t: { tenantId: string }) => t.tenantId)).toEqual([ws]);
  });

  it('one tick of each enabled scheduler runs with zero companies', async () => {
    if (!dbReady) return;
    const { schedulerEnabled } = await import('./features.js');
    expect(['sessionPrune', 'fingerprint', 'aiRetention'].every((n) => schedulerEnabled(n as 'recurring'))).toBe(true);
    // The app drives the recurring run (POST /recurring/run-due, U-63); the timer is off.
    expect(schedulerEnabled('recurring')).toBe(false);
    const recurring = await import('../services/recurring.service.js');
    const fp = await import('../services/db-fingerprint.service.js');
    const ai = await import('../services/ai-retention.service.js');
    await expect(recurring.processAllDue()).resolves.toBeDefined();
    await expect(fp.updateFingerprint()).resolves.toBeDefined();
    expect(existsSync(fp.getFingerprintPath())).toBe(true);
    await expect(ai.purgeOldAiJobs(30)).resolves.toBe(0);
    await expect(ai.purgeOldChatConversations(30)).resolves.toBe(0);
  });

  it('the boot invariant check warns (counts and ids only) on a user homed in a company', async () => {
    if (!dbReady) return;
    const company = crypto.randomUUID();
    const strayId = crypto.randomUUID();
    await onDb(DB.empty, async (c) => {
      await c.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Stray Co', $2)`, [company, `stray-${stamp}`]);
      await c.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, display_name) VALUES ($1, $2, 'stray@example.com', 'x', 'Stray Name')`,
        [strayId, company],
      );
    });
    const { checkWorkspaceInvariant } = await import('./workspace.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const report = await checkWorkspaceInvariant();
      expect(report).toMatchObject({ ok: false, workspaces: 1, users: 2, usersNotHomed: 1, usersWithoutWorkspaceAccess: 1, sampleUserIds: [strayId] });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(warn.mock.calls[0]![0]));
      expect(line).toMatchObject({ event: 'warning', code: 'WORKSPACE_INVARIANT' });
      expect(line.message).toContain(strayId);
      expect(line.message).not.toContain('stray@example.com');
      expect(line.message).not.toContain('Stray');
    } finally {
      warn.mockRestore();
    }
  });
});

// --- per-user security audit rows reach the company -----------------------

describe('desktop workspace: per-user security audit rows go to the company', () => {
  let e: Engine;
  let ws = '';
  let company = '';
  let ownerId = '';
  let bkId = '';
  let recoveryKey = '';
  const BK = { email: 'clerk@example.com', chosen: 'clerk-chose-this-one-7', second: 'clerk-second-choice-8' };
  const EVENTS = ['user_password_change', 'user_password_change_failed', 'user_password_recovery',
    'user_password_recovery_failed', 'user_login_failed', 'user_recovery_key'];
  const secrets: string[] = [];

  beforeAll(async () => {
    if (!dbReady) return;
    e = await startDesktop(DB.audit);
  }, 120_000);

  afterAll(async () => {
    if (e) await e.close();
  });

  const rowsIn = (tenant: string) => onDb(DB.audit, async (c) => (await c.query(
    `SELECT entity_type, entity_id, user_id, before_data, after_data FROM audit_log
      WHERE tenant_id = $1 AND entity_type = ANY($2) ORDER BY created_at`, [tenant, EVENTS])).rows);

  it('set up: a company, its owner and an invited bookkeeper (homed in the workspace)', async () => {
    if (!dbReady) return;
    const r = await e.call('/api/v1/desktop/initialize', { method: 'POST', body: { admin: OWNER, company: { name: 'Audit Co' } } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ({ workspaceTenantId: ws, companyTenantId: company, userId: ownerId, recoveryKey } = r.json);
    const coJwt = await switchTo(e, (await login(e)).jwt, company);
    const inv = await e.call('/api/v1/company/invite-user', {
      method: 'POST', jwt: coJwt, body: { email: BK.email, displayName: 'Clerk', role: 'bookkeeper' },
    });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    bkId = inv.json.user.id;
    await onDb(DB.audit, async (c) => {
      expect((await c.query('SELECT tenant_id FROM users WHERE id = $1', [bkId])).rows).toEqual([{ tenant_id: ws }]);
      const temp = (await c.query('SELECT password_change_required FROM users WHERE id = $1', [bkId])).rows[0];
      expect(temp.password_change_required).toBe(true);
    });
    // The invite's temporary password is set by us so the test knows it.
    const { default: bcryptLib } = await import('bcrypt');
    await onDb(DB.audit, (c) => c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcryptLib.hashSync('clerk-temp-pass-1', 4), bkId]));
    secrets.push('clerk-temp-pass-1', BK.chosen, BK.second, recoveryKey, recoveryKey.replace(/-/g, ''));
  });

  it('own password changes (forced from the workspace, failed, ordinary from the company) and a failed sign-in', async () => {
    if (!dbReady) return;
    const l = await e.call('/api/v1/auth/login', { method: 'POST', body: { email: BK.email, password: 'clerk-temp-pass-1' } });
    expect(l.status, JSON.stringify(l.json)).toBe(200);
    expect(l.json.user.passwordChangeRequired).toBe(true);
    const wsJwt = l.json.tokens.accessToken as string;
    // Forced change from the workspace session the sign-in lands in.
    const forced = await e.call('/api/v1/auth/change-password', {
      method: 'POST', jwt: wsJwt, body: { currentPassword: 'clerk-temp-pass-1', newPassword: BK.chosen },
    });
    expect(forced.status, JSON.stringify(forced.json)).toBe(200);
    const wsJwt2 = forced.json.tokens.accessToken as string;
    const wrong = await e.call('/api/v1/auth/change-password', {
      method: 'POST', jwt: wsJwt2, body: { currentPassword: 'not-my-password-0', newPassword: BK.second },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe('INVALID_CURRENT_PASSWORD');
    // Ordinary change from a company session.
    const coJwt = await switchTo(e, wsJwt2, company);
    const normal = await e.call('/api/v1/auth/change-password', {
      method: 'POST', jwt: coJwt, body: { currentPassword: BK.chosen, newPassword: BK.second },
    });
    expect(normal.status, JSON.stringify(normal.json)).toBe(200);
    const badLogin = await e.call('/api/v1/auth/login', { method: 'POST', body: { email: BK.email, password: 'guessing-wrong-1' } });
    expect(badLogin.status).toBe(401);

    const rows = await rowsIn(company);
    const of = (t: string) => rows.filter((x) => x.entity_type === t);
    expect(of('user_password_change')).toHaveLength(2);
    for (const row of of('user_password_change')) {
      expect(row).toMatchObject({ entity_id: bkId, user_id: bkId, before_data: null });
      expect(JSON.parse(row.after_data)).toEqual({ sessionsRevoked: true });
    }
    expect(of('user_password_change_failed')).toEqual([expect.objectContaining({ entity_id: bkId, user_id: bkId, after_data: null })]);
    expect(of('user_login_failed')).toHaveLength(1);
    expect(JSON.parse(of('user_login_failed')[0]!.after_data)).toMatchObject({ attempts: 1, locked: false });
  });

  it('recovery-key use and failure, and a rotation from the workspace', async () => {
    if (!dbReady) return;
    const recover = (key: string, newPassword: string) =>
      e.call('/api/v1/desktop/recover-password', { method: 'POST', body: { email: OWNER.email, recoveryKey: key, newPassword } });
    expect((await recover('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', 'owner-recovered-pass-9')).status).toBe(401);
    const ok = await recover(recoveryKey, OWNER.password);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    secrets.push(ok.json.recoveryKey);
    const rot = await e.call('/api/v1/auth/recovery-key/rotate', { method: 'POST', jwt: (await login(e)).jwt });
    expect(rot.status, JSON.stringify(rot.json)).toBe(200);
    secrets.push(rot.json.recoveryKey);
    // The failure row is written without waiting (no email guessing by timing).
    await expect.poll(async () => (await rowsIn(company)).filter((x) => x.entity_type === 'user_password_recovery_failed').length).toBe(1);
    const rows = (await rowsIn(company)).filter((x) => x.user_id === ownerId);
    expect(rows.map((x) => x.entity_type).sort()).toEqual(['user_password_recovery', 'user_password_recovery_failed', 'user_recovery_key']);
    expect(JSON.parse(rows.find((x) => x.entity_type === 'user_password_recovery_failed')!.after_data)).toEqual({ reason: 'wrong_key' });
  });

  it('the owner sees them in GET /audit-log?company=current; none is left in the workspace; no secret anywhere', async () => {
    if (!dbReady) return;
    const coJwt = await switchTo(e, (await login(e)).jwt, company);
    let text = '';
    for (const t of EVENTS) {
      const listed = await e.call(`/api/v1/audit-log?company=current&entity_type=${t}`, { jwt: coJwt });
      expect(listed.status, JSON.stringify(listed.json)).toBe(200);
      expect(listed.json.total, t).toBe(t === 'user_password_change' ? 2 : 1);
      text += JSON.stringify(listed.json);
    }
    expect(await rowsIn(ws)).toEqual([]);
    const [hashes] = await onDb(DB.audit, async (c) => [(await c.query('SELECT password_hash, recovery_key_hash FROM users')).rows]);
    text += JSON.stringify(await rowsIn(company));
    for (const s of [...secrets, ...hashes.flatMap((h: Record<string, string>) => Object.values(h))]) {
      if (s) expect(text).not.toContain(s);
    }
  });
});

// --- the first company fails ----------------------------------------------

describe('desktop workspace: the first company cannot be created', () => {
  let e: Engine;

  beforeAll(async () => {
    if (!dbReady) return;
    // Any failure while provisioning the company: here the companies insert.
    await onDb(DB.fail, async (c) => {
      await c.query(`CREATE FUNCTION cl_ws_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected company failure'; END $$`);
      await c.query('CREATE TRIGGER cl_ws_test_fail BEFORE INSERT ON companies FOR EACH ROW EXECUTE FUNCTION cl_ws_test_fail()');
    });
    e = await startDesktop(DB.fail);
  }, 120_000);

  afterAll(async () => {
    if (e) await e.close();
  });

  it('201 with COMPANY_NOT_CREATED; workspace and owner stay, no half-built company', async () => {
    if (!dbReady) return;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let r: Awaited<ReturnType<Engine['call']>>;
    try {
      r = await e.call('/api/v1/desktop/initialize', { method: 'POST', body: { admin: OWNER, company: { name: 'Acme' } } });
    } finally {
      warn.mockRestore();
    }
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ companyTenantId: null, warnings: ['COMPANY_NOT_CREATED'] });
    await onDb(DB.fail, async (c) => {
      expect((await c.query('SELECT id, is_workspace FROM tenants')).rows).toEqual([{ id: r.json.workspaceTenantId, is_workspace: true }]);
      expect((await c.query('SELECT tenant_id FROM users')).rows).toEqual([{ tenant_id: r.json.workspaceTenantId }]);
      expect((await c.query('SELECT tenant_id FROM user_tenant_access')).rows).toEqual([{ tenant_id: r.json.workspaceTenantId }]);
    });
    expect((await e.call('/api/v1/desktop/info')).json.workspaceTenantId).toBe(r.json.workspaceTenantId);
  });

  it('migration 0216 rolls back and re-applies', async () => {
    if (!dbReady) return;
    const fwd = readFileSync(path.join(MIGRATIONS, '0216_tenants_is_workspace.sql'), 'utf8');
    const back = readFileSync(path.join(MIGRATIONS, '0216_tenants_is_workspace.rollback.sql'), 'utf8');
    await onDb(TEMPLATE, async (c) => {
      const has = async () => ({
        column: (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'is_workspace'`)).rowCount,
        index: (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_tenants_workspace'`)).rowCount,
      });
      expect(await has()).toEqual({ column: 1, index: 1 });
      await c.query(back);
      expect(await has()).toEqual({ column: 0, index: 0 });
      await c.query(back); // idempotent
      await c.query(fwd);
      await c.query(fwd); // idempotent
      expect(await has()).toEqual({ column: 1, index: 1 });
      // Server tenants read false by default.
      await c.query(`INSERT INTO tenants (name, slug) VALUES ('Server Co', 'server-co-${stamp}')`);
      expect((await c.query(`SELECT is_workspace FROM tenants WHERE slug = 'server-co-${stamp}'`)).rows).toEqual([{ is_workspace: false }]);
    });
  });
});

// --- server mode: every helper is a no-op ---------------------------------

describe('workspace helpers on the server (CL_MODE unset)', () => {
  it('no workspace, no fence, no guard, no refusal', async () => {
    vi.resetModules();
    resetProcessEnv(savedEnv);
    const profile = await import('./profile.js');
    profile.loadDesktopProfile({});
    const w = await import('./workspace.js');
    const { notInDesktop } = await import('./features.js');
    // None of these may touch the database on the server.
    const { db } = await import('../db/index.js');
    const select = vi.spyOn(db, 'select');
    try {
      expect(await w.getWorkspaceTenantId()).toBeNull();
      expect(await w.isWorkspaceTenant(crypto.randomUUID())).toBe(false);
      await expect(w.assertNotWorkspace(crypto.randomUUID())).resolves.toBeUndefined();
      await expect(w.guardAdminTenantRoute(crypto.randomUUID(), 'safe-delete')).resolves.toBeUndefined();
      await expect(w.workspaceFence({ tenantId: crypto.randomUUID(), originalUrl: '/api/v1/accounts' } as never)).resolves.toBeUndefined();
      expect(await w.checkWorkspaceInvariant()).toBeNull();
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
    const next = vi.fn();
    notInDesktop('x')({} as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    profile._resetDesktopProfileForTests();
  });

  it('the allowlist matches whole segments and fails closed on odd paths', async () => {
    const { isWorkspacePathAllowed, WORKSPACE_ALLOWED_PREFIXES } = await import('./workspace.js');
    expect(WORKSPACE_ALLOWED_PREFIXES).toEqual(['/api/v1/auth/', '/api/v1/tenants', '/api/v1/tenant-archives', '/api/v1/desktop/']);
    for (const p of ['/api/v1/auth/me', '/api/v1/auth/me/preferences', '/api/v1/tenants', '/api/v1/tenants/x', '/api/v1/tenant-archives/jobs/1', '/api/v1/desktop/info']) {
      expect(isWorkspacePathAllowed(p), p).toBe(true);
    }
    for (const p of [
      '/api/v1/auth', '/api/v1/tenant-settings', '/api/v1/tenantsx', '/api/v1/accounts', '/api/v1/desktop',
      '/api/v1/auth/../accounts', '/api/v1/auth/%2e%2e/accounts', '/api/v1/auth/..%2Faccounts', '/API/V1/AUTH/me',
      '/api/v1/auth\\..\\accounts', '/api/v1/tenants/./x',
    ]) {
      expect(isWorkspacePathAllowed(p), p).toBe(false);
    }
  });
});
