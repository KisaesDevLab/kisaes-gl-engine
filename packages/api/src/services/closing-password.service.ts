// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Closing-date password (U-15). An optional per-company password that
// guards the closed period: with one set, a change to the closing date and
// any posting dated on or before it needs the password. The hash lives in
// companies.closing_password_hash (bcrypt). The password itself is never
// stored, logged, audited, exported or echoed; error messages never say
// more than "wrong password". Without a password the closed-period rules
// are exactly as before (ADR-TB-04).

import bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { companies, users } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

/** bcrypt reads at most 72 bytes; a longer password would silently truncate. */
export const CLOSING_PASSWORD_MAX_BYTES = 72;
export const CLOSING_PASSWORD_MIN_LENGTH = 4;

export function closingPasswordInvalid(): AppError {
  return AppError.forbidden('The closing date password is not correct.', 'CLOSING_PASSWORD_INVALID');
}

export function closingPasswordRequired(): AppError {
  return AppError.forbidden('Enter the closing date password to change the closing date.', 'CLOSING_PASSWORD_REQUIRED');
}

/** A usable new password, or a 400 explaining the rule. */
export function assertNewClosingPassword(password: string): void {
  if (password.length < CLOSING_PASSWORD_MIN_LENGTH) {
    throw AppError.badRequest(
      `The closing date password must be at least ${CLOSING_PASSWORD_MIN_LENGTH} characters.`,
      'VALIDATION_ERROR',
    );
  }
  if (Buffer.byteLength(password, 'utf8') > CLOSING_PASSWORD_MAX_BYTES) {
    throw AppError.badRequest('The closing date password is too long.', 'VALIDATION_ERROR');
  }
}

export async function hashClosingPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.BCRYPT_ROUNDS);
}

/** Constant-time bcrypt check; false for a missing hash or password. */
export async function closingPasswordMatches(hash: string | null | undefined, password: string | undefined): Promise<boolean> {
  if (!hash || typeof password !== 'string' || password.length === 0) return false;
  if (Buffer.byteLength(password, 'utf8') > CLOSING_PASSWORD_MAX_BYTES) return false;
  return bcrypt.compare(password, hash);
}

/** Reads the hash and locks the company row until `tx` ends. */
async function lockAndReadHash(tx: Tx, tenantId: string, companyId: string): Promise<string | null> {
  const [row] = await tx.select({ hash: companies.closingPasswordHash }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .for('update')
    .limit(1);
  if (!row) throw AppError.notFound('Company not found');
  return row.hash ?? null;
}

export async function getClosingDateStatus(tenantId: string, companyId: string) {
  const [row] = await db.select({
    lockDate: companies.lockDate,
    lockDateSetBy: companies.lockDateSetBy,
    lockDateSetAt: companies.lockDateSetAt,
    hash: companies.closingPasswordHash,
  }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (!row) throw AppError.notFound('Company not found');
  return {
    closingDate: row.lockDate ?? null,
    setBy: row.lockDateSetBy ?? null,
    setAt: row.lockDateSetAt ?? null,
    closingPasswordSet: !!row.hash,
  };
}

export interface ClosingPasswordActor {
  userId?: string;
  userRole?: string;
  isSuperAdmin?: boolean;
}

function canSetFirstPassword(actor: ClosingPasswordActor): boolean {
  return actor.isSuperAdmin === true || actor.userRole === 'owner';
}

/**
 * Set, change or clear the password. With one set, `currentPassword` must
 * match. With none set, only an owner or super admin may set one.
 * Audited as `closing_password` with only a set/not-set flag
 * (`closingDateProtected`: a key auditLog() does not strip as secret-looking).
 */
export async function setClosingPassword(
  tenantId: string,
  companyId: string,
  input: { currentPassword?: string; newPassword: string | null },
  actor: ClosingPasswordActor,
): Promise<{ closingPasswordSet: boolean }> {
  if (input.newPassword !== null) assertNewClosingPassword(input.newPassword);
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ hash: companies.closingPasswordHash }).from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .for('update')
      .limit(1);
    if (!row) throw AppError.notFound('Company not found');
    const wasSet = !!row.hash;
    if (wasSet) {
      if (!(await closingPasswordMatches(row.hash, input.currentPassword))) throw closingPasswordInvalid();
    } else if (!canSetFirstPassword(actor)) {
      throw AppError.forbidden('Only the company owner can set the closing date password.', 'CLOSING_PASSWORD_OWNER_REQUIRED');
    }
    const hash = input.newPassword === null ? null : await hashClosingPassword(input.newPassword);
    await tx.update(companies).set({ closingPasswordHash: hash, updatedAt: new Date() })
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
    await auditLog(tenantId, 'update', 'closing_password', companyId,
      { closingDateProtected: wasSet }, { closingDateProtected: hash !== null }, actor.userId, tx);
    return { closingPasswordSet: hash !== null };
  });
}

