// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Temporary passwords (U-230, temp-password-v1) through the REAL app.ts:
// an owner sets one for a team member (desktop only); the member must change
// it before anything else; non-owners, yourself, other tenants and super
// admins are refused; the server neither mounts the route nor sets the flag.

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
import { auditLog, sessions, tenants, userTenantAccess, users } from '../db/schema/index.js';
import { createCompanyForTenant } from '../services/company.service.js';
import { deleteTenant } from './sensitive.test-fixtures.js';

const TOKEN = 'tptest_' + 't'.repeat(44);
const SLUG = 'tp-routes-test';
const OLD_PASSWORD = 'member-old-password-1';

let tenantId = '';
let otherTenantId = '';
let companyId = '';
const ids: Record<string, string> = {};
const jwts: Record<string, string> = {};

async function cleanup(): Promise<void> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(inArray(tenants.slug, [SLUG, `${SLUG}-other`]));
  for (const t of rows) {
    const us = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, t.id));
    if (us.length) {
      await db.delete(sessions).where(inArray(sessions.userId, us.map((u) => u.id)));
      await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, us.map((u) => u.id)));
    }
    await deleteTenant(t.id);
  }
}

async function addUser(key: string, tenant: string, role: string, extra: Record<string, unknown> = {}) {
  const [u] = await db.insert(users).values({
    tenantId: tenant, email: `${key}-${SLUG}@example.com`, passwordHash: await bcrypt.hash(OLD_PASSWORD, 4), displayName: key, role, ...extra,
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: tenant, role });
  ids[key] = u!.id;
  jwts[key] = jwt.sign({ userId: u!.id, tenantId: tenant, role, isSuperAdmin: !!extra['isSuperAdmin'] }, process.env['JWT_SECRET']!, { expiresIn: '10m' });
}

beforeAll(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({ name: 'TP Tenant', slug: SLUG }).returning();
  const [o] = await db.insert(tenants).values({ name: 'TP Other', slug: `${SLUG}-other` }).returning();
  tenantId = t!.id;
  otherTenantId = o!.id;
  companyId = (await createCompanyForTenant(tenantId, 'TP Co'))!.id;
  await addUser('owner', tenantId, 'owner');
  await addUser('member', tenantId, 'bookkeeper');
  await addUser('bk', tenantId, 'bookkeeper');
  await addUser('boss', tenantId, 'owner', { isSuperAdmin: true });
  await addUser('outsider', otherTenantId, 'bookkeeper');
}, 60_000);

afterAll(async () => { await cleanup(); });

afterEach(async () => { (await import('../desktop/profile.js'))._resetDesktopProfileForTests(); });

async function loadApp(mode: 'desktop' | 'server'): Promise<Express> {
  vi.resetModules();
  const profile = await import('../desktop/profile.js');
  if (mode === 'desktop') {
    profile.loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: TOKEN, CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-tp-test') });
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
    const headers: Record<string, string> = { 'x-cl-token': TOKEN, 'x-company-id': companyId };
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

const tp = (call: Call, who: string, target: string) =>
  call(`/api/v1/company/users/${target}/temporary-password`, { method: 'POST', jwt: jwts[who] });

describe('temporary passwords (desktop)', () => {
  it('the owner sets one; the member must change it before anything else', async () => {
    await db.update(users).set({ loginFailedAttempts: 5, loginLockedUntil: new Date() }).where(eq(users.id, ids['member']!));
    await db.insert(sessions).values({ userId: ids['member']!, refreshTokenHash: `tp-${Date.now()}`, expiresAt: new Date(Date.now() + 60_000) } as never);
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      const r = await tp(call, 'owner', ids['member']!);
      expect(r.status, r.text).toBe(200);
      const temp = r.json.temporaryPassword as string;
      expect(temp).toMatch(/^[0-9a-f]{16}$/);

      const [u] = await db.select().from(users).where(eq(users.id, ids['member']!));
      expect(u!.passwordChangeRequired).toBe(true);
      expect(u!.loginLockedUntil).toBeNull();
      expect(u!.loginFailedAttempts).toBe(0);
      expect(await bcrypt.compare(temp, u!.passwordHash)).toBe(true);
      expect(await db.select().from(sessions).where(eq(sessions.userId, ids['member']!))).toHaveLength(0);
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'user_temporary_password')));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(temp);

      // The listed user and the sign-in reply show it.
      const list = await call('/api/v1/company/users', { jwt: jwts['owner'] });
      expect(list.json.users.find((x: { id: string }) => x.id === ids['member']).passwordChangeRequired).toBe(true);
      const login = await call('/api/v1/auth/login', { method: 'POST', body: { email: `member-${SLUG}@example.com`, password: temp } });
      expect(login.status, login.text).toBe(200);
      expect(login.json.user.passwordChangeRequired).toBe(true);
      const session = login.json.tokens.accessToken as string;

      // Everything but me and change-password is refused.
      const blocked = await call('/api/v1/company/users', { jwt: session });
      expect(blocked.status).toBe(403);
      expect(blocked.json.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      const me = await call('/api/v1/auth/me', { jwt: session });
      expect(me.status).toBe(200);
      expect(me.json.user.passwordChangeRequired).toBe(true);

      const changed = await call('/api/v1/auth/change-password', {
        method: 'POST', jwt: session, body: { currentPassword: temp, newPassword: 'member-chose-this-one-7' },
      });
      expect(changed.status, changed.text).toBe(200);
      const fresh = changed.json.tokens.accessToken as string;
      expect((await call('/api/v1/company/users', { jwt: fresh })).status).toBe(200);
      expect((await db.select().from(users).where(eq(users.id, ids['member']!)))[0]!.passwordChangeRequired).toBe(false);
    });
  });

  it('refuses a non-owner, yourself, another tenant\'s user and a super admin', async () => {
    const app = await loadApp('desktop');
    await withServer(app, async (call) => {
      const nonOwner = await tp(call, 'bk', ids['member']!);
      expect(nonOwner.status).toBe(403);
      const self = await tp(call, 'owner', ids['owner']!);
      expect(self.status).toBe(403);
      expect(self.json.error.code).toBe('CANNOT_TARGET_SELF');
      const other = await tp(call, 'owner', ids['outsider']!);
      expect(other.status).toBe(403);
      expect(other.json.error.code).toBe('USER_NOT_IN_TENANT');
      const boss = await tp(call, 'owner', ids['boss']!);
      expect(boss.status).toBe(403);
      expect(boss.json.error.code).toBe('SUPER_ADMIN_TARGET');
      const [o] = await db.select().from(users).where(eq(users.id, ids['outsider']!));
      expect(o!.passwordChangeRequired).toBe(false);
    });
  });

  it('the server has no route and its invites never set the flag', async () => {
    const app = await loadApp('server');
    await withServer(app, async (call) => {
      expect((await tp(call, 'owner', ids['bk']!)).status).toBe(404);
    });
    const authService = await import('../services/auth.service.js');
    const r = await authService.inviteUser(tenantId, { email: `invitee-${SLUG}@example.com`, displayName: 'Invitee', role: 'readonly' }, ids['owner']);
    expect(r.user.passwordChangeRequired).toBe(false);
  });
});
