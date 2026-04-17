// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, tfaCodes, tfaTrustedDevices } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import * as tfaConfigService from './tfa-config.service.js';
import * as systemEmail from './system-email.service.js';
import { auditLog } from '../middleware/audit.js';

// ─── Code Generation & Verification ────────────────────────────

function generateCode(length: number = 6): string {
  const max = Math.pow(10, length);
  const code = crypto.randomInt(0, max);
  return String(code).padStart(length, '0');
}

export async function checkTfaRequired(userId: string, deviceFingerprint?: string): Promise<{
  required: boolean;
  methods?: string[];
  preferredMethod?: string;
  phoneMasked?: string;
  emailMasked?: string;
}> {
  const config = await tfaConfigService.getConfig();
  if (!config.isEnabled) return { required: false };

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.tfaEnabled) return { required: false };

  // Check trusted device
  if (deviceFingerprint && config.trustDeviceEnabled) {
    const fpHash = crypto.createHash('sha256').update(deviceFingerprint).digest('hex');
    const trusted = await db.query.tfaTrustedDevices.findFirst({
      where: and(
        eq(tfaTrustedDevices.userId, userId),
        eq(tfaTrustedDevices.deviceFingerprintHash, fpHash),
        eq(tfaTrustedDevices.isActive, true),
      ),
    });
    if (trusted && new Date() < trusted.expiresAt) {
      await db.update(tfaTrustedDevices).set({ lastUsedAt: new Date() }).where(eq(tfaTrustedDevices.id, trusted.id));
      return { required: false };
    }
  }

  const methods = (user.tfaMethods || '').split(',').filter(Boolean);
  const emailMasked = user.email.replace(/^(.{1,2})(.*)(@.*)$/, '$1***$3');
  const phoneMasked = user.tfaPhone ? user.tfaPhone.replace(/^(.*)(.{4})$/, '***$2') : undefined;

  return {
    required: true,
    methods,
    preferredMethod: user.tfaPreferredMethod || methods[0],
    phoneMasked,
    emailMasked,
  };
}

// Minimum interval between code issuances for a single user+method. Prevents
// an attacker with a valid tfaToken from spamming SMS/email to exhaust
// quotas, cost us money, or DoS the real user's inbox.
const CODE_ISSUE_MIN_INTERVAL_MS = 30_000;

export async function generateAndSendCode(userId: string, method: 'email' | 'sms'): Promise<{
  method: string;
  destinationMasked: string;
  expiresInSeconds: number;
}> {
  const config = await tfaConfigService.getConfig();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  // If the user is in a TFA lockout, refuse to issue more codes so an
  // attacker can't keep burning delivery quota while locked out.
  if (user.tfaLockedUntil && new Date() < user.tfaLockedUntil) {
    throw AppError.tooManyRequests('Too many failed attempts. Try again later.');
  }

  // Throttle issuance per user+method so a stolen tfaToken can't spam the
  // user's inbox or rack up SMS cost. Uses the existing codes table as the
  // rate-limit ledger — no extra state needed.
  const [recent] = await db.select({ createdAt: tfaCodes.createdAt })
    .from(tfaCodes)
    .where(and(eq(tfaCodes.userId, userId), eq(tfaCodes.method, method)))
    .orderBy(sql`${tfaCodes.createdAt} DESC`)
    .limit(1);
  if (recent?.createdAt && Date.now() - new Date(recent.createdAt).getTime() < CODE_ISSUE_MIN_INTERVAL_MS) {
    throw AppError.tooManyRequests('Please wait a moment before requesting another code.');
  }

  const code = generateCode(config.codeLength);
  const codeHash = await bcrypt.hash(code, env.BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + config.codeExpirySeconds * 1000);

  // Delete any existing unused codes for this user + method
  await db.delete(tfaCodes).where(and(eq(tfaCodes.userId, userId), eq(tfaCodes.method, method), eq(tfaCodes.used, false)));

  let destination = '';
  if (method === 'email') {
    destination = user.email;
    try {
      await systemEmail.sendCustomEmail(
        user.email,
        'Your Vibe MyBooks verification code',
        `<p>Your verification code is: <strong style="font-size:24px;letter-spacing:4px">${code}</strong></p><p style="color:#6B7280;font-size:14px">This code expires in ${config.codeExpirySeconds / 60} minutes.</p>`,
      );
    } catch {
      await systemEmail.sendPasswordResetEmail(user.email, code); // fallback
    }
  } else if (method === 'sms') {
    if (!user.tfaPhone || !user.tfaPhoneVerified) throw AppError.badRequest('Phone number not verified');
    destination = user.tfaPhone;
    // Send via configured SMS provider
    try {
      const { getSmsProvider } = await import('./sms-providers/index.js');
      const { getRawConfig } = await import('./tfa-config.service.js');
      const rawConfig = await getRawConfig();
      const provider = getSmsProvider(rawConfig);
      const result = await provider.sendCode(destination, code, 'Vibe MyBooks');
      if (!result.success) throw new Error(result.error || 'SMS send failed');
    } catch (err: any) {
      throw AppError.internal(`Failed to send SMS: ${err.message}`);
    }
  }

  await db.insert(tfaCodes).values({ userId, codeHash, method, destination, expiresAt });

  const masked = method === 'email'
    ? user.email.replace(/^(.{1,2})(.*)(@.*)$/, '$1***$3')
    : destination.replace(/^(.*)(.{4})$/, '***$2');

  return { method, destinationMasked: masked, expiresInSeconds: config.codeExpirySeconds };
}

