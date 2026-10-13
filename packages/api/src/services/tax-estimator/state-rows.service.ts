// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator state rows (Phase 5): exactly ONE resident row per scenario plus any
// number of nonresident rows. Q53: each row has a rate mode (state rate schedule | effective-rate
// override) and nonresident rows a nonresident mode (state method | sourced × effective rate). PUT replaces the set
// atomically. `sourced_manual = false` on a nonresident row means "derive sourced
// income later" (engine phase: entity state x share); the value is left NULL here.
//
// Phase 10b: gate inputs (D12b) and prior-year STATE tax / AGI (D9, encrypted, write-only,
// never returned and never audited — the DTO carries only `priorYear*Present`). On PUT a
// field that is OMITTED keeps the value saved for the same state; null clears it.
import { asc, eq } from 'drizzle-orm';
import type { StateRowDTO, StateRowInput, ReplaceStateRowsInput, StateResidency, StateBase, StateRowRateMode, StateRowNonresidentMode } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { taxEstStateRows } from '../../db/schema/tax-estimator-years.js';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';
import { auditYears, loadScenarioForFirm, loadTaxpayerForFirm, type Actor } from './year-access.js';

type Row = typeof taxEstStateRows.$inferSelect;

function toDTO(r: Row): StateRowDTO {
  return {
    id: r.id, scenarioId: r.scenarioId, residency: r.residency as StateResidency, state: r.state.trim(),
    effectiveRate: Number(r.effectiveRate), base: r.base as StateBase,
    rateMode: r.rateMode as StateRowRateMode, nonresidentMode: r.nonresidentMode as StateRowNonresidentMode, customBase: r.customBase,
    sourcedIncome: r.sourcedIncome, sourcedManual: r.sourcedManual, creditOverride: r.creditOverride, memo: r.memo,
    withholding: r.withholding, otherCredits: r.otherCredits, grossIncome: r.grossIncome,
    priorYearGrossIncome: r.priorYearGrossIncome, nonWithheldIncome: r.nonWithheldIncome, exemptions: r.exemptions,
    stateDeductions: r.stateDeductions,
    priorYearTaxPresent: r.priorYearTaxEncrypted != null, priorYearAgiPresent: r.priorYearAgiEncrypted != null,
  };
}

/** Engine view of a scenario's state rows (Phase 10b): the DTO plus the DECRYPTED prior-year state figures. Server-internal. */
export interface StateRowForEngine {
  dto: StateRowDTO;
  priorYearTax: string | null;
  priorYearAgi: string | null;
}

export async function listStateRowsForEngine(scope: FirmScope, scenarioId: string): Promise<StateRowForEngine[]> {
  await loadScenarioForFirm(scope, scenarioId);
  const rows = await db.select().from(taxEstStateRows).where(eq(taxEstStateRows.scenarioId, scenarioId));
  return rows.map((r) => ({
    dto: toDTO(r),
    priorYearTax: r.priorYearTaxEncrypted ? decrypt(r.priorYearTaxEncrypted) : null,
    priorYearAgi: r.priorYearAgiEncrypted ? decrypt(r.priorYearAgiEncrypted) : null,
  })).sort((a, b) => (a.dto.residency === b.dto.residency ? a.dto.state.localeCompare(b.dto.state) : a.dto.residency === 'resident' ? -1 : 1));
}

/** omitted → keep the saved value; null / value → set. */
function keep<T>(input: T | undefined, saved: T | null): T | null {
  return input === undefined ? saved : input;
}

/** Write-only secret: omitted → keep the saved ciphertext; null → clear; value → encrypt. */
function keepSecret(input: string | null | undefined, savedCiphertext: string | null): string | null {
  if (input === undefined) return savedCiphertext;
  return input === null ? null : encrypt(input);
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
    const savedByState = new Map(before.map((b) => [b.state.trim(), b]));
    const inserted = await tx.insert(taxEstStateRows).values(input.rows.map((r) => {
      const nonresident = r.residency === 'nonresident';
      const saved = savedByState.get(r.state);
      return {
        scenarioId, residency: r.residency, state: r.state, effectiveRate: String(r.effectiveRate), base: r.base,
        // Q53: omitted = keep the mode saved for this state; a new row takes the defaults.
        rateMode: r.rateMode ?? saved?.rateMode ?? 'brackets',
        nonresidentMode: r.nonresidentMode ?? saved?.nonresidentMode ?? 'ratio',
        customBase: r.base === 'custom' ? (r.customBase ?? null) : null,
        sourcedManual: nonresident && r.sourcedManual,
        sourcedIncome: nonresident && r.sourcedManual ? (r.sourcedIncome ?? null) : null,
        creditOverride: r.creditOverride ?? null, memo: r.memo ?? null,
        withholding: keep(r.withholding, saved?.withholding ?? null),
        otherCredits: keep(r.otherCredits, saved?.otherCredits ?? null),
        grossIncome: keep(r.grossIncome, saved?.grossIncome ?? null),
        priorYearGrossIncome: keep(r.priorYearGrossIncome, saved?.priorYearGrossIncome ?? null),
        nonWithheldIncome: keep(r.nonWithheldIncome, saved?.nonWithheldIncome ?? null),
        exemptions: keep(r.exemptions, saved?.exemptions ?? null),
        stateDeductions: keep(r.stateDeductions, saved?.stateDeductions ?? null),
        priorYearTaxEncrypted: keepSecret(r.priorYearTax, saved?.priorYearTaxEncrypted ?? null),
        priorYearAgiEncrypted: keepSecret(r.priorYearAgi, saved?.priorYearAgiEncrypted ?? null),
      };
    })).returning();
    await auditYears(scope, actor, 'update', 'tax_est_state_rows', scenarioId, { rows: before.map(toDTO) }, { rows: inserted.map(toDTO) }, tx);
    return inserted.map(toDTO).sort((a, b) => (a.residency === b.residency ? a.state.localeCompare(b.state) : a.residency === 'resident' ? -1 : 1));
  });
}
