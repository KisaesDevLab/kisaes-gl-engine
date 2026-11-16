// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Desktop recovery key (U-23, recovery-key-v1) through the REAL app.ts:
// POST /desktop/recover-password and POST /auth/recovery-key/rotate. A key
// works once (the reply carries a fresh one), a wrong key is 401 and audited
// without the key, recovery clears the lockout and ends sessions, rotation
// makes the old key fail, and the server mounts neither route.
// (/desktop/initialize returning the key: desktop/workspace.test.ts.)

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import type { Express } from 'express';
import { db } from '../db/index.js';
import { auditLog, sessions, tenants, users } from '../db/schema/index.js';

const TOKEN = 'rktest_' + 'k'.repeat(44);
const SLUG = 'rk-routes-test';
const OWNER_EMAIL = `owner-${SLUG}@example.com`;
const BK_EMAIL = `bk-${SLUG}@example.com`;

let tenantId = '';
let ownerId = '';
let ownerJwt = '';
let bkJwt = '';

async function cleanup(): Promise<void> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, SLUG));
  for (const t of rows) {
    const us = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, t.id));
    if (us.length) await db.delete(sessions).where(inArray(sessions.userId, us.map((u) => u.id)));
    await db.delete(auditLog).where(eq(auditLog.tenantId, t.id));
    await db.delete(users).where(eq(users.tenantId, t.id));
  }
  await db.delete(tenants).where(eq(tenants.slug, SLUG));
}

beforeAll(async () => {
  await cleanup();
  const [tenant] = await db.insert(tenants).values({ name: 'RK Tenant', slug: SLUG }).returning();
  tenantId = tenant!.id;
  const [owner] = await db.insert(users).values({
    tenantId, email: OWNER_EMAIL, passwordHash: await bcrypt.hash('old-password-123', 4), displayName: 'Owner', role: 'owner', isSuperAdmin: true,
  }).returning();
  const [bk] = await db.insert(users).values({
    tenantId, email: BK_EMAIL, passwordHash: 'x', displayName: 'BK', role: 'bookkeeper',
  }).returning();
  ownerId = owner!.id;
  const secret = process.env['JWT_SECRET']!;
  ownerJwt = jwt.sign({ userId: ownerId, tenantId, role: 'owner', isSuperAdmin: true }, secret, { expiresIn: '5m' });
  bkJwt = jwt.sign({ userId: bk!.id, tenantId, role: 'bookkeeper', isSuperAdmin: false }, secret, { expiresIn: '5m' });
});

afterAll(async () => { await cleanup(); });

afterEach(async () => { (await import('../desktop/profile.js'))._resetDesktopProfileForTests(); });

async function loadApp(mode: 'desktop' | 'server'): Promise<Express> {
  vi.resetModules();
  const profile = await import('../desktop/profile.js');
  if (mode === 'desktop') {
    profile.loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-rk-test') });
  } else {
    profile.loadDesktopProfile({});
  }
  return (await import('../app.js')).app;
}

type Call = (p: string, init?: { method?: string; body?: unknown; jwt?: string }) => Promise<{ status: number; text: string; json: any }>;

