// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Route-level coverage for the date-range transaction delete + its
// preview: super-admin gating (403 for non-super-admin), Zod date
// validation (400), and a happy-path no-op returning zero counts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users } from '../db/schema/index.js';
import { adminRouter } from './admin.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let adminToken = '';
let staffToken = '';
let tenantId = '';

const ADMIN_EMAIL = 'admin-range-test@example.com';
const STAFF_EMAIL = 'staff-range-test@example.com';
const TENANT_SLUG = 'admin-range-test';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); }
        catch { resolve({ status: res.statusCode ?? 0, json: { raw } }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanDb() {
  await db.delete(users).where(eq(users.email, ADMIN_EMAIL));
  await db.delete(users).where(eq(users.email, STAFF_EMAIL));
  await db.delete(tenants).where(eq(tenants.slug, TENANT_SLUG));
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'Range Route Test', slug: TENANT_SLUG }).returning();
  tenantId = tenant!.id;
  const [admin] = await db.insert(users).values({
    tenantId, email: ADMIN_EMAIL, passwordHash: 'x', role: 'owner', isSuperAdmin: true,
  }).returning();
  const [staff] = await db.insert(users).values({
    tenantId, email: STAFF_EMAIL, passwordHash: 'x', role: 'bookkeeper', isSuperAdmin: false,
  }).returning();
  adminToken = jwt.sign({ userId: admin!.id, tenantId, role: 'owner', isSuperAdmin: true }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  staffToken = jwt.sign({ userId: staff!.id, tenantId, role: 'bookkeeper', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  await startApp();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('POST /tenants/:id/delete-transactions-range', () => {
  it('rejects non-super-admin users with 403', async () => {
    const { status } = await request('POST', `/api/admin/tenants/${tenantId}/delete-transactions-range`,
      { startDate: '2026-02-01', endDate: '2026-02-28' }, staffToken);
    expect(status).toBe(403);
  });

  it('returns 400 for malformed dates', async () => {
    const { status } = await request('POST', `/api/admin/tenants/${tenantId}/delete-transactions-range`,
      { startDate: '02-2026', endDate: '2026-02-28' }, adminToken);
    expect(status).toBe(400);
  });

  it('returns zero counts on a tenant with no activity', async () => {
    const { status, json } = await request('POST', `/api/admin/tenants/${tenantId}/delete-transactions-range`,
      { startDate: '2026-02-01', endDate: '2026-02-28' }, adminToken);
    expect(status).toBe(200);
    expect(json['transactionsDeleted']).toBe(0);
    expect(json['feedItemsDeleted']).toBe(0);
    expect(json['reconciliationsDeleted']).toBe(0);
  });
});

describe('GET /tenants/:id/transactions-range-count', () => {
  it('rejects non-super-admin users with 403', async () => {
    const { status } = await request('GET',
      `/api/admin/tenants/${tenantId}/transactions-range-count?startDate=2026-02-01&endDate=2026-02-28`,
      undefined, staffToken);
    expect(status).toBe(403);
  });

  it('returns preview counts for a super admin', async () => {
    const { status, json } = await request('GET',
      `/api/admin/tenants/${tenantId}/transactions-range-count?startDate=2026-02-01&endDate=2026-02-28`,
      undefined, adminToken);
    expect(status).toBe(200);
    expect(json['transactionsToDelete']).toBe(0);
  });
});
