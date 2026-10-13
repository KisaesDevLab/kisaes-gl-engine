// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator annual settings (Phase 5). One row per (taxpayer, tax year).
//
// Prior-year tax and AGI are tax return information (MODULE.md D9): stored with
// encrypt() in `*_encrypted` text columns (which also enrols them in the credential
// re-encryption sweep), decrypted ONLY here, returned ONLY on the single-year GET,
// and never written to the audit log — an audit row records `{ changed: true }`.
import { and, asc, eq, sql } from 'drizzle-orm';
import type {
  UpsertYearInput, YearDetailDTO, YearSettingsDTO, YearSummaryDTO, SafeHarborOverride, RateMode, DeductionMode,
  ItemizedDTO, Sch1aDTO, HsaCoverageDTO, WithholdingDTO, PersonInputsDTO, FarmerGrossDTO, SafeHarborRuleSource,
} from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxEstYears, taxEstScenarios } from '../../db/schema/tax-estimator-years.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';
import { getFirmSettings } from './firm-settings.service.js';
import { toScenarioDTO } from './scenarios.service.js';
import { auditYears, loadTaxpayerForFirm, type Actor } from './year-access.js';

type YearRow = typeof taxEstYears.$inferSelect;

const BASE_SCENARIO_NAME = 'Base';

function readSecret(ciphertext: string | null): string | null {
  return ciphertext ? decrypt(ciphertext) : null;
}

function toYearDTO(r: YearRow, withSecrets: boolean): YearSettingsDTO {
  return {
    id: r.id, taxpayerId: r.taxpayerId, taxYear: r.taxYear,
    priorYearTax: withSecrets ? readSecret(r.priorYearTaxEncrypted) : null,
    priorYearAgi: withSecrets ? readSecret(r.priorYearAgiEncrypted) : null,
    priorYearTaxPresent: r.priorYearTaxEncrypted != null,
    priorYearAgiPresent: r.priorYearAgiEncrypted != null,
    priorYearTwelveMonths: r.priorYearTwelveMonths, priorYearFiled: r.priorYearFiled,
    safeHarborRule: r.safeHarborRule as SafeHarborOverride | null,
    rateMode: r.rateMode as RateMode,
    effectiveRateOverride: r.effectiveRateOverride == null ? null : Number(r.effectiveRateOverride),
    deductionMode: r.deductionMode as DeductionMode,
    itemized: r.itemized as ItemizedDTO, sch1a: r.sch1a as Sch1aDTO,
    creditsNonrefundable: r.creditsNonrefundable, creditsRefundable: r.creditsRefundable, careExpenses: r.careExpenses,
    unrecaptured1250Gain: r.unrecaptured1250Gain, collectiblesGain: r.collectiblesGain,
    hsaCoverage: r.hsaCoverage as HsaCoverageDTO, withholding: r.withholding as WithholdingDTO,
    personInputs: r.personInputs as PersonInputsDTO, mfsLivedApartAllYear: r.mfsLivedApartAllYear,
    niiAllocableDeductions: r.niiAllocableDeductions, farmerGross: r.farmerGross as FarmerGrossDTO, isFisherman: r.isFisherman,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/** Audit-safe projection: no prior-year values, only whether they changed. */
function auditShape(r: YearRow) {
  const { priorYearTaxEncrypted: _t, priorYearAgiEncrypted: _a, ...rest } = r;
  return { ...rest, priorYearTaxPresent: _t != null, priorYearAgiPresent: _a != null };
}

function defaultYearDTO(taxpayerId: string, taxYear: number): YearSettingsDTO {
  const now = new Date(0).toISOString();
  return {
    id: '', taxpayerId, taxYear, priorYearTax: null, priorYearAgi: null, priorYearTaxPresent: false,
    priorYearAgiPresent: false, priorYearTwelveMonths: true, priorYearFiled: true, safeHarborRule: null,
    rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: {}, sch1a: {},
    creditsNonrefundable: '0.0000', creditsRefundable: '0.0000', careExpenses: '0.0000', unrecaptured1250Gain: '0.0000', collectiblesGain: '0.0000', hsaCoverage: {}, withholding: {},
    personInputs: {}, mfsLivedApartAllYear: false, niiAllocableDeductions: null, farmerGross: {}, isFisherman: false,
    createdAt: now, updatedAt: now,
  };
}

/** Years that have a saved row. No return information in these rows. */
export async function listYears(scope: FirmScope, taxpayerId: string): Promise<YearSummaryDTO[]> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  const rows = await db.select().from(taxEstYears).where(eq(taxEstYears.taxpayerId, taxpayerId)).orderBy(asc(taxEstYears.taxYear));
  const counts = await db.select({ taxYear: taxEstScenarios.taxYear, n: sql<number>`count(*)::int` })
    .from(taxEstScenarios).where(eq(taxEstScenarios.taxpayerId, taxpayerId)).groupBy(taxEstScenarios.taxYear);
  const byYear = new Map(counts.map((c) => [c.taxYear, c.n]));
  return rows.map((r) => ({
    taxYear: r.taxYear, priorYearTaxPresent: r.priorYearTaxEncrypted != null,
    priorYearAgiPresent: r.priorYearAgiEncrypted != null, scenarioCount: byYear.get(r.taxYear) ?? 0,
  }));
}

/** Single-year read: the ONLY place decrypted prior-year values leave the service. */
export async function getYear(scope: FirmScope, taxpayerId: string, taxYear: number): Promise<YearDetailDTO> {
  const taxpayer = await loadTaxpayerForFirm(scope, taxpayerId);
  const [row] = await db.select().from(taxEstYears)
    .where(and(eq(taxEstYears.taxpayerId, taxpayerId), eq(taxEstYears.taxYear, taxYear)));
  const firm = await getFirmSettings(scope);
  const override = taxpayer.safeHarborOverride as SafeHarborOverride | null;
  const scenarios = row
    ? await db.select().from(taxEstScenarios)
      .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear)))
      .orderBy(asc(taxEstScenarios.sortOrder), asc(taxEstScenarios.createdAt))
    : [];
  const year = row ? toYearDTO(row, true) : defaultYearDTO(taxpayerId, taxYear);
  return {
    exists: !!row, year,
    taxpayerSafeHarborOverride: override, firmSafeHarborDefault: firm.safeHarborDefault,
    effectiveSafeHarborRule: year.safeHarborRule ?? override ?? firm.safeHarborDefault,
    scenarios: scenarios.map(toScenarioDTO),
  };
}

