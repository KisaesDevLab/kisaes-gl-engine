// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm-checked loaders shared by the Phase 5 services (years, scenarios, adjustments,
// state rows). Every Phase 5 row hangs off a taxpayer, and a taxpayer is only ever
// loaded with `firm_id = scope.firmId` (404 TE_TAXPAYER_NOT_FOUND otherwise).
import { and, eq } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/index.js';
import { taxEstTaxpayers } from '../../db/schema/tax-estimator-taxpayers.js';
import { taxEstScenarios, taxEstAdjustments } from '../../db/schema/tax-estimator-years.js';
import { auditLog } from '../../middleware/audit.js';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';

export interface Actor {
  tenantId: string;
  userId: string;
}

export type TaxpayerRow = typeof taxEstTaxpayers.$inferSelect;
export type ScenarioRow = typeof taxEstScenarios.$inferSelect;
export type AdjustmentRow = typeof taxEstAdjustments.$inferSelect;

export const taxpayerNotFound = () => new AppError(404, 'Taxpayer not found', 'TE_TAXPAYER_NOT_FOUND');
export const scenarioNotFound = () => new AppError(404, 'Scenario not found', 'TE_SCENARIO_NOT_FOUND');
export const adjustmentNotFound = () => new AppError(404, 'Adjustment not found', 'TE_ADJUSTMENT_NOT_FOUND');
export const tenantNotManaged = () => new AppError(404, 'Client is not managed by your firm', 'TE_TENANT_NOT_MANAGED');

export async function loadTaxpayerForFirm(scope: FirmScope, id: string, exec: DbOrTx = db, lock = false): Promise<TaxpayerRow> {
  const q = exec.select().from(taxEstTaxpayers)
    .where(and(eq(taxEstTaxpayers.id, id), eq(taxEstTaxpayers.firmId, scope.firmId)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw taxpayerNotFound();
  return row;
}

/** Scenario + its taxpayer, firm-checked in one query. A scenario of another firm is a 404. */
export async function loadScenarioForFirm(scope: FirmScope, scenarioId: string, exec: DbOrTx = db): Promise<ScenarioRow> {
  const [row] = await exec.select({ s: taxEstScenarios }).from(taxEstScenarios)
    .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstScenarios.taxpayerId))
    .where(and(eq(taxEstScenarios.id, scenarioId), eq(taxEstTaxpayers.firmId, scope.firmId)));
  if (!row) throw scenarioNotFound();
  return row.s;
}

export async function loadAdjustmentForFirm(
  scope: FirmScope, adjustmentId: string, exec: DbOrTx = db,
): Promise<{ adjustment: AdjustmentRow; scenario: ScenarioRow }> {
  const [row] = await exec.select({ a: taxEstAdjustments, s: taxEstScenarios }).from(taxEstAdjustments)
    .innerJoin(taxEstScenarios, eq(taxEstScenarios.id, taxEstAdjustments.scenarioId))
    .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstScenarios.taxpayerId))
    .where(and(eq(taxEstAdjustments.id, adjustmentId), eq(taxEstTaxpayers.firmId, scope.firmId)));
  if (!row) throw adjustmentNotFound();
  return { adjustment: row.a, scenario: row.s };
}

/** Audit under the caller's ACTIVE tenant; the firm id rides in the after/before data. */
export async function auditYears(
  scope: FirmScope, actor: Actor, action: 'create' | 'update' | 'delete', entityType: string, entityId: string,
  before: unknown | null, after: unknown | null, exec: DbOrTx,
) {
  const tag = (v: unknown | null) => (v ? { ...(v as object), firmId: scope.firmId } : null);
  await auditLog(actor.tenantId, action, entityType, entityId, tag(before), tag(after), actor.userId, exec);
}