export async function verifyCode(userId: string, code: string, method: string): Promise<{
  valid: boolean;
  remainingAttempts?: number;
  lockedUntil?: Date;
}> {
  const config = await tfaConfigService.getConfig();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  // Check lockout
  if (user.tfaLockedUntil && new Date() < user.tfaLockedUntil) {
    return { valid: false, lockedUntil: user.tfaLockedUntil };
  }

  let isValid = false;

  if (method === 'totp') {
    // Verify TOTP
    if (!user.tfaTotpSecretEncrypted || !user.tfaTotpVerified) {
      return { valid: false, remainingAttempts: config.maxAttempts - (user.tfaFailedAttempts || 0) - 1 };
    }
    try {
      const { verifySync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
      const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
      const result = verifySync({ token: code, secret: user.tfaTotpSecretEncrypted, epochTolerance: 30, ...plugins });
      isValid = result.valid;
    } catch {
      isValid = false;
    }
  } else {
    // Verify email/SMS code
    const activeCode = await db.query.tfaCodes.findFirst({
      where: and(eq(tfaCodes.userId, userId), eq(tfaCodes.method, method), eq(tfaCodes.used, false)),
    });

    if (!activeCode || new Date() > activeCode.expiresAt) {
      isValid = false;
    } else {
      isValid = await bcrypt.compare(code, activeCode.codeHash);
      if (isValid) {
        await db.update(tfaCodes).set({ used: true, usedAt: new Date() }).where(eq(tfaCodes.id, activeCode.id));
      }
    }
  }

  if (isValid) {
    await db.update(users).set({ tfaFailedAttempts: 0, tfaLockedUntil: null }).where(eq(users.id, userId));
    return { valid: true };
  }

  // Failed attempt
  const attempts = (user.tfaFailedAttempts || 0) + 1;
  const updates: any = { tfaFailedAttempts: attempts };

  if (attempts >= config.maxAttempts) {
    updates.tfaLockedUntil = new Date(Date.now() + config.lockoutDurationMinutes * 60 * 1000);
    await auditLog(user.tenantId, 'create', 'tfa_lockout', userId, null, { attempts }, userId);
  }

  await db.update(users).set(updates).where(eq(users.id, userId));

  return {
    valid: false,
    remainingAttempts: Math.max(0, config.maxAttempts - attempts),
    lockedUntil: updates.tfaLockedUntil,
  };
}

export async function verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.tfaRecoveryCodesEncrypted) return false;

  const codes: string[] = JSON.parse(user.tfaRecoveryCodesEncrypted);
  for (let i = 0; i < codes.length; i++) {
    if (await bcrypt.compare(code.replace(/-/g, ''), codes[i]!)) {
      // Remove used code
      codes.splice(i, 1);
      await db.update(users).set({
        tfaRecoveryCodesEncrypted: JSON.stringify(codes),
        tfaRecoveryCodesRemaining: codes.length,
        tfaFailedAttempts: 0,
        tfaLockedUntil: null,
      }).where(eq(users.id, userId));
      await auditLog(user.tenantId, 'create', 'tfa_recovery_used', userId, null, { remaining: codes.length }, userId);
      return true;
    }
  }
  return false;
}

// ─── TFA Token (short-lived JWT proving password was correct) ───

export function generateTfaToken(userId: string): string {
  return jwt.sign({ userId, tfa_pending: true }, env.JWT_SECRET, { expiresIn: 300 }); // 5 minutes
}

export function verifyTfaToken(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as any;
    if (!payload.tfa_pending) return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}

// ─── Device Trust ───────────────────────────────────────────────

export async function trustDevice(userId: string, fingerprint: string, userAgent: string, ipAddress: string) {
  const config = await tfaConfigService.getConfig();
  if (!config.trustDeviceEnabled) return;

  const fpHash = crypto.createHash('sha256').update(fingerprint).digest('hex');
  const expiresAt = new Date(Date.now() + config.trustDeviceDurationDays * 24 * 60 * 60 * 1000);

  // Parse device name from user agent
  const deviceName = userAgent.length > 100 ? userAgent.slice(0, 100) : userAgent;

  await db.insert(tfaTrustedDevices).values({
    userId, deviceFingerprintHash: fpHash, deviceName, ipAddress, expiresAt,
  }).onConflictDoUpdate({
    target: [tfaTrustedDevices.userId, tfaTrustedDevices.deviceFingerprintHash],
    set: { expiresAt, lastUsedAt: new Date(), isActive: true, ipAddress },
  });
}

export async function listTrustedDevices(userId: string) {
  return db.select().from(tfaTrustedDevices)
    .where(and(eq(tfaTrustedDevices.userId, userId), eq(tfaTrustedDevices.isActive, true)));
}

export async function revokeDevice(userId: string, deviceId: string) {
  await db.update(tfaTrustedDevices).set({ isActive: false })
    .where(and(eq(tfaTrustedDevices.userId, userId), eq(tfaTrustedDevices.id, deviceId)));
}

export async function revokeAllDevices(userId: string) {
  await db.update(tfaTrustedDevices).set({ isActive: false })
    .where(eq(tfaTrustedDevices.userId, userId));
}