export async function upsertYear(
  scope: FirmScope, actor: Actor, taxpayerId: string, taxYear: number, input: UpsertYearInput,
): Promise<YearDetailDTO> {
  await db.transaction(async (tx) => {
    await loadTaxpayerForFirm(scope, taxpayerId, tx, true); // serialises concurrent first-saves
    const [before] = await tx.select().from(taxEstYears)
      .where(and(eq(taxEstYears.taxpayerId, taxpayerId), eq(taxEstYears.taxYear, taxYear)));

    const patch: Partial<typeof taxEstYears.$inferInsert> = { updatedAt: new Date() };
    let priorChanged = false;
    if (input.priorYearTax !== undefined && input.priorYearTax !== readSecret(before?.priorYearTaxEncrypted ?? null)) {
      patch.priorYearTaxEncrypted = input.priorYearTax === null ? null : encrypt(input.priorYearTax);
      priorChanged = true;
    }
    if (input.priorYearAgi !== undefined && input.priorYearAgi !== readSecret(before?.priorYearAgiEncrypted ?? null)) {
      patch.priorYearAgiEncrypted = input.priorYearAgi === null ? null : encrypt(input.priorYearAgi);
      priorChanged = true;
    }
    if (input.priorYearTwelveMonths !== undefined) patch.priorYearTwelveMonths = input.priorYearTwelveMonths;
    if (input.priorYearFiled !== undefined) patch.priorYearFiled = input.priorYearFiled;
    if (input.safeHarborRule !== undefined) patch.safeHarborRule = input.safeHarborRule;
    if (input.rateMode !== undefined) patch.rateMode = input.rateMode;
    if (input.effectiveRateOverride !== undefined) patch.effectiveRateOverride = input.effectiveRateOverride == null ? null : String(input.effectiveRateOverride);
    if (input.deductionMode !== undefined) patch.deductionMode = input.deductionMode;
    if (input.itemized !== undefined) patch.itemized = input.itemized as Record<string, number>;
    if (input.sch1a !== undefined) patch.sch1a = input.sch1a as Record<string, Record<string, number>>;
    if (input.creditsNonrefundable !== undefined) patch.creditsNonrefundable = input.creditsNonrefundable;
    if (input.creditsRefundable !== undefined) patch.creditsRefundable = input.creditsRefundable;
    if (input.careExpenses !== undefined) patch.careExpenses = input.careExpenses;
    if (input.unrecaptured1250Gain !== undefined) patch.unrecaptured1250Gain = input.unrecaptured1250Gain;
    if (input.collectiblesGain !== undefined) patch.collectiblesGain = input.collectiblesGain;
    if (input.hsaCoverage !== undefined) patch.hsaCoverage = input.hsaCoverage as Record<string, string>;
    if (input.withholding !== undefined) patch.withholding = input.withholding as { federal?: number; states?: Record<string, number> };
    if (input.personInputs !== undefined) patch.personInputs = input.personInputs as Record<string, Record<string, number | string | null>>;
    if (input.mfsLivedApartAllYear !== undefined) patch.mfsLivedApartAllYear = input.mfsLivedApartAllYear;
    if (input.niiAllocableDeductions !== undefined) patch.niiAllocableDeductions = input.niiAllocableDeductions;
    if (input.farmerGross !== undefined) patch.farmerGross = input.farmerGross as Record<string, Record<string, Record<string, number>>>;
    if (input.isFisherman !== undefined) patch.isFisherman = input.isFisherman;

    let row: YearRow | undefined;
    if (before) {
      [row] = await tx.update(taxEstYears).set(patch).where(eq(taxEstYears.id, before.id)).returning();
    } else {
      [row] = await tx.insert(taxEstYears).values({ taxpayerId, taxYear, ...patch }).returning();
      // Base scenario is created with the year, in the same transaction.
      const [base] = await tx.select({ id: taxEstScenarios.id }).from(taxEstScenarios)
        .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear), eq(taxEstScenarios.isBase, true)));
      if (!base) {
        await tx.insert(taxEstScenarios).values({ taxpayerId, taxYear, name: BASE_SCENARIO_NAME, isBase: true, sortOrder: 0 });
      }
    }
    if (!row) throw new AppError(500, 'Year upsert failed', 'TE_YEAR_SAVE_FAILED');
    const beforeShape = before ? auditShape(before) : null;
    const afterShape = { ...auditShape(row), ...(priorChanged ? { priorYearChanged: { changed: true } } : {}) };
    await auditYears(scope, actor, before ? 'update' : 'create', 'tax_est_year', row.id, beforeShape, afterShape, tx);
  });
  return getYear(scope, taxpayerId, taxYear);
}

