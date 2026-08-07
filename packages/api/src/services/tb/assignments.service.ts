// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Account → tax code assignments (Phase 6.2/6C.1). The available-codes
// list is THE filtered surface (ADR-TB-02): pickers and the AI
// assignment service consume it — never the raw seed table (6C.1).

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accountTaxAssignments, companyTaxProfiles, firmTaxCodes, taxCodes,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { latestVersionForYear } from './tax-code-seed.service.js';
import { resolveOwner } from './firm-tax-codes.service.js';
import { isCodeAssignable } from './activity-units.service.js';
import { ZERO_UUID } from './balance-engine.service.js';

// Resolve the seed version an entity reads codes from: pinned, else
// latest for the current calendar year, else the newest year available.
export async function resolveSeedVersionId(tenantId: string, companyId: string): Promise<string | null> {
  const [profile] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
    .limit(1);
  if (!profile) return null;
  if (profile.pinnedSeedVersionId) return profile.pinnedSeedVersionId;
  const year = new Date().getUTCFullYear();
  const latest = await latestVersionForYear(year) ?? await latestVersionForYear(year - 1);
  return latest?.id ?? null;
}

// The filtered code list for this company: seed rows valid for its
// return form (form-specific + form/common + common/common utility)
// plus the firm's active custom codes for the form.
export async function listAvailableCodes(tenantId: string, companyId: string) {
  const [profile] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
    .limit(1);
  if (!profile) {
    throw AppError.unprocessableEntity('Set the company tax profile (return form) first', 'TB_NOT_ASSIGNABLE');
  }
  const versionId = await resolveSeedVersionId(tenantId, companyId);
  if (!versionId) {
    throw AppError.unprocessableEntity('No tax code seed imported', 'TB_SEED_INVALID');
  }
  const seedCodes = await db.select({
    code: taxCodes.code,
    description: taxCodes.description,
    returnForm: taxCodes.returnForm,
    activityType: taxCodes.activityType,
    sortOrder: taxCodes.sortOrder,
    isM1Adjustment: taxCodes.isM1Adjustment,
  }).from(taxCodes)
    .where(and(
      eq(taxCodes.versionId, versionId),
      inArray(taxCodes.returnForm, [profile.returnForm, 'common']),
    ))
    .orderBy(taxCodes.sortOrder, taxCodes.code);

  const owner = await resolveOwner(tenantId);
  const firmConds = [eq(firmTaxCodes.isActive, true), eq(firmTaxCodes.returnForm, profile.returnForm)];
  const firmRows = await db.select().from(firmTaxCodes).where(and(...firmConds));
  const firmCodesList = firmRows.filter((c) =>
    c.firmId ? c.firmId === owner.firmId : c.tenantId === tenantId);

  return {
    returnForm: profile.returnForm,
    versionId,
    seedCodes,
    firmCodes: firmCodesList.map((c) => ({
      id: c.id,
      code: c.code,
      description: c.description,
      activityType: c.activityType,
      sortOrder: c.sortOrder,
      isM1Adjustment: c.isM1Adjustment,
    })),
  };
}

export interface SetAssignmentInput {
  accountId: string;
  activityUnitId?: string | null;
  seedCode?: string | null;
  seedActivityType?: string | null;
  firmCodeId?: string | null;
  source?: 'manual' | 'ai';
  aiConfidence?: number | null;
  effectiveTaxYear?: number | null;
  // The unit's activityType for validation context; account-level
  // assignments validate against 'common' + every unit the account
  // touches at the caller's discretion — we validate with the unit
  // type when given, else 'common'.
  activityUnitType?: string;
}

export async function setAssignment(tenantId: string, companyId: string, input: SetAssignmentInput, userId?: string) {
  const hasSeed = !!(input.seedCode && input.seedActivityType);
  const hasFirm = !!input.firmCodeId;
  if (hasSeed === hasFirm) {
    throw AppError.badRequest('Provide exactly one of seed code or firm code', 'TB_NOT_ASSIGNABLE');
  }
  const check = await isCodeAssignable(tenantId, companyId, {
    seedCode: input.seedCode ?? null,
    seedActivityType: input.seedActivityType ?? null,
    firmCodeId: input.firmCodeId ?? null,
    activityUnitType: input.activityUnitType ?? 'common',
  });
  if (!check.ok) throw AppError.unprocessableEntity(check.reason ?? 'Code not assignable', 'TB_NOT_ASSIGNABLE');

  return db.transaction(async (tx) => {
    const unitKey = input.activityUnitId ?? null;
    // NULL unit is normalized to the zero uuid in the unique index; the
    // lookup below matches in JS so the write path stays plain drizzle.
    const existing = await tx.select().from(accountTaxAssignments)
      .where(and(
        eq(accountTaxAssignments.companyId, companyId),
        eq(accountTaxAssignments.accountId, input.accountId),
      ));
    const match = existing.find((r) => (r.activityUnitId ?? null) === unitKey);
    let row;
    const values = {
      seedCode: hasSeed ? input.seedCode! : null,
      seedActivityType: hasSeed ? input.seedActivityType! : null,
      firmCodeId: hasFirm ? input.firmCodeId! : null,
      source: input.source ?? 'manual',
      aiConfidence: input.aiConfidence ?? null,
      effectiveTaxYear: input.effectiveTaxYear ?? null,
      assignedBy: userId ?? null,
      updatedAt: new Date(),
    };
    if (match) {
      [row] = await tx.update(accountTaxAssignments).set(values)
        .where(eq(accountTaxAssignments.id, match.id)).returning();
    } else {
      [row] = await tx.insert(accountTaxAssignments).values({
        tenantId, companyId,
        accountId: input.accountId,
        activityUnitId: unitKey,
        ...values,
      }).returning();
    }
    if (!row) throw AppError.internal('Assignment write failed');
    await auditLog(tenantId, match ? 'update' : 'create', 'account_tax_assignment', row.id, match ?? null, row, userId, tx);
    return row;
  });
}

export async function clearAssignment(tenantId: string, companyId: string, accountId: string, activityUnitId: string | null, userId?: string) {
  const existing = await db.select().from(accountTaxAssignments)
    .where(and(
      eq(accountTaxAssignments.tenantId, tenantId),
      eq(accountTaxAssignments.companyId, companyId),
      eq(accountTaxAssignments.accountId, accountId),
    ));
  const match = existing.find((r) => (r.activityUnitId ?? null) === (activityUnitId ?? null));
  if (!match) return;
  await db.transaction(async (tx) => {
    await tx.delete(accountTaxAssignments).where(eq(accountTaxAssignments.id, match.id));
    await auditLog(tenantId, 'delete', 'account_tax_assignment', match.id, match, null, userId, tx);
  });
}

export async function bulkAssign(tenantId: string, companyId: string, inputs: SetAssignmentInput[], userId?: string) {
  const results: Array<{ accountId: string; ok: boolean; error?: string }> = [];
  for (const input of inputs) {
    try {
      await setAssignment(tenantId, companyId, input, userId);
      results.push({ accountId: input.accountId, ok: true });
    } catch (err) {
      results.push({
        accountId: input.accountId,
        ok: false,
        error: err instanceof AppError ? err.message : 'Assignment failed',
      });
    }
  }
  return results;
}
