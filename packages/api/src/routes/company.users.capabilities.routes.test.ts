// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Owner parity via firm member access rights on the Team endpoints.
//   - firm_staff with `team_management`, active access on a tenant the firm
//     manages: invite (201) and promote a teammate to owner (200)
//   - same user on a tenant the firm does NOT manage: 403
//   - firm_staff without the capability: 403
//   - firm_readonly (with a stored set that must be ignored): 403
//   - super admin still passes; Stripe needs `integrations_payments`, not
//     `team_management`

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
  tenants, users, companies, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog, sessions,
} from '../db/schema/index.js';
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let managedId = '', unmanagedId = '', firmId = '';
let staffUserId = '', staffFuId = '';
let ownerManagedId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/company', companyRouter);
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
  const [t] = await db.insert(tenants).values({ name, slug: `cuc-${name.toLowerCase()}-${sfx()}` }).returning();
  await db.insert(companies).values({ tenantId: t!.id, businessName: `${name} Co` });
  return t!.id;
}
async function seedUser(tenantId: string, role: string, isSuperAdmin = false) {
  const [u] = await db.insert(users).values({ tenantId, email: `cuc-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role, displayName: role, isSuperAdmin }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role });
  return u!.id;
}
// Token for `userId` acting inside `tenantId` with the given effective role.
function tokenFor(userId: string, tenantId: string, role: string, isSuperAdmin = false) {
  return jwt.sign({ userId, tenantId, role, isSuperAdmin, auth_time: Math.floor(Date.now() / 1000) }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}
async function cleanDb() {
  const tids = [managedId, unmanagedId].filter(Boolean);
  if (tids.length) {
    const uids = (await db.select({ id: users.id }).from(users).where(inArray(users.tenantId, tids))).map((r) => r.id);
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tids));
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.tenantId, tids));
    if (uids.length) {
      await db.delete(sessions).where(inArray(sessions.userId, uids));
      await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
    }
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.tenantId, tids));
    await db.delete(companies).where(inArray(companies.tenantId, tids));
    await db.delete(users).where(inArray(users.tenantId, tids));
    await db.delete(tenants).where(inArray(tenants.id, tids));
  }
  if (firmId) {
    await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  managedId = unmanagedId = firmId = staffUserId = staffFuId = ownerManagedId = '';
}

beforeEach(async () => {
  await cleanDb();
  managedId = await seedTenant('Managed');
  unmanagedId = await seedTenant('Unmanaged');
  ownerManagedId = await seedUser(managedId, 'owner');
  await seedUser(unmanagedId, 'owner');
  // The firm staffer lives in the unmanaged tenant (home) and has accountant
  // access on BOTH tenants; only `managed` is assigned to the firm.
  staffUserId = await seedUser(unmanagedId, 'accountant');
  await db.insert(userTenantAccess).values({ userId: staffUserId, tenantId: managedId, role: 'accountant' });
  const [f] = await db.insert(firms).values({ name: 'CUC Firm', slug: `cuc-firm-${sfx()}` }).returning();
  firmId = f!.id;
  await db.insert(tenantFirmAssignments).values({ firmId, tenantId: managedId, isActive: true });
  const [fu] = await db.insert(firmUsers).values({ firmId, userId: staffUserId, firmRole: 'firm_staff', capabilities: { team_management: true } }).returning();
  staffFuId = fu!.id;
  await startApp();
});
afterEach(async () => { if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; } await cleanDb(); });

describe('Team endpoints with firm member access rights', () => {
  it('capable firm_staff invites and promotes to owner on the managed tenant', async () => {
    const token = tokenFor(staffUserId, managedId, 'accountant');
    const invite = await request('POST', '/api/company/invite-user', { email: `inv-${sfx()}@example.com`, displayName: 'New', role: 'bookkeeper' }, token);
    expect(invite.status).toBe(201);
    const promote = await request('PATCH', `/api/company/users/${invite.json.user.id}`, { role: 'owner' }, token);
    expect(promote.status).toBe(200);
    expect(promote.json.user.role).toBe('owner');
    const templates = await request('GET', '/api/company/permission-templates', undefined, token);
    expect(templates.status).toBe(200);
  });

  it('same user on a tenant the firm does not manage is refused (403 OWNER_REQUIRED)', async () => {
    const token = tokenFor(staffUserId, unmanagedId, 'accountant');
    const r = await request('POST', '/api/company/invite-user', { email: `inv-${sfx()}@example.com`, role: 'bookkeeper' }, token);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('OWNER_REQUIRED');
  });

  it('firm_staff without the capability, and firm_readonly with one stored, are refused', async () => {
    const token = tokenFor(staffUserId, managedId, 'accountant');
    await db.update(firmUsers).set({ capabilities: {} }).where(eq(firmUsers.id, staffFuId));
    expect((await request('POST', `/api/company/users/${ownerManagedId}/unlock`, undefined, token)).status).toBe(403);
    await db.update(firmUsers).set({ firmRole: 'firm_readonly', capabilities: { team_management: true } }).where(eq(firmUsers.id, staffFuId));
    expect((await request('POST', `/api/company/users/${ownerManagedId}/unlock`, undefined, token)).status).toBe(403);
  });

  it('capability revoked on the access row (inactive) stops elevating', async () => {
    await db.update(userTenantAccess).set({ isActive: false })
      .where(eq(userTenantAccess.userId, staffUserId));
    // authenticate() reads the JWT's tenant, so the token still "works";
    // the resolver, however, requires ACTIVE access on the tenant.
    const token = tokenFor(staffUserId, managedId, 'accountant');
    expect((await request('GET', '/api/company/permission-templates', undefined, token)).status).toBe(403);
  });

  it('Stripe needs integrations_payments, not team_management; super admin passes everything', async () => {
    const token = tokenFor(staffUserId, managedId, 'accountant');
    expect((await request('DELETE', '/api/company/stripe', undefined, token)).status).toBe(403);
    await db.update(firmUsers).set({ capabilities: { team_management: true, integrations_payments: true } }).where(eq(firmUsers.id, staffFuId));
    expect((await request('DELETE', '/api/company/stripe', undefined, token)).status).toBe(200);
    const sa = await seedUser(unmanagedId, 'accountant', true);
    expect((await request('GET', '/api/company/permission-templates', undefined, tokenFor(sa, managedId, 'accountant', true))).status).toBe(200);
  });
});
