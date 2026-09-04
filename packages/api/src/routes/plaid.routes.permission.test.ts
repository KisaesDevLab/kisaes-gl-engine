// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The Plaid router had no permission gate at all — only `authenticate`.
//
// So a readonly-role user, or a client-type user, could unmap a bank account
// from its ledger account, remap it, toggle syncing off, or delete an entire
// connection. Every neighbouring banking route has been gated for a long time;
// the invite routes here even grew their own inline role checks because the
// router had none, which is the tell.
//
// These assert the gate by ROUTE rather than by service, because the hole was
// in the wiring and a service-level test would have passed throughout.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, userTenantAccess, companies, sessions } from '../db/schema/index.js';
import { plaidRouter } from './plaid.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let ownerId = '';
const tokens: Record<string, string> = {};

const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

function request(method: string, pathname: string, token: string, body?: unknown) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
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

beforeEach(async () => {
  const reg = await authService.register({
    email: `plaidperm-${suffix()}@example.com`,
    password: 'password123',
    displayName: 'Owner',
    companyName: 'Plaid Perm Co',
  });
  tenantId = reg.user.tenantId;
  ownerId = reg.user.id;
  tokens['owner'] = reg.tokens.accessToken;

  // A readonly staff user in the same tenant.
  const [ro] = await db.insert(users).values({
    tenantId, email: `ro-${suffix()}@example.com`, passwordHash: 'x',
    displayName: 'Readonly', role: 'readonly',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: ro!.id, tenantId, role: 'readonly' });
  tokens['readonly'] = (await authService.issueSession({
    userId: ro!.id, tenantId, role: 'readonly', email: ro!.email,
  } as never)).accessToken;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/plaid', plaidRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  if (!tenantId) return;
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId));
  for (const u of staff) await db.delete(sessions).where(eq(sessions.userId, u.id));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
});

const FAKE = '00000000-0000-0000-0000-0000000000ff';

describe('plaid router — readonly cannot mutate bank connections', () => {
  const mutations: Array<[string, string, unknown?]> = [
    ['POST', `/api/v1/plaid/accounts/${FAKE}/unmap`],
    ['PUT', `/api/v1/plaid/accounts/${FAKE}/remap`, { coaAccountId: FAKE }],
    ['PUT', `/api/v1/plaid/accounts/${FAKE}/sync-toggle`, { enabled: false }],
    ['DELETE', `/api/v1/plaid/items/${FAKE}`],
    ['POST', `/api/v1/plaid/items/${FAKE}/sync`],
  ];

  for (const [method, path, body] of mutations) {
    it(`refuses ${method} ${path.replace(FAKE, ':id')}`, async () => {
      const res = await request(method, path, tokens['readonly']!, body);
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('PERMISSION_DENIED');
    });
  }

  it('still lets a readonly user READ the connection list', async () => {
    // The gate maps method to action, so reads must stay open — otherwise a
    // readonly user loses the Bank Connections screen entirely.
    const res = await request('GET', '/api/v1/plaid/items', tokens['readonly']!);
    expect(res.status).toBe(200);
  });

  it('still lets the owner through to the real handler', async () => {
    // 404 from the service, not 403 from the gate: the permission check passed
    // and the route ran.
    const res = await request('POST', `/api/v1/plaid/accounts/${FAKE}/unmap`, tokens['owner']!);
    expect(res.status).not.toBe(403);
  });
});
