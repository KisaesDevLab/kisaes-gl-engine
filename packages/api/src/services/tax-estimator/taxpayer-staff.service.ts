// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// D17 (Kurt, 2026-10-12) — per-taxpayer staff allow-list ("Who can see this taxpayer").
//
//   * EMPTY list  = every staff member the firm's linked-tenant rule allows;
//   * NON-EMPTY   = only the listed users (plus firm admins / super admins), still subject
//                   to the linked-tenant rule.
// The rule itself is enforced in ONE place, firm-scope.service `visibleTaxpayerFilter`;
// this service only reads and replaces the rows. Only firm admins and super admins (the
// bypass users, `scope.firmRole === 'firm_admin'`) may change the list (403
// TE_FIRM_ADMIN_REQUIRED); everyone who can see the taxpayer may read it. Every change is
// audited, metadata only (user ids).
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { can, type TaxpayerStaffDTO, type TaxpayerStaffCandidateDTO, type TaxpayerStaffCandidateListDTO } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { firmUsers, users, userTenantAccess } from '../../db/schema/index.js';
import { taxEstTaxpayerStaff } from '../../db/schema/tax-estimator-taxpayers.js';
import { AppError } from '../../utils/errors.js';
import * as permissionService from '../permission.service.js';
import type { FirmScope } from './firm-scope.service.js';
import { auditYears, loadTaxpayerForFirm, type Actor } from './year-access.js';

type MemberRole = TaxpayerStaffDTO['members'][number]['firmRole'];
const ELIGIBLE_ROLES = ['firm_staff', 'firm_readonly'] as const;

function requireFirmAdmin(scope: FirmScope): void {
  if (scope.firmRole !== 'firm_admin') {
    throw AppError.forbidden('Only a firm administrator can change who can see a taxpayer', 'TE_FIRM_ADMIN_REQUIRED');
  }
}

/** GET /taxpayers/:id/staff — readable by anyone who can see the taxpayer. */
export async function getTaxpayerStaff(scope: FirmScope, taxpayerId: string, canWrite: boolean): Promise<TaxpayerStaffDTO> {
  await loadTaxpayerForFirm(scope, taxpayerId); // D17: 404 when the caller cannot see it
  const rows = await db.select({
    userId: taxEstTaxpayerStaff.userId, addedAt: taxEstTaxpayerStaff.createdAt,
    email: users.email, displayName: users.displayName, firmRole: firmUsers.firmRole, memberActive: firmUsers.isActive,
  }).from(taxEstTaxpayerStaff)
    .leftJoin(users, eq(users.id, taxEstTaxpayerStaff.userId))
    .leftJoin(firmUsers, and(eq(firmUsers.firmId, taxEstTaxpayerStaff.firmId), eq(firmUsers.userId, taxEstTaxpayerStaff.userId)))
    .where(and(eq(taxEstTaxpayerStaff.firmId, scope.firmId), eq(taxEstTaxpayerStaff.taxpayerId, taxpayerId)))
    .orderBy(asc(users.email), asc(taxEstTaxpayerStaff.userId));
  const members = rows.map((r) => ({
    userId: r.userId, email: r.email ?? '', displayName: r.displayName ?? null,
    firmRole: (r.memberActive ? r.firmRole : null) as MemberRole,
    addedAt: r.addedAt.toISOString(),
  }));
  return {
    taxpayerId, members, total: members.length,
    restrictToLinkedTenants: scope.viewer.restrictToLinkedTenants,
    canEdit: canWrite && scope.firmRole === 'firm_admin',
  };
}

/**
 * The picker (D17 item 5): ACTIVE firm members with role firm_staff or firm_readonly, active
 * staff users, who hold the `tax_estimator` resource in `tenantId` (the admin's ACTIVE tenant —
 * the practice tenant where the firm runs the module; a member without access to it is not
 * offered). Firm admins are never offered: they always see every taxpayer.
 */
