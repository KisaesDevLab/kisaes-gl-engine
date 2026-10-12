// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator scenarios (Phase 5). Base is created with the year row (years.service);
// clones are FULL deep copies of the scenario's adjustments and state rows.
import { and, asc, eq, sql } from 'drizzle-orm';
import { MAX_SCENARIOS_PER_YEAR, type ScenarioDTO } from '@kis-books/shared';
import { db, type DbOrTx } from '../../db/index.js';
import { taxEstScenarios, taxEstAdjustments, taxEstStateRows, taxEstYears } from '../../db/schema/tax-estimator-years.js';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';
import { auditYears, loadScenarioForFirm, loadTaxpayerForFirm, type Actor } from './year-access.js';

type ScenarioRow = typeof taxEstScenarios.$inferSelect;

const MAX_NAME = 120;

export function toScenarioDTO(r: ScenarioRow): ScenarioDTO {
  return {
    id: r.id, taxpayerId: r.taxpayerId, taxYear: r.taxYear, name: r.name, isBase: r.isBase,
    sortOrder: r.sortOrder, sourceScenarioId: r.sourceScenarioId,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listScenarios(scope: FirmScope, taxpayerId: string, taxYear: number): Promise<ScenarioDTO[]> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  const rows = await db.select().from(taxEstScenarios)
    .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear)))
    .orderBy(asc(taxEstScenarios.sortOrder), asc(taxEstScenarios.createdAt));
  return rows.map(toScenarioDTO);
}

async function assertNameFree(exec: DbOrTx, taxpayerId: string, taxYear: number, name: string, exceptId?: string) {
  const rows = await exec.select({ id: taxEstScenarios.id }).from(taxEstScenarios).where(and(
    eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear),
    sql`lower(${taxEstScenarios.name}) = lower(${name})`,
  ));
  if (rows.some((r) => r.id !== exceptId)) {
    throw AppError.conflict('A scenario with that name already exists', 'TE_SCENARIO_NAME_TAKEN');
  }
}

async function assertCapacity(exec: DbOrTx, taxpayerId: string, taxYear: number) {
  const [yr] = await exec.select({ id: taxEstYears.id }).from(taxEstYears)
    .where(and(eq(taxEstYears.taxpayerId, taxpayerId), eq(taxEstYears.taxYear, taxYear)));
  if (!yr) throw AppError.unprocessableEntity('Save the annual settings for this year first', 'TE_YEAR_NOT_SET_UP');
  const [n] = await exec.select({ n: sql<number>`count(*)::int` }).from(taxEstScenarios)
    .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear)));
  if ((n?.n ?? 0) >= MAX_SCENARIOS_PER_YEAR) {
    throw AppError.unprocessableEntity(`At most ${MAX_SCENARIOS_PER_YEAR} scenarios per tax year`, 'TE_SCENARIO_CAP');
  }
}

async function nextSortOrder(exec: DbOrTx, taxpayerId: string, taxYear: number): Promise<number> {
  const [r] = await exec.select({ m: sql<number>`coalesce(max(${taxEstScenarios.sortOrder}), 0)::int` }).from(taxEstScenarios)
    .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear)));
  return (r?.m ?? 0) + 1;
}

export async function createScenario(
  scope: FirmScope, actor: Actor, taxpayerId: string, taxYear: number, name: string,
): Promise<ScenarioDTO> {
  return db.transaction(async (tx) => {
    await loadTaxpayerForFirm(scope, taxpayerId, tx, true);
    await assertCapacity(tx, taxpayerId, taxYear);
    await assertNameFree(tx, taxpayerId, taxYear, name);
    const [row] = await tx.insert(taxEstScenarios).values({
      taxpayerId, taxYear, name, isBase: false, sortOrder: await nextSortOrder(tx, taxpayerId, taxYear),
    }).returning();
    if (!row) throw AppError.internal('Scenario create failed');
    await auditYears(scope, actor, 'create', 'tax_est_scenario', row.id, null, toScenarioDTO(row), tx);
    return toScenarioDTO(row);
  });
}

