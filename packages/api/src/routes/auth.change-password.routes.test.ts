// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// POST /auth/change-password:
//   - 401 without a bearer token
//   - 400 on a too-short new password (Zod)
//   - happy path: 200, fresh access token in the body, rotated kb_refresh
//     cookie, and every pre-change refresh token is dead
//   - 400 INVALID_CURRENT_PASSWORD on a wrong current password

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog } from '../db/schema/index.js';
import { authRouter } from './auth.routes.js';
import * as authService from '../services/auth.service.js';

let server: Server | null = null;
let port = 0;

const EMAIL = 'change-password-route-test@example.com';

async function cleanDb() {
  const owned = await db.select({ id: users.tenantId }).from(users).where(inArray(users.email, [EMAIL]));
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
  app.use('/api/auth', authRouter);
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

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, any>; setCookie: string[] }> {
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
          const setCookie = res.headers['set-cookie'] ?? [];
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {}, setCookie }); }
          catch { resolve({ status: res.statusCode ?? 0, json: { raw }, setCookie }); }
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

async function registerUser() {
  return authService.register({
    email: EMAIL, password: 'password123',
    displayName: 'CP Route', companyName: 'CP Route Co',
  });
}

describe('POST /auth/change-password', () => {
  it('401s without a bearer token', async () => {
    const res = await request('POST', '/api/auth/change-password', {
      currentPassword: 'password123', newPassword: 'newpassword456',
    });
    expect(res.status).toBe(401);
  });

  it('400s on a too-short new password (Zod)', async () => {
    const reg = await registerUser();
    const res = await request('POST', '/api/auth/change-password', {
      currentPassword: 'password123', newPassword: 'short',
    }, reg.tokens.accessToken);
    expect(res.status).toBe(400);
  });

  it('400s with INVALID_CURRENT_PASSWORD on a wrong current password', async () => {
    const reg = await registerUser();
    const res = await request('POST', '/api/auth/change-password', {
      currentPassword: 'wrongpassword', newPassword: 'newpassword456',
    }, reg.tokens.accessToken);
    expect(res.status).toBe(400);
    expect(res.json['error']?.code).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('changes the password, keeps this device signed in, kills the old refresh token', async () => {
    const reg = await registerUser();
    const res = await request('POST', '/api/auth/change-password', {
      currentPassword: 'password123', newPassword: 'newpassword456',
    }, reg.tokens.accessToken);

    expect(res.status).toBe(200);
    expect(res.json['tokens']?.accessToken).toBeTruthy();
    // A fresh session was minted for this device: rotated refresh cookie.
    expect(res.setCookie.some((c) => c.startsWith('kb_refresh=') && !c.startsWith('kb_refresh=;'))).toBe(true);

    // The pre-change refresh token is dead; the new session works.
    await expect(authService.refresh(reg.tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
    const login = await authService.login({ email: EMAIL, password: 'newpassword456' });
    expect(login.tokens.accessToken).toBeTruthy();
  });
});
