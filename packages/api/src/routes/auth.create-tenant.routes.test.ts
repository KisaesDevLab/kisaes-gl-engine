// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Self-service tenant creation (POST /auth/create-tenant + eligibility):
//   - default OFF: eligibility says disabled and the POST 403s
//   - enabled: an owner creates a tenant and gets an 'owner' access row,
//     with NO appliance-firm assignment (unlike /auth/create-client)
//   - non-owner staff (bookkeeper) are refused
//   - the per-user cap counts total owned tenancies (home tenant included)
//   - limit 0 = unlimited

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, systemSettings, userTenantAccess } from '../db/schema/index.js';
import { authRouter } from './auth.routes.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';

let server: Server | null = null;
let port = 0;
let ownerToken = '';
let bookkeeperToken = '';
let homeTenantId = '';
let ownerId = '';

const OWNER_EMAIL = 'owner-create-tenant-test@example.com';
const BOOKKEEPER_EMAIL = 'bk-create-tenant-test@example.com';
const HOME_SLUG = 'create-tenant-test-home';
const SETTING_KEYS = [
  SystemSettingsKeys.SELF_SERVICE_TENANT_CREATION,
  SystemSettingsKeys.SELF_SERVICE_TENANT_LIMIT,
];

// Tenants provisioned during a test (tracked for FK-ordered cleanup).
let createdTenantIds: string[] = [];

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
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

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
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
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); }
          catch { resolve({ status: res.statusCode ?? 0, json: { raw } }); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function setSettings(enabled: boolean, limit?: number) {
  const rows: Array<{ key: string; value: string }> = [
    { key: SystemSettingsKeys.SELF_SERVICE_TENANT_CREATION, value: enabled ? 'true' : 'false' },
  ];
  if (limit !== undefined) rows.push({ key: SystemSettingsKeys.SELF_SERVICE_TENANT_LIMIT, value: String(limit) });
  for (const r of rows) {
    await db.insert(systemSettings).values({ ...r, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: r.value, updatedAt: new Date() } });
  }
}

async function deleteProvisionedTenants(ids: string[]) {
  if (ids.length === 0) return;
  // FK-ordered teardown of everything provisionTenant seeds.
  for (const table of ['audit_log', 'accounts', 'companies', 'tenant_feature_flags', 'user_tenant_access', 'tenant_firm_assignments']) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (${ids.map((i) => `'${i}'`).join(',')})`));
  }
  await db.delete(tenants).where(inArray(tenants.id, ids));
}

async function cleanDb() {
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  await deleteProvisionedTenants(createdTenantIds);
  createdTenantIds = [];
  const home = await db.query.tenants.findFirst({ where: eq(tenants.slug, HOME_SLUG) });
  if (home) {
    await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, home.id));
    await db.delete(users).where(inArray(users.email, [OWNER_EMAIL, BOOKKEEPER_EMAIL]));
    await db.delete(tenants).where(eq(tenants.id, home.id));
  }
}

beforeEach(async () => {
  await cleanDb();

  const [tenant] = await db.insert(tenants).values({ name: 'Create Tenant Home', slug: HOME_SLUG }).returning();
  homeTenantId = tenant!.id;

  const [owner] = await db.insert(users).values({
    tenantId: homeTenantId, email: OWNER_EMAIL, passwordHash: 'not-used',
    displayName: 'Owner', role: 'owner',
  }).returning();
  ownerId = owner!.id;
  // Mirror register(): the home tenancy is an owner access row.
  await db.insert(userTenantAccess).values({ userId: ownerId, tenantId: homeTenantId, role: 'owner' });

  const [bk] = await db.insert(users).values({
    tenantId: homeTenantId, email: BOOKKEEPER_EMAIL, passwordHash: 'not-used',
    displayName: 'BK', role: 'bookkeeper',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: bk!.id, tenantId: homeTenantId, role: 'bookkeeper' });

  ownerToken = jwt.sign(
    { userId: ownerId, tenantId: homeTenantId, role: 'owner', isSuperAdmin: false },
    process.env['JWT_SECRET']!, { expiresIn: '5m' },
  );
  bookkeeperToken = jwt.sign(
    { userId: bk!.id, tenantId: homeTenantId, role: 'bookkeeper', isSuperAdmin: false },
    process.env['JWT_SECRET']!, { expiresIn: '5m' },
  );

  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

async function createTenant(token: string, name: string) {
  const res = await request('POST', '/api/auth/create-tenant', { companyName: name, systemAccountsOnly: true }, token);
  if (res.status === 201) createdTenantIds.push(res.json['tenantId'] as string);
  return res;
}

describe('self-service tenant creation — disabled by default', () => {
  it('eligibility reports disabled and the POST 403s', async () => {
    const elig = await request('GET', '/api/auth/create-tenant/eligibility', undefined, ownerToken);
    expect(elig.status).toBe(200);
    expect(elig.json['enabled']).toBe(false);
    expect(elig.json['allowed']).toBe(false);

    const { status } = await createTenant(ownerToken, 'Should Not Exist LLC');
    expect(status).toBe(403);
  });
});

describe('self-service tenant creation — enabled', () => {
  beforeEach(() => setSettings(true));

  it('an owner creates an owned tenant: owner access row, no firm assignment', async () => {
    const { status, json } = await createTenant(ownerToken, 'Second Books LLC');
    expect(status).toBe(201);
    const newTenantId = json['tenantId'] as string;
    expect(newTenantId).toBeTruthy();
    expect(json['companyId']).toBeTruthy();

    const access = await db.query.userTenantAccess.findFirst({
      where: sql`user_id = ${ownerId} AND tenant_id = ${newTenantId}`,
    });
    expect(access?.role).toBe('owner');

    // Unlike create-client: the user's own books are NOT practice tooling,
    // so no appliance-firm assignment may exist for the new tenant.
    const firmRows = await db.execute(sql`SELECT id FROM tenant_firm_assignments WHERE tenant_id = ${newTenantId}`);
    expect(firmRows.rows).toHaveLength(0);
  });

  it('refuses non-owner staff', async () => {
    const { status, json } = await createTenant(bookkeeperToken, 'BK Books LLC');
    expect(status).toBe(403);
    expect((json['error'] as { message: string }).message).toMatch(/owner/i);
  });

  it('refuses a blank company name', async () => {
    const { status } = await request('POST', '/api/auth/create-tenant', { companyName: '   ' }, ownerToken);
    expect(status).toBe(400);
  });

  it('enforces the total-owned cap (home tenant counts)', async () => {
    await setSettings(true, 2);

    // Home tenancy = 1 of 2; this create makes 2 of 2.
    expect((await createTenant(ownerToken, 'Cap Books One')).status).toBe(201);

    const refused = await createTenant(ownerToken, 'Cap Books Two');
    expect(refused.status).toBe(403);
    expect((refused.json['error'] as { message: string }).message).toMatch(/2 allowed/);

    const elig = await request('GET', '/api/auth/create-tenant/eligibility', undefined, ownerToken);
    expect(elig.json['allowed']).toBe(false);
    expect(elig.json['used']).toBe(2);
    expect(elig.json['limit']).toBe(2);
  });

  it('treats limit 0 as unlimited', async () => {
    await setSettings(true, 0);
    expect((await createTenant(ownerToken, 'Unlimited One')).status).toBe(201);
    expect((await createTenant(ownerToken, 'Unlimited Two')).status).toBe(201);
    const elig = await request('GET', '/api/auth/create-tenant/eligibility', undefined, ownerToken);
    expect(elig.json['allowed']).toBe(true);
    expect(elig.json['limit']).toBe(0);
  });
});