/**
 * Estimate assembly (Phase 10b): the year WITH decrypted prior-year values plus the
 * resolved safe-harbor rule and where it came from (year → taxpayer → firm default).
 * Server-internal: the decrypted values feed the engine and are never returned by a
 * route except the single-year GET above (D9).
 */
export async function loadYearForEngine(scope: FirmScope, taxpayerId: string, taxYear: number): Promise<{
  exists: boolean; year: YearSettingsDTO; rule: SafeHarborOverride; ruleSource: SafeHarborRuleSource;
}> {
  const taxpayer = await loadTaxpayerForFirm(scope, taxpayerId);
  const [row] = await db.select().from(taxEstYears)
    .where(and(eq(taxEstYears.taxpayerId, taxpayerId), eq(taxEstYears.taxYear, taxYear)));
  const year = row ? toYearDTO(row, true) : defaultYearDTO(taxpayerId, taxYear);
  const override = taxpayer.safeHarborOverride as SafeHarborOverride | null;
  if (year.safeHarborRule) return { exists: !!row, year, rule: year.safeHarborRule, ruleSource: 'year' };
  if (override) return { exists: !!row, year, rule: override, ruleSource: 'taxpayer' };
  const firm = await getFirmSettings(scope);
  return { exists: !!row, year, rule: firm.safeHarborDefault, ruleSource: 'firm_default' };
}