export async function renameScenario(scope: FirmScope, actor: Actor, scenarioId: string, name: string): Promise<ScenarioDTO> {
  return db.transaction(async (tx) => {
    const before = await loadScenarioForFirm(scope, scenarioId, tx);
    // QA D21: Base keeps its name (it is the scenario the portal, packs and finalize default to).
    if (before.isBase && name !== before.name) throw AppError.unprocessableEntity('The Base scenario cannot be renamed', 'TE_BASE_SCENARIO_PROTECTED');
    await loadTaxpayerForFirm(scope, before.taxpayerId, tx, true);
    await assertNameFree(tx, before.taxpayerId, before.taxYear, name, scenarioId);
    const [row] = await tx.update(taxEstScenarios).set({ name, updatedAt: new Date() })
      .where(eq(taxEstScenarios.id, scenarioId)).returning();
    if (!row) throw AppError.internal('Scenario rename failed');
    await auditYears(scope, actor, 'update', 'tax_est_scenario', scenarioId, toScenarioDTO(before), toScenarioDTO(row), tx);
    return toScenarioDTO(row);
  });
}

export async function deleteScenario(scope: FirmScope, actor: Actor, scenarioId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await loadScenarioForFirm(scope, scenarioId, tx);
    if (before.isBase) throw AppError.unprocessableEntity('The Base scenario cannot be deleted', 'TE_BASE_SCENARIO_PROTECTED');
    await tx.delete(taxEstScenarios).where(eq(taxEstScenarios.id, scenarioId)); // children cascade
    await auditYears(scope, actor, 'delete', 'tax_est_scenario', scenarioId, toScenarioDTO(before), null, tx);
  });
}

/** Deep copy: every adjustment and state row of the source is duplicated under the new scenario. */
export async function cloneScenario(scope: FirmScope, actor: Actor, scenarioId: string, requestedName?: string): Promise<ScenarioDTO> {
  return db.transaction(async (tx) => {
    const source = await loadScenarioForFirm(scope, scenarioId, tx);
    await loadTaxpayerForFirm(scope, source.taxpayerId, tx, true);
    await assertCapacity(tx, source.taxpayerId, source.taxYear);
    // QA D21: the caller names the copy; without a name it is "Copy of …" (numbered when taken).
    if (requestedName) await assertNameFree(tx, source.taxpayerId, source.taxYear, requestedName);
    let name = requestedName ?? `Copy of ${source.name}`.slice(0, MAX_NAME);
    for (let i = 2; !requestedName; i++) {
      try { await assertNameFree(tx, source.taxpayerId, source.taxYear, name); break; }
      catch (e) {
        if (i > MAX_SCENARIOS_PER_YEAR + 1) throw e;
        name = `Copy of ${source.name}`.slice(0, MAX_NAME - 6) + ` (${i})`;
      }
    }
    const [row] = await tx.insert(taxEstScenarios).values({
      taxpayerId: source.taxpayerId, taxYear: source.taxYear, name, isBase: false,
      sortOrder: await nextSortOrder(tx, source.taxpayerId, source.taxYear), sourceScenarioId: source.id,
    }).returning();
    if (!row) throw AppError.internal('Scenario clone failed');

    const adjustments = await tx.select().from(taxEstAdjustments).where(eq(taxEstAdjustments.scenarioId, source.id));
    if (adjustments.length) {
      await tx.insert(taxEstAdjustments).values(adjustments.map(({ id: _id, createdAt: _c, updatedAt: _u, ...a }) => ({ ...a, scenarioId: row.id })));
    }
    const states = await tx.select().from(taxEstStateRows).where(eq(taxEstStateRows.scenarioId, source.id));
    if (states.length) {
      await tx.insert(taxEstStateRows).values(states.map(({ id: _id, createdAt: _c, updatedAt: _u, ...s }) => ({ ...s, scenarioId: row.id })));
    }
    await auditYears(scope, actor, 'create', 'tax_est_scenario', row.id, null,
      { ...toScenarioDTO(row), clonedFrom: source.id, adjustments: adjustments.length, stateRows: states.length }, tx);
    return toScenarioDTO(row);
  });
}
