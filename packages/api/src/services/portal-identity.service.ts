// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import bcrypt from 'bcrypt';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  portalIdentities,
  portalContacts,
  tenants,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

// PORTAL_IDENTITY_LINKING_V1 — master identity layer for portal
// contacts. See docs/plans (the approved plan file) and the migration
// at packages/api/src/db/migrations/0097_portal_identity_linking.sql.
//
// Identity vs. portal_contact:
//   - portal_identities is keyed on lowercased email globally. One row
//     per real human.
//   - portal_contacts stays scoped to (tenantId, email). Each firm
//     owns its own row with its own status/permissions/companies.
//   - portal_contacts.identity_id is the nullable bridge.
//
// Lockout policy mirrors the staff users table
// (auth.service.ts:267–284): after MAX_LOGIN_ATTEMPTS failures we set
// locked_until = now() as a sentinel. Any truthy value blocks login;
// an admin unlock (or a successful login on a separate device that
// resets failedLoginAttempts) clears both columns. The result is that
// brute force at firm A also throttles firm B — the documented
// tradeoff of unifying credentials.

const MAX_LOGIN_ATTEMPTS = 5;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface PortalIdentityRow {
  id: string;
  email: string;
  bcryptHash: string;
  emailVerifiedAt: Date | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LinkedContactSummary {
  contactId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  displayName: string;
  status: string;
}

/**
 * Look up an identity by case-insensitive email. Returns null when no
 * row exists. Callers must treat "not found" as "no auto-link" without
 * leaking that distinction to the network (timing-equalized at the
 * route layer, not here).
 */
export async function getIdentityByEmail(
  email: string,
): Promise<PortalIdentityRow | null> {
  const normalized = normalizeEmail(email);
  // Functional index uq_portal_identities_email is on LOWER(email) so
  // this comparison hits it. Drizzle doesn't model the functional
  // expression — we mirror it by lowercasing input.
  const row = await db.query.portalIdentities.findFirst({
    where: sql`lower(${portalIdentities.email}) = ${normalized}`,
  });
  return row ?? null;
}

/**
 * Find an identity for `email` or create one with the given bcrypt
 * hash. Idempotent — passing a different hash for an existing identity
 * does NOT update the stored hash. Use {@link updateIdentityPassword}
 * to rotate credentials.
 *
 * The caller is responsible for verifying the bcrypt cost factor
 * (env.BCRYPT_ROUNDS) before hashing; this function expects a
 * pre-hashed value so the lockout path can reuse the same call site
 * without re-hashing.
 */
export async function findOrCreateIdentity(args: {
  email: string;
  bcryptHash: string;
  emailVerified: boolean;
}): Promise<PortalIdentityRow> {
  const normalized = normalizeEmail(args.email);
  const existing = await getIdentityByEmail(normalized);
  if (existing) return existing;

  const [row] = await db.insert(portalIdentities)
    .values({
      email: normalized,
      bcryptHash: args.bcryptHash,
      emailVerifiedAt: args.emailVerified ? new Date() : null,
    })
    .returning();
  if (!row) throw AppError.internal('Failed to create portal identity');
  return row as PortalIdentityRow;
}

/**
 * Verify `plaintext` against the stored bcrypt hash. Updates the
 * lockout counter on failure and resets it on success.
 *
 * Returns the identity row on success, or throws AppError.forbidden
 * ('ACCOUNT_LOCKED') if the account is currently locked. A simple
 * password mismatch returns null (caller should map to the same
 * generic INVALID_CREDENTIALS as the staff path to avoid email
 * enumeration via response shape).
 */
export async function verifyPassword(
  identityId: string,
  plaintext: string,
): Promise<PortalIdentityRow | null> {
  const row = await db.query.portalIdentities.findFirst({
    where: eq(portalIdentities.id, identityId),
  });
  if (!row) return null;

  if (row.lockedUntil) {
    throw AppError.forbidden(
      'This account is locked due to too many failed login attempts. Contact your administrator to unlock it.',
      'ACCOUNT_LOCKED',
    );
  }

  const ok = await bcrypt.compare(plaintext, row.bcryptHash);
  if (!ok) {
    const attempts = (row.failedLoginAttempts ?? 0) + 1;
    const lockUntil = attempts >= MAX_LOGIN_ATTEMPTS ? new Date() : null;
    await db.update(portalIdentities)
      .set({ failedLoginAttempts: attempts, lockedUntil: lockUntil, updatedAt: new Date() })
      .where(eq(portalIdentities.id, identityId));
    return null;
  }

  if ((row.failedLoginAttempts ?? 0) > 0 || row.lockedUntil) {
    await db.update(portalIdentities)
      .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(portalIdentities.id, identityId));
  }
  await db.update(portalIdentities)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(portalIdentities.id, identityId));

  return row as PortalIdentityRow;
}

/**
 * Bind a portal_contacts row to an identity. Writes an audit row in
 * the contact's tenant so an admin can see when and from where the
 * link happened. Safe to call multiple times — re-linking to the same
 * identity is a no-op.
 */
export async function linkContactToIdentity(
  contactId: string,
  identityId: string,
  actorUserId?: string,
): Promise<void> {
  const before = await db.query.portalContacts.findFirst({
    where: eq(portalContacts.id, contactId),
  });
  if (!before) throw AppError.notFound('Portal contact not found');
  if (before.identityId === identityId) return;

  await db.update(portalContacts)
    .set({ identityId, updatedAt: new Date() })
    .where(eq(portalContacts.id, contactId));

  await auditLog(
    before.tenantId,
    'update',
    'portal_contact_identity_link',
    contactId,
    { identityId: before.identityId },
    { identityId },
    actorUserId,
  );
}

/**
 * Return the list of (tenant, contact) pairs an identity can switch
 * between. Filters out contacts whose status is not 'active' — paused
 * or soft-deleted contacts should not appear in the switcher.
 */
export async function listLinkedContacts(
  identityId: string,
): Promise<LinkedContactSummary[]> {
  const rows = await db
    .select({
      contactId: portalContacts.id,
      tenantId: portalContacts.tenantId,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      email: portalContacts.email,
      firstName: portalContacts.firstName,
      lastName: portalContacts.lastName,
      status: portalContacts.status,
    })
    .from(portalContacts)
    .innerJoin(tenants, eq(portalContacts.tenantId, tenants.id))
    .where(
      and(
        eq(portalContacts.identityId, identityId),
        eq(portalContacts.status, 'active'),
      ),
    );

  return rows.map((r) => ({
    contactId: r.contactId,
    tenantId: r.tenantId,
    tenantSlug: r.tenantSlug,
    tenantName: r.tenantName,
    displayName:
      [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.email,
    status: r.status,
  }));
}

/**
 * Whether the feature flag is enabled. Centralized so service callers
 * don't sprinkle env reads.
 */
export function isLinkingEnabled(): boolean {
  return env.PORTAL_IDENTITY_LINKING_V1 === true;
}

/**
 * Hash a plaintext password with the project's bcrypt cost. Helper so
 * callers don't have to import bcrypt + env separately.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, env.BCRYPT_ROUNDS);
}
