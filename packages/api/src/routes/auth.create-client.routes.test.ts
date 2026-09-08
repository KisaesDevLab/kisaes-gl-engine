// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// POST /auth/create-client assigns the new tenant to the CREATOR'S firm:
//   - sole membership → that firm, and no new firm_users row is created
//   - two memberships → 422 FIRM_SELECTION_REQUIRED with details.firms;
//     with a valid firmId → 201
//   - super admin with no membership → the appliance firm
//   - the body is validated (unknown keys stripped)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { APPLIANCE_FIRM_SLUG } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog,
} from '../db/schema/index.js';
import { authRouter } from './auth.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let homeTenantId = '';
let staffId = '';
let staffToken = '';
let saId = '';
let saToken = '';
let firmAId = '';
let firmBId = '';
const createdTenantIds: string[] = [];

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}
function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': String(data.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); } catch { resolve({ status: res.statusCode ?? 0, json: { raw } }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function seedUser(role: string, isSuperAdmin = false) {
  const [u] = await db.insert(users).values({
    tenantId: homeTenantId, email: `cc-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role, displayName: role, isSuperAdmin,
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: homeTenantId, role });
  const token = jwt.sign({ userId: u!.id, tenantId: homeTenantId, role, isSuperAdmin }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return { id: u!.id, token };
}

async function cleanDb() {
  const tids = [...createdTenantIds, homeTenantId].filter(Boolean);
  const uids = [staffId, saId].filter(Boolean);
  if (uids.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
  if (tids.length) {
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.tenantId, tids));
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tids));
  }
  const fids = [firmAId, firmBId].filter(Boolean);
  if (fids.length) {
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, fids));
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  if (uids.length) await db.delete(firmUsers).where(inArray(firmUsers.userId, uids));
  // Tenants provisioned by the route own companies/accounts/etc. — the FK
  // cascades on tenants handle those.
  for (const tid of tids) {
    await db.delete(users).where(eq(users.tenantId, tid));
    await db.delete(tenants).where(eq(tenants.id, tid));
  }
  createdTenantIds.length = 0;
  homeTenantId = staffId = staffToken = saId = saToken = firmAId = firmBId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'CC Home', slug: `cc-home-${sfx()}` }).returning();
  homeTenantId = t!.id;
  const staff = await seedUser('accountant');
  staffId = staff.id; staffToken = staff.token;
  const sa = await seedUser('owner', true);
  saId = sa.id; saToken = sa.token;
  const [a] = await db.insert(firms).values({ name: 'CC Firm A', slug: `cc-firm-a-${sfx()}` }).returning();
  firmAId = a!.id;
  await db.insert(firmUsers).values({ firmId: firmAId, userId: staffId, firmRole: 'firm_staff' });
  await startApp();
});
afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

async function activeFirmFor(tenantId: string) {
  return db.query.tenantFirmAssignments.findFirst({
    where: and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)),
  });
}

describe('POST /auth/create-client — firm routing', () => {
  it('sole membership → assigned to that firm, creator is accountant, no new firm_users row', async () => {
    const before = await db.select().from(firmUsers).where(eq(firmUsers.userId, staffId));
    const r = await request('POST', '/api/auth/create-client', { companyName: 'Client One', systemAccountsOnly: true, bogus: 1 }, staffToken);
    expect(r.status).toBe(201);
    createdTenantIds.push(r.json.tenantId);
    expect(r.json).toMatchObject({ firmId: firmAId, firmName: 'CC Firm A' });
    expect((await activeFirmFor(r.json.tenantId))?.firmId).toBe(firmAId);
    const access = await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, staffId), eq(userTenantAccess.tenantId, r.json.tenantId)),
    });
    expect(access?.role).toBe('accountant');
    const after = await db.select().from(firmUsers).where(eq(firmUsers.userId, staffId));
    expect(after).toHaveLength(before.length);
  });

  it('two memberships → 422 with the candidate list; explicit firmId → 201', async () => {
    const [b] = await db.insert(firms).values({ name: 'CC Firm B', slug: `cc-firm-b-${sfx()}` }).returning();
    firmBId = b!.id;
    await db.insert(firmUsers).values({ firmId: firmBId, userId: staffId, firmRole: 'firm_admin' });

    const r = await request('POST', '/api/auth/create-client', { companyName: 'Client Two', systemAccountsOnly: true }, staffToken);
    expect(r.status).toBe(422);
    expect(r.json?.error?.code ?? r.json?.code).toBe('FIRM_SELECTION_REQUIRED');
    const names = (r.json?.error?.details?.firms ?? r.json?.details?.firms ?? []).map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['CC Firm A', 'CC Firm B']);

    const ok = await request('POST', '/api/auth/create-client', { companyName: 'Client Two', systemAccountsOnly: true, firmId: firmBId }, staffToken);
    expect(ok.status).toBe(201);
    createdTenantIds.push(ok.json.tenantId);
    expect((await activeFirmFor(ok.json.tenantId))?.firmId).toBe(firmBId);
    // firm_admin auto-access: the creator is firm_admin of B → already has
    // the accountant row from the creator insert; no duplicate.
    const rows = await db.select().from(userTenantAccess)
      .where(and(eq(userTenantAccess.userId, staffId), eq(userTenantAccess.tenantId, ok.json.tenantId)));
    expect(rows).toHaveLength(1);
  });

  it('super admin with no membership → appliance firm; bad firmId → 404', async () => {
    const r = await request('POST', '/api/auth/create-client', { companyName: 'Client SA', systemAccountsOnly: true }, saToken);
    expect(r.status).toBe(201);
    createdTenantIds.push(r.json.tenantId);
    const assigned = await activeFirmFor(r.json.tenantId);
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, assigned!.firmId) });
    expect(firm?.slug).toBe(APPLIANCE_FIRM_SLUG);
    // Still no membership side effect for the super admin.
    expect(await db.query.firmUsers.findFirst({ where: eq(firmUsers.userId, saId) })).toBeUndefined();

    const bad = await request('POST', '/api/auth/create-client', { companyName: 'X', firmId: '00000000-0000-0000-0000-000000000000' }, saToken);
    expect(bad.status).toBe(404);
    expect((await db.select().from(tenants).where(eq(tenants.name, 'X'))).length).toBe(0);
  });
});
