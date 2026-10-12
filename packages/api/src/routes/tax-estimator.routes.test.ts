// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, tenantFeatureFlags, firms, firmUsers, tenantFirmAssignments, userTenantAccess,
} from '../db/schema/index.js';
import { taxEstimatorRouter } from './tax-estimator.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

// Guard chain + cross-tenant scope of the Tax Estimator router (MODULE.md D1, D5).
// T1 practice tenant (flag ON), T2 managed client the user can reach, T3 managed
// client the user can NOT reach, T4 a client of ANOTHER firm the user can reach.
// Expected scope for the firm-A staff user = {T1, T2}.

let server: Server | null = null;
let port = 0;
const ids = { t1: '', t2: '', t3: '', t4: '', firmA: '', firmB: '' };
const userIds: string[] = [];
let staffToken = '';
let readonlyToken = '';
let tenantReadonlyToken = '';
let clientUserToken = '';
let outsiderToken = '';
let superToken = '';
let flagOffToken = '';

function slug(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

async function mkTenant(name: string) {
  const [t] = await db.insert(tenants).values({ name, slug: slug('te') }).returning();
  return t!.id;
}
async function mkUser(tenantId: string, role: string, opts: { userType?: string; isSuperAdmin?: boolean } = {}) {
  const [u] = await db.insert(users).values({
    tenantId, email: `${slug('u')}@example.com`, passwordHash: await bcrypt.hash('x-secret-12345', 4),
    displayName: role, role, isSuperAdmin: opts.isSuperAdmin ?? false, userType: opts.userType ?? 'staff',
  }).returning();
  userIds.push(u!.id);
  const token = jwt.sign(
    { userId: u!.id, tenantId, role, isSuperAdmin: opts.isSuperAdmin ?? false },
    process.env['JWT_SECRET']!, { expiresIn: '5m' },
  );
  return { id: u!.id, token };
}

function request(method: string, path: string, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function cleanDb() {
  const tids = [ids.t1, ids.t2, ids.t3, ids.t4].filter(Boolean);
  const fids = [ids.firmA, ids.firmB].filter(Boolean);
  if (userIds.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
  if (fids.length) {
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  for (const t of tids) {
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, t));
    await db.delete(users).where(eq(users.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
  userIds.length = 0;
  Object.keys(ids).forEach((k) => { (ids as Record<string, string>)[k] = ''; });
}

beforeEach(async () => {
  await cleanDb();
  ids.t1 = await mkTenant('TE Practice');
  ids.t2 = await mkTenant('TE Client Reachable');
  ids.t3 = await mkTenant('TE Client Unreachable');
  ids.t4 = await mkTenant('TE Other Firm Client');
  const [fa] = await db.insert(firms).values({ name: 'TE Firm A', slug: slug('fa') }).returning();
  const [fb] = await db.insert(firms).values({ name: 'TE Firm B', slug: slug('fb') }).returning();
  ids.firmA = fa!.id; ids.firmB = fb!.id;
  await db.insert(tenantFirmAssignments).values([
    { tenantId: ids.t1, firmId: ids.firmA }, { tenantId: ids.t2, firmId: ids.firmA },
    { tenantId: ids.t3, firmId: ids.firmA }, { tenantId: ids.t4, firmId: ids.firmB },
  ]);
  for (const t of [ids.t1, ids.t2, ids.t3, ids.t4]) {
    await db.insert(tenantFeatureFlags).values({ tenantId: t, flagKey: 'TAX_ESTIMATOR_V1', enabled: t !== ids.t3 });
  }
  const staff = await mkUser(ids.t1, 'accountant');
  staffToken = staff.token;
  await db.insert(firmUsers).values({ firmId: ids.firmA, userId: staff.id, firmRole: 'firm_staff' });
  await db.insert(userTenantAccess).values([
    { userId: staff.id, tenantId: ids.t1, role: 'accountant' },
    { userId: staff.id, tenantId: ids.t2, role: 'accountant' },
    { userId: staff.id, tenantId: ids.t4, role: 'accountant' }, // reachable but another firm's client
  ]);
  const ro = await mkUser(ids.t1, 'accountant');
  readonlyToken = ro.token;
  await db.insert(firmUsers).values({ firmId: ids.firmA, userId: ro.id, firmRole: 'firm_readonly' });
  await db.insert(userTenantAccess).values({ userId: ro.id, tenantId: ids.t1, role: 'accountant' });
  // QA D2: firm staff whose ACTIVE-tenant role is `readonly`.
  const tro = await mkUser(ids.t1, 'readonly');
  tenantReadonlyToken = tro.token;
  await db.insert(firmUsers).values({ firmId: ids.firmA, userId: tro.id, firmRole: 'firm_staff' });
  await db.insert(userTenantAccess).values({ userId: tro.id, tenantId: ids.t1, role: 'readonly' });
  clientUserToken = (await mkUser(ids.t1, 'owner', { userType: 'client' })).token;
  outsiderToken = (await mkUser(ids.t1, 'accountant')).token; // staff, no firm membership
  superToken = (await mkUser(ids.t1, 'owner', { isSuperAdmin: true })).token;
  flagOffToken = (await mkUser(ids.t3, 'accountant')).token; // active tenant has the flag OFF

  const app = express();
  app.use(express.json());
  app.use('/api/v1/tax-estimator', taxEstimatorRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('tax-estimator router guard chain', () => {
  it('401 without a token', async () => {
    expect((await request('GET', '/api/v1/tax-estimator/scope')).status).toBe(401);
  });

  it('404 for user_type client (TB13 pattern)', async () => {
    expect((await request('GET', '/api/v1/tax-estimator/scope', clientUserToken)).status).toBe(404);
  });

  it('404 when TAX_ESTIMATOR_V1 is OFF on the active tenant', async () => {
    expect((await request('GET', '/api/v1/tax-estimator/scope', flagOffToken)).status).toBe(404);
  });

  it('404 for staff who belong to no firm', async () => {
    expect((await request('GET', '/api/v1/tax-estimator/scope', outsiderToken)).status).toBe(404);
  });
});

describe('firm scope (MODULE.md D1)', () => {
  it('scope = firm-managed tenants ∩ tenants the caller can reach', async () => {
    const r = await request('GET', '/api/v1/tax-estimator/scope', staffToken);
    expect(r.status).toBe(200);
    expect(r.json.data.firmId).toBe(ids.firmA);
    expect(r.json.data.firmRole).toBe('firm_staff');
    // T1 + T2 only: T3 is managed but unreachable; T4 is reachable but another firm's.
    expect(r.json.data.managedTenantCount).toBe(2);
    expect(JSON.stringify(r.json)).not.toContain(ids.t3);
    expect(JSON.stringify(r.json)).not.toContain(ids.t4);
  });

  it('a tenant whose firm assignment is deactivated drops out of the next request', async () => {
    await db.update(tenantFirmAssignments).set({ isActive: false }).where(eq(tenantFirmAssignments.tenantId, ids.t2));
    const r = await request('GET', '/api/v1/tax-estimator/scope', staffToken);
    expect(r.json.data.managedTenantCount).toBe(1);
  });

  it('a revoked user_tenant_access row drops the tenant out of scope', async () => {
    await db.update(userTenantAccess).set({ isActive: false }).where(eq(userTenantAccess.tenantId, ids.t2));
    const r = await request('GET', '/api/v1/tax-estimator/scope', staffToken);
    expect(r.json.data.managedTenantCount).toBe(1);
  });

  it('X-Firm-Id naming a firm the user is not in is a 404 (hides existence)', async () => {
    const r = await request('GET', '/api/v1/tax-estimator/scope', staffToken, { 'X-Firm-Id': ids.firmB });
    expect(r.status).toBe(404);
  });

  it('readonly firm members can read the scope', async () => {
    const r = await request('GET', '/api/v1/tax-estimator/scope', readonlyToken);
    expect(r.status).toBe(200);
    expect(r.json.data.firmRole).toBe('firm_readonly');
  });

  it('QA D2: scope.canWrite is true only for firm admin/staff with the update permission; a tenant-readonly member reads but cannot write', async () => {
    expect((await request('GET', '/api/v1/tax-estimator/scope', staffToken)).json.data.canWrite).toBe(true);
    expect((await request('GET', '/api/v1/tax-estimator/scope', readonlyToken)).json.data.canWrite).toBe(false);
    const tro = await request('GET', '/api/v1/tax-estimator/scope', tenantReadonlyToken);
    expect(tro.status).toBe(200);
    expect(tro.json.data).toMatchObject({ firmRole: 'firm_staff', canWrite: false });
    expect((await request('GET', '/api/v1/tax-estimator/taxpayers', tenantReadonlyToken)).status).toBe(200);
    expect((await request('POST', '/api/v1/tax-estimator/taxpayers', tenantReadonlyToken)).status).toBe(403);
  });

  it('super admin must name a firm, then sees the firm\'s full managed set', async () => {
    const none = await request('GET', '/api/v1/tax-estimator/scope', superToken);
    expect(none.status).toBe(400);
    expect(none.json.error.code).toBe('TE_FIRM_REQUIRED');
    const r = await request('GET', '/api/v1/tax-estimator/scope', superToken, { 'X-Firm-Id': ids.firmA });
    expect(r.status).toBe(200);
    expect(r.json.data.managedTenantCount).toBe(3); // T1, T2, T3 (assignments), not T4
  });
});
