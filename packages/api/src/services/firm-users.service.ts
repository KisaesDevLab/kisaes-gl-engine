// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, sql } from 'drizzle-orm';
import type {
  FirmRole,
  FirmUser,
  FirmUserWithProfile,
  InviteFirmUserInput,
  UpdateFirmUserInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { firmUsers, users } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// 3-tier rules plan, Phase 1 — firm membership service.
// firm_users joins users → firms with a firm-internal role.
// firm membership is orthogonal to per-tenant access; a firm
// staffer still needs a `user_tenant_access` row to operate on a
// specific managed tenant. v1 does NOT auto-grant tenant access.

function mapRow(row: typeof firmUsers.$inferSelect): FirmUser {
  return {
    id: row.id,
    firmId: row.firmId,
    userId: row.userId,
    firmRole: row.firmRole as FirmRole,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

// Resolves an invite payload (userId OR email) to a user id.
// Email lookup is case-insensitive and throws if no user exists —
// the firm-admin UI does NOT silently auto-create users; the
// invitee must already have a kis-books account.
async function resolveInviteeUserId(input: InviteFirmUserInput): Promise<string> {
  if (input.userId) {
    const u = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
    if (!u) throw AppError.notFound('Invitee user not found');
    return u.id;
  }
  if (!input.email) {
    throw AppError.badRequest('Either userId or email is required', 'INVITE_PAYLOAD_INVALID');
  }
  const u = await db.query.users.findFirst({
    where: sql`LOWER(${users.email}) = LOWER(${input.email})`,
  });
  if (!u) {
    throw AppError.notFound(
      `No user found with email "${input.email}". The invitee must have a kis-books account first.`,
    );
  }
  return u.id;
}

export async function invite(firmId: string, input: InviteFirmUserInput): Promise<FirmUser> {
  const userId = await resolveInviteeUserId(input);
  // If the user is already a member, surface a 409 — the UI can
  // offer to "reactivate" or "change role" instead of silently
  // overwriting.
  const existing = await db.query.firmUsers.findFirst({
    where: and(eq(firmUsers.firmId, firmId), eq(firmUsers.userId, userId)),
  });
  if (existing) {
    throw AppError.conflict(
      'User is already a member of this firm',
      'FIRM_USER_EXISTS',
      { firmUserId: existing.id, isActive: existing.isActive, firmRole: existing.firmRole },
    );
  }
  const [row] = await db.insert(firmUsers).values({
    firmId,
    userId,
    firmRole: input.firmRole,
  }).returning();
  return mapRow(row!);
}

export async function listForFirm(firmId: string): Promise<FirmUserWithProfile[]> {
  const rows = await db
    .select({
      id: firmUsers.id,
      firmId: firmUsers.firmId,
      userId: firmUsers.userId,
      firmRole: firmUsers.firmRole,
      isActive: firmUsers.isActive,
      createdAt: firmUsers.createdAt,
      email: users.email,
      displayName: users.displayName,
    })
    .from(firmUsers)
    .innerJoin(users, eq(users.id, firmUsers.userId))
    .where(eq(firmUsers.firmId, firmId))
    .orderBy(users.email);
  return rows.map((r) => ({
    id: r.id,
    firmId: r.firmId,
    userId: r.userId,
    firmRole: r.firmRole as FirmRole,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    email: r.email,
    displayName: r.displayName,
  }));
}

// Look up a single user's role within a firm (used by the
// firm-access middleware). Returns null when the user is not a
// member or the row is inactive — the middleware translates that
// into a 403.
export async function getRoleForUser(
  firmId: string,
  userId: string,
): Promise<FirmRole | null> {
  const row = await db.query.firmUsers.findFirst({
    where: and(
      eq(firmUsers.firmId, firmId),
      eq(firmUsers.userId, userId),
      eq(firmUsers.isActive, true),
    ),
  });
  return row ? (row.firmRole as FirmRole) : null;
}

export async function updateMembership(
  firmId: string,
  firmUserId: string,
  input: UpdateFirmUserInput,
): Promise<FirmUser> {
  const set: Partial<typeof firmUsers.$inferInsert> = {};
  if (input.firmRole !== undefined) set.firmRole = input.firmRole;
  if (input.isActive !== undefined) set.isActive = input.isActive;
  const [row] = await db
    .update(firmUsers)
    .set(set)
    .where(and(eq(firmUsers.firmId, firmId), eq(firmUsers.id, firmUserId)))
    .returning();
  if (!row) throw AppError.notFound('Firm membership not found');
  return mapRow(row);
}

// Hard remove (vs. soft is_active=false). Note: removing a firm
// staffer does NOT cascade to rules — `tenant_firm` and
// `global_firm` rules are owned by the firm itself, not by the
// individual user, by design. Soft-removal is preferred when the
// staffer might be re-added later.
export async function remove(firmId: string, firmUserId: string): Promise<void> {
  await db.delete(firmUsers).where(
    and(eq(firmUsers.firmId, firmId), eq(firmUsers.id, firmUserId)),
  );
}

// Bootstrap helper — when a super-admin creates a firm, they're
// auto-added as `firm_admin`. Lives here (rather than inline in
// firms.service.create) so the same atomic semantics can be
// reused by future firm-bootstrap flows (e.g., invite-driven
// firm creation).
export async function addCreatorAsAdmin(firmId: string, userId: string): Promise<void> {
  await db.insert(firmUsers).values({
    firmId,
    userId,
    firmRole: 'firm_admin',
  });
}
