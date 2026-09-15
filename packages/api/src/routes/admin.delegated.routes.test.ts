// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Delegated admin: a firm member holding `admin_tenant_ops` /
// `admin_user_support` reaches ONLY the delegable routes, sees ONLY the
// firm's tenants and their users, and is bound by the admin session limits.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog, sessions, tenantFeatureFlags,
} from '../db/schema/index.js';
import { adminRouter } from './admin.routes.js';
import { adminFeatureFlagsRouter } from './feature-flags.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let inScopeId = '', outScopeId = '', firmId = '', otherFirmId = '';
let staffId = '', staffFuId = '', inUserId = '', outUserId = '', saId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/feature-flags', adminFeatureFlagsRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}
function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': String(data.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function seedTenant(name: string) {
  const [t] = await db.insert(tenants).values({ name, slug: `dlg-${name.toLowerCase()}-${sfx()}` }).returning();
  return t!.id;
}
async function seedUser(tenantId: string, role: string, isSuperAdmin = false) {
  const [u] = await db.insert(users).values({ tenantId, email: `dlg-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role, displayName: role, isSuperAdmin }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role });
  return u!.id;
}
function tokenFor(userId: string, tenantId: string, role: string, opts: { isSuperAdmin?: boolean; iatAgoSec?: number; authAgoSec?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  // Explicit exp: a backdated iat must not make the JWT itself expire —
  // the admin idle bound is what is under test, not token expiry.
  return jwt.sign(
    { userId, tenantId, role, isSuperAdmin: opts.isSuperAdmin ?? false, iat: now - (opts.iatAgoSec ?? 0), exp: now + 300, auth_time: now - (opts.authAgoSec ?? 0) },
    process.env['JWT_SECRET']!,
  );
}
async function cleanDb() {
  const tids = [inScopeId, outScopeId].filter(Boolean);
  if (tids.length) {
    const uids = (await db.select({ id: users.id }).from(users).where(inArray(users.tenantId, tids))).map((r) => r.id);
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tids));
    await db.delete(tenantFeatureFlags).where(inArray(tenantFeatureFlags.tenantId, tids));
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.tenantId, tids));
    if (uids.length) {
      await db.delete(sessions).where(inArray(sessions.userId, uids));
      await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
      await db.delete(firmUsers).where(inArray(firmUsers.userId, uids));
    }
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.tenantId, tids));
    await db.delete(users).where(inArray(users.tenantId, tids));
    await db.delete(tenants).where(inArray(tenants.id, tids));
  }
  const fids = [firmId, otherFirmId].filter(Boolean);
  if (fids.length) {
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, fids));
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  inScopeId = outScopeId = firmId = otherFirmId = staffId = staffFuId = inUserId = outUserId = saId = '';
}

beforeEach(async () => {
  await cleanDb();
  inScopeId = await seedTenant('InScope');
  outScopeId = await seedTenant('OutScope');
  inUserId = await seedUser(inScopeId, 'owner');
  outUserId = await seedUser(outScopeId, 'owner');
  saId = await seedUser(outScopeId, 'owner', true);
  // Firm staffer lives in the out-of-scope tenant; the firm manages in-scope.
  staffId = await seedUser(outScopeId, 'accountant');
  const [f] = await db.insert(firms).values({ name: 'Dlg Firm', slug: `dlg-firm-${sfx()}` }).returning();
  firmId = f!.id;
  const [of] = await db.insert(firms).values({ name: 'Other Firm', slug: `dlg-other-${sfx()}` }).returning();
  otherFirmId = of!.id;
  await db.insert(tenantFirmAssignments).values({ firmId, tenantId: inScopeId, isActive: true });
  const [fu] = await db.insert(firmUsers).values({
    firmId, userId: staffId, firmRole: 'firm_staff', capabilities: { admin_tenant_ops: true, admin_user_support: true },
  }).returning();
  staffFuId = fu!.id;
  await startApp();
});
afterEach(async () => { if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; } await cleanDb(); });

const A = '/api/v1/admin';

describe('delegated admin — tenant operations', () => {
  it('GET /tenants is scoped; out-of-scope detail 404; in-scope detail hides super admins', async () => {
    const token = tokenFor(staffId, outScopeId, 'accountant');
    const list = await request('GET', `${A}/tenants`, undefined, token);
    expect(list.status).toBe(200);
    expect(list.json.tenants.map((t: { id: string }) => t.id)).toEqual([inScopeId]);
    expect(list.json.total).toBe(1);
    expect((await request('GET', `${A}/tenants/${outScopeId}`, undefined, token)).status).toBe(404);
    const detail = await request('GET', `${A}/tenants/${inScopeId}`, undefined, token);
    expect(detail.status).toBe(200);
    expect(detail.json.users.some((u: { isSuperAdmin: boolean }) => u.isSuperAdmin)).toBe(false);
    // Super admin remains unfiltered.
    const saList = await request('GET', `${A}/tenants?search=Scope`, undefined, tokenFor(saId, outScopeId, 'owner', { isSuperAdmin: true }));
    expect(saList.json.tenants.length).toBe(2);
  });

  it('in-scope disable/enable + feature flags work; out-of-scope flags 404', async () => {
    const token = tokenFor(staffId, outScopeId, 'accountant');
    expect((await request('POST', `${A}/tenants/${inScopeId}/disable`, undefined, token)).status).toBe(200);
    expect((await request('POST', `${A}/tenants/${inScopeId}/enable`, undefined, token)).status).toBe(200);
    expect((await request('POST', `${A}/tenants/${outScopeId}/disable`, undefined, token)).status).toBe(404);
    expect((await request('GET', `${A}/feature-flags/${inScopeId}`, undefined, token)).status).toBe(200);
    expect((await request('GET', `${A}/feature-flags/${outScopeId}`, undefined, token)).status).toBe(404);
  });

  it('managing-firm reassignment needs firm_admin of every firm involved', async () => {
    const token = tokenFor(staffId, outScopeId, 'accountant');
    // firm_staff (not firm_admin) of the current firm → 404 'Firm not found'.
    expect((await request('POST', `${A}/tenants/${inScopeId}/firm`, { firmId: null }, token)).status).toBe(404);
    await db.update(firmUsers).set({ firmRole: 'firm_admin', capabilities: { admin_tenant_ops: true } }).where(eq(firmUsers.id, staffFuId));
    // Not a member of the target firm → 404.
    expect((await request('POST', `${A}/tenants/${inScopeId}/firm`, { firmId: otherFirmId }, token)).status).toBe(404);
    // Admin of both → OK.
    await db.insert(firmUsers).values({ firmId: otherFirmId, userId: staffId, firmRole: 'firm_admin' });
    const moved = await request('POST', `${A}/tenants/${inScopeId}/firm`, { firmId: otherFirmId }, token);
    expect(moved.status).toBe(200);
    expect(moved.json.current.firmId).toBe(otherFirmId);
  });

  it('never-delegable routes 403 with the uniform message; no admin capability → 403 at the router', async () => {
    const token = tokenFor(staffId, outScopeId, 'accountant');
    for (const [m, p] of [['DELETE', `/tenants/${inScopeId}`], ['POST', `/impersonate/${inUserId}`], ['GET', '/settings'], ['GET', '/metrics'], ['POST', `/users/${inUserId}/toggle-super-admin`], ['POST', `/users/${inUserId}/reset-password`]] as const) {
      const r = await request(m, `${A}${p}`, m === 'POST' ? { password: 'x'.repeat(16) } : undefined, token);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.error.message).toBe('Super admin access required');
    }
    await db.update(firmUsers).set({ capabilities: { team_management: true } }).where(eq(firmUsers.id, staffFuId));
    expect((await request('GET', `${A}/tenants`, undefined, token)).status).toBe(403);
  });

  it('user_support-only member cannot reach tenant ops (ADMIN_CAPABILITY_REQUIRED)', async () => {
    await db.update(firmUsers).set({ capabilities: { admin_user_support: true } }).where(eq(firmUsers.id, staffFuId));
    const r = await request('GET', `${A}/tenants`, undefined, tokenFor(staffId, outScopeId, 'accountant'));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('ADMIN_CAPABILITY_REQUIRED');
  });
});

describe('delegated admin — user support', () => {
  it('GET /users lists only in-scope, non-super-admin users', async () => {
    const r = await request('GET', `${A}/users`, undefined, tokenFor(staffId, outScopeId, 'accountant'));
    expect(r.status).toBe(200);
    const ids = r.json.users.map((u: { id: string }) => u.id);
    expect(ids).toContain(inUserId);
    expect(ids).not.toContain(outUserId);
    expect(ids).not.toContain(saId);
  });

  it('unlock in-scope 200; out-of-scope 404; super-admin target 404; self role change refused', async () => {
    const token = tokenFor(staffId, outScopeId, 'accountant');
    expect((await request('POST', `${A}/users/${inUserId}/unlock`, undefined, token)).status).toBe(200);
    expect((await request('POST', `${A}/users/${outUserId}/unlock`, undefined, token)).status).toBe(404);
    expect((await request('POST', `${A}/users/${saId}/set-role`, { role: 'readonly' }, token)).status).toBe(404);
    // Grant the staffer access on the in-scope tenant and try to self-elevate.
    await db.insert(userTenantAccess).values({ userId: staffId, tenantId: inScopeId, role: 'accountant' });
    // set-role is 'home' scoped: the staffer's home is out of scope → 404.
    expect((await request('POST', `${A}/users/${staffId}/set-role`, { role: 'owner' }, token)).status).toBe(404);
  });

  it('grant-tenant-access only into scope; tenant-access list is filtered', async () => {
    const token = tokenFor(staffId, outScopeId, 'accountant');
    expect((await request('POST', `${A}/users/${inUserId}/grant-tenant-access`, { tenantId: outScopeId, role: 'readonly' }, token)).status).toBe(404);
    const ok = await request('POST', `${A}/users/${outUserId}/grant-tenant-access`, { tenantId: inScopeId, role: 'readonly' }, token);
    // outUser's home is out of scope and they are in no scoped firm → not grantable.
    expect(ok.status).toBe(404);
    const list = await request('GET', `${A}/users/${inUserId}/tenant-access`, undefined, token);
    expect(list.status).toBe(200);
    expect(list.json.access.map((a: { tenantId: string }) => a.tenantId)).toEqual([inScopeId]);
  });

  it('users/create only into an in-scope tenant', async () => {
    const token = tokenFor(staffId, outScopeId, 'accountant');
    const bad = await request('POST', `${A}/users/create`, { email: `c-${sfx()}@example.com`, password: 'Str0ngPassw0rd!!', tenantId: outScopeId, role: 'readonly' }, token);
    expect(bad.status).toBe(404);
    const ok = await request('POST', `${A}/users/create`, { email: `c-${sfx()}@example.com`, password: 'Str0ngPassw0rd!!', tenantId: inScopeId, role: 'owner' }, token);
    expect(ok.status).toBe(201);
  });
});

describe('delegated admin — session bounds and principals', () => {
  it('idle-expired and absolute-expired tokens get 401 ADMIN_SESSION_EXPIRED', async () => {
    const idle = await request('GET', `${A}/tenants`, undefined, tokenFor(staffId, outScopeId, 'accountant', { iatAgoSec: 31 * 60 }));
    expect(idle.status).toBe(401);
    expect(idle.json.error.code).toBe('ADMIN_SESSION_EXPIRED');
    const abs = await request('GET', `${A}/tenants`, undefined, tokenFor(staffId, outScopeId, 'accountant', { authAgoSec: 13 * 3600 }));
    expect(abs.status).toBe(401);
    expect(abs.json.error.code).toBe('ADMIN_SESSION_EXPIRED');
  });
});
