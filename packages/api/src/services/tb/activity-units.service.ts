// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Activity units + tag→unit mapping (Phase 3, ADR-TB-02, D3/D13).
// A unit = one activity schedule instance on the return (Sch C #1,
// Rental #2, …). Tags map one-to-one onto units; a line whose tag is
// unmapped (or absent) falls to the company's single default unit.

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accountTaxAssignments, activityUnits, companyTaxProfiles, firmTaxCodes,
  tagActivityMap, tags, taxCodes, tbTaxEntryLines,
} from '../../db/schema/index.js';
import type { z } from 'zod';
import { createActivityUnitSchema } from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { latestVersionForYear } from './tax-code-seed.service.js';
import { resolveOwner } from './firm-tax-codes.service.js';

type CreateUnitInput = z.infer<typeof createActivityUnitSchema>;

export async function listUnits(tenantId: string, companyId: string, includeArchived = false) {
  const conds = [eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)];
  if (!includeArchived) conds.push(isNull(activityUnits.archivedAt));
  return db.select().from(activityUnits).where(and(...conds))
    .orderBy(asc(activityUnits.activityType), asc(activityUnits.instanceNumber));
}

export async function getDefaultUnit(tenantId: string, companyId: string) {
  const [unit] = await db.select().from(activityUnits)
    .where(and(
      eq(activityUnits.tenantId, tenantId),
      eq(activityUnits.companyId, companyId),
      eq(activityUnits.isDefault, true),
      isNull(activityUnits.archivedAt),
    )).limit(1);
  return unit ?? null;
}

export async function createUnit(tenantId: string, companyId: string, input: CreateUnitInput, userId?: string) {
  return db.transaction(async (tx) => {
    let instanceNumber = input.instanceNumber;
    if (!instanceNumber) {
      const [max] = await tx.select({ n: sql<number>`COALESCE(MAX(${activityUnits.instanceNumber}), 0)::int` })
        .from(activityUnits)
        .where(and(
          eq(activityUnits.companyId, companyId),
          eq(activityUnits.activityType, input.activityType),
          isNull(activityUnits.archivedAt),
        ));
      instanceNumber = (max?.n ?? 0) + 1;
    }
    // First live unit for the company becomes the default (exactly-one-
    // default invariant: the partial unique index enforces "at most one";
    // this keeps "at least one" true from the first unit on).
    const [existing] = await tx.select({ id: activityUnits.id }).from(activityUnits)
      .where(and(
        eq(activityUnits.companyId, companyId),
        isNull(activityUnits.archivedAt),
      )).limit(1);
    const [unit] = await tx.insert(activityUnits).values({
      tenantId,
      companyId,
      activityType: input.activityType,
      instanceNumber,
      displayName: input.displayName,
      isDefault: !existing,
    }).returning();
    if (!unit) throw AppError.internal('Activity unit insert failed');
    await auditLog(tenantId, 'create', 'activity_unit', unit.id, null, unit, userId, tx);
    return unit;
  });
}

export async function renameUnit(tenantId: string, companyId: string, unitId: string, displayName: string, userId?: string, instanceNumber?: number) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(activityUnits)
      .where(and(eq(activityUnits.id, unitId), eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)))
      .limit(1);
    if (!before) throw AppError.notFound('Activity unit not found');
    if (instanceNumber !== undefined && instanceNumber !== before.instanceNumber) {
      const [clash] = await tx.select({ id: activityUnits.id }).from(activityUnits)
        .where(and(
          eq(activityUnits.companyId, companyId),
          eq(activityUnits.activityType, before.activityType),
          eq(activityUnits.instanceNumber, instanceNumber),
          isNull(activityUnits.archivedAt),
        )).limit(1);
      if (clash) {
        throw AppError.conflict(`Unit number ${instanceNumber} is already used by another ${before.activityType} unit`, 'TB_UNIT_IN_USE');
      }
    }
    const [unit] = await tx.update(activityUnits)
      .set({ displayName, ...(instanceNumber !== undefined ? { instanceNumber } : {}) })
      .where(eq(activityUnits.id, unitId)).returning();
    if (!unit) throw AppError.internal('Activity unit update failed');
    await auditLog(tenantId, 'update', 'activity_unit', unitId, before, unit, userId, tx);
    return unit;
  });
}

