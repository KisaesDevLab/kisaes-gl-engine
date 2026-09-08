// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Route-level gates for /api/v1/firm-invites: owner-only sends (client
// user_type → 404, non-owner staff → 403, super admin ok), per-tenant send
// cap, list never leaks hashes, and the staff lookup/accept path via code.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog, firmInvites,
} from '../db/schema/index.js';
import { errorHandler } from '../middleware/error-handler.js';

const mail = vi.hoisted(() => ({ sendActionEmail: vi.fn(async () => {}) }));
vi.mock('../services/system-email.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/system-email.service.js')>();
  return { ...actual, sendActionEmail: (...args: unknown[]) => (mail.sendActionEmail as (...a: unknown[]) => Promise<void>)(...args) };
});

import { firmInvitesRouter } from './firm-invites.routes.js';

let server: Server | null = null;
let port = 0;
const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let clientTenantId = '';
let staffHomeId = '';
let firmId = '';
let ownerToken = '';
let accountantToken = '';
let clientUserToken = '';
let superAdminToken = '';
let staffToken = '';
let staffEmail = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/firm-invites', firmInvitesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
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
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({ name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix()}` }).returning();
  return t!.id;
}
async function seedUser(opts: { tenantId: string; role: string; email?: string; userType?: 'staff' | 'client'; isSuperAdmin?: boolean }) {
  const [u] = await db.insert(users).values({
    tenantId: opts.tenantId, email: opts.email ?? `u-${suffix()}@example.com`, passwordHash: 'x'.repeat(60),
    role: opts.role, displayName: opts.role, userType: opts.userType ?? 'staff', isSuperAdmin: opts.isSuperAdmin ?? false,
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: opts.tenantId, role: opts.role });
  const token = jwt.sign(
    { userId: u!.id, tenantId: opts.tenantId, role: opts.role, isSuperAdmin: opts.isSuperAdmin ?? false },
    process.env['JWT_SECRET']!, { expiresIn: '5m' },
  );
  return { id: u!.id, token };
}

async function cleanDb() {
  const tIds = [clientTenantId, staffHomeId].filter(Boolean);
  if (tIds.length) {
    await db.delete(firmInvites).where(inArray(firmInvites.tenantId, tIds));
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.tenantId, tIds));
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tIds));
  }
  if (firmId) {
    await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  if (tIds.length) {
    const uids = (await db.select({ id: users.id }).from(users).where(inArray(users.tenantId, tIds))).map((r) => r.id);
    if (uids.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
    await db.delete(users).where(inArray(users.tenantId, tIds));
    await db.delete(tenants).where(inArray(tenants.id, tIds));
  }
  clientTenantId = staffHomeId = firmId = '';
}

beforeEach(async () => {
  await cleanDb();
  mail.sendActionEmail.mockClear();
  clientTenantId = await seedTenant('FI Client');
  staffHomeId = await seedTenant('FI Staff Home');
  ownerToken = (await seedUser({ tenantId: clientTenantId, role: 'owner' })).token;
  accountantToken = (await seedUser({ tenantId: clientTenantId, role: 'accountant' })).token;
  clientUserToken = (await seedUser({ tenantId: clientTenantId, role: 'owner', userType: 'client' })).token;
  superAdminToken = (await seedUser({ tenantId: staffHomeId, role: 'owner', isSuperAdmin: true })).token;
  staffEmail = `cpa-${suffix()}@firm.example.com`;
  const staff = await seedUser({ tenantId: staffHomeId, role: 'accountant', email: staffEmail });
  staffToken = staff.token;
  const [f] = await db.insert(firms).values({ name: 'Route Firm', slug: `route-firm-${suffix()}` }).returning();
  firmId = f!.id;
  await db.insert(firmUsers).values({ firmId, userId: staff.id, firmRole: 'firm_staff' });
  await startApp();
});
afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

function codeFromLastMail(): string {
  const call = mail.sendActionEmail.mock.calls.at(-1) as unknown as [{ bodyText: string }];
  return /\n {4}([A-Z2-9]{8})\n/.exec(call[0].bodyText)![1]!;
}

describe('firm-invites routes — owner side', () => {
  it('401 without token', async () => {
    expect((await request('POST', '/api/v1/firm-invites', { email: staffEmail })).status).toBe(401);
  });
  it('client-type user gets 404, non-owner staff gets 403 OWNER_REQUIRED', async () => {
    expect((await request('POST', '/api/v1/firm-invites', { email: staffEmail }, clientUserToken)).status).toBe(404);
    const r = await request('POST', '/api/v1/firm-invites', { email: staffEmail }, accountantToken);
    expect(r.status).toBe(403);
    expect(r.json?.error?.code ?? r.json?.code).toBe('OWNER_REQUIRED');
    expect((await request('GET', '/api/v1/firm-invites', undefined, accountantToken)).status).toBe(403);
  });
  it('owner (and super admin) can send; list carries no hashes; invalid email is 400', async () => {
    const r = await request('POST', '/api/v1/firm-invites', { email: staffEmail }, ownerToken);
    expect(r.status).toBe(201);
    expect(r.json.sent).toBe(true);
    const list = await request('GET', '/api/v1/firm-invites', undefined, ownerToken);
    expect(list.status).toBe(200);
    expect(list.json.invites).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toMatch(/tokenHash|codeHash/);
    expect((await request('POST', '/api/v1/firm-invites', { email: 'not-an-email' }, ownerToken)).status).toBe(400);
    // Super admin acting on a tenant they don't own.
    expect((await request('POST', '/api/v1/firm-invites', { email: `x-${suffix()}@example.com` }, superAdminToken)).status).toBe(201);
  });
  it('resend / revoke', async () => {
    const r = await request('POST', '/api/v1/firm-invites', { email: staffEmail }, ownerToken);
    expect((await request('POST', `/api/v1/firm-invites/${r.json.inviteId}/resend`, undefined, ownerToken)).status).toBe(200);
    expect((await request('POST', `/api/v1/firm-invites/${r.json.inviteId}/revoke`, undefined, ownerToken)).status).toBe(200);
    expect((await request('POST', `/api/v1/firm-invites/${r.json.inviteId}/resend`, undefined, ownerToken)).status).toBe(400);
  });
  it('caps sends per tenant (5/hour → 429)', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await request('POST', '/api/v1/firm-invites', { email: `cap-${i}-${suffix()}@example.com` }, ownerToken);
      expect(r.status).toBe(201);
    }
    const sixth = await request('POST', '/api/v1/firm-invites', { email: `cap-6-${suffix()}@example.com` }, ownerToken);
    expect(sixth.status).toBe(429);
  });
});

describe('firm-invites routes — staff side', () => {
  it('lookup + accept by code; client-type users get 404; body validation', async () => {
    await request('POST', '/api/v1/firm-invites', { email: staffEmail }, ownerToken);
    const code = codeFromLastMail();
    expect((await request('POST', '/api/v1/firm-invites/lookup', { code }, clientUserToken)).status).toBe(404);
    expect((await request('POST', '/api/v1/firm-invites/lookup', {}, staffToken)).status).toBe(400);
    expect((await request('POST', '/api/v1/firm-invites/lookup', { code: 'nope' }, staffToken)).status).toBe(400);

    const preview = await request('POST', '/api/v1/firm-invites/lookup', { code: code.toLowerCase() }, staffToken);
    expect(preview.status).toBe(200);
    expect(preview.json.tenantName).toBe('FI Client');
    expect(preview.json.firms).toHaveLength(1);

    const accept = await request('POST', '/api/v1/firm-invites/accept', { code }, staffToken);
    expect(accept.status).toBe(200);
    expect(accept.json).toMatchObject({ firmId, alreadyAssigned: false, accessGranted: true });
    const active = await db.query.tenantFirmAssignments.findFirst({ where: eq(tenantFirmAssignments.tenantId, clientTenantId) });
    expect(active).toMatchObject({ firmId, isActive: true });
    // The wrong account is refused.
    const wrong = await request('POST', '/api/v1/firm-invites/lookup', { code }, accountantToken);
    expect(wrong.status).toBe(400); // already accepted (checked before identity)
  });
});
