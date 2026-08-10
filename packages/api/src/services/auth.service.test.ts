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
const TEST_EMAILS = [
  'test@example.com', 'session-cap@example.com', 'lockout@example.com',
  'changepw@example.com', 'role-owner@example.com', 'role-owner-b@example.com',
];

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

  describe('sendPasswordReset (owner/admin-triggered)', () => {
    it('issues a reset token for a user in the caller tenant', async () => {
      const reg = await authService.register({
        email: 'owner@example.com', password: 'password123',
        displayName: 'Owner', companyName: 'Reset Co',
      });
      const result = await authService.sendPasswordReset(reg.user.tenantId, reg.user.id);
      expect(result.email).toBe('owner@example.com');
      const tokens = await db.execute(sql`SELECT 1 FROM password_reset_tokens WHERE user_id = ${reg.user.id}`);
      expect(tokens.rows.length).toBe(1);
    });

    it('rejects a user without access to the caller tenant (cross-tenant)', async () => {
      const a = await authService.register({
        email: 'a@example.com', password: 'password123',
        displayName: 'A', companyName: 'Tenant A Co',
      });
      const b = await authService.register({
        email: 'b@example.com', password: 'password123',
        displayName: 'B', companyName: 'Tenant B Co',
      });
      await expect(authService.sendPasswordReset(a.user.tenantId, b.user.id))
        .rejects.toThrow('User access not found');
    });
  });

  describe('changePassword', () => {
    it('changes the password: new one logs in, old one is rejected', async () => {
      const reg = await authService.register({
        email: 'changepw@example.com', password: 'password123',
        displayName: 'PW User', companyName: 'PW Co',
      });

      await authService.changePassword(reg.user.id, {
        currentPassword: 'password123', newPassword: 'newpassword456',
      });

      const ok = await authService.login({ email: 'changepw@example.com', password: 'newpassword456' });
      expect(ok.tokens.accessToken).toBeTruthy();
      await expect(
        authService.login({ email: 'changepw@example.com', password: 'password123' }),
      ).rejects.toThrow('Invalid email or password');

      const rows = await db.select().from(auditLog).where(
        and(eq(auditLog.tenantId, reg.user.tenantId), eq(auditLog.entityType, 'user_password_change')),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(reg.user.id);
    });

    it('rejects a wrong current password without touching the hash, and audits the attempt', async () => {
      const reg = await authService.register({
        email: 'changepw@example.com', password: 'password123',
        displayName: 'PW User', companyName: 'PW Co',
      });

      await expect(
        authService.changePassword(reg.user.id, { currentPassword: 'wrongpassword', newPassword: 'newpassword456' }),
      ).rejects.toThrow('Current password is incorrect');

      // Old password still works — the hash was not modified.
      const ok = await authService.login({ email: 'changepw@example.com', password: 'password123' });
      expect(ok.tokens.accessToken).toBeTruthy();

      const rows = await db.select().from(auditLog).where(
        and(eq(auditLog.tenantId, reg.user.tenantId), eq(auditLog.entityType, 'user_password_change_failed')),
      );
      expect(rows).toHaveLength(1);
    });

    it('rejects a new password identical to the current one', async () => {
      const reg = await authService.register({
        email: 'changepw@example.com', password: 'password123',
        displayName: 'PW User', companyName: 'PW Co',
      });
      await expect(
        authService.changePassword(reg.user.id, { currentPassword: 'password123', newPassword: 'password123' }),
      ).rejects.toThrow('must be different');
    });

    it('revokes every existing session (trust-boundary event)', async () => {
      const reg = await authService.register({
        email: 'changepw@example.com', password: 'password123',
        displayName: 'PW User', companyName: 'PW Co',
      });
      const second = await authService.login({ email: 'changepw@example.com', password: 'password123' });

      const before = await db.select().from(sessions).where(eq(sessions.userId, reg.user.id));
      expect(before.length).toBe(2);

      await authService.changePassword(reg.user.id, {
        currentPassword: 'password123', newPassword: 'newpassword456',
      });

      const after = await db.select().from(sessions).where(eq(sessions.userId, reg.user.id));
      expect(after.length).toBe(0);
      await expect(authService.refresh(reg.tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
      await expect(authService.refresh(second.tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
    });
  });

  describe('updateUser (role change)', () => {
    async function setup() {
      const reg = await authService.register({
        email: 'role-owner@example.com', password: 'password123',
        displayName: 'Role Owner', companyName: 'Role Co',
      });
      const invited = await authService.inviteUser(reg.user.tenantId, {
        email: 'role-target@example.com', displayName: 'Target', role: 'readonly',
      }, reg.user.id);
      return { reg, invited };
    }

    it('promotes a home-tenant readonly user: both users.role and the UTA row update', async () => {
      const { reg, invited } = await setup();

      await authService.updateUser(reg.user.tenantId, invited.user.id, { role: 'accountant' }, reg.user.id);

      const u = await db.query.users.findFirst({ where: eq(users.id, invited.user.id) });
      expect(u!.role).toBe('accountant');
      const uta = await db.query.userTenantAccess.findFirst({
        where: and(eq(userTenantAccess.userId, invited.user.id), eq(userTenantAccess.tenantId, reg.user.tenantId)),
      });
      expect(uta!.role).toBe('accountant');

      const listed = await authService.listTenantUsers(reg.user.tenantId);
      expect(listed.find((x) => x.id === invited.user.id)!.role).toBe('accountant');

      const rows = await db.select().from(auditLog).where(
        and(eq(auditLog.tenantId, reg.user.tenantId), eq(auditLog.entityType, 'user_role')),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(reg.user.id);
      expect(rows[0]!.beforeData).toEqual({ role: 'readonly' });
      expect(rows[0]!.afterData).toEqual({ role: 'accountant' });
    });

    it('changes only the UTA row when the tenant is not the user home tenant', async () => {
      const { reg } = await setup();
      const other = await authService.register({
        email: 'role-owner-b@example.com', password: 'password123',
        displayName: 'Owner B', companyName: 'Role B Co',
      });
      // Owner B gets readonly access to Role Co (non-home tenant for them).
      await db.insert(userTenantAccess).values({
        userId: other.user.id, tenantId: reg.user.tenantId, role: 'readonly', isActive: true,
      });

      await authService.updateUser(reg.user.tenantId, other.user.id, { role: 'bookkeeper' }, reg.user.id);

      const uta = await db.query.userTenantAccess.findFirst({
        where: and(eq(userTenantAccess.userId, other.user.id), eq(userTenantAccess.tenantId, reg.user.tenantId)),
      });
      expect(uta!.role).toBe('bookkeeper');
      // Home role (owner of their own tenant) must be untouched.
      const u = await db.query.users.findFirst({ where: eq(users.id, other.user.id) });
      expect(u!.role).toBe('owner');
    });

    it('rejects changing your own role', async () => {
      const { reg } = await setup();
      await expect(
        authService.updateUser(reg.user.tenantId, reg.user.id, { role: 'accountant' }, reg.user.id),
      ).rejects.toThrow('You cannot change your own role');
    });

    it('rejects demoting the only owner; allows it once a second owner exists', async () => {
      const { reg, invited } = await setup();

      // Only one owner — demotion (by a different actor) must be refused.
      await expect(
        authService.updateUser(reg.user.tenantId, reg.user.id, { role: 'accountant' }, invited.user.id),
      ).rejects.toThrow('Cannot demote the only owner');

      // Promote the invited user to owner (multi-owner supported)...
      await authService.updateUser(reg.user.tenantId, invited.user.id, { role: 'owner' }, reg.user.id);
      const listed = await authService.listTenantUsers(reg.user.tenantId);
      expect(listed.find((x) => x.id === invited.user.id)!.role).toBe('owner');

      // ...after which demoting the original owner goes through.
      await authService.updateUser(reg.user.tenantId, reg.user.id, { role: 'accountant' }, invited.user.id);
      const u = await db.query.users.findFirst({ where: eq(users.id, reg.user.id) });
      expect(u!.role).toBe('accountant');
    });

    it('a name/email-only update leaves the role untouched (regression)', async () => {
      const { reg, invited } = await setup();
      await authService.updateUser(reg.user.tenantId, invited.user.id, { displayName: 'Renamed' }, reg.user.id);
      const u = await db.query.users.findFirst({ where: eq(users.id, invited.user.id) });
      expect(u!.displayName).toBe('Renamed');
      expect(u!.role).toBe('readonly');
    });

    it('refresh() picks up the new role within one token rotation', async () => {
      const { reg, invited } = await setup();
      const login = await authService.login({
        email: 'role-target@example.com', password: invited.temporaryPassword!,
      });
      expect((jwt.verify(login.tokens.accessToken, env.JWT_SECRET) as JwtPayload).role).toBe('readonly');

      await authService.updateUser(reg.user.tenantId, invited.user.id, { role: 'accountant' }, reg.user.id);

      const refreshed = await authService.refresh(login.tokens.refreshToken);
      expect((jwt.verify(refreshed.accessToken, env.JWT_SECRET) as JwtPayload).role).toBe('accountant');
    });

    it('admin setUserRole keeps the home-tenant UTA row in sync', async () => {
      const { reg, invited } = await setup();
      const { setUserRole } = await import('./admin.service.js');

      await setUserRole(invited.user.id, 'bookkeeper', reg.user.id);

      const u = await db.query.users.findFirst({ where: eq(users.id, invited.user.id) });
      expect(u!.role).toBe('bookkeeper');
      const uta = await db.query.userTenantAccess.findFirst({
        where: and(eq(userTenantAccess.userId, invited.user.id), eq(userTenantAccess.tenantId, reg.user.tenantId)),
      });
      expect(uta!.role).toBe('bookkeeper');
    });
  });
});
