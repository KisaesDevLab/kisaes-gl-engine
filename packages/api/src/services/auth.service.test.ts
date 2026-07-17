// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { db, pool } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, userTenantAccess } from '../db/schema/index.js';
import { auditLog } from '../db/schema/index.js';
import { env } from '../config/env.js';
import * as authService from './auth.service.js';
import type { JwtPayload } from '@kis-books/shared';
import { sql, eq, and, inArray, like } from 'drizzle-orm';

// Every email this file registers with — register() creates one tenant
// per call, so these locate the tenants the file owns.
const TEST_EMAILS = ['test@example.com', 'session-cap@example.com', 'lockout@example.com'];

// Tenant-scoped cleanup — only ever touch this file's own tenants so
// concurrently-running suites' data survives. Tenants are discovered via
// the fixed registration emails (covers leftovers from a previous crashed
// run too) plus the directly-inserted 'tenant-b-*' switch-target tenants.
async function cleanDb() {
  const owned = await db
    .select({ id: users.tenantId })
    .from(users)
    .where(inArray(users.email, TEST_EMAILS));
  const switchTargets = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(like(tenants.slug, 'tenant-b-%'));
  const tenantIds = [...new Set([...owned, ...switchTargets].map((r) => r.id))];
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

describe('Auth Service', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterEach(async () => {
    await cleanDb();
  });

  describe('register', () => {
    it('should create tenant, user, and return tokens', async () => {
      const result = await authService.register({
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
        companyName: 'Test Company',
      });

      expect(result.user.email).toBe('test@example.com');
      expect(result.user.displayName).toBe('Test User');
      expect(result.user.role).toBe('owner');
      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.refreshToken).toBeTruthy();

      // Verify JWT contains correct payload
      const payload = jwt.verify(result.tokens.accessToken, env.JWT_SECRET) as JwtPayload;
      expect(payload.userId).toBe(result.user.id);
      expect(payload.tenantId).toBe(result.user.tenantId);
      expect(payload.role).toBe('owner');

      // Self-signup must also create a client-portal contact linked to
      // the tenant's company (owner role, financials access).
      const { db } = await import('../db/index.js');
      const { portalContacts, portalContactCompanies } = await import('../db/schema/index.js');
      const { eq } = await import('drizzle-orm');
      const contact = await db.query.portalContacts.findFirst({
        where: eq(portalContacts.tenantId, result.user.tenantId),
      });
      expect(contact).toBeTruthy();
      expect(contact!.email).toBe('test@example.com');
      const links = await db.select().from(portalContactCompanies)
        .where(eq(portalContactCompanies.contactId, contact!.id));
      expect(links).toHaveLength(1);
      expect(links[0]!.role).toBe('owner');
      expect(links[0]!.financialsAccess).toBe(true);

      // Self-signup: tenant is ASSIGNED to the appliance firm (so
      // firm/global rules apply) but the user gets NO firm membership
      // — firm membership is what exposes the Practice/Firm staff
      // surfaces and, historically, appliance-wide admin powers.
      const { getActiveForTenant } = await import('./tenant-firm-assignment.service.js');
      const { getRoleForUser } = await import('./firm-users.service.js');
      const assignment = await getActiveForTenant(result.user.tenantId);
      expect(assignment).not.toBeNull();
      const firmRole = await getRoleForUser(assignment!.firmId, result.user.id);
      expect(firmRole).toBeNull();
    });

    it('should reject duplicate email', async () => {
      await authService.register({
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
        companyName: 'Test Company',
      });

      await expect(
        authService.register({
          email: 'test@example.com',
          password: 'password456',
          displayName: 'Another User',
          companyName: 'Another Company',
        }),
      ).rejects.toThrow('An account with this email already exists');
    });
  });

  describe('login', () => {
    it('should login with correct credentials', async () => {
      await authService.register({
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
        companyName: 'Test Company',
      });

      const result = await authService.login({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.user.email).toBe('test@example.com');
      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.refreshToken).toBeTruthy();
    });

    it('should reject invalid password', async () => {
      await authService.register({
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
        companyName: 'Test Company',
      });

      await expect(
        authService.login({
          email: 'test@example.com',
          password: 'wrongpassword',
        }),
      ).rejects.toThrow('Invalid email or password');
    });

    it('should reject non-existent email', async () => {
      await expect(
        authService.login({
          email: 'nonexistent@example.com',
          password: 'password123',
        }),
      ).rejects.toThrow('Invalid email or password');
    });

    it('caps per-user sessions at 3; the oldest gets revoked when a fourth login arrives', async () => {
      const reg = await authService.register({
        email: 'session-cap@example.com',
        password: 'password123',
        displayName: 'Session Cap',
        companyName: 'Cap Co',
      });
      // Registration already created session #1. Login three more
      // times — the oldest (the register session) should be trimmed
      // once we cross the MAX_SESSIONS_PER_USER=3 threshold.
      const logins = [];
      for (let i = 0; i < 3; i++) {
        const r = await authService.login({ email: 'session-cap@example.com', password: 'password123' });
        logins.push(r);
      }

      // Verify: the original register refresh token must now fail,
      // while the three most recent sessions all work.
      await expect(authService.refresh(reg.tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
      for (const login of logins) {
        // refresh() rotates, so we test once and then remaining
        // sessions remain live via their new tokens.
        const newTokens = await authService.refresh(login.tokens.refreshToken);
        expect(newTokens.accessToken).toBeTruthy();
      }
    });

    it('locks the account after 5 failed attempts and requires admin unlock', async () => {
      const reg = await authService.register({
        email: 'lockout@example.com',
        password: 'password123',
        displayName: 'Lockout User',
        companyName: 'Lockout Co',
      });

      for (let i = 0; i < 5; i++) {
        await expect(
          authService.login({ email: 'lockout@example.com', password: 'wrongpassword' }),
        ).rejects.toThrow('Invalid email or password');
      }

      // 6th attempt — even with the correct password — must fail
      // because the account is now locked. Auto-unlock-after-15-min
      // was removed per CLOUDFLARE_TUNNEL_PLAN Phase 3.
      await expect(
        authService.login({ email: 'lockout@example.com', password: 'password123' }),
      ).rejects.toThrow(/locked/i);

      // Admin unlock clears the counter and lets the correct
      // password through.
      const { unlockUser } = await import('./admin.service.js');
      const result = await unlockUser(reg.user.id, reg.user.id);
      expect(result.unlocked).toBe(true);
      expect(result.wasLocked).toBe(true);

      const ok = await authService.login({ email: 'lockout@example.com', password: 'password123' });
      expect(ok.tokens.accessToken).toBeTruthy();
    });
  });

  describe('refresh', () => {
    it('should issue new tokens with valid refresh token', async () => {
      const registerResult = await authService.register({
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
        companyName: 'Test Company',
      });

      const newTokens = await authService.refresh(registerResult.tokens.refreshToken);

      expect(newTokens.accessToken).toBeTruthy();
      expect(newTokens.refreshToken).toBeTruthy();
      // Old refresh token should be rotated (different from original)
      expect(newTokens.refreshToken).not.toBe(registerResult.tokens.refreshToken);
    });

    it('should reject invalid refresh token', async () => {
      await expect(authService.refresh('invalid-token')).rejects.toThrow('Invalid refresh token');
    });

    it('should reject reused (rotated) refresh token', async () => {
      const registerResult = await authService.register({
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
        companyName: 'Test Company',
      });

      // Use the refresh token once
      await authService.refresh(registerResult.tokens.refreshToken);

      // Try to use the same token again (it was rotated)
      await expect(authService.refresh(registerResult.tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
    });

    it('preserves a switched tenant across refresh (does not revert to home)', async () => {
      const reg = await authService.register({
        email: 'test@example.com', password: 'password123', displayName: 'Test User', companyName: 'Home Co',
      });
      const [tenantB] = await db.insert(tenants).values({ name: 'Tenant B', slug: 'tenant-b-' + Date.now() }).returning();
      await db.insert(userTenantAccess).values({ userId: reg.user.id, tenantId: tenantB!.id, role: 'bookkeeper', isActive: true });

      const switched = await authService.switchTenant(reg.user.id, tenantB!.id, reg.tokens.refreshToken);
      expect((jwt.verify(switched.accessToken, env.JWT_SECRET) as JwtPayload).tenantId).toBe(tenantB!.id);

      // The bug: an expired access token refreshed mid-session used to
      // re-mint against the user's HOME tenant, silently switching them.
      const refreshed = await authService.refresh(switched.refreshToken);
      const payload = jwt.verify(refreshed.accessToken, env.JWT_SECRET) as JwtPayload;
      expect(payload.tenantId).toBe(tenantB!.id);
      expect(payload.role).toBe('bookkeeper');
    });

    it('re-reads the CURRENT role on refresh — a demotion is not survivable (SECURITY)', async () => {
      const reg = await authService.register({
        email: 'test@example.com', password: 'password123', displayName: 'Test User', companyName: 'Home Co',
      });
      // Session was minted with role 'owner'. Admin demotes the user.
      await db.update(users).set({ role: 'readonly' }).where(eq(users.id, reg.user.id));

      const refreshed = await authService.refresh(reg.tokens.refreshToken);
      const payload = jwt.verify(refreshed.accessToken, env.JWT_SECRET) as JwtPayload;
      // The stale session.role ('owner') must NOT be re-minted.
      expect(payload.role).toBe('readonly');

      // And the demotion sticks across a second refresh (the new session row
      // must not have re-persisted the stale role either).
      const again = await authService.refresh(refreshed.refreshToken);
      expect((jwt.verify(again.accessToken, env.JWT_SECRET) as JwtPayload).role).toBe('readonly');
    });

    it('reverts to home tenant on refresh when switched-tenant access was revoked', async () => {
      const reg = await authService.register({
        email: 'test@example.com', password: 'password123', displayName: 'Test User', companyName: 'Home Co',
      });
      const [tenantB] = await db.insert(tenants).values({ name: 'Tenant B', slug: 'tenant-b-' + Date.now() }).returning();
      await db.insert(userTenantAccess).values({ userId: reg.user.id, tenantId: tenantB!.id, role: 'bookkeeper', isActive: true });
      const switched = await authService.switchTenant(reg.user.id, tenantB!.id, reg.tokens.refreshToken);

      // Access to B is revoked after the switch.
      await db.update(userTenantAccess).set({ isActive: false })
        .where(and(eq(userTenantAccess.userId, reg.user.id), eq(userTenantAccess.tenantId, tenantB!.id)));

      const refreshed = await authService.refresh(switched.refreshToken);
      const payload = jwt.verify(refreshed.accessToken, env.JWT_SECRET) as JwtPayload;
      expect(payload.tenantId).toBe(reg.user.tenantId); // fell back home
    });
  });

  describe('logout', () => {
    it('should invalidate refresh token', async () => {
      const registerResult = await authService.register({
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
        companyName: 'Test Company',
      });

      await authService.logout(registerResult.tokens.refreshToken);

      // Refresh token should no longer work
      await expect(authService.refresh(registerResult.tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
    });
  });
});
