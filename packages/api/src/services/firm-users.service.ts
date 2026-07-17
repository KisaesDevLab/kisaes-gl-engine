// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  FirmRole,
  FirmUser,
  FirmUserWithProfile,
  InviteFirmUserInput,
  SetStaffTenantAccessInput,
  StaffTenantAccessRow,
  TenantAccessRole,
  UpdateFirmUserInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { firms, firmUsers, tenantFirmAssignments, tenants, userTenantAccess, users } from '../db/schema/index.js';
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
// invitee must already have a user account on this installation.
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
    const appName = await (async () => {
      try { const { getBranding } = await import('./admin.service.js'); return (await getBranding()).appName; }
      catch { return 'Vibe MyBooks'; }
    })();
    throw AppError.notFound(
      `No user found with email "${input.email}". Create their account first (Admin → Users), then invite them to the firm — the invitee must already have a ${appName} account.`,
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

  // Notify the invitee. Fire-and-forget — a mail failure must not block
  // the membership grant, and the invitee already has a working account.
  void (async () => {
    const [firm, invitee] = await Promise.all([
      db.query.firms.findFirst({ where: eq(firms.id, firmId) }),
      db.query.users.findFirst({ where: eq(users.id, userId) }),
    ]);
    if (!firm || !invitee) return;
    const systemEmail = await import('./system-email.service.js');
    const baseUrl = process.env['CORS_ORIGIN'] || 'http://localhost:5173';
    await systemEmail.sendActionEmail({
      to: invitee.email,
      subject: `You've been added to ${firm.name}`,
      bodyText: `You've been added to the firm "${firm.name}" as ${input.firmRole}.\nLog in with your existing credentials to access it.`,
      cta: { label: 'Log In', url: `${baseUrl}/login` },
    });
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[firm-users.service] firm-invite email failed:`, err?.message ?? err);
  });

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

// ─── Per-tenant access for firm staff ────────────────────────
//
// Firm membership is orthogonal to per-tenant access: a staffer only operates
// on a client's books once a `user_tenant_access` row exists. These helpers
// are the UX that grants those rows in bulk across the firm's managed tenants,
// so a firm admin doesn't have to invite the same person from each client's
// Team page one at a time.

// Resolve a firm_users row id to its underlying user id, asserting the row
// belongs to THIS firm. Guarantees a firm admin can only manage members of
// their own firm.
async function resolveFirmStaffUserId(firmId: string, firmUserId: string): Promise<string> {
  const row = await db.query.firmUsers.findFirst({
    where: and(eq(firmUsers.firmId, firmId), eq(firmUsers.id, firmUserId)),
  });
  if (!row) throw AppError.notFound('Firm membership not found');
  return row.userId;
}

// The firm's ACTIVE managed tenants joined with this staffer's per-tenant
// access. Powers the firm-staff "tenant access" matrix.
export async function listTenantAccessForStaff(
  firmId: string,
  firmUserId: string,
): Promise<StaffTenantAccessRow[]> {
  const userId = await resolveFirmStaffUserId(firmId, firmUserId);
  const rows = await db
    .select({
      tenantId: tenantFirmAssignments.tenantId,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
      accessActive: userTenantAccess.isActive,
      role: userTenantAccess.role,
    })
    .from(tenantFirmAssignments)
    .innerJoin(tenants, eq(tenants.id, tenantFirmAssignments.tenantId))
    .leftJoin(
      userTenantAccess,
      and(
        eq(userTenantAccess.tenantId, tenantFirmAssignments.tenantId),
        eq(userTenantAccess.userId, userId),
      ),
    )
    .where(and(eq(tenantFirmAssignments.firmId, firmId), eq(tenantFirmAssignments.isActive, true)))
    .orderBy(tenants.name);
  return rows.map((r) => ({
    tenantId: r.tenantId,
    tenantName: r.tenantName,
    tenantSlug: r.tenantSlug,
    hasAccess: r.accessActive === true,
    role: r.accessActive === true ? (r.role as TenantAccessRole) : null,
  }));
}

// Set a staffer's access across the firm's managed tenants. The request is
// authoritative for the firm's tenants only: a managed tenant in `access` is
// granted/re-roled; a managed tenant absent from `access` is revoked (soft —
// is_active=false). Tenants outside the firm are rejected, so this can never
// grant access to, or revoke, the user's direct (non-firm) tenants.
export async function setTenantAccessForStaff(
  firmId: string,
  firmUserId: string,
  input: SetStaffTenantAccessInput,
): Promise<StaffTenantAccessRow[]> {
  const userId = await resolveFirmStaffUserId(firmId, firmUserId);

  const managed = await db
    .select({ tenantId: tenantFirmAssignments.tenantId })
    .from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.firmId, firmId), eq(tenantFirmAssignments.isActive, true)));
  const managedIds = new Set(managed.map((m) => m.tenantId));

  const desired = new Map<string, TenantAccessRole>();
  for (const a of input.access) {
    if (!managedIds.has(a.tenantId)) {
      throw AppError.badRequest(
        `Tenant ${a.tenantId} is not managed by this firm`,
        'TENANT_NOT_MANAGED_BY_FIRM',
      );
    }
    desired.set(a.tenantId, a.role);
  }

  if (managedIds.size > 0) {
    await db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(userTenantAccess)
        .where(and(
          eq(userTenantAccess.userId, userId),
          inArray(userTenantAccess.tenantId, [...managedIds]),
        ));
      const currentByTenant = new Map(current.map((c) => [c.tenantId, c]));

      // Grant / reactivate / re-role.
      for (const [tenantId, role] of desired) {
        const existing = currentByTenant.get(tenantId);
        if (existing) {
          if (!existing.isActive || existing.role !== role) {
            await tx.update(userTenantAccess)
              .set({ isActive: true, role })
              .where(eq(userTenantAccess.id, existing.id));
          }
        } else {
          await tx.insert(userTenantAccess).values({ userId, tenantId, role });
        }
      }

      // Revoke any managed tenant that is currently active but not desired.
      for (const c of current) {
        if (c.isActive && !desired.has(c.tenantId)) {
          await tx.update(userTenantAccess)
            .set({ isActive: false })
            .where(eq(userTenantAccess.id, c.id));
        }
      }
    });
  }

  return listTenantAccessForStaff(firmId, firmUserId);
}

// Idempotent membership upsert keyed by the (firm_id, user_id)
// unique index. Unlike addCreatorAsAdmin this never throws on a
// duplicate, and it does NOT overwrite an existing row's role —
// re-provisioning a tenant must not silently downgrade or upgrade a
// member who was already granted a specific firm role. Used by
// appliance-firm auto-provisioning and the backfill script.
export async function ensureMembership(
  firmId: string,
  userId: string,
  firmRole: FirmRole = 'firm_admin',
): Promise<void> {
  await db
    .insert(firmUsers)
    .values({ firmId, userId, firmRole })
    .onConflictDoNothing({ target: [firmUsers.firmId, firmUsers.userId] });
}
