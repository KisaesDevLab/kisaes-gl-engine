import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, tfaConfig, tfaCodes, tfaTrustedDevices } from '../db/schema/index.js';
import { auditLog } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as tfaService from './tfa.service.js';
import * as tfaEnrollment from './tfa-enrollment.service.js';
import * as tfaConfigService from './tfa-config.service.js';

async function cleanDb() {
  await db.delete(tfaTrustedDevices);
  await db.delete(tfaCodes);
  await db.delete(tfaConfig);
  await db.delete(auditLog);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function createTestUser() {
  const result = await authService.register({
    email: 'tfa-test@example.com',
    password: 'password123',
    displayName: 'TFA Test User',
    companyName: 'TFA Test Co',
  });
  return result;
}

async function enableSystemTfa() {
  await tfaConfigService.updateConfig({ isEnabled: true, allowedMethods: ['email', 'totp'] });
}

describe('TFA Config Service', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should create default config on first access', async () => {
    const config = await tfaConfigService.getConfig();
    expect(config.isEnabled).toBe(false);
    expect(config.allowedMethods).toContain('email');
    expect(config.allowedMethods).toContain('totp');
  });

  it('should enable/disable 2FA system-wide', async () => {
    await tfaConfigService.updateConfig({ isEnabled: true });
    let config = await tfaConfigService.getConfig();
    expect(config.isEnabled).toBe(true);

    await tfaConfigService.updateConfig({ isEnabled: false });
    config = await tfaConfigService.getConfig();
    expect(config.isEnabled).toBe(false);
  });

  it('should update allowed methods', async () => {
    await tfaConfigService.updateConfig({ allowedMethods: ['email', 'sms', 'totp'] });
    const config = await tfaConfigService.getConfig();
    expect(config.allowedMethods).toEqual(['email', 'sms', 'totp']);
  });

  it('should report availability correctly', async () => {
    expect(await tfaConfigService.isTfaAvailable()).toBe(false);
    await tfaConfigService.updateConfig({ isEnabled: true });
    expect(await tfaConfigService.isTfaAvailable()).toBe(true);
  });
});

describe('TFA Enrollment Service', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should enable 2FA and return recovery codes', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();

    const codes = await tfaEnrollment.enableTfa(user.id);
    expect(codes).toHaveLength(10);
    codes.forEach((code: string) => {
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });

    const status = await tfaEnrollment.getTfaStatus(user.id);
    expect(status.userEnabled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(10);
  });

  it('should reject enable when system 2FA is disabled', async () => {
    const { user } = await createTestUser();
    await expect(tfaEnrollment.enableTfa(user.id)).rejects.toThrow(/not enabled/);
  });

  it('should add and remove email method', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);

    await tfaEnrollment.addEmailMethod(user.id);
    let status = await tfaEnrollment.getTfaStatus(user.id);
    expect(status.methods).toContain('email');

    await tfaEnrollment.removeMethodFromUser(user.id, 'email');
    status = await tfaEnrollment.getTfaStatus(user.id);
    expect(status.methods).not.toContain('email');
  });

  it('should set up and verify TOTP', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);

    const { secret, qrUri } = await tfaEnrollment.addTotpMethod(user.id);
    expect(secret).toBeTruthy();
    expect(qrUri).toContain('otpauth://');

    // Generate a valid TOTP code
    const { generateSync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
    const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
    const code = generateSync({ secret, ...plugins });

    const ok = await tfaEnrollment.verifyTotpSetup(user.id, code);
    expect(ok).toBe(true);

    const status = await tfaEnrollment.getTfaStatus(user.id);
    expect(status.methods).toContain('totp');
    expect(status.totpConfigured).toBe(true);
  });

  it('should disable 2FA with correct password', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);

    await tfaEnrollment.disableTfa(user.id, 'password123');
    const status = await tfaEnrollment.getTfaStatus(user.id);
    expect(status.userEnabled).toBe(false);
    expect(status.methods).toHaveLength(0);
  });

  it('should reject disable with wrong password', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);

    await expect(tfaEnrollment.disableTfa(user.id, 'wrongpassword')).rejects.toThrow(/Invalid password/);
  });

  it('should regenerate recovery codes', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    const originalCodes = await tfaEnrollment.enableTfa(user.id);

    const newCodes = await tfaEnrollment.regenerateRecoveryCodes(user.id, 'password123');
    expect(newCodes).toHaveLength(10);
    // New codes should be different from original
    expect(newCodes).not.toEqual(originalCodes);
  });
});

