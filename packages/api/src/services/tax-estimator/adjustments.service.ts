// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator adjustments (Phase 5). Rows hang off a scenario, which hangs off a
// firm taxpayer; every access is firm-checked (404 for another firm's rows). An
// adjustment linked to a GL account carries (tenant_id, company_id, account_id) and
// the tenant is validated against the SERVER-resolved scope (404 TE_TENANT_NOT_MANAGED).
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  allocateAdjustment, createAdjustmentSchema, adjustmentLinkRule, ADJUSTMENT_LINK_REQUIRED_MESSAGE, ADJUSTMENT_LINK_NOT_ALLOWED_MESSAGE,
  type AdjustmentKind,
  type AdjustmentDTO, type AdjustmentListDTO, type CreateAdjustmentInput, type UpdateAdjustmentInput, type AdjustmentCadenceDTO,
} from '@kis-books/shared';
import { db, type DbOrTx } from '../../db/index.js';
import { taxEstAdjustments, taxEstAdjustmentTypes } from '../../db/schema/tax-estimator-years.js';
import { taxEstPersons, taxEstLinks } from '../../db/schema/tax-estimator-taxpayers.js';
import { companies } from '../../db/schema/company.js';
import { accounts } from '../../db/schema/accounts.js';
import { AppError } from '../../utils/errors.js';
import { baseScope, isTenantInScope, type FirmScope } from './firm-scope.service.js';
import { loadVisibleType } from './adjustment-types.service.js';
import {
  auditYears, loadAdjustmentForFirm, loadScenarioForFirm, tenantNotManaged, type Actor, type AdjustmentRow, type ScenarioRow,
} from './year-access.js';

const MAX_PER_SCENARIO = 500;

function toDTO(r: AdjustmentRow, typeName: string, taxYear: number): AdjustmentDTO {
  return {
    id: r.id, scenarioId: r.scenarioId, adjustmentTypeId: r.adjustmentTypeId, adjustmentTypeName: typeName,
    personId: r.personId, linkId: r.linkId, label: r.label, amount: r.amount,
    pct: r.pct == null ? null : Number(r.pct), cadence: r.cadence as AdjustmentCadenceDTO,
    startMonth: r.startMonth, endMonth: r.endMonth, glLinked: r.glLinked, tenantId: r.tenantId,
    companyId: r.companyId, accountId: r.accountId, nonRecurring: r.nonRecurring, memo: r.memo,
    monthly: allocateAdjustment({
      amount: r.amount, cadence: r.cadence as AdjustmentCadenceDTO, startMonth: r.startMonth, endMonth: r.endMonth,
    }, taxYear),
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

async function typeName(exec: DbOrTx, id: string): Promise<string> {
  const [t] = await exec.select({ name: taxEstAdjustmentTypes.name }).from(taxEstAdjustmentTypes).where(eq(taxEstAdjustmentTypes.id, id));
  return t?.name ?? '';
}

export async function listAdjustments(
  scope: FirmScope, scenarioId: string, page: { limit: number; offset: number },
): Promise<AdjustmentListDTO> {
  const scenario = await loadScenarioForFirm(scope, scenarioId);
  const where = eq(taxEstAdjustments.scenarioId, scenarioId);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(taxEstAdjustments).where(where);
  const rows = await db.select({ a: taxEstAdjustments, t: taxEstAdjustmentTypes.name }).from(taxEstAdjustments)
    .innerJoin(taxEstAdjustmentTypes, eq(taxEstAdjustmentTypes.id, taxEstAdjustments.adjustmentTypeId))
    .where(where).orderBy(asc(taxEstAdjustments.createdAt), asc(taxEstAdjustments.id)).limit(page.limit).offset(page.offset);
  return {
    data: rows.map((r) => toDTO(r.a, r.t, scenario.taxYear)), total: count?.n ?? 0, limit: page.limit, offset: page.offset,
  };
}

/** Person and link must belong to the scenario's taxpayer (and the link to the scenario's year). */
async function assertOwnedRefs(exec: DbOrTx, scenario: ScenarioRow, personId: string | null | undefined, linkId: string | null | undefined) {
  if (personId) {
    const [p] = await exec.select({ id: taxEstPersons.id }).from(taxEstPersons)
      .where(and(eq(taxEstPersons.id, personId), eq(taxEstPersons.taxpayerId, scenario.taxpayerId)));
    if (!p) throw AppError.unprocessableEntity('Person does not belong to this taxpayer', 'TE_ADJUSTMENT_PERSON_INVALID');
  }
  if (linkId) {
    const [l] = await exec.select({ id: taxEstLinks.id }).from(taxEstLinks).where(and(
      eq(taxEstLinks.id, linkId), eq(taxEstLinks.taxpayerId, scenario.taxpayerId), eq(taxEstLinks.taxYear, scenario.taxYear)));
    if (!l) throw AppError.unprocessableEntity('Entity link does not belong to this taxpayer and year', 'TE_ADJUSTMENT_LINK_INVALID');
  }
}

/** GL link: tenant in the server-resolved scope, then company and account inside that tenant. */
async function assertGlLink(scope: FirmScope, exec: DbOrTx, tenantId: string, companyId: string, accountId: string) {
  // D18: a GL reference reads raw books — the caller's OWN reach, never a staff-list widening.
  if (!isTenantInScope(baseScope(scope), tenantId)) throw tenantNotManaged();
  const [c] = await exec.select({ id: companies.id }).from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)));
  if (!c) throw new AppError(404, 'Company not found', 'TE_COMPANY_NOT_FOUND');
  const [a] = await exec.select({ id: accounts.id, companyId: accounts.companyId }).from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.tenantId, tenantId)));
  if (!a || (a.companyId != null && a.companyId !== companyId)) {
    throw new AppError(404, 'Account not found', 'TE_ACCOUNT_NOT_FOUND');
  }
}

