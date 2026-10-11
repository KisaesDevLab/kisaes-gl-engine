// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Adjustment-type catalog (Phase 5): shipped rows (firm_id NULL, read-only) plus the
// caller's firm custom rows. Another firm's custom rows are invisible (404).
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { AdjustmentTypeDTO, AdjustmentKind, CreateAdjustmentTypeInput, UpdateAdjustmentTypeInput } from '@kis-books/shared';
import { db, type DbOrTx } from '../../db/index.js';
import { taxEstAdjustmentTypes, taxEstAdjustments } from '../../db/schema/tax-estimator-years.js';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';
import { auditYears, type Actor } from './year-access.js';

type Row = typeof taxEstAdjustmentTypes.$inferSelect;

export function toTypeDTO(r: Row): AdjustmentTypeDTO {
  return {
    id: r.id, firmId: r.firmId, code: r.code, name: r.name, kind: r.kind as AdjustmentKind,
    affectsSe: r.affectsSe, affectsQbi: r.affectsQbi, isCapitalGainLt: r.isCapitalGainLt,
    isCapitalGainSt: r.isCapitalGainSt, isQualifiedDividend: r.isQualifiedDividend,
    isReitDividend: r.isReitDividend, isPtp: r.isPtp, is1231: r.is1231, isAboveTheLine: r.isAboveTheLine,
    nonRecurring: r.nonRecurring, defaultPct: r.defaultPct == null ? null : Number(r.defaultPct),
    isActive: r.isActive, isShipped: r.firmId == null,
  };
}

const notFound = () => new AppError(404, 'Adjustment type not found', 'TE_ADJUSTMENT_TYPE_NOT_FOUND');

/** A type the caller's firm may use: shipped or its own. */
export async function loadVisibleType(scope: FirmScope, id: string, exec: DbOrTx = db): Promise<Row> {
  const [row] = await exec.select().from(taxEstAdjustmentTypes).where(and(
    eq(taxEstAdjustmentTypes.id, id),
    or(isNull(taxEstAdjustmentTypes.firmId), eq(taxEstAdjustmentTypes.firmId, scope.firmId)),
  ));
  if (!row) throw notFound();
  return row;
}

export async function listAdjustmentTypes(scope: FirmScope, includeInactive = false): Promise<AdjustmentTypeDTO[]> {
  const conds = [or(isNull(taxEstAdjustmentTypes.firmId), eq(taxEstAdjustmentTypes.firmId, scope.firmId))!];
  if (!includeInactive) conds.push(eq(taxEstAdjustmentTypes.isActive, true));
  const rows = await db.select().from(taxEstAdjustmentTypes).where(and(...conds))
    .orderBy(sql`${taxEstAdjustmentTypes.firmId} IS NOT NULL`, asc(taxEstAdjustmentTypes.name));
  return rows.map(toTypeDTO);
}

async function assertNameFree(scope: FirmScope, name: string, exceptId?: string) {
  const rows = await db.select({ id: taxEstAdjustmentTypes.id }).from(taxEstAdjustmentTypes).where(and(
    or(isNull(taxEstAdjustmentTypes.firmId), eq(taxEstAdjustmentTypes.firmId, scope.firmId)),
    sql`lower(${taxEstAdjustmentTypes.name}) = lower(${name})`,
  ));
  if (rows.some((r) => r.id !== exceptId)) {
    throw AppError.conflict('An adjustment type with that name already exists', 'TE_ADJUSTMENT_TYPE_NAME_TAKEN');
  }
}

async function loadOwn(scope: FirmScope, id: string, exec: DbOrTx = db): Promise<Row> {
  const row = await loadVisibleType(scope, id, exec);
  if (row.firmId == null) throw AppError.forbidden('Shipped adjustment types are read-only', 'TE_ADJUSTMENT_TYPE_READONLY');
  return row;
}

export async function createAdjustmentType(scope: FirmScope, actor: Actor, input: CreateAdjustmentTypeInput): Promise<AdjustmentTypeDTO> {
  await assertNameFree(scope, input.name);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(taxEstAdjustmentTypes).values({
      firmId: scope.firmId, name: input.name, kind: input.kind, affectsSe: input.affectsSe, affectsQbi: input.affectsQbi,
      isCapitalGainLt: input.isCapitalGainLt, isCapitalGainSt: input.isCapitalGainSt,
      isQualifiedDividend: input.isQualifiedDividend, isReitDividend: input.isReitDividend, isPtp: input.isPtp,
      is1231: input.is1231, isAboveTheLine: input.isAboveTheLine, nonRecurring: input.nonRecurring,
      defaultPct: input.defaultPct == null ? null : String(input.defaultPct), isActive: input.isActive,
    }).returning();
    if (!row) throw AppError.internal('Adjustment type create failed');
    await auditYears(scope, actor, 'create', 'tax_est_adjustment_type', row.id, null, toTypeDTO(row), tx);
    return toTypeDTO(row);
  });
}

export async function updateAdjustmentType(
  scope: FirmScope, actor: Actor, id: string, input: UpdateAdjustmentTypeInput,
): Promise<AdjustmentTypeDTO> {
  const before = await loadOwn(scope, id);
  if (input.name !== undefined) await assertNameFree(scope, input.name, id);
  return db.transaction(async (tx) => {
    const { defaultPct, ...rest } = input;
    const [row] = await tx.update(taxEstAdjustmentTypes).set({
      ...rest,
      ...(defaultPct !== undefined ? { defaultPct: defaultPct == null ? null : String(defaultPct) } : {}),
      updatedAt: new Date(),
    }).where(and(eq(taxEstAdjustmentTypes.id, id), eq(taxEstAdjustmentTypes.firmId, scope.firmId))).returning();
    if (!row) throw notFound();
    await auditYears(scope, actor, 'update', 'tax_est_adjustment_type', id, toTypeDTO(before), toTypeDTO(row), tx);
    return toTypeDTO(row);
  });
}

export async function deleteAdjustmentType(scope: FirmScope, actor: Actor, id: string): Promise<void> {
  const before = await loadOwn(scope, id);
  await db.transaction(async (tx) => {
    const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(taxEstAdjustments)
      .where(eq(taxEstAdjustments.adjustmentTypeId, id));
    if ((used?.n ?? 0) > 0) {
      throw AppError.conflict('This type is used by adjustments; deactivate it instead', 'TE_ADJUSTMENT_TYPE_IN_USE');
    }
    await tx.delete(taxEstAdjustmentTypes).where(and(eq(taxEstAdjustmentTypes.id, id), eq(taxEstAdjustmentTypes.firmId, scope.firmId)));
    await auditYears(scope, actor, 'delete', 'tax_est_adjustment_type', id, toTypeDTO(before), null, tx);
  });
}
