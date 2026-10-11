// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator state rows (Phase 5): exactly ONE resident row per scenario plus any
// number of nonresident rows (flat effective-rate estimate). PUT replaces the set
// atomically. `sourced_manual = false` on a nonresident row means "derive sourced
// income later" (engine phase: entity state x share); the value is left NULL here.
import { asc, eq } from 'drizzle-orm';
import type { StateRowDTO, StateRowInput, ReplaceStateRowsInput, StateResidency, StateBase } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxEstStateRows } from '../../db/schema/tax-estimator-years.js';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';
import { auditYears, loadScenarioForFirm, loadTaxpayerForFirm, type Actor } from './year-access.js';

type Row = typeof taxEstStateRows.$inferSelect;

function toDTO(r: Row): StateRowDTO {
  return {
    id: r.id, scenarioId: r.scenarioId, residency: r.residency as StateResidency, state: r.state.trim(),
    effectiveRate: Number(r.effectiveRate), base: r.base as StateBase, customBase: r.customBase,
    sourcedIncome: r.sourcedIncome, sourcedManual: r.sourcedManual, creditOverride: r.creditOverride, memo: r.memo,
  };
}

export async function listStateRows(scope: FirmScope, scenarioId: string): Promise<StateRowDTO[]> {
  await loadScenarioForFirm(scope, scenarioId);
  const rows = await db.select().from(taxEstStateRows).where(eq(taxEstStateRows.scenarioId, scenarioId))
    .orderBy(asc(taxEstStateRows.residency), asc(taxEstStateRows.state)); // 'nonresident' < 'resident'
  return rows.map(toDTO).sort((a, b) => (a.residency === b.residency ? a.state.localeCompare(b.state) : a.residency === 'resident' ? -1 : 1));
}

export function validateStateRows(rows: StateRowInput[]): void {
  const residents = rows.filter((r) => r.residency === 'resident');
  if (residents.length !== 1) {
    throw AppError.unprocessableEntity('Exactly one resident state row is required', 'TE_STATE_ONE_RESIDENT');
  }
  const resident = residents[0]!;
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.residency === 'nonresident' && r.state === resident.state) {
      throw AppError.unprocessableEntity('A nonresident state cannot be the resident state', 'TE_STATE_NONRESIDENT_EQUALS_RESIDENT');
    }
    if (seen.has(r.state)) throw AppError.unprocessableEntity(`State ${r.state} appears more than once`, 'TE_STATE_DUPLICATE');
    seen.add(r.state);
  }
}

export async function replaceStateRows(
  scope: FirmScope, actor: Actor, scenarioId: string, input: ReplaceStateRowsInput,
): Promise<StateRowDTO[]> {
  validateStateRows(input.rows);
  return db.transaction(async (tx) => {
    const scenario = await loadScenarioForFirm(scope, scenarioId, tx);
    await loadTaxpayerForFirm(scope, scenario.taxpayerId, tx, true);
    const before = await tx.select().from(taxEstStateRows).where(eq(taxEstStateRows.scenarioId, scenarioId));
    await tx.delete(taxEstStateRows).where(eq(taxEstStateRows.scenarioId, scenarioId));
    const inserted = await tx.insert(taxEstStateRows).values(input.rows.map((r) => {
      const nonresident = r.residency === 'nonresident';
      return {
        scenarioId, residency: r.residency, state: r.state, effectiveRate: String(r.effectiveRate), base: r.base,
        customBase: r.base === 'custom' ? (r.customBase ?? null) : null,
        sourcedManual: nonresident && r.sourcedManual,
        sourcedIncome: nonresident && r.sourcedManual ? (r.sourcedIncome ?? null) : null,
        creditOverride: r.creditOverride ?? null, memo: r.memo ?? null,
      };
    })).returning();
    await auditYears(scope, actor, 'update', 'tax_est_state_rows', scenarioId, { rows: before.map(toDTO) }, { rows: inserted.map(toDTO) }, tx);
    return inserted.map(toDTO).sort((a, b) => (a.residency === b.residency ? a.state.localeCompare(b.state) : a.residency === 'resident' ? -1 : 1));
  });
}