type Merged = CreateAdjustmentInput;

function normalise(m: Merged): Merged {
  // A one-time adjustment occupies exactly one month.
  return m.cadence === 'one_time' ? { ...m, endMonth: m.startMonth } : m;
}

function toValues(m: Merged) {
  return {
    adjustmentTypeId: m.adjustmentTypeId, personId: m.personId ?? null, linkId: m.linkId ?? null, label: m.label,
    amount: m.amount, pct: m.pct == null ? null : String(m.pct), cadence: m.cadence, startMonth: m.startMonth,
    endMonth: m.endMonth, glLinked: m.glLinked, tenantId: m.glLinked ? (m.tenantId ?? null) : null,
    companyId: m.glLinked ? (m.companyId ?? null) : null, accountId: m.glLinked ? (m.accountId ?? null) : null,
    nonRecurring: m.nonRecurring, memo: m.memo ?? null,
  };
}

async function validate(scope: FirmScope, exec: DbOrTx, scenario: ScenarioRow, m: Merged, checkTypeActive: boolean) {
  const t = await loadVisibleType(scope, m.adjustmentTypeId, exec);
  if (checkTypeActive && !t.isActive) throw AppError.unprocessableEntity('Adjustment type is inactive', 'TE_ADJUSTMENT_TYPE_INACTIVE');
  // QA D1: a business deduction (§179 vehicle, tax-vs-book depreciation, a firm type that affects
  // SE/QBI) must name the entity link it belongs to; a person-level owner deduction must not.
  const rule = adjustmentLinkRule({
    code: t.code, kind: t.kind as AdjustmentKind, affectsSe: t.affectsSe, affectsQbi: t.affectsQbi, isAboveTheLine: t.isAboveTheLine,
  });
  if (rule === 'required' && !m.linkId) throw AppError.unprocessableEntity(ADJUSTMENT_LINK_REQUIRED_MESSAGE, 'TE_ADJUSTMENT_LINK_REQUIRED');
  if (rule === 'not_allowed' && m.linkId) throw AppError.unprocessableEntity(ADJUSTMENT_LINK_NOT_ALLOWED_MESSAGE, 'TE_ADJUSTMENT_LINK_NOT_ALLOWED');
  await assertOwnedRefs(exec, scenario, m.personId, m.linkId);
  if (m.glLinked) await assertGlLink(scope, exec, m.tenantId!, m.companyId!, m.accountId!);
}

