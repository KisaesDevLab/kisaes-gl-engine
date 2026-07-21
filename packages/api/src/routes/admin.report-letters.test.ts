// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// /admin/report-letters — super-admin gating, zod validation, CRUD round-trip,
// and audit logging. report_letters is system-level (no tenant), so cleanup
// only removes rows this suite created; the seeded SSARS-21 defaults are left
// in place (and the list endpoint is asserted to include them).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, reportLetters, auditLog } from '../db/schema/index.js';
import { adminRouter } from './admin.routes.js';

let server: Server | null = null;
let port = 0;
let adminToken = '';
let staffToken = '';
let tenantId = '';

const ADMIN_EMAIL = 'admin-report-letters-test@example.com';
const STAFF_EMAIL = 'staff-report-letters-test@example.com';
const TENANT_SLUG = 'admin-report-letters-test';
const NAME_PREFIX = 'ZZ-route-letter-';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use((err: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Mirror the real global handler enough for these tests: ZodError → 400.
    const status = err.name === 'ZodError' ? 400 : (err.statusCode ?? 500);
    res.status(status).json({ error: { message: err.message } });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

function request(
  method: string,
  pathname: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function cleanDb() {
  await db.delete(reportLetters).where(like(reportLetters.name, `${NAME_PREFIX}%`));
  if (tenantId) await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(users).where(inArray(users.email, [ADMIN_EMAIL, STAFF_EMAIL]));
  await db.delete(tenants).where(eq(tenants.slug, TENANT_SLUG));
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'Report Letters Test', slug: TENANT_SLUG }).returning();
  tenantId = tenant!.id;
  const [admin] = await db.insert(users).values({
    tenantId, email: ADMIN_EMAIL, passwordHash: 'x', displayName: 'Admin', role: 'owner', isSuperAdmin: true,
  }).returning();
  const [staff] = await db.insert(users).values({
    tenantId, email: STAFF_EMAIL, passwordHash: 'x', displayName: 'Staff', role: 'bookkeeper', isSuperAdmin: false,
  }).returning();
  adminToken = jwt.sign({ userId: admin!.id, tenantId, role: 'owner', isSuperAdmin: true }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  staffToken = jwt.sign({ userId: staff!.id, tenantId, role: 'bookkeeper', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  await startApp();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('/admin/report-letters', () => {
  it('rejects non-super-admin and unauthenticated', async () => {
    expect((await request('GET', '/api/admin/report-letters', staffToken)).status).toBe(403);
    expect((await request('GET', '/api/admin/report-letters')).status).toBe(401);
  });

  it('lists default letters (compilation + preparation)', async () => {
    // report_letters is a shared system-level table; rather than depend on the
    // migration seeds surviving concurrent test files, insert our own
    // default-marked letters (isDefault can't be set via the API) and assert
    // the endpoint returns them. The prefix cleanup removes these afterward.
    await db.insert(reportLetters).values([
      { name: `${NAME_PREFIX}compilation-default`, letterType: 'compilation', bodyHtml: '<p>c</p>', isDefault: true },
      { name: `${NAME_PREFIX}preparation-default`, letterType: 'preparation', bodyHtml: '<p>p</p>', isDefault: true },
    ]);
    const { status, json } = await request('GET', '/api/admin/report-letters', adminToken);
    expect(status).toBe(200);
    const letters = json['letters'] as Array<Record<string, unknown>>;
    expect(letters.some((l) => l['letterType'] === 'compilation' && l['isDefault'] === true)).toBe(true);
    expect(letters.some((l) => l['letterType'] === 'preparation' && l['isDefault'] === true)).toBe(true);
  });

  it('validates the body (missing name, bad type → 400)', async () => {
    expect((await request('POST', '/api/admin/report-letters', adminToken, { letterType: 'compilation', bodyHtml: '<p>x</p>' })).status).toBe(400);
    expect((await request('POST', '/api/admin/report-letters', adminToken, { name: `${NAME_PREFIX}bad`, letterType: 'audit', bodyHtml: '<p>x</p>' })).status).toBe(400);
  });

  it('creates, reads, updates, and deletes a letter (with audit)', async () => {
    // create
    const created = await request('POST', '/api/admin/report-letters', adminToken, {
      name: `${NAME_PREFIX}one`, letterType: 'compilation', bodyHtml: '<p>Hello {{client_name}}</p>',
    });
    expect(created.status).toBe(201);
    const letter = created.json['letter'] as Record<string, unknown>;
    const id = letter['id'] as string;
    expect(letter['isDefault']).toBe(false);

    // read
    const got = await request('GET', `/api/admin/report-letters/${id}`, adminToken);
    expect(got.status).toBe(200);
    expect((got.json['letter'] as Record<string, unknown>)['name']).toBe(`${NAME_PREFIX}one`);

    // update
    const updated = await request('PUT', `/api/admin/report-letters/${id}`, adminToken, { isActive: false, name: `${NAME_PREFIX}renamed` });
    expect(updated.status).toBe(200);
    expect((updated.json['letter'] as Record<string, unknown>)['isActive']).toBe(false);
    expect((updated.json['letter'] as Record<string, unknown>)['name']).toBe(`${NAME_PREFIX}renamed`);

    // audit rows exist for create + update
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audits.map((a) => a.action).sort()).toEqual(expect.arrayContaining(['create', 'update']));

    // delete
    const del = await request('DELETE', `/api/admin/report-letters/${id}`, adminToken);
    expect(del.status).toBe(200);
    expect((await request('GET', `/api/admin/report-letters/${id}`, adminToken)).status).toBe(404);
  });
});
