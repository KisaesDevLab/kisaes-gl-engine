// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Desktop per-user recovery key (U-23, capability recovery-key-v1; Q-210,
 * Q-P29m). Not the appliance's installation recovery key
 * (recovery-key.service.ts, which unlocks /data/.env.recovery).
 *
 * A key is 25 characters from a 32-letter alphabet (125 random bits), shown
 * in five groups of five. The engine stores only the SHA-256 of the
 * normalised key (uppercase letters and digits only, so "abcde-fghij" and
 * "ABCDE FGHIJ" are the same key, as ClientLedger normalises it). The key's
 * entropy makes a fast hash sufficient, as for refresh tokens.
 *
 * Using the key (recoverPassword) sets the new password, clears the lockout
 * and the must-change flag, ends every session and replaces the key with a
 * fresh one, returned once. The swap is a compare-and-set on the old hash,
 * so a key works once even under concurrent use. Keys never reach logs or
 * audit data.
 */

import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE } from '@kis-books/shared';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 letters: no I, O, 0, 1
const KEY_CHARS = 25;

/** Uppercase letters and digits only. */
export function normalizeRecoveryKey(typed: string): string {
  return typed.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function hashRecoveryKey(typed: string): string {
  return crypto.createHash('sha256').update(normalizeRecoveryKey(typed)).digest('hex');
}

/** A new key in display form (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX) and its hash. */
export function generateRecoveryKey(): { key: string; hash: string } {
  const bytes = crypto.randomBytes(KEY_CHARS);
  let raw = '';
  // 256 is a multiple of 32, so the low five bits are unbiased.
  for (let i = 0; i < KEY_CHARS; i++) raw += ALPHABET[bytes[i]! & 31];
  const key = raw.match(/.{5}/g)!.join('-');
  return { key, hash: hashRecoveryKey(key) };
}

// Compared when there is no stored hash, so every failure does the same work.
const DUMMY_HASH = crypto.createHash('sha256').update('no-recovery-key').digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Sets a fresh key for the user and returns it (shown once). */
export async function issueRecoveryKey(userId: string): Promise<string> {
  const { key, hash } = generateRecoveryKey();
  await db.update(users).set({ recoveryKeyHash: hash, updatedAt: new Date() }).where(eq(users.id, userId));
  return key;
}

/** Rotates the caller's own key (owner or super admin; the route checks). */
export async function rotateRecoveryKey(tenantId: string, userId: string): Promise<string> {
  const key = await issueRecoveryKey(userId);
  await auditLog(tenantId, 'update', 'user_recovery_key', userId, null, { rotated: true }, userId);
  return key;
}

function invalid(): AppError {
  return AppError.unauthorized('The email or recovery key is not right', 'INVALID_CREDENTIALS');
}

export interface RecoverInput { email: string; recoveryKey: string; newPassword: string }

/**
 * Resets the password with the recovery key. 401 INVALID_CREDENTIALS for an
 * unknown email, a user without a key, an inactive user or a wrong key (the
 * same answer, and the same hash comparison, for each). Returns a fresh key.
 */
export async function recoverPassword(input: RecoverInput): Promise<{ recoveryKey: string }> {
  if (input.newPassword.length < PASSWORD_MIN_LENGTH) {
    throw AppError.badRequest(PASSWORD_MIN_MESSAGE, 'VALIDATION_ERROR');
  }
  if (Buffer.byteLength(input.newPassword, 'utf8') > 72) {
    throw AppError.badRequest('Password must be at most 72 bytes (UTF-8)', 'VALIDATION_ERROR');
  }
  const email = input.email.trim().toLowerCase();
  const typedHash = hashRecoveryKey(input.recoveryKey);
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  const stored = user?.recoveryKeyHash ?? null;
  const equal = sameHash(typedHash, stored ?? DUMMY_HASH);
  if (!user) throw invalid();
  const match = equal && stored !== null && normalizeRecoveryKey(input.recoveryKey).length > 0;
  if (!match || !user.isActive) {
    await auditLog(user.tenantId, 'update', 'user_password_recovery_failed', user.id, null,
      { reason: stored === null ? 'no_key' : !match ? 'wrong_key' : 'inactive' }, user.id);
    throw invalid();
  }

  const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_ROUNDS);
  const fresh = generateRecoveryKey();
  const swapped = await db.transaction(async (tx) => {
    const rows = await tx.update(users)
      .set({
        passwordHash, recoveryKeyHash: fresh.hash, loginFailedAttempts: 0, loginLockedUntil: null,
        passwordChangeRequired: false, updatedAt: new Date(),
      })
      .where(and(eq(users.id, user.id), eq(users.recoveryKeyHash, stored!)))
      .returning({ id: users.id });
    if (rows.length === 0) return false;
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    return true;
  });
  // Lost a race with another use of the same key: it no longer works.
  if (!swapped) throw invalid();
  await auditLog(user.tenantId, 'update', 'user_password_recovery', user.id, null,
    { sessionsRevoked: true, lockoutCleared: true, recoveryKeyRotated: true }, user.id);
  return { recoveryKey: fresh.key };
}