export function accountPasswordInvalid(): AppError {
  return AppError.forbidden('Your sign-in password is not correct.', 'ACCOUNT_PASSWORD_INVALID');
}

/**
 * Owner reset of a forgotten closing-date password (Q-239, part of
 * closing-password-v1): clears (`newPassword: null`) or replaces it without
 * the old one. Only the company owner or a super admin, and only after
 * re-entering their own sign-in password (bcrypt against their user row;
 * wrong or none: 403 ACCOUNT_PASSWORD_INVALID, audited as a failed reset).
 * Audited as `closing_password_reset` with set/not-set flags only — never a
 * password or hash.
 */
export async function resetClosingPassword(
  tenantId: string,
  companyId: string,
  input: { accountPassword: string; newPassword: string | null },
  actor: ClosingPasswordActor,
): Promise<{ closingPasswordSet: boolean }> {
  if (!canSetFirstPassword(actor)) {
    throw AppError.forbidden('Only the company owner can reset the closing date password.', 'CLOSING_PASSWORD_OWNER_REQUIRED');
  }
  if (input.newPassword !== null) assertNewClosingPassword(input.newPassword);

  const user = actor.userId
    ? await db.query.users.findFirst({ where: eq(users.id, actor.userId), columns: { passwordHash: true } })
    : undefined;
  // A malformed stored hash (e.g. an SSO-only account) counts as wrong.
  const ok = !!user?.passwordHash && input.accountPassword.length > 0
    && await bcrypt.compare(input.accountPassword, user.passwordHash).catch(() => false);
  if (!ok) {
    // Outside the write transaction so the failed attempt stays recorded.
    await auditLog(tenantId, 'update', 'closing_password_reset_failed', companyId, null, null, actor.userId);
    throw accountPasswordInvalid();
  }

  return db.transaction(async (tx) => {
    const [row] = await tx.select({ hash: companies.closingPasswordHash }).from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .for('update')
      .limit(1);
    if (!row) throw AppError.notFound('Company not found');
    const wasSet = !!row.hash;
    const hash = input.newPassword === null ? null : await hashClosingPassword(input.newPassword);
    await tx.update(companies).set({ closingPasswordHash: hash, updatedAt: new Date() })
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
    await auditLog(tenantId, 'update', 'closing_password_reset', companyId,
      { closingDateProtected: wasSet }, { closingDateProtected: hash !== null, method: 'account_password' }, actor.userId, tx);
    return { closingPasswordSet: hash !== null };
  });
}

/**
 * Gate for a closing-date change (PUT /company/settings `lockDate`,
 * PUT /tb/closing-date). Call only when the date actually changes.
 * - Password set: `password` must match (missing: CLOSING_PASSWORD_REQUIRED,
 *   wrong: CLOSING_PASSWORD_INVALID).
 * - None set and a password given: it becomes the company's password
 *   ("set or confirm"); only an owner or super admin may do that.
 * Returns the hash to store when a first password is being set.
 */
export async function authorizeLockDateChange(
  // The caller's transaction: the company row stays locked until the new
  // closing date (and a first password) are written in the same tx.
  tx: Tx,
  tenantId: string,
  companyId: string,
  password: string | undefined,
  actor: ClosingPasswordActor,
): Promise<{ newHash: string | null }> {
  const hash = await lockAndReadHash(tx, tenantId, companyId);
  if (hash) {
    if (password === undefined) throw closingPasswordRequired();
    if (!(await closingPasswordMatches(hash, password))) throw closingPasswordInvalid();
    return { newHash: null };
  }
  if (password === undefined) return { newHash: null };
  if (!canSetFirstPassword(actor)) {
    throw AppError.forbidden('Only the company owner can set the closing date password.', 'CLOSING_PASSWORD_OWNER_REQUIRED');
  }
  assertNewClosingPassword(password);
  return { newHash: await hashClosingPassword(password) };
}

/** Removes the hash from a company row before it leaves the service layer. */
export function withoutClosingPasswordHash<T extends { closingPasswordHash?: unknown }>(row: T): Omit<T, 'closingPasswordHash'> {
  const { closingPasswordHash: _hash, ...rest } = row;
  return rest;
}