export async function setDefaultUnit(tenantId: string, companyId: string, unitId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(activityUnits)
      .where(and(eq(activityUnits.id, unitId), eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)))
      .limit(1);
    if (!target) throw AppError.notFound('Activity unit not found');
    if (target.archivedAt) throw AppError.badRequest('An archived unit cannot be the default', 'TB_UNIT_IN_USE');
    // Clear-then-set inside one tx so the partial unique index never
    // sees two defaults.
    await tx.update(activityUnits).set({ isDefault: false })
      .where(and(eq(activityUnits.companyId, companyId), eq(activityUnits.isDefault, true)));
    const [unit] = await tx.update(activityUnits).set({ isDefault: true })
      .where(eq(activityUnits.id, unitId)).returning();
    await auditLog(tenantId, 'update', 'activity_unit', unitId, target, unit ?? null, userId, tx);
    return unit;
  });
}

// Delete degrades to soft-archive when the unit has history (mapped
// tags, assignments, or tax-entry lines) — plan 3.2. The default unit
// can never be removed while other units exist.
export async function archiveUnit(tenantId: string, companyId: string, unitId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const [unit] = await tx.select().from(activityUnits)
      .where(and(eq(activityUnits.id, unitId), eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)))
      .limit(1);
    if (!unit) throw AppError.notFound('Activity unit not found');
    if (unit.archivedAt) return { unit, mode: 'archived' as const };
    if (unit.isDefault) {
      const [other] = await tx.select({ id: activityUnits.id }).from(activityUnits)
        .where(and(
          eq(activityUnits.companyId, companyId),
          isNull(activityUnits.archivedAt),
          sql`${activityUnits.id} <> ${unitId}`,
        )).limit(1);
      if (other) {
        throw AppError.conflict('Set another unit as default before removing this one', 'TB_UNIT_IN_USE');
      }
    }
    const [mapped] = await tx.select({ id: tagActivityMap.id }).from(tagActivityMap)
      .where(eq(tagActivityMap.activityUnitId, unitId)).limit(1);
    const [assigned] = await tx.select({ id: accountTaxAssignments.id }).from(accountTaxAssignments)
      .where(eq(accountTaxAssignments.activityUnitId, unitId)).limit(1);
    const [taxLine] = await tx.select({ id: tbTaxEntryLines.id }).from(tbTaxEntryLines)
      .where(eq(tbTaxEntryLines.activityUnitId, unitId)).limit(1);
    const hasHistory = !!(mapped || assigned || taxLine);
    let mode: 'archived' | 'deleted';
    let after;
    if (hasHistory) {
      [after] = await tx.update(activityUnits)
        .set({ archivedAt: new Date(), isDefault: false })
        .where(eq(activityUnits.id, unitId)).returning();
      mode = 'archived';
    } else {
      await tx.delete(activityUnits).where(eq(activityUnits.id, unitId));
      after = null;
      mode = 'deleted';
    }
    await auditLog(tenantId, mode === 'deleted' ? 'delete' : 'update', 'activity_unit', unitId, unit, after ?? null, userId, tx);
    return { unit: after ?? unit, mode };
  });
}

// ── Tag → unit mapping (3.3) ────────────────────────────────────────

