// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// GET /admin/tenants and GET /admin/users — super-admin gating, limit/offset
// paging with a `total` that reflects the whole match set, ?search= handling,
// bogus query-param coercion, and the unpaged shape the tenant-picker
// dropdowns still depend on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { inArray, like } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users } from '../db/schema/index.js';
import { adminRouter } from './admin.routes.js';

let server: Server | null = null;
let port = 0;
let adminToken = '';
let staffToken = '';

// Unique token so assertions ignore whatever else lives in the shared test DB.
const token = `routepage${Date.now().toString(36)}`;
const SLUG_PREFIX = `${token}-tenant`;
const EMAIL_PREFIX = `${token}-user`;

interface ListBody { tenants?: unknown[]; users?: unknown[]; total?: number }

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use((err: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: { message: err.message } });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(pathname: string, authToken?: string): Promise<{ status: number; json: ListBody }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers: { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: {} });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function cleanDb() {
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
  await db.delete(tenants).where(like(tenants.slug, `${SLUG_PREFIX}%`));
}

beforeAll(async () => {
  await cleanDb();

  const tenantIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const [t] = await db.insert(tenants)
      .values({ name: `${token} Tenant ${i}`, slug: `${SLUG_PREFIX}-${i}` })
      .returning();
    tenantIds.push(t!.id);
  }

  const [admin] = await db.insert(users).values({
    tenantId: tenantIds[0]!,
    email: `${EMAIL_PREFIX}-admin@example.com`,
    passwordHash: 'not-used',
    displayName: `${token} Admin`,
    role: 'owner',
    isSuperAdmin: true,
  }).returning();
  const [staff] = await db.insert(users).values({
    tenantId: tenantIds[0]!,
    email: `${EMAIL_PREFIX}-staff@example.com`,
    passwordHash: 'not-used',
    displayName: `${token} Staff`,
    role: 'bookkeeper',
    isSuperAdmin: false,
  }).returning();
  // Two more so the user directory has 4 matching rows to page through.
  for (let i = 0; i < 2; i++) {
    await db.insert(users).values({
      tenantId: tenantIds[0]!,
      email: `${EMAIL_PREFIX}-extra${i}@example.com`,
      passwordHash: 'not-used',
      displayName: `${token} Extra ${i}`,
      role: 'owner',
      isSuperAdmin: false,
    });
  }

  adminToken = jwt.sign(
    { userId: admin!.id, tenantId: tenantIds[0]!, role: 'owner', isSuperAdmin: true },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );
  staffToken = jwt.sign(
    { userId: staff!.id, tenantId: tenantIds[0]!, role: 'bookkeeper', isSuperAdmin: false },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );

  await startApp();
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

describe('GET /admin/tenants', () => {
  it('rejects non-super-admin and unauthenticated callers', async () => {
    expect((await request('/api/admin/tenants', staffToken)).status).toBe(403);
    expect((await request('/api/admin/tenants')).status).toBe(401);
  });

  it('returns the full list with a matching total when unpaged', async () => {
    const { status, json } = await request('/api/admin/tenants', adminToken);
    expect(status).toBe(200);
    expect(json.tenants!.length).toBe(json.total);
    expect(json.total!).toBeGreaterThanOrEqual(4);
  });

  it('pages with limit/offset and keeps total at the full match count', async () => {
    const first = await request(`/api/admin/tenants?search=${token}&limit=3&offset=0`, adminToken);
    expect(first.json.tenants!.length).toBe(3);
    expect(first.json.total).toBe(4);

    const second = await request(`/api/admin/tenants?search=${token}&limit=3&offset=3`, adminToken);
    expect(second.json.tenants!.length).toBe(1);
    expect(second.json.total).toBe(4);

    const past = await request(`/api/admin/tenants?search=${token}&limit=3&offset=99`, adminToken);
    expect(past.json.tenants!.length).toBe(0);
    expect(past.json.total).toBe(4);
  });

  it('coerces junk limit/offset instead of failing or running unbounded', async () => {
    const junk = await request(`/api/admin/tenants?search=${token}&limit=abc&offset=-5`, adminToken);
    expect(junk.status).toBe(200);
    // limit falls back to 50, offset clamps to 0 — all 4 matches come back.
    expect(junk.json.tenants!.length).toBe(4);

    const huge = await request(`/api/admin/tenants?search=${token}&limit=999999&offset=0`, adminToken);
    expect(huge.status).toBe(200);
    expect(huge.json.tenants!.length).toBe(4);
  });
});

describe('GET /admin/users', () => {
  it('rejects non-super-admin callers', async () => {
    expect((await request('/api/admin/users', staffToken)).status).toBe(403);
  });

  it('returns the full list with a matching total when unpaged', async () => {
    const { status, json } = await request('/api/admin/users', adminToken);
    expect(status).toBe(200);
    expect(json.users!.length).toBe(json.total);
  });

  it('pages with limit/offset and keeps total at the full match count', async () => {
    const first = await request(`/api/admin/users?search=${EMAIL_PREFIX}&limit=3&offset=0`, adminToken);
    expect(first.json.users!.length).toBe(3);
    expect(first.json.total).toBe(4);

    const second = await request(`/api/admin/users?search=${EMAIL_PREFIX}&limit=3&offset=3`, adminToken);
    expect(second.json.users!.length).toBe(1);
    expect(second.json.total).toBe(4);
  });

  it('searches across email, display name and tenant name', async () => {
    const byEmail = await request(`/api/admin/users?search=${EMAIL_PREFIX}-staff@example.com`, adminToken);
    expect(byEmail.json.total).toBe(1);

    const byDisplayName = await request(`/api/admin/users?search=${encodeURIComponent(`${token} Extra`)}`, adminToken);
    expect(byDisplayName.json.total).toBe(2);

    const byTenant = await request(`/api/admin/users?search=${encodeURIComponent(`${token} Tenant 0`)}`, adminToken);
    expect(byTenant.json.total).toBe(4);
  });
});
