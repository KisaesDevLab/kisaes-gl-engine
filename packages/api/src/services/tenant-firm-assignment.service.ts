// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, inArray } from 'drizzle-orm';
import type {
  AssignTenantToFirmInput,
  TenantFirmAssignment,
  TenantFirmAssignmentWithTenant,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenantFirmAssignments, tenants, userTenantAccess } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// 3-tier rules plan, Phase 1 — tenant ↔ firm assignment service.
// 1:N: a tenant has at most one ACTIVE managing firm. Modeled
// with a partial unique index (`WHERE is_active = true`); the
// service also pre-checks before insert to surface a clean 409
// instead of relying on the raw pg unique-violation message.

function mapRow(row: typeof tenantFirmAssignments.$inferSelect): TenantFirmAssignment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    firmId: row.firmId,
    assignedByUserId: row.assignedByUserId,
    assignedAt: row.assignedAt.toISOString(),
    isActive: row.isActive,
  };
}

// Returns the active assignment for a tenant (if any). null when
// the tenant is a solo book — i.e., not managed by any firm.
// Used by the rule-evaluation pipeline to decide whether to
// surface tenant_firm / global_firm rules.
export async function getActiveForTenant(
  tenantId: string,
): Promise<TenantFirmAssignment | null> {
  const row = await db.query.tenantFirmAssignments.findFirst({
    where: and(
      eq(tenantFirmAssignments.tenantId, tenantId),
      eq(tenantFirmAssignments.isActive, true),
    ),
  });
  return row ? mapRow(row) : null;
}

// Tenants the caller can assign to this firm, for a searchable picker instead
// of a raw-UUID field. Excludes tenants already actively assigned to this firm.
// A super-admin sees every tenant; anyone else sees only tenants they're
// owner/accountant on — the same authority the assign endpoint enforces, so
// the list never offers a tenant the assign would then reject.
export async function listAssignableTenants(
  firmId: string,
  callerUserId: string,
  isSuperAdmin: boolean,
): Promise<Array<{ tenantId: string; name: string; slug: string }>> {
  const assigned = await db
    .select({ tenantId: tenantFirmAssignments.tenantId })
    .from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.firmId, firmId), eq(tenantFirmAssignments.isActive, true)));
  const assignedSet = new Set(assigned.map((a) => a.tenantId));

  const rows = isSuperAdmin
    ? await db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(tenants).orderBy(tenants.name)
    : await db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(userTenantAccess)
        .innerJoin(tenants, eq(tenants.id, userTenantAccess.tenantId))
        .where(and(
          eq(userTenantAccess.userId, callerUserId),
          eq(userTenantAccess.isActive, true),
          inArray(userTenantAccess.role, ['owner', 'accountant']),
        ))
        .orderBy(tenants.name);

  return rows
    .filter((r) => !assignedSet.has(r.id))
    .map((r) => ({ tenantId: r.id, name: r.name, slug: r.slug }));
}

export async function listForFirm(firmId: string): Promise<TenantFirmAssignmentWithTenant[]> {
  const rows = await db
    .select({
      id: tenantFirmAssignments.id,
      tenantId: tenantFirmAssignments.tenantId,
      firmId: tenantFirmAssignments.firmId,
      assignedByUserId: tenantFirmAssignments.assignedByUserId,
      assignedAt: tenantFirmAssignments.assignedAt,
      isActive: tenantFirmAssignments.isActive,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
    })
    .from(tenantFirmAssignments)
    .innerJoin(tenants, eq(tenants.id, tenantFirmAssignments.tenantId))
    .where(eq(tenantFirmAssignments.firmId, firmId))
    .orderBy(tenants.name);
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    firmId: r.firmId,
    assignedByUserId: r.assignedByUserId,
    assignedAt: r.assignedAt.toISOString(),
    isActive: r.isActive,
    tenantName: r.tenantName,
    tenantSlug: r.tenantSlug,
  }));
}

// Assigns a tenant to a firm. 1:N enforcement happens in two places:
//   1. This pre-check returns a clean 409 if another firm is
//      already actively assigned and `force` is false.
//   2. The DB partial unique index (tfa_tenant_active_unique_idx)
//      catches any race condition.
// When `force=true`, soft-detach the prior active assignment in
// the same transaction so attribution history survives.
export async function assignTenant(
  firmId: string,
  input: AssignTenantToFirmInput,
  assignedByUserId: string,
): Promise<TenantFirmAssignment> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.tenantFirmAssignments.findFirst({
      where: and(
        eq(tenantFirmAssignments.tenantId, input.tenantId),
        eq(tenantFirmAssignments.isActive, true),
      ),
    });
    if (existing) {
      if (existing.firmId === firmId) {
        // Idempotent — already assigned to this firm. Return the
        // existing row.
        return mapRow(existing);
      }
      if (!input.force) {
        throw AppError.conflict(
          'Tenant is already assigned to another firm. Pass force=true to reassign.',
          'TENANT_ALREADY_ASSIGNED',
          { currentFirmId: existing.firmId },
        );
      }
      // Soft-detach the prior assignment.
      await tx
        .update(tenantFirmAssignments)
        .set({ isActive: false })
        .where(eq(tenantFirmAssignments.id, existing.id));
    }
    const [row] = await tx.insert(tenantFirmAssignments).values({
      tenantId: input.tenantId,
      firmId,
      assignedByUserId,
    }).returning();
    return mapRow(row!);
  });
}

// Soft-detach. The row is preserved with is_active=false so audit
// queries can still attribute historical work to the firm.
export async function unassignTenant(firmId: string, tenantId: string): Promise<void> {
  const existing = await db.query.tenantFirmAssignments.findFirst({
    where: and(
      eq(tenantFirmAssignments.firmId, firmId),
      eq(tenantFirmAssignments.tenantId, tenantId),
      eq(tenantFirmAssignments.isActive, true),
    ),
  });
  if (!existing) {
    throw AppError.notFound('Tenant is not currently assigned to this firm');
  }
  await db
    .update(tenantFirmAssignments)
    .set({ isActive: false })
    .where(eq(tenantFirmAssignments.id, existing.id));
}