describe('TFA Core Service', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should not require 2FA when system is disabled', async () => {
    const { user } = await createTestUser();
    const result = await tfaService.checkTfaRequired(user.id);
    expect(result.required).toBe(false);
  });

  it('should not require 2FA when user has not enabled it', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    const result = await tfaService.checkTfaRequired(user.id);
    expect(result.required).toBe(false);
  });

  it('should require 2FA when enabled for user', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);
    await tfaEnrollment.addEmailMethod(user.id);

    const result = await tfaService.checkTfaRequired(user.id);
    expect(result.required).toBe(true);
    expect(result.methods).toContain('email');
  });

  it('should generate TFA token and verify it', () => {
    const token = tfaService.generateTfaToken('test-user-id');
    expect(token).toBeTruthy();

    const payload = tfaService.verifyTfaToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe('test-user-id');
  });

  it('should reject invalid TFA token', () => {
    const payload = tfaService.verifyTfaToken('invalid-token');
    expect(payload).toBeNull();
  });

  it('should verify TOTP code correctly', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);

    const { secret } = await tfaEnrollment.addTotpMethod(user.id);
    const { generateSync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
    const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
    const code = generateSync({ secret, ...plugins });
    await tfaEnrollment.verifyTotpSetup(user.id, code);

    // Now verify through the core service
    const freshCode = generateSync({ secret, ...plugins });
    const result = await tfaService.verifyCode(user.id, freshCode, 'totp');
    expect(result.valid).toBe(true);
  });

  it('should reject invalid TOTP code', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);

    const { secret } = await tfaEnrollment.addTotpMethod(user.id);
    const { generateSync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
    const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
    const code = generateSync({ secret, ...plugins });
    await tfaEnrollment.verifyTotpSetup(user.id, code);

    const result = await tfaService.verifyCode(user.id, '000000', 'totp');
    expect(result.valid).toBe(false);
    expect(result.remainingAttempts).toBeDefined();
  });

  it('should lock out after max failed attempts', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaConfigService.updateConfig({ maxAttempts: 3, lockoutDurationMinutes: 15 });
    await tfaEnrollment.enableTfa(user.id);

    const { secret } = await tfaEnrollment.addTotpMethod(user.id);
    const { generateSync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
    const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
    const code = generateSync({ secret, ...plugins });
    await tfaEnrollment.verifyTotpSetup(user.id, code);

    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      await tfaService.verifyCode(user.id, '000000', 'totp');
    }

    // Should be locked
    const result = await tfaService.verifyCode(user.id, '000000', 'totp');
    expect(result.valid).toBe(false);
    expect(result.lockedUntil).toBeDefined();
  });

  it('should verify and consume recovery code', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    const codes = await tfaEnrollment.enableTfa(user.id);

    const firstCode = codes[0]!;
    const ok = await tfaService.verifyRecoveryCode(user.id, firstCode);
    expect(ok).toBe(true);

    const status = await tfaEnrollment.getTfaStatus(user.id);
    expect(status.recoveryCodesRemaining).toBe(9);

    // Same code should not work again
    const reuse = await tfaService.verifyRecoveryCode(user.id, firstCode);
    expect(reuse).toBe(false);
  });

  it('should reject invalid recovery code', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);

    const ok = await tfaService.verifyRecoveryCode(user.id, 'XXXX-XXXX');
    expect(ok).toBe(false);
  });
});

describe('TFA Trusted Devices', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should trust and list devices', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();

    await tfaService.trustDevice(user.id, 'fingerprint-abc', 'Chrome/120', '192.168.1.1');
    const devices = await tfaService.listTrustedDevices(user.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.deviceName).toBe('Chrome/120');
  });

  it('should skip 2FA for trusted device', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);
    await tfaEnrollment.addEmailMethod(user.id);

    await tfaService.trustDevice(user.id, 'fingerprint-abc', 'Chrome/120', '192.168.1.1');
    const result = await tfaService.checkTfaRequired(user.id, 'fingerprint-abc');
    expect(result.required).toBe(false);
  });

  it('should revoke device and require 2FA again', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();
    await tfaEnrollment.enableTfa(user.id);
    await tfaEnrollment.addEmailMethod(user.id);

    await tfaService.trustDevice(user.id, 'fingerprint-abc', 'Chrome/120', '192.168.1.1');
    const devices = await tfaService.listTrustedDevices(user.id);
    await tfaService.revokeDevice(user.id, devices[0]!.id);

    const result = await tfaService.checkTfaRequired(user.id, 'fingerprint-abc');
    expect(result.required).toBe(true);
  });

  it('should revoke all devices', async () => {
    const { user } = await createTestUser();
    await enableSystemTfa();

    await tfaService.trustDevice(user.id, 'fp-1', 'Chrome', '1.1.1.1');
    await tfaService.trustDevice(user.id, 'fp-2', 'Firefox', '2.2.2.2');
    expect(await tfaService.listTrustedDevices(user.id)).toHaveLength(2);

    await tfaService.revokeAllDevices(user.id);
    expect(await tfaService.listTrustedDevices(user.id)).toHaveLength(0);
  });
});
