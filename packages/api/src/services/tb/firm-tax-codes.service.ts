// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm custom tax codes (Phase 2.4, rule TB8). Owned by the tenant's
// firm when one exists (shared across all the firm's client tenants),
// otherwise by the tenant itself — exactly one owner per row, enforced
// by chk_firm_tax_codes_one_owner. Codes are FIRM:-namespaced so seed
// updates can never clobber them (standing invariant #5).

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { firmTaxCodes, tenantFirmAssignments } from '../../db/schema/index.js';
import type { z } from 'zod';
import { createFirmTaxCodeSchema, updateFirmTaxCodeSchema } from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';

type CreateInput = z.infer<typeof createFirmTaxCodeSchema>;
type UpdateInput = z.infer<typeof updateFirmTaxCodeSchema>;

const FIRM_PREFIX = 'FIRM:';

function namespaced(code: string): string {
  // Reject a caller trying to smuggle a double prefix or a bare seed
  // collision — the stored value always has exactly one FIRM: prefix.
  const bare = code.startsWith(FIRM_PREFIX) ? code.slice(FIRM_PREFIX.length) : code;
  if (bare.startsWith(FIRM_PREFIX)) {
    throw AppError.badRequest('Code must not repeat the FIRM: prefix', 'TB_FIRM_CODE_NAMESPACE');
  }
  if (!bare) throw AppError.badRequest('Code is required', 'TB_FIRM_CODE_NAMESPACE');
  return FIRM_PREFIX + bare;
}

// The owning scope for a tenant: its firm when assigned, else itself.
export async function resolveOwner(tenantId: string): Promise<{ firmId: string | null; tenantId: string | null }> {
  const [assignment] = await db.select({ firmId: tenantFirmAssignments.firmId })
    .from(tenantFirmAssignments)
    .where(eq(tenantFirmAssignments.tenantId, tenantId))
    .limit(1);
  return assignment ? { firmId: assignment.firmId, tenantId: null } : { firmId: null, tenantId };
}

function ownerWhere(owner: { firmId: string | null; tenantId: string | null }) {
  return owner.firmId
    ? and(eq(firmTaxCodes.firmId, owner.firmId), isNull(firmTaxCodes.tenantId))
    : and(isNull(firmTaxCodes.firmId), eq(firmTaxCodes.tenantId, owner.tenantId ?? ''));
}

export async function listFirmCodes(tenantId: string, includeInactive = false) {
  const owner = await resolveOwner(tenantId);
  const conds = [ownerWhere(owner)];
  if (!includeInactive) conds.push(eq(firmTaxCodes.isActive, true));
  const codes = await db.select().from(firmTaxCodes)
    .where(and(...conds))
    .orderBy(firmTaxCodes.returnForm, firmTaxCodes.activityType, firmTaxCodes.sortOrder, firmTaxCodes.code);
  return { codes, ownedByFirm: owner.firmId !== null };
}

export async function createFirmCode(tenantId: string, input: CreateInput, userId?: string) {
  const owner = await resolveOwner(tenantId);
  const code = namespaced(input.code);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: firmTaxCodes.id }).from(firmTaxCodes)
      .where(and(ownerWhere(owner),
        eq(firmTaxCodes.returnForm, input.returnForm),
        eq(firmTaxCodes.activityType, input.activityType),
        eq(firmTaxCodes.code, code)))
      .limit(1);
    if (existing) {
      throw AppError.conflict('A custom code with this form, activity, and code already exists', 'TB_FIRM_CODE_NAMESPACE');
    }
    const [row] = await tx.insert(firmTaxCodes).values({
      firmId: owner.firmId,
      tenantId: owner.tenantId,
      code,
      description: input.description,
      returnForm: input.returnForm,
      activityType: input.activityType,
      sortOrder: input.sortOrder,
      isM1Adjustment: input.isM1Adjustment,
      ultrataxCode: input.ultrataxCode ?? null,
      cchCode: input.cchCode ?? null,
      lacerteCode: input.lacerteCode ?? null,
      gosystemCode: input.gosystemCode ?? null,
      genericCode: input.genericCode ?? null,
      createdBy: userId ?? null,
    }).returning();
    if (!row) throw AppError.internal('Custom code insert failed');
    await auditLog(tenantId, 'create', 'firm_tax_code', row.id, null, row, userId, tx);
    return row;
  });
}

export async function updateFirmCode(tenantId: string, id: string, input: UpdateInput, userId?: string) {
  const owner = await resolveOwner(tenantId);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(firmTaxCodes)
      .where(and(eq(firmTaxCodes.id, id), ownerWhere(owner))).limit(1);
    if (!before) throw AppError.notFound('Custom code not found');
    const patch: Partial<typeof firmTaxCodes.$inferInsert> = { updatedAt: new Date() };
    if (input.code !== undefined) patch.code = namespaced(input.code);
    if (input.description !== undefined) patch.description = input.description;
    if (input.returnForm !== undefined) patch.returnForm = input.returnForm;
    if (input.activityType !== undefined) patch.activityType = input.activityType;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.isM1Adjustment !== undefined) patch.isM1Adjustment = input.isM1Adjustment;
    if (input.ultrataxCode !== undefined) patch.ultrataxCode = input.ultrataxCode;
    if (input.cchCode !== undefined) patch.cchCode = input.cchCode;
    if (input.lacerteCode !== undefined) patch.lacerteCode = input.lacerteCode;
    if (input.gosystemCode !== undefined) patch.gosystemCode = input.gosystemCode;
    if (input.genericCode !== undefined) patch.genericCode = input.genericCode;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    const [row] = await tx.update(firmTaxCodes).set(patch)
      .where(eq(firmTaxCodes.id, id)).returning();
    if (!row) throw AppError.internal('Custom code update failed');
    await auditLog(tenantId, 'update', 'firm_tax_code', id, before, row, userId, tx);
    return row;
  });
}

// Soft delete: assignments FK RESTRICT on firm_code_id, so codes in use
// can't be hard-deleted anyway. Deactivation hides them from pickers.
export async function deactivateFirmCode(tenantId: string, id: string, userId?: string) {
  return updateFirmCode(tenantId, id, { isActive: false }, userId);
}
