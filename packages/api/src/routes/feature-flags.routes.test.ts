// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// express-async-errors patches Express 4 so throws inside async
// handlers reach the error middleware. Must be imported before
// the router so the patch is active when the handlers run.
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, tenantFeatureFlags, auditLog as auditLogTable } from '../db/schema/index.js';
import { featureFlagsRouter, adminFeatureFlagsRouter } from './feature-flags.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let staffToken = '';
let superAdminToken = '';
let otherTenantId = '';
let primaryTenantId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/feature-flags', featureFlagsRouter);
  app.use('/api/v1/admin/feature-flags', adminFeatureFlagsRouter);
  // Use the real error handler so ZodError → 400 and AppError →
  // its statusCode, matching production behavior.
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedSuperAdminAndStaff() {
  // Primary tenant with super admin + staff user.
  const [primary] = await db.insert(tenants).values({ name: 'FF Primary', slug: 'ff-primary-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  primaryTenantId = primary!.id;
  // Separate tenant used to verify tenant isolation.
  const [other] = await db.insert(tenants).values({ name: 'FF Other', slug: 'ff-other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  otherTenantId = other!.id;

  const passwordHash = await bcrypt.hash('super-secret-123', 12);

  const [superAdmin] = await db.insert(users).values({
    tenantId: primaryTenantId,
    email: `super-${Date.now()}@example.com`,
    passwordHash,
    displayName: 'Super',
    role: 'owner',
    isSuperAdmin: true,
  }).returning();

  const [staff] = await db.insert(users).values({
    tenantId: primaryTenantId,
    email: `staff-${Date.now()}@example.com`,
    passwordHash,
    displayName: 'Staff',
    role: 'bookkeeper',
    isSuperAdmin: false,
  }).returning();

  superAdminToken = jwt.sign(
    { userId: superAdmin!.id, tenantId: primaryTenantId, role: 'owner', isSuperAdmin: true },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );
  staffToken = jwt.sign(
    { userId: staff!.id, tenantId: primaryTenantId, role: 'bookkeeper', isSuperAdmin: false },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );
}

async function cleanDb() {
  for (const id of [primaryTenantId, otherTenantId]) {
    if (!id) continue;
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, id));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, id));
    await db.delete(users).where(eq(users.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
  primaryTenantId = '';
  otherTenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  await seedSuperAdminAndStaff();
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

describe('feature-flags routes', () => {
  describe('GET /api/v1/feature-flags', () => {
    it('401 without token', async () => {
      const { status } = await request('GET', '/api/v1/feature-flags');
      expect(status).toBe(401);
    });

    it('returns all flags for the caller tenant (staff token)', async () => {
      const { status, json } = await request('GET', '/api/v1/feature-flags', undefined, staffToken);
      expect(status).toBe(200);
      expect(json.flags).toBeDefined();
      // With no rows seeded, every flag shows disabled default.
      expect(json.flags.CLOSE_REVIEW_V1.enabled).toBe(false);
    });

    it('scopes response to the caller tenant — another tenant cannot be queried via this endpoint', async () => {
      // Seed a row on the OTHER tenant; caller is on primary.
      await db.insert(tenantFeatureFlags).values({
        tenantId: otherTenantId,
        flagKey: 'CLOSE_REVIEW_V1',
        enabled: true,
      });
      const { json } = await request('GET', '/api/v1/feature-flags', undefined, staffToken);
      expect(json.flags.CLOSE_REVIEW_V1.enabled).toBe(false);
    });
  });

  describe('POST /api/v1/admin/feature-flags/:tenantId/:flagKey', () => {
    it('401 without token', async () => {
      const { status } = await request('POST', `/api/v1/admin/feature-flags/${primaryTenantId}/CLOSE_REVIEW_V1`, { enabled: true });
      expect(status).toBe(401);
    });

    it('403 for non-super-admin staff', async () => {
      const { status } = await request('POST', `/api/v1/admin/feature-flags/${primaryTenantId}/CLOSE_REVIEW_V1`, { enabled: true }, staffToken);
      expect(status).toBe(403);
    });

    it('super-admin toggles a flag and GET reflects the change', async () => {
      const toggle = await request('POST', `/api/v1/admin/feature-flags/${primaryTenantId}/CLOSE_REVIEW_V1`, { enabled: true }, superAdminToken);
      expect(toggle.status).toBe(200);
      expect(toggle.json.enabled).toBe(true);

      const list = await request('GET', '/api/v1/feature-flags', undefined, staffToken);
      expect(list.json.flags.CLOSE_REVIEW_V1.enabled).toBe(true);
    });

    it('rejects unknown flag key with 400', async () => {
      const { status, json } = await request('POST', `/api/v1/admin/feature-flags/${primaryTenantId}/NOT_A_REAL_FLAG`, { enabled: true }, superAdminToken);
      expect(status).toBe(400);
      expect(json.error?.message ?? '').toMatch(/Unknown feature flag key/);
    });

    it('rejects invalid body with 400', async () => {
      const { status } = await request('POST', `/api/v1/admin/feature-flags/${primaryTenantId}/CLOSE_REVIEW_V1`, { enabled: 'yes' }, superAdminToken);
      expect(status).toBe(400);
    });

    it('super-admin can toggle flags on a DIFFERENT tenant than their own', async () => {
      // superAdminToken has tenantId = primaryTenantId, but the POST
      // targets otherTenantId. The endpoint must use the URL param,
      // not the token's tenant, so this must succeed and persist.
      const { status, json } = await request('POST', `/api/v1/admin/feature-flags/${otherTenantId}/CLOSE_REVIEW_V1`, { enabled: true }, superAdminToken);
      expect(status).toBe(200);
      expect(json.enabled).toBe(true);
    });
  });

  describe('GET /api/v1/admin/feature-flags/:tenantId', () => {
    it('401 without token', async () => {
      const { status } = await request('GET', `/api/v1/admin/feature-flags/${primaryTenantId}`);
      expect(status).toBe(401);
    });

    it('403 for non-super-admin staff', async () => {
      const { status } = await request('GET', `/api/v1/admin/feature-flags/${primaryTenantId}`, undefined, staffToken);
      expect(status).toBe(403);
    });

    it('super-admin reads any tenant', async () => {
      await db.insert(tenantFeatureFlags).values({
        tenantId: otherTenantId,
        flagKey: 'REPORT_BUILDER_V1',
        enabled: true,
      });
      const { status, json } = await request('GET', `/api/v1/admin/feature-flags/${otherTenantId}`, undefined, superAdminToken);
      expect(status).toBe(200);
      expect(json.flags.REPORT_BUILDER_V1.enabled).toBe(true);
    });
  });
});
