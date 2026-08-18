// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Regression tests for the 2026-08-18 security review fixes:
//
//   1. Cross-tenant account takeover via Team "edit user": an owner of
//      tenant B who has invited an existing user (home tenant A) must not
//      be able to rewrite that user's email or trigger a password reset,
//      and inviting a super-admin must not attach them to the tenant.
//   2. API-key role escalation: a readonly member cannot mint an
//      'accountant' key; API-key principals cannot call switch-tenant
//      (would mint a full session) or mint further keys.
//   3. Book export/backup surfaces are gated on company_settings:update
//      (readonly members are refused).
//   4. Download tokens (?_dl=) are GET-only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { inArray, eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, apiKeys, userTenantAccess } from '../db/schema/index.js';
import { companyRouter } from './company.routes.js';
import { apiKeysRouter } from './api-keys.routes.js';
import { authRouter } from './auth.routes.js';
import { apiV2Router } from './api-v2.routes.js';
import { backupRouter } from './backup.routes.js';
import { tenantExportRouter } from './tenant-export.routes.js';
import * as authService from '../services/auth.service.js';
import { issueDownloadToken } from '../utils/download-token.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;

const PFX = 'sec-hardening-20260818';
const OWNER_A = `${PFX}-owner-a@example.com`;
const OWNER_B = `${PFX}-owner-b@example.com`;
const READONLY_B = `${PFX}-readonly-b@example.com`;
const SUPER = `${PFX}-super@example.com`;
const ALL_EMAILS = [OWNER_A, OWNER_B, READONLY_B, SUPER];

async function cleanDb() {
  const rows = await db.select({ id: users.id, tenantId: users.tenantId }).from(users).where(inArray(users.email, ALL_EMAILS));
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const userIds = rows.map((r) => r.id);
  if (userIds.length) {
    await db.delete(apiKeys).where(inArray(apiKeys.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
  }
  if (tenantIds.length) {
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.tenantId, tenantIds));
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
    await db.delete(accounts).where(inArray(accounts.tenantId, tenantIds));
    await db.delete(companies).where(inArray(companies.tenantId, tenantIds));
    await db.delete(users).where(inArray(users.tenantId, tenantIds));
    await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  }
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/company', companyRouter);
  app.use('/api/v1/api-keys', apiKeysRouter);
  app.use('/api/v1/backup', backupRouter);
  app.use('/api/v1/tenant-export', tenantExportRouter);
  app.use('/api/v2', apiV2Router);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(data ? { 'Content-Length': String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); }
          catch { resolve({ status: res.statusCode ?? 0, json: { raw } }); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  await cleanDb();
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

async function twoTenants() {
  const a = await authService.register({ email: OWNER_A, password: 'password123', displayName: 'Owner A', companyName: 'Tenant A' });
  const b = await authService.register({ email: OWNER_B, password: 'password123', displayName: 'Owner B', companyName: 'Tenant B' });
  return { a, b };
}

describe('C1 — cross-tenant account takeover via Team edit-user', () => {
  it('owner B cannot rewrite the email of an invited user whose home tenant is A', async () => {
    const { a, b } = await twoTenants();
    // B invites the existing user A (grants a UTA row — this is allowed).
    await authService.inviteUser(b.user.tenantId, { email: OWNER_A, displayName: 'Owner A', role: 'accountant' }, b.user.id);

    const res = await request('PATCH', `/api/v1/company/users/${a.user.id}`, {
      email: `${PFX}-attacker@example.com`, displayName: 'Owner A', role: 'accountant',
    }, bearer(b.tokens.accessToken));
    expect(res.status).toBe(403);
    expect(res.json['error']?.code).toBe('USER_MANAGED_ELSEWHERE');

    const still = await db.query.users.findFirst({ where: eq(users.id, a.user.id) });
    expect(still!.email).toBe(OWNER_A);
  });

  it('owner B cannot trigger a password reset for a non-home user', async () => {
    const { a, b } = await twoTenants();
    await authService.inviteUser(b.user.tenantId, { email: OWNER_A, displayName: 'Owner A', role: 'accountant' }, b.user.id);
    const res = await request('POST', `/api/v1/company/users/${a.user.id}/send-password-reset`, {}, bearer(b.tokens.accessToken));
    expect(res.status).toBe(403);
  });

  it('owner still manages home-tenant users (email + reset)', async () => {
    const { b } = await twoTenants();
    const invited = await authService.inviteUser(b.user.tenantId, { email: READONLY_B, displayName: 'RO', role: 'readonly' }, b.user.id);
    const res = await request('PATCH', `/api/v1/company/users/${invited.user.id}`, {
      email: READONLY_B, displayName: 'RO renamed', role: 'readonly',
    }, bearer(b.tokens.accessToken));
    expect(res.status).toBe(200);
    expect(res.json['user']?.displayName).toBe('RO renamed');
  });

  it('inviting a super-admin does not attach them to the tenant', async () => {
    const { a, b } = await twoTenants();
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, a.user.id));
    const r = await authService.inviteUser(b.user.tenantId, { email: OWNER_A, displayName: 'SA', role: 'accountant' }, b.user.id);
    expect(r.existingUser).toBe(true);
    const uta = await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, a.user.id), eq(userTenantAccess.tenantId, b.user.tenantId)),
    });
    expect(uta).toBeUndefined();
  });
});

