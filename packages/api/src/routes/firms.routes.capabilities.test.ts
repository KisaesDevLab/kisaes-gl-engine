// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// GET/PUT /firms/:firmId/users/:firmUserId/capabilities
//   - firm_admin of the firm edits; firm_staff 403 NOT_FIRM_ADMIN; outsider 404
//   - on a superAdminManaged firm (Default Practice) a non-super-admin
//     firm_admin is refused (FIRM_SUPER_ADMIN_MANAGED) while a super admin
//     succeeds
//   - roster (GET /users) carries capabilities + capabilitiesCustomized
//   - unknown keys 400; null reverts; readonly 400 FIRM_ROLE_INELIGIBLE
//   - audit row written

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog } from '../db/schema/index.js';
import { firmsRouter } from './firms.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let tenantId = '', firmId = '', managedFirmId = '';
let saToken = '', adminToken = '', staffToken = '', outsiderToken = '';
let staffFuId = '', readonlyFuId = '', managedAdminFuId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/firms', firmsRouter);
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
async function seedUser(role: string, isSuperAdmin = false) {
  const [u] = await db.insert(users).values({ tenantId, email: `fcap-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role, displayName: role, isSuperAdmin }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role });
  const token = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin, auth_time: Math.floor(Date.now() / 1000) }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return { id: u!.id, token };
}
async function cleanDb() {
  if (tenantId) {
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, tenantId));
    await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  const fids = [firmId, managedFirmId].filter(Boolean);
  if (fids.length) {
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  tenantId = firmId = managedFirmId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'FCap Tenant', slug: `fcap-${sfx()}` }).returning();
  tenantId = t!.id;
  const sa = await seedUser('owner', true); saToken = sa.token;
  const admin = await seedUser('accountant'); adminToken = admin.token;
  const staff = await seedUser('accountant'); staffToken = staff.token;
  const ro = await seedUser('accountant');
  const outsider = await seedUser('accountant'); outsiderToken = outsider.token;

  const [f] = await db.insert(firms).values({ name: 'FCap Firm', slug: `fcap-firm-${sfx()}` }).returning();
  firmId = f!.id;
  await db.insert(firmUsers).values({ firmId, userId: admin.id, firmRole: 'firm_admin' });
  const [sfu] = await db.insert(firmUsers).values({ firmId, userId: staff.id, firmRole: 'firm_staff' }).returning();
  staffFuId = sfu!.id;
  const [rfu] = await db.insert(firmUsers).values({ firmId, userId: ro.id, firmRole: 'firm_readonly' }).returning();
  readonlyFuId = rfu!.id;

  // A super-admin-managed firm where the same admin user is firm_admin.
  const [mf] = await db.insert(firms).values({ name: 'Managed Firm', slug: `fcap-managed-${sfx()}`, superAdminManaged: true }).returning();
  managedFirmId = mf!.id;
  const [mfu] = await db.insert(firmUsers).values({ firmId: managedFirmId, userId: admin.id, firmRole: 'firm_admin' }).returning();
  managedAdminFuId = mfu!.id;
  await startApp();
});
afterEach(async () => { if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; } await cleanDb(); });

const capsPath = (fid: string, fuid: string) => `/api/v1/firms/${fid}/users/${fuid}/capabilities`;

describe('firm member capabilities routes', () => {
  it('firm_admin reads and writes; roster reflects it; audit row written', async () => {
    const before = await request('GET', capsPath(firmId, staffFuId), undefined, adminToken);
    expect(before.status).toBe(200);
    expect(before.json.capabilitiesCustomized).toBe(false);
    expect(before.json.capabilities.team_management).toBe(false);

    const put = await request('PUT', capsPath(firmId, staffFuId), { capabilities: { team_management: true, admin_user_support: true } }, adminToken);
    expect(put.status).toBe(200);
    expect(put.json.capabilitiesCustomized).toBe(true);
    expect(put.json.capabilities.team_management).toBe(true);
    expect(put.json.capabilities.admin_tenant_ops).toBe(false);

    const roster = await request('GET', `/api/v1/firms/${firmId}/users`, undefined, adminToken);
    const row = roster.json.users.find((u: { id: string }) => u.id === staffFuId);
    expect(row.capabilities.admin_user_support).toBe(true);
    expect(row.capabilitiesCustomized).toBe(true);

    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'firm_user_capabilities')));
    expect(audits).toHaveLength(1);

    const cleared = await request('PUT', capsPath(firmId, staffFuId), { capabilities: null }, adminToken);
    expect(cleared.status).toBe(200);
    expect(cleared.json.capabilitiesCustomized).toBe(false);
  });

  it('firm_staff gets 403 NOT_FIRM_ADMIN; outsider gets 404', async () => {
    const s = await request('PUT', capsPath(firmId, staffFuId), { capabilities: { team_management: true } }, staffToken);
    expect(s.status).toBe(403);
    expect(s.json.error.code).toBe('NOT_FIRM_ADMIN');
    expect((await request('GET', capsPath(firmId, staffFuId), undefined, outsiderToken)).status).toBe(404);
  });

  it('unknown keys 400; readonly member 400 FIRM_ROLE_INELIGIBLE; foreign membership id 404', async () => {
    expect((await request('PUT', capsPath(firmId, staffFuId), { capabilities: { bogus: true } }, adminToken)).status).toBe(400);
    const ro = await request('PUT', capsPath(firmId, readonlyFuId), { capabilities: { team_management: true } }, adminToken);
    expect(ro.status).toBe(400);
    expect(ro.json.error.code).toBe('FIRM_ROLE_INELIGIBLE');
    expect((await request('GET', capsPath(firmId, managedAdminFuId), undefined, adminToken)).status).toBe(404);
  });

  it('super-admin-managed firm: firm_admin refused, super admin succeeds', async () => {
    const denied = await request('PUT', capsPath(managedFirmId, managedAdminFuId), { capabilities: {} }, adminToken);
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('FIRM_SUPER_ADMIN_MANAGED');
    const ok = await request('PUT', capsPath(managedFirmId, managedAdminFuId), { capabilities: { admin_tenant_ops: true } }, saToken);
    expect(ok.status).toBe(200);
    expect(ok.json.capabilities.admin_tenant_ops).toBe(true);
  });

  it('changing a member firm role resets a customized set to role defaults', async () => {
    await request('PUT', capsPath(firmId, staffFuId), { capabilities: { team_management: true } }, adminToken);
    const patched = await request('PATCH', `/api/v1/firms/${firmId}/users/${staffFuId}`, { firmRole: 'firm_admin' }, adminToken);
    expect(patched.status).toBe(200);
    expect(patched.json.capabilitiesCustomized).toBe(false);
    expect(patched.json.capabilities.admin_user_support).toBe(true);
  });
});
