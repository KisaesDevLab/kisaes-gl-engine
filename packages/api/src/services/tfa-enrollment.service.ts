// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as tfaConfigService from './tfa-config.service.js';
import * as tfaService from './tfa.service.js';
import { env } from '../config/env.js';
import { encrypt, decrypt } from '../utils/encryption.js';

// Column name includes "Encrypted" but earlier versions stored the raw
// TOTP secret. We now encrypt at rest and decrypt on verify. To remain
// compatible with pre-hardening rows that are still plaintext (not yet
// re-enrolled), decryption silently falls back to the input. This lets
// users keep using their existing TOTP generator; next re-enrol writes
// the encrypted form.
function decryptTotpSecret(stored: string): string {
  try {
    return decrypt(stored);
  } catch {
    return stored;
  }
}

function generateRecoveryCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i]! % chars.length];
  }
  return code.slice(0, 4) + '-' + code.slice(4);
}

async function generateRecoveryCodes(): Promise<{ plaintext: string[]; hashes: string[] }> {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const code = generateRecoveryCode();
    codes.push(code);
    hashes.push(await bcrypt.hash(code.replace(/-/g, ''), env.BCRYPT_ROUNDS));
  }
  return { plaintext: codes, hashes };
}

export async function enableTfa(userId: string): Promise<string[]> {
  const available = await tfaConfigService.isTfaAvailable();
  if (!available) throw AppError.badRequest('Two-factor authentication is not enabled for this system');

  const { plaintext, hashes } = await generateRecoveryCodes();

  await db.update(users).set({
    tfaEnabled: true,
    tfaRecoveryCodesEncrypted: JSON.stringify(hashes),
    tfaRecoveryCodesRemaining: 10,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (user) await auditLog(user.tenantId, 'create', 'tfa_enabled', userId, null, null, userId);

  return plaintext;
}

export async function disableTfa(userId: string, password: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw AppError.unauthorized('Invalid password');

  await db.update(users).set({
    tfaEnabled: false,
    tfaMethods: '',
    tfaPreferredMethod: null,
    tfaPhone: null,
    tfaPhoneVerified: false,
    tfaTotpSecretEncrypted: null,
    tfaTotpVerified: false,
    tfaRecoveryCodesEncrypted: null,
    tfaRecoveryCodesRemaining: 0,
    tfaFailedAttempts: 0,
    tfaLockedUntil: null,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  await tfaService.revokeAllDevices(userId);
  await auditLog(user.tenantId, 'create', 'tfa_disabled', userId, null, null, userId);
}

function addMethod(current: string, method: string): string {
  const methods = current.split(',').filter(Boolean);
  if (!methods.includes(method)) methods.push(method);
  return methods.join(',');
}

function removeMethod(current: string, method: string): string {
  return current.split(',').filter((m) => m && m !== method).join(',');
}

export async function addEmailMethod(userId: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  await db.update(users).set({
    tfaMethods: addMethod(user.tfaMethods || '', 'email'),
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  await auditLog(user.tenantId, 'create', 'tfa_method_added', userId, null, { method: 'email' }, userId);
}

export async function addSmsMethod(userId: string, phoneNumber: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  await db.update(users).set({
    tfaPhone: phoneNumber,
    tfaPhoneVerified: false,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  // Send verification code
  await tfaService.generateAndSendCode(userId, 'sms');
}

export async function verifySmsSetup(userId: string, code: string): Promise<boolean> {
  const result = await tfaService.verifyCode(userId, code, 'sms');
  if (!result.valid) return false;

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return false;

  await db.update(users).set({
    tfaPhoneVerified: true,
    tfaMethods: addMethod(user.tfaMethods || '', 'sms'),
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  await auditLog(user.tenantId, 'create', 'tfa_method_added', userId, null, { method: 'sms' }, userId);
  return true;
}

export async function addTotpMethod(userId: string): Promise<{ secret: string; qrUri: string }> {
  const { generateSecret, generateURI, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
  const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
  const secret = generateSecret(plugins);

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  await db.update(users).set({
    // AES-256-GCM at rest via utils/encryption.encrypt. DB compromise
    // no longer yields every user's TOTP generator.
    tfaTotpSecretEncrypted: encrypt(secret),
    tfaTotpVerified: false,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  const qrUri = generateURI({ label: user.email, issuer: 'Vibe MyBooks', secret });
  return { secret, qrUri };
}

export async function verifyTotpSetup(userId: string, code: string): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.tfaTotpSecretEncrypted) return false;

  const { verifySync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
  const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
  const secret = decryptTotpSecret(user.tfaTotpSecretEncrypted);
  const result = verifySync({ token: code, secret, epochTolerance: 30, ...plugins });
  const valid = result.valid;
  if (!valid) return false;

  await db.update(users).set({
    tfaTotpVerified: true,
    tfaMethods: addMethod(user.tfaMethods || '', 'totp'),
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  await auditLog(user.tenantId, 'create', 'tfa_method_added', userId, null, { method: 'totp' }, userId);
  return true;
}

export async function removeMethodFromUser(userId: string, method: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  const updates: any = {
    tfaMethods: removeMethod(user.tfaMethods || '', method),
    updatedAt: new Date(),
  };

  if (method === 'sms') { updates.tfaPhone = null; updates.tfaPhoneVerified = false; }
  if (method === 'totp') { updates.tfaTotpSecretEncrypted = null; updates.tfaTotpVerified = false; }

  await db.update(users).set(updates).where(eq(users.id, userId));

  // If no methods remain, warn
  const remaining = updates.tfaMethods.split(',').filter(Boolean);
  if (remaining.length === 0) {
    // Auto-disable TFA if no methods left
    await db.update(users).set({ tfaEnabled: false }).where(eq(users.id, userId));
  }

  await auditLog(user.tenantId, 'create', 'tfa_method_removed', userId, null, { method }, userId);
}

export async function regenerateRecoveryCodes(userId: string, password: string): Promise<string[]> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw AppError.unauthorized('Invalid password');

  const { plaintext, hashes } = await generateRecoveryCodes();

  await db.update(users).set({
    tfaRecoveryCodesEncrypted: JSON.stringify(hashes),
    tfaRecoveryCodesRemaining: 10,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  return plaintext;
}

export async function setPreferredMethod(userId: string, method: string): Promise<void> {
  await db.update(users).set({ tfaPreferredMethod: method, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function getTfaStatus(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  const config = await tfaConfigService.getConfig();

  return {
    systemEnabled: config.isEnabled,
    userEnabled: user.tfaEnabled || false,
    methods: (user.tfaMethods || '').split(',').filter(Boolean),
    preferredMethod: user.tfaPreferredMethod,
    phoneMasked: user.tfaPhone ? user.tfaPhone.replace(/^(.*)(.{4})$/, '***$2') : null,
    totpConfigured: user.tfaTotpVerified || false,
    recoveryCodesRemaining: user.tfaRecoveryCodesRemaining || 0,
    allowedMethods: config.allowedMethods,
    trustDeviceEnabled: config.trustDeviceEnabled,
    trustDeviceDurationDays: config.trustDeviceDurationDays,
  };
}
