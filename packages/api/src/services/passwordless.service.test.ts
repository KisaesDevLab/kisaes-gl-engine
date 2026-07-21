// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, tfaConfig, tfaCodes, tfaTrustedDevices, passkeys, magicLinks } from '../db/schema/index.js';
import { auditLog } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as tfaConfigService from './tfa-config.service.js';
import * as tfaEnrollment from './tfa-enrollment.service.js';
import * as magicLinkService from './magic-link.service.js';
import * as passkeyService from './passkey.service.js';
import * as authAvailability from './auth-availability.service.js';
import { eq, inArray } from 'drizzle-orm';

// Scoped cleanup — this suite registers its user under a fixed email, so
// the tenant/user fixtures are resolved from that email instead of
// truncating shared tables (which nuked concurrently-running suites).
async function cleanDb() {
  const testUsers = await db
    .select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .where(eq(users.email, 'pless-test@example.com'));
  const userIds = testUsers.map((u) => u.id);
  const tenantIds = [...new Set(testUsers.map((u) => u.tenantId))];

  await db.delete(magicLinks).where(inArray(magicLinks.userId, userIds));
  await db.delete(passkeys).where(inArray(passkeys.userId, userIds));
  await db.delete(tfaTrustedDevices).where(inArray(tfaTrustedDevices.userId, userIds));
  await db.delete(tfaCodes).where(inArray(tfaCodes.userId, userIds));
  await db.delete(tfaConfig); // global table — no tenant column; suites share it by design
  await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
  await db.delete(accounts).where(inArray(accounts.tenantId, tenantIds));
  await db.delete(companies).where(inArray(companies.tenantId, tenantIds));
  await db.delete(sessions).where(inArray(sessions.userId, userIds));
  await db.delete(users).where(inArray(users.tenantId, tenantIds));
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
}

async function createTestUser() {
  const result = await authService.register({
    email: 'pless-test@example.com',
    password: 'password123',
    displayName: 'Passwordless Test',
    companyName: 'Passwordless Co',
  });
  return result;
}

async function enableSystemPasswordless() {
  await tfaConfigService.updateConfig({
    isEnabled: true,
    allowedMethods: ['email', 'totp'],
  });
  // Enable passkeys and magic links at system level
  const config = await db.query.tfaConfig.findFirst();
  if (config) {
    await db.update(tfaConfig).set({ passkeysEnabled: true, magicLinkEnabled: true }).where(eq(tfaConfig.id, config.id));
  }
}

describe('Auth Availability Service', () => {
  beforeEach(async () => { await cleanDb(); authAvailability.invalidateCapabilitiesCache(); });
  afterEach(async () => { await cleanDb(); });

  it('should return system capabilities', async () => {
    const caps = await authAvailability.getSystemCapabilities();
    expect(caps.passkeysSupported).toBe(true);
    expect(caps.totpSupported).toBe(true);
    expect(typeof caps.smtpReady).toBe('boolean');
    expect(typeof caps.smsReady).toBe('boolean');
  });

  it('should return only password when nothing else enabled', async () => {
    const methods = await authAvailability.getEffectiveLoginMethods();
    expect(methods.password).toBe(true);
    expect(methods.passkey).toBe(false);
    expect(methods.magicLink).toBe(false);
  });

  it('should return passkey when enabled', async () => {
    await enableSystemPasswordless();
    const methods = await authAvailability.getEffectiveLoginMethods();
    expect(methods.passkey).toBe(true);
  });

  // The endpoint now returns the *same* shape regardless of email, because
  // the previous "add extra fields when user exists" behavior was an email
  // enumeration oracle (see security commit). All three cases should now
  // produce identical keys with safe defaults.

  it('should return auth methods for anonymous user', async () => {
    const result = await authAvailability.getAuthMethods();
    expect(result.loginMethods.password).toBe(true);
    expect(result.userHasPasskeys).toBe(false);
    expect(result.userPreferredMethod).toBe('password');
  });

  it('should not leak email existence for unknown emails', async () => {
    const result = await authAvailability.getAuthMethods('nonexistent@example.com');
    expect(result.userHasPasskeys).toBe(false);
    expect(result.userPreferredMethod).toBe('password');
  });

  it('should return the same shape for a known email', async () => {
    await createTestUser();
    const result = await authAvailability.getAuthMethods('pless-test@example.com') as any;
    // Defaults only — no user-specific hints to avoid leaking existence.
    expect(result.userHasPasskeys).toBe(false);
    expect(result.userPreferredMethod).toBe('password');
  });
});