async function withServer<T>(app: Express, fn: (call: Call) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
  setDesktopBoundAddress('127.0.0.1', port);
  const call: Call = async (p, init = {}) => {
    const headers: Record<string, string> = { 'x-cl-token': TOKEN };
    if (init.jwt) headers['authorization'] = `Bearer ${init.jwt}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, json };
  };
  try {
    return await fn(call);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const recover = (call: Call, recoveryKey: string, newPassword = 'a-brand-new-password-1', email = OWNER_EMAIL) =>
  call('/api/v1/desktop/recover-password', { method: 'POST', body: { email, recoveryKey, newPassword } });

describe('desktop recovery key', () => {
  it('a key works once, clears the lockout, ends sessions and returns a fresh key', async () => {
    const svc = await import('../services/desktop-recovery-key.service.js');
    const key = await svc.issueRecoveryKey(ownerId);
    expect(key).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){4}$/);
    const stored = (await db.select({ h: users.recoveryKeyHash }).from(users).where(eq(users.id, ownerId)))[0]!.h;
    expect(stored).toBe(svc.hashRecoveryKey(key));
    expect(stored).not.toContain(key.replace(/-/g, ''));
    await db.update(users).set({ loginFailedAttempts: 5, loginLockedUntil: new Date(Date.now() + 60_000), passwordChangeRequired: true })
      .where(eq(users.id, ownerId));
    await db.insert(sessions).values({ userId: ownerId, refreshTokenHash: `rk-${Date.now()}`, expiresAt: new Date(Date.now() + 60_000) } as never);

    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      // Wrong key: 401, audited without the key.
      const wrong = await recover(call, 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
      expect(wrong.status).toBe(401);
      expect(wrong.json.error.code).toBe('INVALID_CREDENTIALS');
      const unknown = await recover(call, key, 'a-brand-new-password-1', `nobody-${SLUG}@example.com`);
      expect(unknown.status).toBe(401);
      expect(unknown.json.error.code).toBe('INVALID_CREDENTIALS');

      // The right key, typed lowercase with spaces.
      const typed = key.toLowerCase().replace(/-/g, ' ');
      const ok = await recover(call, typed);
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json.recovered).toBe(true);
      expect(ok.json.recoveryKey).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){4}$/);
      expect(ok.json.recoveryKey).not.toBe(key);

      const [u] = await db.select().from(users).where(eq(users.id, ownerId));
      expect(u!.loginFailedAttempts).toBe(0);
      expect(u!.loginLockedUntil).toBeNull();
      expect(u!.passwordChangeRequired).toBe(false);
      expect(u!.recoveryKeyHash).toBe(svc.hashRecoveryKey(ok.json.recoveryKey));
      expect(await bcrypt.compare('a-brand-new-password-1', u!.passwordHash)).toBe(true);
      expect(await db.select().from(sessions).where(eq(sessions.userId, ownerId))).toHaveLength(0);

      // A used key stops working.
      const again = await recover(call, key, 'another-new-password-2');
      expect(again.status).toBe(401);

      // Audit rows: one success, failures with a reason; never the key.
      const rows = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityId, ownerId)));
      const types = rows.map((r) => r.entityType);
      expect(types).toContain('user_password_recovery');
      expect(types).toContain('user_password_recovery_failed');
      const blob = JSON.stringify(rows);
      for (const k of [key, ok.json.recoveryKey]) {
        expect(blob).not.toContain(k);
        expect(blob).not.toContain(k.replace(/-/g, ''));
      }
      expect(blob).not.toContain('a-brand-new-password-1');

      // Rotate: owner gets a new key, the previous one fails; a bookkeeper is 403.
      const rot = await call('/api/v1/auth/recovery-key/rotate', { method: 'POST', jwt: ownerJwt });
      expect(rot.status, rot.text).toBe(200);
      expect(rot.json.recoveryKey).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){4}$/);
      expect((await recover(call, ok.json.recoveryKey, 'third-new-password-3')).status).toBe(401);
      const bk = await call('/api/v1/auth/recovery-key/rotate', { method: 'POST', jwt: bkJwt });
      expect(bk.status).toBe(403);
      expect(bk.json.error.code).toBe('OWNER_REQUIRED');
      expect((await recover(call, rot.json.recoveryKey, 'third-new-password-3')).status).toBe(200);
    });
  });

  it('a short password is 400 and nothing changes', async () => {
    const svc = await import('../services/desktop-recovery-key.service.js');
    const key = await svc.issueRecoveryKey(ownerId);
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      const r = await recover(call, key, 'short');
      expect(r.status).toBe(400);
      expect((await recover(call, key)).status).toBe(200);
    });
  });

  it('wrong keys are rate-limited per email', async () => {
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await recover(call, 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'a-brand-new-password-1', BK_EMAIL)).status);
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes[5]).toBe(429);
    });
  });

  it('the server has neither route', async () => {
    const app = await loadApp('server');
    await withServer(app, async (call) => {
      expect((await recover(call, 'AAAAA')).status).toBe(404);
      expect((await call('/api/v1/auth/recovery-key/rotate', { method: 'POST', jwt: ownerJwt })).status).toBe(404);
    });
  });
});
