// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, userTenantAccess } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// Delegated-admin scope assertions. Every helper is a no-op for super
// admins (req.adminDelegated is unset) and a 404 — never a 403 — for a
// delegated caller whose target lies outside req.adminScope, so a firm
// member can't probe tenant / user ids the way resolveFirmFromPath hides
// foreign firm ids.

export function isDelegatedAdmin(req: Request): boolean {
  return req.adminDelegated === true && !req.isSuperAdmin;
}

export function assertTenantInScope(req: Request, tenantId: string): void {
  if (!isDelegatedAdmin(req)) return;
  if (!req.adminScope?.tenantIds.includes(tenantId)) {
    throw AppError.notFound('Tenant not found');
  }
}

export function assertFirmInScope(req: Request, firmId: string): void {
  if (!isDelegatedAdmin(req)) return;
  if (!req.adminScope?.firmIds.includes(firmId)) {
    throw AppError.notFound('Firm not found');
  }
}

export type UserScopeMode =
  // The user's HOME tenant (users.tenant_id) must be in scope. Use for
  // operations that act on the user record globally (activate/deactivate,
  // home role, company access) — a user who merely has access to a firm
  // tenant but lives elsewhere is not the firm's to manage.
  | 'home'
  // ANY active user_tenant_access row on an in-scope tenant suffices. Use
  // for support actions scoped to that access (unlock, reset link, access
  // toggles).
  | 'any';

// Loads the target user. For delegated callers: 404 when the target is a
// super admin (never manageable by delegation), or outside scope per `mode`.
export async function assertUserInScope(
  req: Request,
  userId: string,
  mode: UserScopeMode,
): Promise<typeof users.$inferSelect> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  if (!isDelegatedAdmin(req)) return user;

  const tenantIds = req.adminScope?.tenantIds ?? [];
  if (user.isSuperAdmin || tenantIds.length === 0) throw AppError.notFound('User not found');

  if (mode === 'home') {
    if (!tenantIds.includes(user.tenantId)) throw AppError.notFound('User not found');
    return user;
  }
  const [row] = await db
    .select({ id: userTenantAccess.id })
    .from(userTenantAccess)
    .where(and(
      eq(userTenantAccess.userId, userId),
      eq(userTenantAccess.isActive, true),
      inArray(userTenantAccess.tenantId, tenantIds),
    ))
    .limit(1);
  if (!row) throw AppError.notFound('User not found');
  return user;
}

// For grant-tenant-access: the target may not yet hold access on any
// in-scope tenant (that is the point of the grant). Delegated callers may
// grant to (a) users whose home tenant is in scope, or (b) users who are
// members of one of the caller's scoped firms. Super admins: anyone.
export async function assertUserGrantable(req: Request, userId: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  if (!isDelegatedAdmin(req)) return;
  if (user.isSuperAdmin) throw AppError.notFound('User not found');
  const tenantIds = req.adminScope?.tenantIds ?? [];
  const firmIds = req.adminScope?.firmIds ?? [];
  if (tenantIds.includes(user.tenantId)) return;
  if (firmIds.length > 0) {
    const { firmUsers } = await import('../db/schema/index.js');
    const [member] = await db
      .select({ id: firmUsers.id })
      .from(firmUsers)
      .where(and(
        eq(firmUsers.userId, userId),
        eq(firmUsers.isActive, true),
        inArray(firmUsers.firmId, firmIds),
      ))
      .limit(1);
    if (member) return;
  }
  throw AppError.notFound('User not found');
}

// POST /admin/tenants/:id/firm for delegated callers. Reassigning a tenant's
// managing firm is firm ADMINISTRATION, so beyond tenant scope the caller
// must be an active firm_admin of every firm involved: the target (when
// non-null) and the currently assigned firm (when any). Target firms the
// caller isn't a member of 404; the super-admin-managed appliance firm is
// refused with FIRM_SUPER_ADMIN_MANAGED, mirroring requireFirmAdmin.
export async function assertMayReassignTenantFirm(
  req: Request,
  tenantId: string,
  targetFirmId: string | null,
): Promise<void> {
  if (!isDelegatedAdmin(req)) return;
  const firmUsersService = await import('../services/firm-users.service.js');
  const firmsService = await import('../services/firms.service.js');
  const tfa = await import('../services/tenant-firm-assignment.service.js');

  const requireAdminOf = async (firmId: string) => {
    const role = await firmUsersService.getRoleForUser(firmId, req.userId);
    if (role !== 'firm_admin') throw AppError.notFound('Firm not found');
    const firm = await firmsService.getById(firmId);
    if (firm.superAdminManaged) {
      throw AppError.forbidden('This firm is managed by the system administrator', 'FIRM_SUPER_ADMIN_MANAGED');
    }
  };

  const current = await tfa.getActiveForTenant(tenantId);
  if (current) await requireAdminOf(current.firmId);
  if (targetFirmId) await requireAdminOf(targetFirmId);
}
