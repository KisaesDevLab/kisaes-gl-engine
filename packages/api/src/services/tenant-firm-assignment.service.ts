// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import type {
  AssignTenantToFirmInput,
  TenantFirmAssignment,
  TenantFirmAssignmentWithTenant,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenantFirmAssignments, tenants } from '../db/schema/index.js';
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