export async function listStaffCandidates(scope: FirmScope, tenantId: string): Promise<TaxpayerStaffCandidateDTO[]> {
  const rows = await db.select({
    userId: firmUsers.userId, firmRole: firmUsers.firmRole, email: users.email, displayName: users.displayName,
    isSuperAdmin: users.isSuperAdmin, accessRole: userTenantAccess.role,
  }).from(firmUsers)
    .innerJoin(users, eq(users.id, firmUsers.userId))
    .leftJoin(userTenantAccess, and(eq(userTenantAccess.userId, firmUsers.userId), eq(userTenantAccess.tenantId, tenantId), eq(userTenantAccess.isActive, true)))
    .where(and(
      eq(firmUsers.firmId, scope.firmId), eq(firmUsers.isActive, true), inArray(firmUsers.firmRole, [...ELIGIBLE_ROLES]),
      sql`coalesce(${users.isActive}, true)`, eq(users.userType, 'staff'),
    ))
    .orderBy(asc(users.email), asc(firmUsers.userId));
  const out: TaxpayerStaffCandidateDTO[] = [];
  for (const r of rows) {
    const superAdmin = r.isSuperAdmin === true;
    if (!superAdmin && !r.accessRole) continue;
    const perms = await permissionService.getEffectivePermissions(tenantId, r.userId, r.accessRole ?? 'owner', 'staff', superAdmin);
    if (!can(perms, 'tax_estimator', 'read')) continue;
    out.push({ userId: r.userId, email: r.email, displayName: r.displayName ?? null, firmRole: r.firmRole as TaxpayerStaffCandidateDTO['firmRole'] });
  }
  return out;
}

/** GET /taxpayers/:id/staff-candidates — firm admins only (the people who can edit the list). */
export async function getStaffCandidates(scope: FirmScope, taxpayerId: string, tenantId: string): Promise<TaxpayerStaffCandidateListDTO> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  requireFirmAdmin(scope);
  const data = await listStaffCandidates(scope, tenantId);
  return { data, total: data.length };
}

/**
 * PUT /taxpayers/:id/staff — replace the list. Users ADDED must be eligible candidates
 * (422 TE_STAFF_NOT_ELIGIBLE); users already on the list may stay even if they no longer
 * are (removing them is always allowed). One audit row per change, metadata only.
 */
export async function replaceTaxpayerStaff(
  scope: FirmScope, actor: Actor, taxpayerId: string, userIds: string[], canWrite: boolean,
): Promise<TaxpayerStaffDTO> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  requireFirmAdmin(scope);
  const wanted = [...new Set(userIds)];
  await db.transaction(async (tx) => {
    await loadTaxpayerForFirm(scope, taxpayerId, tx, true); // serialise concurrent edits
    const current = (await tx.select({ userId: taxEstTaxpayerStaff.userId }).from(taxEstTaxpayerStaff)
      .where(and(eq(taxEstTaxpayerStaff.firmId, scope.firmId), eq(taxEstTaxpayerStaff.taxpayerId, taxpayerId))))
      .map((r) => r.userId);
    const added = wanted.filter((u) => !current.includes(u));
    const removed = current.filter((u) => !wanted.includes(u));
    if (added.length > 0) {
      const eligible = new Set((await listStaffCandidates(scope, actor.tenantId)).map((c) => c.userId));
      const bad = added.filter((u) => !eligible.has(u));
      if (bad.length > 0) {
        throw AppError.unprocessableEntity('Only active firm staff with Tax Estimator access can be added', 'TE_STAFF_NOT_ELIGIBLE', { userIds: bad });
      }
    }
    if (added.length === 0 && removed.length === 0) return;
    if (removed.length > 0) {
      await tx.delete(taxEstTaxpayerStaff).where(and(
        eq(taxEstTaxpayerStaff.firmId, scope.firmId), eq(taxEstTaxpayerStaff.taxpayerId, taxpayerId),
        inArray(taxEstTaxpayerStaff.userId, removed)));
    }
    if (added.length > 0) {
      await tx.insert(taxEstTaxpayerStaff)
        .values(added.map((userId) => ({ firmId: scope.firmId, taxpayerId, userId, createdBy: actor.userId })))
        .onConflictDoNothing();
    }
    await auditYears(scope, actor, 'update', 'tax_est_taxpayer_staff', taxpayerId,
      { userIds: [...current].sort() },
      { userIds: [...wanted].sort(), added: [...added].sort(), removed: [...removed].sort() }, tx);
  });
  return getTaxpayerStaff(scope, taxpayerId, canWrite);
}