describe('API keys — role clamp and no session minting', () => {
  it('a readonly member cannot mint an accountant key', async () => {
    const { b } = await twoTenants();
    const ro = await authService.inviteUser(b.user.tenantId, { email: READONLY_B, displayName: 'RO', role: 'readonly' }, b.user.id);
    const login = await authService.login({ email: READONLY_B, password: ro.temporaryPassword! });
    const res = await request('POST', '/api/v1/api-keys', { name: 'esc', role: 'accountant' }, bearer(login.tokens.accessToken));
    expect(res.status).toBe(403);
    expect(res.json['error']?.code).toBe('API_KEY_ROLE_ESCALATION');
    const ok = await request('POST', '/api/v1/api-keys', { name: 'ro', role: 'readonly' }, bearer(login.tokens.accessToken));
    expect(ok.status).toBe(201);
  });

  it('an API key cannot call switch-tenant or mint more keys', async () => {
    const { b } = await twoTenants();
    const created = await request('POST', '/api/v1/api-keys', { name: 'k', role: 'owner' }, bearer(b.tokens.accessToken));
    expect(created.status).toBe(201);
    const key = created.json['apiKey'];
    expect(typeof key).toBe('string');

    const sw = await request('POST', '/api/v1/auth/switch-tenant', { tenantId: b.user.tenantId }, { 'x-api-key': key });
    expect(sw.status).toBe(403);
    expect(sw.json['error']?.code).toBe('SESSION_AUTH_REQUIRED');

    const sw2 = await request('POST', '/api/v2/tenants/switch', { tenantId: b.user.tenantId }, { 'x-api-key': key });
    expect(sw2.status).toBe(403);

    const mint = await request('POST', '/api/v1/api-keys', { name: 'k2', role: 'owner' }, { 'x-api-key': key });
    expect(mint.status).toBe(403);
  });
});

describe('export / backup surfaces require company_settings:update', () => {
  it('a readonly member is refused; the owner is not', async () => {
    const { b } = await twoTenants();
    const ro = await authService.inviteUser(b.user.tenantId, { email: READONLY_B, displayName: 'RO', role: 'readonly' }, b.user.id);
    const login = await authService.login({ email: READONLY_B, password: ro.temporaryPassword! });

    const r1 = await request('POST', '/api/v1/backup/create', { passphrase: 'correct horse battery staple 42' }, bearer(login.tokens.accessToken));
    expect(r1.status).toBe(403);
    const r2 = await request('POST', '/api/v1/tenant-export/', { passphrase: 'correct horse battery staple 42' }, bearer(login.tokens.accessToken));
    expect(r2.status).toBe(403);
    const r3 = await request('GET', '/api/v1/backup/history', undefined, bearer(login.tokens.accessToken));
    expect(r3.status).toBe(403);

    // Owner passes the permission gate (whatever the handler then does).
    const r4 = await request('GET', '/api/v1/backup/history', undefined, bearer(b.tokens.accessToken));
    expect(r4.status).not.toBe(403);
  });
});

describe('download tokens are GET-only', () => {
  it('rejects a POST carrying ?_dl=', async () => {
    const { b } = await twoTenants();
    const { token } = issueDownloadToken({ userId: b.user.id, tenantId: b.user.tenantId, userRole: 'owner', isSuperAdmin: false, companyId: null });
    const res = await request('POST', `/api/v1/api-keys?_dl=${encodeURIComponent(token)}`, { name: 'x' });
    expect(res.status).toBe(401);
  });
});