// Entity tags with usage counts (line-level, D13) and their current
// unit mapping. Unmapped tags visibly flow to the default unit.
export async function listTagMappings(tenantId: string, companyId: string) {
  const tagRows = await db.select({
    id: tags.id,
    name: tags.name,
    color: tags.color,
    isActive: tags.isActive,
    groupId: tags.groupId,
    lineUsage: sql<number>`(
      SELECT COUNT(*)::int FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.tag_id = "tags"."id"
        AND t.tenant_id = ${tenantId}
        AND (t.company_id = ${companyId} OR t.company_id IS NULL)
        AND t.status <> 'void'
    )`,
  }).from(tags)
    .where(and(
      eq(tags.tenantId, tenantId),
      sql`(${tags.companyId} = ${companyId} OR ${tags.companyId} IS NULL)`,
      eq(tags.isActive, true),
    ))
    .orderBy(asc(tags.name));

  const mappings = await db.select().from(tagActivityMap)
    .where(and(eq(tagActivityMap.tenantId, tenantId), eq(tagActivityMap.companyId, companyId)));
  const byTag = new Map(mappings.map((m) => [m.tagId, m]));
  const defaultUnit = await getDefaultUnit(tenantId, companyId);
  return {
    tags: tagRows.map((t) => ({
      ...t,
      activityUnitId: byTag.get(t.id)?.activityUnitId ?? null,
    })),
    defaultUnitId: defaultUnit?.id ?? null,
  };
}

export async function mapTag(tenantId: string, companyId: string, tagId: string, activityUnitId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const [tag] = await tx.select({ id: tags.id }).from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.tenantId, tenantId))).limit(1);
    if (!tag) throw AppError.notFound('Tag not found');
    const [unit] = await tx.select().from(activityUnits)
      .where(and(eq(activityUnits.id, activityUnitId), eq(activityUnits.companyId, companyId), isNull(activityUnits.archivedAt)))
      .limit(1);
    if (!unit) throw AppError.badRequest('Activity unit not found or archived', 'TB_UNIT_IN_USE');
    const [before] = await tx.select().from(tagActivityMap)
      .where(and(eq(tagActivityMap.companyId, companyId), eq(tagActivityMap.tagId, tagId))).limit(1);
    let row;
    if (before) {
      [row] = await tx.update(tagActivityMap).set({ activityUnitId })
        .where(eq(tagActivityMap.id, before.id)).returning();
    } else {
      [row] = await tx.insert(tagActivityMap).values({ tenantId, companyId, tagId, activityUnitId }).returning();
    }
    await auditLog(tenantId, before ? 'update' : 'create', 'tag_activity_map', row?.id ?? tagId, before ?? null, row ?? null, userId, tx);
    return row;
  });
}

export async function unmapTag(tenantId: string, companyId: string, tagId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(tagActivityMap)
      .where(and(eq(tagActivityMap.companyId, companyId), eq(tagActivityMap.tagId, tagId), eq(tagActivityMap.tenantId, tenantId)))
      .limit(1);
    if (!before) return;
    await tx.delete(tagActivityMap).where(eq(tagActivityMap.id, before.id));
    await auditLog(tenantId, 'delete', 'tag_activity_map', before.id, before, null, userId, tx);
  });
}

// ── Code assignability (3.4, ADR-TB-02 seed-validity rules) ─────────

export interface AssignabilityQuery {
  seedCode?: string | null;
  seedActivityType?: string | null;
  firmCodeId?: string | null;
  // The specific unit's activityType, or 'common' for an ACCOUNT-LEVEL
  // assignment (no unit) — account-level accepts any activity the
  // entity actually runs (ADR-TB-02 defines validity per unit; the
  // account-level row serves whichever units the account touches).
  activityUnitType: string;
}