export async function createAdjustment(
  scope: FirmScope, actor: Actor, scenarioId: string, input: CreateAdjustmentInput,
): Promise<AdjustmentDTO> {
  return db.transaction(async (tx) => {
    const scenario = await loadScenarioForFirm(scope, scenarioId, tx);
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(taxEstAdjustments).where(eq(taxEstAdjustments.scenarioId, scenarioId));
    if ((count?.n ?? 0) >= MAX_PER_SCENARIO) throw AppError.unprocessableEntity('Too many adjustments in this scenario', 'TE_ADJUSTMENT_CAP');
    const m = normalise(input);
    await validate(scope, tx, scenario, m, true);
    const [row] = await tx.insert(taxEstAdjustments).values({ scenarioId, ...toValues(m) }).returning();
    if (!row) throw AppError.internal('Adjustment create failed');
    const dto = toDTO(row, await typeName(tx, row.adjustmentTypeId), scenario.taxYear);
    await auditYears(scope, actor, 'create', 'tax_est_adjustment', row.id, null, dto, tx);
    return dto;
  });
}

export async function updateAdjustment(
  scope: FirmScope, actor: Actor, adjustmentId: string, input: UpdateAdjustmentInput,
): Promise<AdjustmentDTO> {
  return db.transaction(async (tx) => {
    const { adjustment, scenario } = await loadAdjustmentForFirm(scope, adjustmentId, tx);
    // Merge the patch over the stored row, then validate the WHOLE row as a create would be.
    const merged = createAdjustmentSchema.safeParse(normalise({
      adjustmentTypeId: input.adjustmentTypeId ?? adjustment.adjustmentTypeId,
      personId: input.personId !== undefined ? input.personId : adjustment.personId,
      linkId: input.linkId !== undefined ? input.linkId : adjustment.linkId,
      label: input.label ?? adjustment.label,
      amount: input.amount !== undefined ? input.amount : adjustment.amount,
      pct: input.pct !== undefined ? input.pct : (adjustment.pct == null ? null : Number(adjustment.pct)),
      cadence: input.cadence ?? (adjustment.cadence as AdjustmentCadenceDTO),
      startMonth: input.startMonth ?? adjustment.startMonth,
      endMonth: input.endMonth ?? adjustment.endMonth,
      glLinked: input.glLinked ?? adjustment.glLinked,
      tenantId: input.tenantId !== undefined ? input.tenantId : adjustment.tenantId,
      companyId: input.companyId !== undefined ? input.companyId : adjustment.companyId,
      accountId: input.accountId !== undefined ? input.accountId : adjustment.accountId,
      nonRecurring: input.nonRecurring ?? adjustment.nonRecurring,
      memo: input.memo !== undefined ? input.memo : adjustment.memo,
    } as Merged));
    if (!merged.success) {
      throw AppError.unprocessableEntity(merged.error.issues[0]?.message ?? 'Invalid adjustment', 'TE_ADJUSTMENT_INVALID');
    }
    const m = merged.data;
    await validate(scope, tx, scenario, m, input.adjustmentTypeId !== undefined);
    const [row] = await tx.update(taxEstAdjustments).set({ ...toValues(m), updatedAt: new Date() })
      .where(eq(taxEstAdjustments.id, adjustmentId)).returning();
    if (!row) throw AppError.internal('Adjustment update failed');
    const before = toDTO(adjustment, await typeName(tx, adjustment.adjustmentTypeId), scenario.taxYear);
    const dto = toDTO(row, await typeName(tx, row.adjustmentTypeId), scenario.taxYear);
    await auditYears(scope, actor, 'update', 'tax_est_adjustment', adjustmentId, before, dto, tx);
    return dto;
  });
}

export async function deleteAdjustment(scope: FirmScope, actor: Actor, adjustmentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const { adjustment, scenario } = await loadAdjustmentForFirm(scope, adjustmentId, tx);
    await tx.delete(taxEstAdjustments).where(eq(taxEstAdjustments.id, adjustmentId));
    await auditYears(scope, actor, 'delete', 'tax_est_adjustment', adjustmentId,
      toDTO(adjustment, await typeName(tx, adjustment.adjustmentTypeId), scenario.taxYear), null, tx);
  });
}
