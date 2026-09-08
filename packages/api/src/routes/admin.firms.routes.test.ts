// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Route gates for the admin firm surface: GET /admin/firms and
// POST /admin/tenants/:id/firm are super-admin only; the body is validated.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, firms, tenantFirmAssignments, userTenantAccess, auditLog } from '../db/schema/index.js';
import { adminRouter } from './admin.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let tenantId = '', firmId = '', staffToken = '', saToken = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}
function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
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
async function seedUser(role: string, isSuperAdmin: boolean) {
  const [u] = await db.insert(users).values({ tenantId, email: `af-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role, displayName: role, isSuperAdmin }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role });
  return jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin, auth_time: Math.floor(Date.now() / 1000) }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}
async function cleanDb() {
  if (tenantId) {
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, tenantId));
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
    const uids = (await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))).map((r) => r.id);
    if (uids.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  if (firmId) await db.delete(firms).where(eq(firms.id, firmId));
  tenantId = firmId = staffToken = saToken = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'AF Tenant', slug: `af-${sfx()}` }).returning();
  tenantId = t!.id;
  staffToken = await seedUser('accountant', false);
  saToken = await seedUser('owner', true);
  const [f] = await db.insert(firms).values({ name: 'AF Firm', slug: `af-firm-${sfx()}` }).returning();
  firmId = f!.id;
  await startApp();
});
afterEach(async () => { if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; } await cleanDb(); });

describe('admin firm routes', () => {
  it('non-super-admin is refused', async () => {
    expect((await request('GET', '/api/v1/admin/firms', undefined, staffToken)).status).toBe(403);
    expect((await request('POST', `/api/v1/admin/tenants/${tenantId}/firm`, { firmId }, staffToken)).status).toBe(403);
  });
  it('super admin lists firms with counts and sets/clears a tenant firm; bad body is 400', async () => {
    const list = await request('GET', '/api/v1/admin/firms?search=AF%20Firm', undefined, saToken);
    expect(list.status).toBe(200);
    expect(list.json.firms.find((f: { id: string }) => f.id === firmId)).toMatchObject({ memberCount: 0, tenantCount: 0 });

    expect((await request('POST', `/api/v1/admin/tenants/${tenantId}/firm`, { firmId: 'nope' }, saToken)).status).toBe(400);
    expect((await request('POST', `/api/v1/admin/tenants/${tenantId}/firm`, {}, saToken)).status).toBe(400);

    const set = await request('POST', `/api/v1/admin/tenants/${tenantId}/firm`, { firmId }, saToken);
    expect(set.status).toBe(200);
    expect(set.json.current.firmId).toBe(firmId);
    const detail = await request('GET', `/api/v1/admin/tenants/${tenantId}`, undefined, saToken);
    expect(detail.json.firm.current.firmName).toBe('AF Firm');
    const cleared = await request('POST', `/api/v1/admin/tenants/${tenantId}/firm`, { firmId: null }, saToken);
    expect(cleared.json.current).toBeNull();
    expect(cleared.json.history).toHaveLength(1);
  });
});