// Activity types a code may carry for the given context: 'common'
// always; a specific unit type when targeting that unit; for
// account-level, every LIVE unit type — and when no units are
// configured yet (fresh entity), any type for the form, so the module
// is usable before activity setup.
async function allowedActivityTypes(companyId: string, activityUnitType: string): Promise<Set<string> | null> {
  if (activityUnitType && activityUnitType !== 'common') {
    return new Set(['common', activityUnitType]);
  }
  const units = await db.select({ t: activityUnits.activityType }).from(activityUnits)
    .where(and(eq(activityUnits.companyId, companyId), isNull(activityUnits.archivedAt)));
  if (units.length === 0) return null; // no units yet → any activity type
  // The profile's entity activity is always assignable account-level —
  // a business-default entity with only a rental unit must still take
  // business codes (the picker surface offers them).
  const [profile] = await db.select({ t: companyTaxProfiles.defaultActivityType }).from(companyTaxProfiles)
    .where(eq(companyTaxProfiles.companyId, companyId)).limit(1);
  return new Set(['common', ...(profile?.t ? [profile.t] : []), ...units.map((u) => u.t)]);
}

// A code is assignable iff the pinned (or latest) seed version contains
// a row for (returnForm, allowedActivity, code) or (returnForm,
// 'common', code) or the common/common utility codes — and firm codes
// must match form + activity the same way.
export async function isCodeAssignable(tenantId: string, companyId: string, q: AssignabilityQuery): Promise<{ ok: boolean; reason?: string }> {
  const [profile] = await db.select().from(companyTaxProfiles)
    .where(and(eq(companyTaxProfiles.tenantId, tenantId), eq(companyTaxProfiles.companyId, companyId)))
    .limit(1);
  if (!profile) return { ok: false, reason: 'Set the company tax profile (return form) first' };
  const allowed = await allowedActivityTypes(companyId, q.activityUnitType);

  if (q.firmCodeId) {
    const owner = await resolveOwner(tenantId);
    const conds = [eq(firmTaxCodes.id, q.firmCodeId), eq(firmTaxCodes.isActive, true)];
    const [code] = await db.select().from(firmTaxCodes).where(and(...conds)).limit(1);
    if (!code) return { ok: false, reason: 'Unknown or inactive custom code' };
    if (code.firmId ? code.firmId !== owner.firmId : code.tenantId !== tenantId) {
      return { ok: false, reason: 'Custom code belongs to another firm' };
    }
    if (code.returnForm !== profile.returnForm) return { ok: false, reason: `Code is for form ${code.returnForm}` };
    if (allowed && !allowed.has(code.activityType)) {
      return { ok: false, reason: `Code is for ${code.activityType} activities` };
    }
    return { ok: true };
  }

  if (!q.seedCode || !q.seedActivityType) return { ok: false, reason: 'No code reference given' };
  let versionId = profile.pinnedSeedVersionId;
  if (!versionId) {
    const today = new Date().toISOString().slice(0, 10);
    // Latest version for the current tax year, else the latest year available.
    const currentYear = Number(today.slice(0, 4));
    const latest = await latestVersionForYear(currentYear) ?? await latestVersionForYear(currentYear - 1);
    versionId = latest?.id ?? null;
  }
  if (!versionId) return { ok: false, reason: 'No tax code seed imported' };

  const candidates = await db.select().from(taxCodes)
    .where(and(
      eq(taxCodes.versionId, versionId),
      eq(taxCodes.code, q.seedCode),
      eq(taxCodes.activityType, q.seedActivityType),
      inArray(taxCodes.returnForm, [profile.returnForm, 'common']),
    ));
  const match = candidates.find((c) =>
    // utility codes: common/common rows work for any unit
    (c.returnForm === 'common' && c.activityType === 'common') ||
    // form match with an allowed activity (specific unit, the entity's
    // live unit types for account-level, or anything pre-unit-setup)
    (c.returnForm === profile.returnForm && (allowed === null || allowed.has(c.activityType))),
  );
  if (!match) return { ok: false, reason: `Code ${q.seedCode} is not valid for form ${profile.returnForm} / ${q.activityUnitType === 'common' ? 'this entity’s' : q.activityUnitType} activities` };
  return { ok: true };
}
