// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { db, pool } from '../db/index.js';
import { tenants, users, sessions, companies, accounts } from '../db/schema/index.js';
import { auditLog } from '../db/schema/index.js';
import { env } from '../config/env.js';
import * as authService from './auth.service.js';
import type { JwtPayload } from '@kis-books/shared';
import { sql } from 'drizzle-orm';

async function cleanDb() {
  await db.delete(auditLog);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
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