describe('Magic Link Service', () => {
  beforeEach(async () => { await cleanDb(); authAvailability.invalidateCapabilitiesCache(); });
  afterEach(async () => { await cleanDb(); });

  it('should not reveal user existence on send', async () => {
    const result = await magicLinkService.sendMagicLink('nonexistent@test.com', '127.0.0.1', 'test');
    expect(result.sent).toBe(true);
  });

  it('sends (creates a link row) for an active user without per-user opt-in', async () => {
    const { user } = await createTestUser();
    await enableSystemPasswordless();
    // Per-user opt-in is no longer required — magic-link is available to any
    // active user while the system toggle is on.
    const result = await magicLinkService.sendMagicLink('pless-test@example.com', '127.0.0.1', 'test');
    expect(result.sent).toBe(true);
    expect(await db.select().from(magicLinks).where(eq(magicLinks.userId, user.id))).toHaveLength(1);
  });

  it('sends (creates a link row) even when the user has no non-email 2FA', async () => {
    const { user } = await createTestUser();
    await enableSystemPasswordless();
    // No TOTP/SMS — the link becomes single-factor login; a row is still made.
    const result = await magicLinkService.sendMagicLink('pless-test@example.com', '127.0.0.1', 'test');
    expect(result.sent).toBe(true);
    expect(await db.select().from(magicLinks).where(eq(magicLinks.userId, user.id))).toHaveLength(1);
  });

  it('should send magic link when prerequisites met', async () => {
    const { user } = await createTestUser();
    await enableSystemPasswordless();
    await tfaEnrollment.enableTfa(user.id);
    await tfaEnrollment.addEmailMethod(user.id);
    // Add TOTP for non-email 2FA requirement
    const { secret } = await tfaEnrollment.addTotpMethod(user.id);
    const { generateSync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
    const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
    const code = generateSync({ secret, ...plugins });
    await tfaEnrollment.verifyTotpSetup(user.id, code);
    // Enable magic link for user
    await db.update(users).set({ magicLinkEnabled: true }).where(eq(users.id, user.id));

    const result = await magicLinkService.sendMagicLink('pless-test@example.com', '127.0.0.1', 'test');
    expect(result.sent).toBe(true);
    expect(result.expiresInMinutes).toBeGreaterThan(0);
  });

  it('should verify valid magic link token', async () => {
    const { user } = await createTestUser();
    await enableSystemPasswordless();
    await tfaEnrollment.enableTfa(user.id);
    const { secret } = await tfaEnrollment.addTotpMethod(user.id);
    const { generateSync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
    const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
    await tfaEnrollment.verifyTotpSetup(user.id, generateSync({ secret, ...plugins }));
    await db.update(users).set({ magicLinkEnabled: true }).where(eq(users.id, user.id));

    // Manually insert a magic link to test verification
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.insert(magicLinks).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    // This user has a TOTP factor, so verify returns the 2FA challenge branch.
    const result = await magicLinkService.verifyMagicLink(token) as Record<string, unknown>;
    expect(result['valid']).toBe(true);
    expect(result['loggedIn']).toBe(false);
    expect(result['tfaToken']).toBeTruthy();
    expect(result['availableMethods']).toContain('totp');
    expect(result['availableMethods']).not.toContain('email'); // email excluded
  });

  it('should reject expired magic link', async () => {
    const { user } = await createTestUser();
    await enableSystemPasswordless(); // verify now enforces the system toggle first
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.insert(magicLinks).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() - 1000), // expired
    });

    await expect(magicLinkService.verifyMagicLink(token)).rejects.toThrow(/expired/);
  });

  it('should reject already used magic link', async () => {
    const { user } = await createTestUser();
    await enableSystemPasswordless(); // verify now enforces the system toggle first
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.insert(magicLinks).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      used: true,
      usedAt: new Date(),
    });

    await expect(magicLinkService.verifyMagicLink(token)).rejects.toThrow(/Invalid/);
  });

  it('should clean up expired links', async () => {
    const { user } = await createTestUser();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.insert(magicLinks).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() - 1000),
    });

    const count = await magicLinkService.cleanupExpiredLinks();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('Passkey Service', () => {
  beforeEach(async () => { await cleanDb(); authAvailability.invalidateCapabilitiesCache(); });
  afterEach(async () => { await cleanDb(); });

  it('should generate registration options', async () => {
    const { user } = await createTestUser();
    const options = await passkeyService.getRegistrationOptions(user.id);
    expect(options.challenge).toBeTruthy();
    expect(options.rp).toBeTruthy();
    expect(options.user).toBeTruthy();
  });

  it('should generate authentication options without email', async () => {
    const options = await passkeyService.getAuthenticationOptions();
    expect(options.challenge).toBeTruthy();
    expect(options.rpId).toBeTruthy();
  });

  it('should list passkeys (empty initially)', async () => {
    const { user } = await createTestUser();
    const list = await passkeyService.listPasskeys(user.id);
    expect(list).toHaveLength(0);
  });

  it('should return passkey count of 0 for new user', async () => {
    const { user } = await createTestUser();
    expect(await passkeyService.getPasskeyCount(user.id)).toBe(0);
  });
});
