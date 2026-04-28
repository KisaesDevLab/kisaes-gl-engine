// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants,
  users,
  firms,
  firmUsers,
  tenantFirmAssignments,
  userTenantAccess,
  auditLog as auditLogTable,
} from '../db/schema/index.js';
import { firmsRouter } from './firms.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

// 3-tier rules plan, Phase 1 — firms routes integration tests.
// Covers: super-admin gate on create/delete, firm-admin gate on
// updates / staff-invite / tenant-assign, 1:N tenant assignment
// with force, soft-detach on un-assign, member-only listing.

let server: Server | null = null;
let port = 0;
let primaryTenantId = '';
let secondaryTenantId = '';
let superAdminToken = '';
let firmAdminToken = '';
let firmAdminUserId = '';
let outsiderToken = '';
let outsiderUserId = '';
let firmId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/firms', firmsRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
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

async function seedTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }).returning();
  return t!.id;
}

async function seedUser(opts: {
  tenantId: string;
  role: string;
  isSuperAdmin?: boolean;
}): Promise<{ id: string; token: string }> {
  const [u] = await db.insert(users).values({
    tenantId: opts.tenantId,
    email: `u-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: await bcrypt.hash('secret-123-456', 12),
    role: opts.role,
    displayName: opts.role,
    isSuperAdmin: opts.isSuperAdmin ?? false,
  }).returning();
  await db.insert(userTenantAccess).values({
    userId: u!.id,
    tenantId: opts.tenantId,
    role: opts.role,
  });
  const token = jwt.sign(
    {
      userId: u!.id,
      tenantId: opts.tenantId,
      role: opts.role,
      isSuperAdmin: opts.isSuperAdmin ?? false,
    },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );
  return { id: u!.id, token };
}

async function cleanDb() {
  // Tenant-scoped deletes; mirror the apply-test pattern that
  // avoids cross-test deadlocks by skipping the tenant-cascade
  // path when sibling test files may be running.
  for (const tId of [primaryTenantId, secondaryTenantId].filter(Boolean)) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, tId));
    await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tId));
    await db.delete(users).where(eq(users.tenantId, tId));
  }
  if (firmId) {
    await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  primaryTenantId = '';
  secondaryTenantId = '';
  firmId = '';
}

beforeEach(async () => {
  await cleanDb();
  primaryTenantId = await seedTenant('FirmTest Primary');
  secondaryTenantId = await seedTenant('FirmTest Secondary');
  const sa = await seedUser({ tenantId: primaryTenantId, role: 'owner', isSuperAdmin: true });
  superAdminToken = sa.token;
  const fa = await seedUser({ tenantId: primaryTenantId, role: 'accountant' });
  firmAdminToken = fa.token;
  firmAdminUserId = fa.id;
  const out = await seedUser({ tenantId: secondaryTenantId, role: 'bookkeeper' });
  outsiderToken = out.token;
  outsiderUserId = out.id;
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

describe('firms — collection', () => {
  it('401 without token', async () => {
    const { status } = await request('GET', '/api/v1/firms');
    expect(status).toBe(401);
  });

  it('non-super-admin POST returns 403', async () => {
    const { status } = await request(
      'POST',
      '/api/v1/firms',
      { name: 'Smith CPAs', slug: 'smith-cpas' },
      firmAdminToken,
    );
    expect(status).toBe(403);
  });

  it('super-admin can create a firm and is auto-added as firm_admin', async () => {
    const { status, json } = await request(
      'POST',
      '/api/v1/firms',
      { name: 'Smith CPAs', slug: 'smith-cpas' },
      superAdminToken,
    );
    expect(status).toBe(201);
    expect(json.name).toBe('Smith CPAs');
    expect(json.slug).toBe('smith-cpas');
    firmId = json.id;
    // Verify the creator was added as firm_admin.
    const members = await db.query.firmUsers.findMany({ where: eq(firmUsers.firmId, firmId) });
    expect(members).toHaveLength(1);
    expect(members[0]!.firmRole).toBe('firm_admin');
  });

  it('rejects duplicate slug with 409', async () => {
    await request('POST', '/api/v1/firms', { name: 'A', slug: 'taken-slug' }, superAdminToken);
    const dup = await request(
      'POST',
      '/api/v1/firms',
      { name: 'B', slug: 'taken-slug' },
      superAdminToken,
    );
    expect(dup.status).toBe(409);
    // Capture for cleanup
    const list = await request('GET', '/api/v1/firms', undefined, superAdminToken);
    firmId = list.json.firms[0].id;
  });

  it('list returns only firms the user belongs to', async () => {
    // Create two firms as super-admin.
    const a = await request('POST', '/api/v1/firms', { name: 'A', slug: 'firm-a' }, superAdminToken);
    const b = await request('POST', '/api/v1/firms', { name: 'B', slug: 'firm-b' }, superAdminToken);
    // Outsider sees neither.
    const out = await request('GET', '/api/v1/firms', undefined, outsiderToken);
    expect(out.status).toBe(200);
    expect(out.json.firms).toHaveLength(0);
    // Super-admin sees both.
    const sa = await request('GET', '/api/v1/firms', undefined, superAdminToken);
    expect(sa.json.firms.length).toBeGreaterThanOrEqual(2);
    // Cleanup tracker
    firmId = a.json.id;
    await db.delete(firmUsers).where(eq(firmUsers.firmId, b.json.id));
    await db.delete(firms).where(eq(firms.id, b.json.id));
  });
});

describe('firms — staff management', () => {
  beforeEach(async () => {
    const created = await request(
      'POST',
      '/api/v1/firms',
      { name: 'F', slug: 'staff-test' },
      superAdminToken,
    );
    firmId = created.json.id;
  });

  it('non-firm-admin cannot invite staff (404 — firm hidden)', async () => {
    const { status } = await request(
      'POST',
      `/api/v1/firms/${firmId}/users`,
      { userId: outsiderUserId, firmRole: 'firm_staff' },
      outsiderToken,
    );
    expect(status).toBe(404);
  });

  it('firm-admin can invite by userId', async () => {
    // Super-admin creator is firm_admin and can invite.
    const { status, json } = await request(
      'POST',
      `/api/v1/firms/${firmId}/users`,
      { userId: outsiderUserId, firmRole: 'firm_staff' },
      superAdminToken,
    );
    expect(status).toBe(201);
    expect(json.firmRole).toBe('firm_staff');
    expect(json.userId).toBe(outsiderUserId);
  });

  it('rejects double-invite with 409', async () => {
    await request(
      'POST',
      `/api/v1/firms/${firmId}/users`,
      { userId: outsiderUserId },
      superAdminToken,
    );
    const dup = await request(
      'POST',
      `/api/v1/firms/${firmId}/users`,
      { userId: outsiderUserId },
      superAdminToken,
    );
    expect(dup.status).toBe(409);
  });

  it('lists firm users with email + display name', async () => {
    await request(
      'POST',
      `/api/v1/firms/${firmId}/users`,
      { userId: outsiderUserId, firmRole: 'firm_staff' },
      superAdminToken,
    );
    const { status, json } = await request(
      'GET',
      `/api/v1/firms/${firmId}/users`,
      undefined,
      superAdminToken,
    );
    expect(status).toBe(200);
    expect(json.users.length).toBe(2); // creator + invitee
    const emails = json.users.map((u: { email: string }) => u.email);
    expect(emails.some((e: string) => e.includes('@example.com'))).toBe(true);
  });
});

describe('firms — tenant assignment 1:N', () => {
  beforeEach(async () => {
    const created = await request(
      'POST',
      '/api/v1/firms',
      { name: 'F', slug: 'assign-test' },
      superAdminToken,
    );
    firmId = created.json.id;
  });

  it('assigns a tenant the caller has accountant role on', async () => {
    const { status, json } = await request(
      'POST',
      `/api/v1/firms/${firmId}/tenants`,
      { tenantId: primaryTenantId },
      superAdminToken,
    );
    expect(status).toBe(201);
    expect(json.tenantId).toBe(primaryTenantId);
    expect(json.firmId).toBe(firmId);
    expect(json.isActive).toBe(true);
  });

  it('idempotent — assigning the same tenant to the same firm returns existing row', async () => {
    const first = await request(
      'POST',
      `/api/v1/firms/${firmId}/tenants`,
      { tenantId: primaryTenantId },
      superAdminToken,
    );
    const second = await request(
      'POST',
      `/api/v1/firms/${firmId}/tenants`,
      { tenantId: primaryTenantId },
      superAdminToken,
    );
    expect(second.status).toBe(201);
    expect(second.json.id).toBe(first.json.id);
  });

  it('rejects re-assigning a tenant already on another firm without force', async () => {
    // Create a second firm to simulate the conflict.
    const otherFirm = await request(
      'POST',
      '/api/v1/firms',
      { name: 'Other', slug: 'other-firm' },
      superAdminToken,
    );
    await request(
      'POST',
      `/api/v1/firms/${otherFirm.json.id}/tenants`,
      { tenantId: primaryTenantId },
      superAdminToken,
    );
    const conflict = await request(
      'POST',
      `/api/v1/firms/${firmId}/tenants`,
      { tenantId: primaryTenantId },
      superAdminToken,
    );
    expect(conflict.status).toBe(409);
    // Cleanup the extra firm
    await db.delete(firmUsers).where(eq(firmUsers.firmId, otherFirm.json.id));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, otherFirm.json.id));
    await db.delete(firms).where(eq(firms.id, otherFirm.json.id));
  });

  it('force=true soft-detaches the prior assignment', async () => {
    const otherFirm = await request(
      'POST',
      '/api/v1/firms',
      { name: 'Other', slug: 'other-firm-force' },
      superAdminToken,
    );
    await request(
      'POST',
      `/api/v1/firms/${otherFirm.json.id}/tenants`,
      { tenantId: primaryTenantId },
      superAdminToken,
    );
    const reassign = await request(
      'POST',
      `/api/v1/firms/${firmId}/tenants`,
      { tenantId: primaryTenantId, force: true },
      superAdminToken,
    );
    expect(reassign.status).toBe(201);
    // Prior row should still exist but is_active=false.
    const all = await db.query.tenantFirmAssignments.findMany({
      where: eq(tenantFirmAssignments.tenantId, primaryTenantId),
    });
    const active = all.filter((a) => a.isActive);
    const inactive = all.filter((a) => !a.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]!.firmId).toBe(firmId);
    expect(inactive).toHaveLength(1);
    expect(inactive[0]!.firmId).toBe(otherFirm.json.id);
    await db.delete(firmUsers).where(eq(firmUsers.firmId, otherFirm.json.id));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, otherFirm.json.id));
    await db.delete(firms).where(eq(firms.id, otherFirm.json.id));
  });

  it('un-assign soft-detaches (row preserved with is_active=false)', async () => {
    await request(
      'POST',
      `/api/v1/firms/${firmId}/tenants`,
      { tenantId: primaryTenantId },
      superAdminToken,
    );
    const { status } = await request(
      'DELETE',
      `/api/v1/firms/${firmId}/tenants/${primaryTenantId}`,
      undefined,
      superAdminToken,
    );
    expect(status).toBe(200);
    const all = await db.query.tenantFirmAssignments.findMany({
      where: eq(tenantFirmAssignments.tenantId, primaryTenantId),
    });
    expect(all).toHaveLength(1);
    expect(all[0]!.isActive).toBe(false);
  });

  it('caller without accountant/owner role on tenant is denied 403', async () => {
    // outsider has bookkeeper role on secondaryTenantId only —
    // promote outsider to firm_admin first then try to assign
    // primaryTenantId (where they have no role).
    await request(
      'POST',
      `/api/v1/firms/${firmId}/users`,
      { userId: outsiderUserId, firmRole: 'firm_admin' },
      superAdminToken,
    );
    const { status } = await request(
      'POST',
      `/api/v1/firms/${firmId}/tenants`,
      { tenantId: primaryTenantId },
      outsiderToken,
    );
    expect(status).toBe(403);
  });
});

describe('firms — delete with active assignments', () => {
  it('rejects DELETE with 409 when active assignments remain', async () => {
    const created = await request(
      'POST',
      '/api/v1/firms',
      { name: 'F', slug: 'delete-test' },
      superAdminToken,
    );
    firmId = created.json.id;
    await request(
      'POST',
      `/api/v1/firms/${firmId}/tenants`,
      { tenantId: primaryTenantId },
      superAdminToken,
    );
    const { status, json } = await request(
      'DELETE',
      `/api/v1/firms/${firmId}`,
      undefined,
      superAdminToken,
    );
    expect(status).toBe(409);
    expect(JSON.stringify(json)).toMatch(/active tenant assignment/i);
  });
});
