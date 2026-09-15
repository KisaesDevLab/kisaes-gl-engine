// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm member access rights — resolution + per-member editing.
//
// A capability is stored firm-wide on the firm_users row (jsonb, NULL =
// role defaults; see migration 0173) and resolved with the shared
// `resolveFirmCapabilities`. Two views exist:
//
//   tenant-level  — the union of the member's effective sets across every
//                   ACTIVE firm that ACTIVELY manages `tenantId`, but ONLY
//                   when the member already holds ACTIVE user_tenant_access
//                   on that tenant. A capability elevates a member to owner
//                   parity for one settings area; it never grants access.
//   admin-level   — the union across every active membership, plus the
//                   scope (firm ids + tenant ids) a given admin capability
//                   authorizes.
//
// Super admins are NOT special-cased here: the resolver reads membership
// only. The "super admin passes" short-circuit lives in the middleware, the
// same division of labour as resolveFirmFromPath / requireFirmAdmin.
//
// This module imports no other firm service so firm-users.service can
// import it (for mapRow) without a cycle.

import { and, eq, inArray } from 'drizzle-orm';
import {
  ADMIN_CAPABILITY_KEYS,
  emptyFirmCapabilities,
  isCapabilityEligibleRole,
  normalizeFirmCapabilityMap,
  resolveFirmCapabilities,
  unionFirmCapabilities,
  type EffectiveFirmCapabilities,
  type FirmCapabilityKey,
  type FirmCapabilityMap,
  type FirmRole,
  type FirmUserCapabilitiesView,
  type MeFirmCapabilities,
  type SetFirmUserCapabilitiesInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { firms, firmUsers, tenantFirmAssignments, userTenantAccess } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

interface MembershipRow {
  firmId: string;
  firmRole: FirmRole;
  capabilities: FirmCapabilityMap | null;
}

// Active memberships in active firms — the one query every resolver
// starts from. Deactivated firms authorize nobody (same rule as
// firm-users.service.getRoleForUser).
async function listActiveMemberships(userId: string): Promise<MembershipRow[]> {
  const rows = await db
    .select({
      firmId: firmUsers.firmId,
      firmRole: firmUsers.firmRole,
      capabilities: firmUsers.capabilities,
    })
    .from(firmUsers)
    .innerJoin(firms, eq(firms.id, firmUsers.firmId))
    .where(and(
      eq(firmUsers.userId, userId),
      eq(firmUsers.isActive, true),
      eq(firms.isActive, true),
    ));
  return rows.map((r) => ({
    firmId: r.firmId,
    firmRole: r.firmRole as FirmRole,
    capabilities: r.capabilities ?? null,
  }));
}

function effective(row: MembershipRow): EffectiveFirmCapabilities {
  return resolveFirmCapabilities(row.firmRole, row.capabilities);
}

// ─── Tenant-level ────────────────────────────────────────────

// Effective owner-parity capabilities for `userId` on `tenantId`. All
// false unless (a) the user has ACTIVE user_tenant_access on the tenant,
// and (b) at least one active firm the user is an active member of
// actively manages the tenant.
export async function getTenantCapabilitiesForUser(
  userId: string,
  tenantId: string,
): Promise<EffectiveFirmCapabilities> {
  const rows = await db
    .select({
      firmId: firmUsers.firmId,
      firmRole: firmUsers.firmRole,
      capabilities: firmUsers.capabilities,
    })
    .from(firmUsers)
    .innerJoin(firms, eq(firms.id, firmUsers.firmId))
    .innerJoin(tenantFirmAssignments, and(
      eq(tenantFirmAssignments.firmId, firmUsers.firmId),
      eq(tenantFirmAssignments.tenantId, tenantId),
      eq(tenantFirmAssignments.isActive, true),
    ))
    .innerJoin(userTenantAccess, and(
      eq(userTenantAccess.userId, userId),
      eq(userTenantAccess.tenantId, tenantId),
      eq(userTenantAccess.isActive, true),
    ))
    .where(and(
      eq(firmUsers.userId, userId),
      eq(firmUsers.isActive, true),
      eq(firms.isActive, true),
    ));
  if (rows.length === 0) return emptyFirmCapabilities();
  return unionFirmCapabilities(rows.map((r) => effective({
    firmId: r.firmId,
    firmRole: r.firmRole as FirmRole,
    capabilities: r.capabilities ?? null,
  })));
}

// ─── Admin-level ─────────────────────────────────────────────

// Union across every active membership. No tenant condition: delegated
// admin is a firm-derived power, scoped separately by getAdminScope.
export async function getAdminCapabilitiesForUser(userId: string): Promise<EffectiveFirmCapabilities> {
  const memberships = await listActiveMemberships(userId);
  if (memberships.length === 0) return emptyFirmCapabilities();
  const union = unionFirmCapabilities(memberships.map(effective));
  // Only the admin-scoped keys are meaningful here; tenant-scoped keys
  // are reported too (harmless) so callers get one consistent shape.
  return union;
}

export interface AdminScope {
  // Firms where the member is active AND holds the capability.
  firmIds: string[];
  // Tenants actively assigned to those firms.
  tenantIds: string[];
}

export async function getAdminScope(userId: string, cap: FirmCapabilityKey): Promise<AdminScope> {
  const memberships = await listActiveMemberships(userId);
  const firmIds = memberships.filter((m) => effective(m)[cap]).map((m) => m.firmId);
  if (firmIds.length === 0) return { firmIds: [], tenantIds: [] };
  const rows = await db
    .select({ tenantId: tenantFirmAssignments.tenantId })
    .from(tenantFirmAssignments)
    .where(and(
      inArray(tenantFirmAssignments.firmId, firmIds),
      eq(tenantFirmAssignments.isActive, true),
    ));
  return { firmIds, tenantIds: [...new Set(rows.map((r) => r.tenantId))] };
}

export function hasAnyAdminCapability(caps: EffectiveFirmCapabilities): boolean {
  return ADMIN_CAPABILITY_KEYS.some((k) => caps[k]);
}

// `/auth/me` addendum.
export async function getForMe(userId: string, activeTenantId: string): Promise<MeFirmCapabilities> {
  const [tenant, admin] = await Promise.all([
    getTenantCapabilitiesForUser(userId, activeTenantId),
    getAdminCapabilitiesForUser(userId),
  ]);
  return { tenant, admin };
}

// ─── Per-member editing (firm admin UI) ──────────────────────

async function loadMember(firmId: string, firmUserId: string) {
  const row = await db.query.firmUsers.findFirst({
    where: and(eq(firmUsers.firmId, firmId), eq(firmUsers.id, firmUserId)),
  });
  // 404 keeps a firm admin from probing other firms' membership ids —
  // same convention as resolveFirmStaffUserId in firm-users.service.
  if (!row) throw AppError.notFound('Firm membership not found');
  return row;
}

function toView(row: typeof firmUsers.$inferSelect): FirmUserCapabilitiesView {
  const stored = row.capabilities ?? null;
  return {
    firmUserId: row.id,
    userId: row.userId,
    firmRole: row.firmRole as FirmRole,
    capabilities: resolveFirmCapabilities(row.firmRole, stored),
    capabilitiesCustomized: stored !== null,
    stored,
    updatedAt: row.capabilitiesUpdatedAt ? row.capabilitiesUpdatedAt.toISOString() : null,
  };
}

export async function getForMember(firmId: string, firmUserId: string): Promise<FirmUserCapabilitiesView> {
  return toView(await loadMember(firmId, firmUserId));
}

export interface SetForMemberResult {
  before: FirmUserCapabilitiesView;
  after: FirmUserCapabilitiesView;
}

// Store an explicit set (customized) or NULL (back to role defaults).
// firm_readonly members are ineligible: the resolver would return none
// anyway, but refusing the write keeps the UI honest and the row clean.
export async function setForMember(
  firmId: string,
  firmUserId: string,
  input: SetFirmUserCapabilitiesInput,
  actingUserId: string,
): Promise<SetForMemberResult> {
  const row = await loadMember(firmId, firmUserId);
  if (!isCapabilityEligibleRole(row.firmRole)) {
    throw AppError.badRequest(
      'Read-only firm members cannot hold access rights. Change their firm role to firm_staff first.',
      'FIRM_ROLE_INELIGIBLE',
    );
  }
  const next: FirmCapabilityMap | null = input.capabilities === null
    ? null
    : normalizeFirmCapabilityMap(input.capabilities);
  const [updated] = await db
    .update(firmUsers)
    .set({
      capabilities: next,
      capabilitiesUpdatedAt: new Date(),
      capabilitiesUpdatedByUserId: actingUserId,
    })
    .where(eq(firmUsers.id, row.id))
    .returning();
  return { before: toView(row), after: toView(updated!) };
}
