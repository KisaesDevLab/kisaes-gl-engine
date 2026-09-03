// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// PATCH /company/users/:userId (role editing):
//   - an owner changes a team member's role → 200, role persisted
//   - a non-owner is refused → 403
//   - an empty body fails the schema refine → 400
//
// POST /company/users/:userId/unlock (lockout release):
//   - an owner clears a locked teammate's lockout → 200, login works again
//   - a non-owner is refused → 403
//   - a user outside the caller's tenant → 404 (no cross-tenant unlock)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog } from '../db/schema/index.js';
import { companyRouter } from './company.routes.js';
import * as authService from '../services/auth.service.js';

let server: Server | null = null;
let port = 0;

const OWNER_EMAIL = 'company-users-route-owner@example.com';

async function cleanDb() {
  const owned = await db.select({ id: users.tenantId }).from(users).where(inArray(users.email, [OWNER_EMAIL]));
  const tenantIds = [...new Set(owned.map((r) => r.id))];
  if (tenantIds.length === 0) return;
  await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
  await db.delete(accounts).where(inArray(accounts.tenantId, tenantIds));
  await db.delete(companies).where(inArray(companies.tenantId, tenantIds));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(inArray(users.tenantId, tenantIds))),
  );
  await db.delete(users).where(inArray(users.tenantId, tenantIds));
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/company', companyRouter);
  app.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Mirror the real error-handler's ZodError mapping so validate()
    // failures come back as 400s here too.
    const status = err.name === 'ZodError' ? 400 : (err.statusCode ?? 500);
    res.status(status).json({ error: { message: err.message, code: err.code } });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, any> }> {
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

beforeEach(async () => {
  await cleanDb();
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

async function setup() {
  const reg = await authService.register({
    email: OWNER_EMAIL, password: 'password123',
    displayName: 'Owner', companyName: 'Users Route Co',
  });
  const invited = await authService.inviteUser(reg.user.tenantId, {
    email: 'company-users-route-target@example.com', displayName: 'Target', role: 'readonly',
  }, reg.user.id);
  return { reg, invited };
}

describe('PATCH /company/users/:userId (role)', () => {
  it('lets an owner change a member role', async () => {
    const { reg, invited } = await setup();
    const res = await request('PATCH', `/api/company/users/${invited.user.id}`, {
      email: invited.user.email, displayName: 'Target', role: 'accountant',
    }, reg.tokens.accessToken);

    expect(res.status).toBe(200);
    expect(res.json['user']?.role).toBe('accountant');
    const listed = await authService.listTenantUsers(reg.user.tenantId);
    expect(listed.find((u) => u.id === invited.user.id)!.role).toBe('accountant');
  });

  it('refuses a non-owner', async () => {
    const { reg, invited } = await setup();
    // Promote target to accountant first so we test the gate, not the role.
    await authService.updateUser(reg.user.tenantId, invited.user.id, { role: 'accountant' }, reg.user.id);
    const login = await authService.login({
      email: 'company-users-route-target@example.com', password: invited.temporaryPassword!,
    });

    const res = await request('PATCH', `/api/company/users/${reg.user.id}`, {
      email: OWNER_EMAIL, displayName: 'Owner', role: 'bookkeeper',
    }, login.tokens.accessToken);
    expect(res.status).toBe(403);
  });

  it('400s on an empty body (schema refine)', async () => {
    const { reg, invited } = await setup();
    const res = await request('PATCH', `/api/company/users/${invited.user.id}`, {}, reg.tokens.accessToken);
    expect(res.status).toBe(400);
  });
});

describe('POST /company/users/:userId/unlock', () => {
  it('lets an owner clear a lockout so the user can sign in again', async () => {
    const { reg, invited } = await setup();
    // Simulate the lockout the login path writes after MAX_LOGIN_ATTEMPTS.
    // login_locked_until is a flag, not a countdown: any non-null value
    // keeps a regular user out until an admin clears it.
    await db.update(users)
      .set({ loginFailedAttempts: 5, loginLockedUntil: new Date('2099-01-01T00:00:00Z') })
      .where(eq(users.id, invited.user.id));

    const listedLocked = await authService.listTenantUsers(reg.user.tenantId);
    expect(listedLocked.find((u) => u.id === invited.user.id)!.isLocked).toBe(true);

    await expect(authService.login({
      email: invited.user.email, password: invited.temporaryPassword!,
    })).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });

    const res = await request('POST', `/api/company/users/${invited.user.id}/unlock`, {}, reg.tokens.accessToken);
    expect(res.status).toBe(200);
    expect(res.json['wasLocked']).toBe(true);

    const after = await db.query.users.findFirst({ where: eq(users.id, invited.user.id) });
    expect(after!.loginLockedUntil).toBeNull();
    expect(after!.loginFailedAttempts).toBe(0);

    const listed = await authService.listTenantUsers(reg.user.tenantId);
    expect(listed.find((u) => u.id === invited.user.id)!.isLocked).toBe(false);

    // The whole point: the user can actually get back in.
    const login = await authService.login({
      email: invited.user.email, password: invited.temporaryPassword!,
    });
    expect(login.tokens.accessToken).toBeTruthy();
  });

  it('is a no-op (not an error) for a user who is not locked', async () => {
    const { reg, invited } = await setup();
    const res = await request('POST', `/api/company/users/${invited.user.id}/unlock`, {}, reg.tokens.accessToken);
    expect(res.status).toBe(200);
    expect(res.json['wasLocked']).toBe(false);
  });

  it('refuses a non-owner', async () => {
    const { reg, invited } = await setup();
    await authService.updateUser(reg.user.tenantId, invited.user.id, { role: 'accountant' }, reg.user.id);
    const login = await authService.login({
      email: invited.user.email, password: invited.temporaryPassword!,
    });
    const res = await request('POST', `/api/company/users/${reg.user.id}/unlock`, {}, login.tokens.accessToken);
    expect(res.status).toBe(403);
  });

  it('404s for a user outside the caller tenant', async () => {
    const { reg } = await setup();
    const outsider = await authService.register({
      email: 'company-users-route-outsider@example.com', password: 'password123',
      displayName: 'Outsider', companyName: 'Other Co',
    });
    try {
      const res = await request('POST', `/api/company/users/${outsider.user.id}/unlock`, {}, reg.tokens.accessToken);
      expect(res.status).toBe(404);
      // And the outsider's own state is untouched.
      const still = await db.query.users.findFirst({ where: eq(users.id, outsider.user.id) });
      expect(still).toBeDefined();
    } finally {
      await db.delete(auditLog).where(eq(auditLog.tenantId, outsider.user.tenantId));
      await db.delete(accounts).where(eq(accounts.tenantId, outsider.user.tenantId));
      await db.delete(companies).where(eq(companies.tenantId, outsider.user.tenantId));
      await db.delete(sessions).where(eq(sessions.userId, outsider.user.id));
      await db.delete(users).where(eq(users.tenantId, outsider.user.tenantId));
      await db.delete(tenants).where(eq(tenants.id, outsider.user.tenantId));
    }
  });
});
