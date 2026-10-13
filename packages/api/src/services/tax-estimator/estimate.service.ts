// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator estimate assembly (Phase 10b). Books + taxpayer setup → ONE
// EstimateResultDTO for (taxpayer, tax year, scenario). This service only gathers and
// maps inputs; every number is computed by the pure engine in @kis-books/shared
// (MODULE.md "Engineering rules": services never re-implement tax math):
//
//   links in scope (D1) → P&L provider per linked company → bridge → computeFederal
//   state rows (+ gate inputs, prior-year state figures) → computeState
//   payment ledger (stored + live GL) → computeFederalEstimates (with Schedule AI period
//     actuals from snapshots or the provider) / computeStateEstimates, each fed the
//     ROUNDED current-year tax (FederalResult.federalTotal, StateRowResult.netTax; Q34)
//   farm entities / manual farmer figures → computeFarmer (farmer policies when it qualifies)
//   linked C corporations → computeCcorp (entity level, outside the taxpayer totals)
//
// Parameters come from getParameters / getStateRules WITH statuses so the D12a
// unverified / provisional warnings surface. The result is Redis-cached (test Redis only
// in tests) under a key built from every input: GL version stamps, estimator config
// versions, the inputs themselves, the parameter values and the day (D10 "live estimate").
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type {
  AdjustmentDTO, AdjustmentTypeDTO, CcorpResult, EngineEntity, EnginePerson, EstimateEntityDTO, EstimateEntityOwnerDTO, EstimatePayment, EstimatePaymentDTO,
  EstimateReadinessDTO, EstimateReadinessEntityDTO, EstimateReadinessPeriodDTO, EstimateResultDTO, EngineYearInputs, FarmerResult,
  FarmerYearGross, FarmerGrossYearDTO, FederalEngineInput, FederalResult, JurisdictionEstimate, LinkDTO, ParameterUse, PersonDTO, DependentDTO,
  SchAiPeriodSourceDTO, StateResult, StateRuleUse, StateRulesDTO, TaxBasisPl, TaxEstimatorWarning, EntitySettingsResponse,
  StateGateInputs, TaxMethod, EstimateAdjustmentSummaryDTO, EstimateEntityReclassDTO, FirmSettingsDTO, PortalShows, OutsideEntityDTO,
  ProjectionMethod, EntityTaxType,
} from '@kis-books/shared';
import {
  computeFederal, computeState, computeFederalEstimates, computeStateEstimates, computeCcorp, computeFarmer,
  engineEntityFromTaxBasisPl, enginePersonFromDto, engineAdjustmentFromDto, engineYearFromDto, personYearInputsFromDto, engineDependentFromDto, activeDependents,
  parameterMapFromRows, jurisdictionFromStateRules, federalFiguresFromResult, stateRowFromDto, sourcedEntitiesFromFederal,
  projectCharacters, sumCharacters, allocateAdjustment, FARMER_SAFE_HARBOR_POLICY, FARMER_INSTALLMENT_POLICY, TAX_ENGINE_VERSION,
  dAdd, dDiv, dMul, dSum, dRoundDollars, buildEstimateAssumptions, engineEntityFromOutside, outsidePeriodEntity, OUTSIDE_TENANT_ID,
  priorYearTrendFor, DEFAULT_PROJECTION_METHOD, PROJECTION_METHOD_LABELS, PY_TREND_FALLBACK_LABELS,
} from '@kis-books/shared';
import { db } from '../../db/index.js';
import { accounts } from '../../db/schema/index.js';
import { buildAccountDetailReport } from '../report.service.js';
import { getGlVersionStamp } from '../tb/balance-engine.service.js';
import { tbCacheGet, tbCacheSet } from '../tb/tb-redis.js';
import { AppError } from '../../utils/errors.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { getFirmSettings } from './firm-settings.service.js';
import { isElevated, isTenantInScope, scopeForTaxpayer, type FirmScope } from './firm-scope.service.js';
import { getTaxBasisPl, loadConfigVersion } from './pl-provider.service.js';
import { getReadiness } from './readiness.service.js';
import { getEntitySettings, getYearInputs } from './entity-settings.service.js';
import { loadPriorYearTrendInputs, priorYearTrendReadinessWarning, type PriorYearTrendInputs } from './prior-year-trend.service.js';
import { scopeWarningForLink } from './entity-type.service.js';
import { getParameters } from './tax-parameters.service.js';
import { getStateRules } from './tax-state-rules.service.js';
import { getTaxpayer, listLinks, listOutsideEntities } from './taxpayers.service.js';
import { loadYearForEngine } from './years.service.js';
import { listAdjustments } from './adjustments.service.js';
import { listAdjustmentTypes } from './adjustment-types.service.js';
import { listStateRowsForEngine, type StateRowForEngine } from './state-rows.service.js';
import { getPaymentLedger } from './payments.service.js';
import { inScopeCompanies, loadSnapshotFigures, periodFiguresFromPl, schAiPeriods, listSnapshots, type SchAiFigures } from './sch-ai-snapshots.service.js';
import { lastCompleteMonth, monthEnd } from './periods.js';
import { loadScenarioForFirm, loadTaxpayerForFirm, scenarioNotFound, type TaxpayerRow } from './year-access.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecJs = InstanceType<typeof Decimal>;

// v2 (Phase 12): the cached payload is AES-encrypted (D9) and carries the assumptions block.
// v3 (QA2-04): adjustments carry their monthly allocation.
// v4 (2026-10-12): entities carry their owners (PDF "Businesses included").
// v5 (Q45): businesses outside MyBooks (entities carry `source` / `outside`).
// v6 (Q46): projection method + prior-year trend figures per company (entity results carry `projection`).
// v7 (Q49): per-year entity type override (resolved per tax year; `eto` in the key; entities may carry `entityTypeOverride`).
const CACHE_VERSION = 'te-estimate-v7';
const FEDERAL = 'federal';
const MONTHS_PER_YEAR = 12;
const MAX_ADJUSTMENTS = 500;
const ALL_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'];
const INCOME_ACCOUNT_TYPES = new Set(['revenue', 'other_revenue']);
/** Q44: a joint return has two filers for the state personal exemptions. */
const JOINT_RETURN_FILERS = 2;
const R = dRoundDollars;

export interface EstimateRequest {
  taxpayerId: string;
  taxYear: number;
  scenarioId: string;
  /** 'YYYY-MM' range end for every linked entity; default = each entity's last closed / complete month. */
  throughMonth?: string;
  /** Bypass the estimate cache. */
  refresh?: boolean;
}

export interface EstimateOptions {
  today?: Date;
  /**
   * QA D13 (as-of semantics, client portal): payments dated after this day (YYYY-MM-DD) are
   * not paid yet, so they are left out of the computation (a TE_PAYMENTS_AFTER_AS_OF note
   * says how many). Undated rows (prior-year overpayment) always count. Staff estimates
   * leave it unset: they project every known payment, scheduled ones included.
   */
  paymentsAsOf?: string;
  /** Bypass the P&L provider cache as well (tests). */
  skipProviderCache?: boolean;
}

/** Engine errors carry a `TE_*` prefix: surface them as 422 with the code. */
function runEngine<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = /^(TE_[A-Z0-9_]+)/.exec(message)?.[1];
    if (code) throw AppError.unprocessableEntity(message, code);
    throw err;
  }
}

const isoDate = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const pad2 = (n: number) => String(n).padStart(2, '0');
const prorate = (v: string, months: number) => dDiv(dMul(v, String(months)), String(MONTHS_PER_YEAR));
const prorateNullable = (v: string | null, months: number) => (v == null ? null : prorate(v, months));

/** 1..12 month index of a 'YYYY-MM' inside `taxYear` (0 before the year, 12 after). */
function monthIndex(ym: string, taxYear: number): number {
  if (ym < `${taxYear}-01`) return 0;
  if (ym > `${taxYear}-12`) return MONTHS_PER_YEAR;
  return Number(ym.slice(5, 7));
}

function dedupeWarnings(ws: TaxEstimatorWarning[]): TaxEstimatorWarning[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const k = `${w.code}|${w.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function uniqueParams(lists: ParameterUse[][]): ParameterUse[] {
  const m = new Map<string, ParameterUse>();
  for (const l of lists) for (const u of l) if (!m.has(u.key)) m.set(u.key, u);
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function uniqueRules(lists: StateRuleUse[][]): StateRuleUse[] {
  const m = new Map<string, StateRuleUse>();
  for (const l of lists) for (const u of l) if (!m.has(`${u.state}|${u.key}`)) m.set(`${u.state}|${u.key}`, u);
  return [...m.values()].sort((a, b) => a.state.localeCompare(b.state) || a.key.localeCompare(b.key));
}

/**
 * GL monthly actuals (Jan..through) for a GL-linked adjustment, profit-direction
 * magnitude per account type (income accounts credit − debit, others debit − credit),
 * read through the report builder on the entity's tax method.
 */
async function glMonthlyActuals(
  tenantId: string, companyId: string, accountId: string, taxYear: number, throughIdx: number, basis: TaxMethod,
): Promise<string[]> {
  if (throughIdx <= 0) return [];
  const [acct] = await db.select({ accountType: accounts.accountType }).from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.tenantId, tenantId)));
  if (!acct) return [];
  const income = INCOME_ACCOUNT_TYPES.has(acct.accountType);
  const months: DecJs[] = Array.from({ length: MONTHS_PER_YEAR }, () => new Decimal(0));
  const detail = await buildAccountDetailReport(tenantId, `${taxYear}-01-01`, monthEnd(`${taxYear}-${pad2(throughIdx)}`), {
    title: 'tax-estimator-adjustment-actuals', accountTypes: ALL_ACCOUNT_TYPES, normalSide: 'debit', companyId,
    accountIds: [accountId], detail: true, basis, exactAmounts: true,
  });
  if ('groups' in detail) {
    for (const g of detail.groups) {
      for (const line of g.lines) {
        const d = new Decimal(line.debitExact ?? line.debit);
        const c = new Decimal(line.creditExact ?? line.credit);
        const m = Number(isoDate(line.date).slice(5, 7)) - 1;
        if (m < 0 || m >= MONTHS_PER_YEAR) continue;
        months[m] = months[m]!.plus(income ? c.minus(d) : d.minus(c));
      }
    }
  }
  return months.slice(0, throughIdx).map((v) => v.toFixed(4));
}

// ── Input gathering ─────────────────────────────────────────────────────

interface CompanyInputs {
  tenantId: string;
  companyId: string;
  companyName: string | null;
  settings: EntitySettingsResponse;
  glVersionStamp: number;
  configVersion: string;
  /** Q46: the entity year's projection method (default run_rate). */
  projectionMethod: ProjectionMethod;
  /** Q46: prior-year monthly figures (or why none) — read only when a prior-year method is selected. */
  priorYear: PriorYearTrendInputs | null;
}

interface Gathered {
  taxpayer: TaxpayerRow;
  firmSettings: FirmSettingsDTO;
  taxpayerFilingStatus: FederalEngineInput['filingStatus'];
  scenarioName: string;
  year: Awaited<ReturnType<typeof loadYearForEngine>>;
  persons: PersonDTO[];
  /** Q44: the taxpayer's dependents (all years; the engine filters by tax year). */
  dependents: DependentDTO[];
  linksAll: LinkDTO[];
  links: LinkDTO[];
  /** Q45: businesses outside MyBooks that have amounts for this tax year (definition + `year`). */
  outside: OutsideEntityDTO[];
  companies: CompanyInputs[];
  adjustments: AdjustmentDTO[];
  types: AdjustmentTypeDTO[];
  stateRows: StateRowForEngine[];
  paramsDto: Awaited<ReturnType<typeof getParameters>>;
  stateRules: StateRulesDTO[];
  ledger: Awaited<ReturnType<typeof getPaymentLedger>>;
  snapshots: Map<string, SchAiFigures>;
  warnings: TaxEstimatorWarning[];
}

async function gather(scope: FirmScope, req: EstimateRequest): Promise<Gathered> {
  const taxpayer = await loadTaxpayerForFirm(scope, req.taxpayerId);
  const scenario = await loadScenarioForFirm(scope, req.scenarioId);
  if (scenario.taxpayerId !== taxpayer.id || scenario.taxYear !== req.taxYear) throw scenarioNotFound();
  const warnings: TaxEstimatorWarning[] = [];

  const [year, detail, linkList, outsideList, adjustmentList, types, stateRows, paramsDto, snapshots, firmSettings] = await Promise.all([
    loadYearForEngine(scope, taxpayer.id, req.taxYear),
    getTaxpayer(scope, taxpayer.id),
    listLinks(scope, taxpayer.id, req.taxYear),
    listOutsideEntities(scope, taxpayer.id, req.taxYear),
    listAdjustments(scope, scenario.id, { limit: MAX_ADJUSTMENTS, offset: 0 }),
    listAdjustmentTypes(scope, true),
    listStateRowsForEngine(scope, scenario.id),
    getParameters(req.taxYear),
    loadSnapshotFigures(scope, taxpayer.id, req.taxYear),
    getFirmSettings(scope),
  ]);
  if (detail.persons.length === 0) throw AppError.unprocessableEntity('Add the taxpayer (primary person) before estimating', 'TE_NO_PERSONS');
  if (!year.exists) {
    warnings.push({ code: 'TE_YEAR_NOT_SAVED', severity: 'warning', message: `No annual settings are saved for ${req.taxYear}; defaults were used (no prior-year tax, no withholding, no credits).` });
  }
  if (paramsDto.isFallback) {
    warnings.push({ code: 'TE_PARAMS_FALLBACK_YEAR', severity: 'warning', message: `No federal parameters exist for ${req.taxYear}; the ${paramsDto.fallbackYear} values were used (all provisional). Due dates, the return due date and holidays were rolled forward to ${req.taxYear}; rates, amounts and the penalty rate table are ${paramsDto.fallbackYear}'s.`, details: { fallbackYear: paramsDto.fallbackYear } });
  }

  // D1: a link whose tenant left the scope is excluded, with a readiness warning.
  const linksAll = linkList.data;
  const outOfScope = new Map<string, LinkDTO>();
  for (const l of linksAll) if (l.outOfScope || !isTenantInScope(scope, l.tenantId)) outOfScope.set(`${l.tenantId}|${l.companyId}`, l);
  for (const l of outOfScope.values()) {
    const w = scopeWarningForLink(scope, l.tenantId, 'A linked company');
    if (w) warnings.push({ ...w, details: { linkId: l.id } });
  }
  const links = linksAll.filter((l) => !l.outOfScope && isTenantInScope(scope, l.tenantId));

  const companies: CompanyInputs[] = [];
  for (const c of inScopeCompanies(scope, links)) {
    const [settings, glVersionStamp, configVersion, yearInputs] = await Promise.all([
      // Q49: resolved for the tax year (the entity year's override decides the type when set).
      getEntitySettings(scope, c.tenantId, c.companyId, req.taxYear),
      getGlVersionStamp(c.tenantId, c.companyId),
      loadConfigVersion(c.tenantId, c.companyId, req.taxYear),
      getYearInputs(scope, c.tenantId, c.companyId, req.taxYear),
    ]);
    // Q46: the prior year is read (through the same provider, Redis-cached by the GL stamp) only
    // when a prior-year method is selected; its figures go into the cache key and the snapshot.
    const projectionMethod = yearInputs.projectionMethod ?? DEFAULT_PROJECTION_METHOD;
    const priorYear = projectionMethod === 'run_rate' ? null
      : await loadPriorYearTrendInputs(scope, c.tenantId, c.companyId, req.taxYear, settings.resolved.entityType ?? null);
    companies.push({ ...c, settings, glVersionStamp, configVersion, projectionMethod, priorYear });
  }

  const states = [...new Set(stateRows.map((r) => r.dto.state))];
  const stateRules = await Promise.all(states.map((s) => getStateRules(req.taxYear, s)));
  // R6-03: the state mirror of TE_PARAMS_FALLBACK_YEAR — the admin States screen says the same (status `fallback`).
  for (const sr of stateRules) {
    if (!sr.isFallback) continue;
    warnings.push({ code: 'TE_STATE_RULES_FALLBACK_YEAR', severity: 'warning', message: `No ${sr.state} rules exist for ${req.taxYear}; the ${sr.fallbackYear} ${sr.state} rules were used (all provisional). Due dates, the return due date, the farmer dates and holidays were derived for ${req.taxYear}; thresholds, percentages and penalty rates are ${sr.fallbackYear}'s.`, details: { state: sr.state, fallbackYear: sr.fallbackYear } });
  }
  const ledger = await getPaymentLedger(scope, taxpayer.id, req.taxYear, scenario.id, { links: linksAll });
  warnings.push(...ledger.warnings);

  if (adjustmentList.total > adjustmentList.data.length) {
    warnings.push({ code: 'TE_ADJUSTMENTS_TRUNCATED', severity: 'warning', message: `Only the first ${adjustmentList.data.length} adjustments were used.` });
  }
  return {
    taxpayer, firmSettings,
    taxpayerFilingStatus: taxpayer.filingStatus as FederalEngineInput['filingStatus'], scenarioName: scenario.name, year,
    persons: detail.persons, dependents: detail.dependents ?? [], linksAll, links, outside: outsideList.data.filter((o) => o.year != null), companies,
    adjustments: adjustmentList.data, types, stateRows, paramsDto, stateRules,
    ledger, snapshots, warnings,
  };
}

function inputsHash(scope: FirmScope, req: EstimateRequest, g: Gathered, today: Date): string {
  const payload = {
    v: CACHE_VERSION, engine: TAX_ENGINE_VERSION, firm: scope.firmId, req: { ...req, refresh: undefined }, day: today.toISOString().slice(0, 10),
    // R3-01 (D1): the result depends on WHICH tenants the caller reaches (a GL-linked
    // adjustment into a non-linked company is read only when its tenant is in scope), so
    // two firm members with different tenant access never share a cache entry.
    tenants: [...scope.allowedTenantIds].sort(),
    // D18: a listed user's widened read is its own cache entry (flag + tenant set above).
    elevated: isElevated(scope),
    filingStatus: g.taxpayerFilingStatus, year: g.year, persons: g.persons, dependents: g.dependents, links: g.links,
    // Q45: any change to an outside business or its year amounts re-keys the live estimate.
    outside: g.outside,
    // Q49: the per-year entity type override (and its effective type) is part of the key.
    companies: g.companies.map((c) => ({ t: c.tenantId, c: c.companyId, stamp: c.glVersionStamp, cfg: c.configVersion, s: c.settings, pm: c.projectionMethod, py: c.priorYear, eto: c.settings.resolved.entityTypeOverride ?? null })),
    adjustments: g.adjustments, types: g.types, stateRows: g.stateRows, params: g.paramsDto, stateRules: g.stateRules,
    payments: g.ledger.payments, snapshots: [...g.snapshots.entries()],
    // Phase 12: the disclaimer / portal default / safe-harbor default land on the result.
    firmSettings: { ...g.firmSettings, updatedAt: undefined }, portalShows: g.taxpayer.portalShows,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ── Assembly ────────────────────────────────────────────────────────────

/** Q49: the estimate DTO marks an entity whose type the entity year's override decided (absent otherwise). */
function entityTypeOverrideOf(c: CompanyInputs): Pick<EstimateEntityDTO, 'entityTypeSource' | 'entityTypeOverride'> {
  const o = c.settings.resolved.entityTypeOverride;
  return o ? { entityTypeSource: 'estimator_override', entityTypeOverride: o } : {};
}

/**
 * Q49: owner inputs saved for another entity type once the entity year's override changed the type —
 * officer / limited-partner link flags (the engine ignores them: SE and officer rules follow the
 * entity type) and owner-targeted W-2 wages on a non-S corp. Warnings, never a failed estimate.
 */
function staleOwnerInputWarnings(g: Pick<Gathered, 'links'>, c: CompanyInputs, pl: TaxBasisPl): TaxEstimatorWarning[] {
  const entityType = pl.entityType!;
  const companyName = pl.companyName;
  const own = g.links.filter((l) => l.tenantId === c.tenantId && l.companyId === c.companyId);
  const out: TaxEstimatorWarning[] = [];
  // Officer W-2 wages (w2_wages treatment targeted at an owner) still reach the owner's W-2 wages.
  if (entityType !== 's_corp' && entityType !== 'c_corp' && pl.w2Wages.byPerson.length > 0) {
    out.push({ code: 'TE_OFFICER_WAGES_NOT_S_CORP', severity: 'warning', message: `${companyName}: W-2 wages are assigned to an owner (officer wages), but the entity type for this year is ${ENTITY_TYPE_NAME[entityType]}; they are still counted as that owner's W-2 wages. Re-treat them (e.g. guaranteed payments for a partnership) if that is what they are.`, details: { companyId: c.companyId, personIds: pl.w2Wages.byPerson.map((w) => w.personId) } });
  }
  const officer = own.filter((l) => l.isOfficer && entityType !== 's_corp');
  if (officer.length) {
    out.push({ code: 'TE_LINK_FLAG_NOT_FOR_ENTITY', severity: 'warning', message: `${companyName}: an owner link is marked officer, which applies to S corporations only; the entity type for this year is ${ENTITY_TYPE_NAME[entityType]}, so the flag is ignored.`, details: { companyId: c.companyId, flag: 'isOfficer', linkIds: officer.map((l) => l.id) } });
  }
  const limited = own.filter((l) => l.partnerSeStatus === 'limited' && entityType !== 'partnership');
  if (limited.length) {
    out.push({ code: 'TE_LINK_FLAG_NOT_FOR_ENTITY', severity: 'warning', message: `${companyName}: an owner link is marked limited partner, which applies to partnerships only; the entity type for this year is ${ENTITY_TYPE_NAME[entityType]}, so the flag is ignored.`, details: { companyId: c.companyId, flag: 'partnerSeStatus', linkIds: limited.map((l) => l.id) } });
  }
  return out;
}
const ENTITY_TYPE_NAME: Record<EntityTaxType, string> = {
  sch_c: 'Schedule C', sch_f: 'Schedule F', s_corp: 'S corporation', partnership: 'partnership', c_corp: 'C corporation',
};

interface EntityRun {
  company: CompanyInputs;
  pl: TaxBasisPl | null;
  dto: EstimateEntityDTO;
  engine: EngineEntity | null;
}

async function runEntities(scope: FirmScope, req: EstimateRequest, g: Gathered, opts: EstimateOptions, today: Date, warnings: TaxEstimatorWarning[]): Promise<EntityRun[]> {
  const out: EntityRun[] = [];
  for (const c of g.companies) {
    const base: EstimateEntityDTO = {
      tenantId: c.tenantId, companyId: c.companyId, companyName: c.companyName ?? c.settings.resolved.companyName, entityType: null,
      path: 'skipped', skippedReason: null, throughMonth: null, throughMonthSource: null, monthsElapsed: 0, monthsRemaining: 0,
      glVersionStamp: c.glVersionStamp, providerCached: false, owners: ownersOf(g, c.tenantId, c.companyId),
    };
    let pl: TaxBasisPl;
    try {
      pl = await getTaxBasisPl(scope, { tenantId: c.tenantId, companyId: c.companyId, taxYear: req.taxYear, throughMonth: req.throughMonth }, { today, skipCache: opts.skipProviderCache });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      warnings.push({ code: err.code ?? 'TE_ENTITY_SKIPPED', severity: 'warning', message: `${base.companyName}: ${err.message}; left out of the estimate.`, details: { companyId: c.companyId } });
      out.push({ company: c, pl: null, dto: { ...base, skippedReason: err.message }, engine: null });
      continue;
    }
    warnings.push(...pl.warnings.map((w) => ({ ...w, details: { ...(w.details ?? {}), companyId: c.companyId, companyName: pl.companyName } })));
    const dto: EstimateEntityDTO = {
      ...base, companyName: pl.companyName, entityType: pl.entityType, throughMonth: pl.throughMonth, throughMonthSource: pl.throughMonthSource,
      monthsElapsed: pl.monthsElapsed, monthsRemaining: pl.monthsRemaining, glVersionStamp: pl.glVersionStamp, providerCached: pl.cached,
      basis: pl.basis, throughMonthReason: pl.throughMonthReason, nonRecurringYtd: pl.nonRecurring, reclass: reclassOf(pl),
      includeSehiInW2Wages: pl.w2Wages.includeSehiInW2Wages ?? false,
      // Q46: only a non-default method is marked (run-rate DTOs unchanged).
      ...(c.projectionMethod !== 'run_rate' ? { projectionMethod: c.projectionMethod } : {}),
      // Q49: only an overridden entity type is marked (DTOs without an override unchanged).
      ...entityTypeOverrideOf(c),
    };
    if (!pl.entityType) {
      warnings.push({ code: 'TE_ENTITY_TYPE_MISSING', severity: 'warning', message: `${pl.companyName} has no tax entity type (no TB profile and no estimator setting); left out of the estimate.`, details: { companyId: c.companyId } });
      out.push({ company: c, pl, dto: { ...dto, skippedReason: 'No tax entity type' }, engine: null });
      continue;
    }
    if (c.settings.resolved.entityTypeOverride) warnings.push(...staleOwnerInputWarnings(g, c, pl));
    if (pl.entityType === 'c_corp') {
      if (c.projectionMethod !== 'run_rate') {
        warnings.push({ code: 'TE_PY_TREND_FALLBACK', severity: 'warning', message: `${pl.companyName}: ${PROJECTION_METHOD_LABELS[c.projectionMethod]} could not be used (${PY_TREND_FALLBACK_LABELS.not_supported_entity}); the run rate was used.`, details: { companyId: c.companyId, method: c.projectionMethod, reason: 'not_supported_entity' } });
      }
      out.push({ company: c, pl, dto: { ...dto, path: 'c_corp' }, engine: null });
      continue;
    }
    const bridged = engineEntityFromTaxBasisPl(pl, g.links, {
      isSstb: c.settings.settings.isSstb, rentalQbiTradeOrBusiness: c.settings.settings.rentalQbiTradeOrBusiness,
    });
    // Q46: prior-year figures split at THIS year's through month (calendar window: months elapsed).
    const engine: EngineEntity = c.projectionMethod === 'run_rate' ? bridged : {
      ...bridged,
      priorYearTrend: priorYearTrendFor(c.projectionMethod, c.priorYear?.figures ?? null, pl.monthsElapsed, c.priorYear?.reason ?? null),
    };
    out.push({ company: c, pl, dto: { ...dto, path: 'individual' }, engine });
  }
  return out;
}

/**
 * Who owns the business (owner request 2026-10-12): one entry per in-scope link, with the
 * percentages the engine allocates (income.ts linkFractions: a blank profit % is 100 for a
 * sole owner, else 0; a blank loss % follows the profit %). Display data only.
 */
function ownersOf(g: Pick<Gathered, 'links' | 'persons'>, tenantId: string, companyId: string): EstimateEntityOwnerDTO[] {
  const own = g.links.filter((l) => l.tenantId === tenantId && l.companyId === companyId);
  return own.map((l) => {
    const p = g.persons.find((x) => x.id === l.personId);
    const profitPct = l.profitPct ?? (own.length === 1 ? 100 : 0);
    return {
      personId: l.personId, personRole: l.personRole,
      displayName: p ? `${p.firstName} ${p.lastName}`.trim() : l.personRole,
      profitPct, lossPct: l.lossPct ?? profitPct,
    };
  });
}

interface OutsideRun {
  def: OutsideEntityDTO;
  engine: EngineEntity;
  dto: EstimateEntityDTO;
}

/**
 * Q45: businesses outside MyBooks with amounts for the year → engine entities (the shared bridge)
 * and estimate DTOs. A C corporation takes the entity-level path like a linked one. No tenant,
 * no books readiness: the figures are typed in. Owners show the STATED % (on an owner's share it
 * is informational; the engine allocates 100% of the entered share).
 */
function runOutside(g: Pick<Gathered, 'outside' | 'persons'>): OutsideRun[] {
  return g.outside.filter((o) => o.year).map((o) => {
    const y = o.year!;
    const engine = engineEntityFromOutside(o, y);
    const p = g.persons.find((x) => x.id === o.personId);
    const profitPct = o.profitPct ?? 100;
    const dto: EstimateEntityDTO = {
      tenantId: OUTSIDE_TENANT_ID, companyId: o.id, companyName: o.name, entityType: o.entityType,
      path: o.entityType === 'c_corp' ? 'c_corp' : 'individual', skippedReason: null, throughMonth: null, throughMonthSource: null,
      monthsElapsed: engine.monthsElapsed, monthsRemaining: engine.monthsRemaining, glVersionStamp: 0, providerCached: false,
      owners: [{ personId: o.personId, personRole: o.personRole, displayName: p ? `${p.firstName} ${p.lastName}`.trim() : o.personRole, profitPct, lossPct: o.lossPct ?? profitPct }],
      source: 'outside',
      outside: {
        outsideEntityId: o.id, entryMode: y.entryMode, amountBasis: y.amountBasis, throughMonth: y.entryMode === 'ytd' ? y.throughMonth : null,
        statedProfitPct: o.profitPct, statedLossPct: o.lossPct,
      },
    };
    return { def: o, engine, dto };
  });
}

/** YTD treatment-map reclass totals for the assumptions page (sums of provider figures; no tax math). */
function reclassOf(pl: TaxBasisPl): EstimateEntityReclassDTO {
  return {
    ownerSehi: pl.ownerLevel.ownerSehi, ownerRetirement: pl.ownerLevel.ownerRetirement, ownerPersonalDropped: pl.ownerLevel.ownerPersonalDropped,
    sehiAsW2Wages: pl.ownerLevel.sehiAsW2Wages, guaranteedPayments: dSum(pl.guaranteedPayments.map((x) => x.amount)),
    nondeductibleAddBack: pl.nondeductibleAddBack, estimatedTaxPayments: dSum(pl.estimatedPayments.map((x) => x.amount)),
    taxDepreciationBook: dSum(pl.taxDepreciationDiffers.map((x) => x.bookAmount)),
  };
}

async function adjustmentMonths(
  scope: FirmScope, req: EstimateRequest, g: Gathered, runs: EntityRun[], today: Date, warnings: TaxEstimatorWarning[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (const a of g.adjustments) {
    if (!a.glLinked) { out.set(a.id, a.monthly); continue; }
    if (!a.tenantId || !a.companyId || !a.accountId || !isTenantInScope(scope, a.tenantId)) {
      warnings.push({ code: 'TE_TENANT_NOT_MANAGED', severity: 'warning', message: `Adjustment "${a.label || a.adjustmentTypeName}" reads an account in a client the firm no longer manages (or you can no longer reach); only its manual amount is used.`, details: { adjustmentId: a.id } });
      out.set(a.id, a.amount == null ? new Array<number>(MONTHS_PER_YEAR).fill(0) : a.monthly);
      continue;
    }
    const run = runs.find((r) => r.company.tenantId === a.tenantId && r.company.companyId === a.companyId && r.pl);
    const through = run?.pl?.throughMonth ?? req.throughMonth ?? lastCompleteMonth(today);
    const throughIdx = monthIndex(through, req.taxYear);
    let basis: TaxMethod | undefined = run?.pl?.basis;
    if (!basis) {
      try {
        const settings = await getEntitySettings(scope, a.tenantId, a.companyId, req.taxYear);
        basis = settings.resolved.taxMethod;
      } catch (err) {
        // R3-10: a deleted / unreadable company degrades this ONE adjustment to its manual
        // amount (like every other per-entity failure) instead of failing the estimate.
        if (!(err instanceof AppError)) throw err;
        warnings.push({ code: 'TE_ADJUSTMENT_ACCOUNT_UNREADABLE', severity: 'warning', message: `Adjustment "${a.label || a.adjustmentTypeName}" reads an account whose company could not be read (${err.message}); only its manual amount is used.`, details: { adjustmentId: a.id } });
        out.set(a.id, a.amount == null ? new Array<number>(MONTHS_PER_YEAR).fill(0) : a.monthly);
        continue;
      }
    }
    const actuals = await glMonthlyActuals(a.tenantId, a.companyId, a.accountId, req.taxYear, throughIdx, basis);
    // R7-05: a non-recurring adjustment (row or type flag) is never run-rated to year end.
    const nonRecurring = a.nonRecurring || g.types.some((t) => t.id === a.adjustmentTypeId && t.nonRecurring);
    out.set(a.id, allocateAdjustment({ amount: a.amount, cadence: a.cadence, startMonth: a.startMonth, endMonth: a.endMonth, glLinked: true, nonRecurring }, req.taxYear, { throughMonth: throughIdx, glActuals: actuals }));
  }
  return out;
}

function periodPersons(persons: EnginePerson[], months: number): EnginePerson[] {
  return persons.map((p) => ({
    ...p,
    w2Wages: prorate(p.w2Wages, months),
    w2SocialSecurityWages: prorateNullable(p.w2SocialSecurityWages, months),
    retirementEmployeeDeferral: prorateNullable(p.retirementEmployeeDeferral, months),
    hsaContribution: prorate(p.hsaContribution, months),
    sch1a: { qualifiedTips: prorate(p.sch1a.qualifiedTips, months), qualifiedOvertime: prorate(p.sch1a.qualifiedOvertime, months), carLoanInterest: prorate(p.sch1a.carLoanInterest, months) },
  }));
}

function periodYear(y: EngineYearInputs, months: number): EngineYearInputs {
  const i = y.itemized;
  return {
    ...y,
    itemized: { saltPaid: prorate(i.saltPaid, months), mortgageInterest: prorate(i.mortgageInterest, months), charitableCash: prorate(i.charitableCash, months), charitableNoncash: prorate(i.charitableNoncash, months), other: prorate(i.other, months) },
    unrecaptured1250Gain: prorate(y.unrecaptured1250Gain, months),
    collectiblesGain: prorate(y.collectiblesGain, months),
  };
}

function farmerYearFromManual(y: FarmerGrossYearDTO, persons: PersonDTO[]): FarmerYearGross {
  return {
    byPerson: persons.filter((p) => (p.role === 'primary' ? y.primary : y.spouse)).map((p) => {
      const v = (p.role === 'primary' ? y.primary : y.spouse)!;
      return { personId: p.id, farming: String(v.farming ?? 0), fishing: String(v.fishing ?? 0), totalGross: String(v.totalGross ?? 0) };
    }),
  };
}

/** Phase 10b fallback when no manual figures: books gross farming income (run-rated to the full year), other income at its net amount. */
function farmerYearFromBooks(runs: EntityRun[], farmIds: Set<string>, federal: FederalResult, persons: PersonDTO[]): FarmerYearGross {
  const farming = new Map<string, DecJs>(persons.map((p) => [p.id, new Decimal(0)]));
  for (const r of runs) {
    if (!r.engine || !r.pl || !farmIds.has(r.engine.companyId)) continue;
    const months = r.pl.monthsElapsed + r.pl.monthsRemaining;
    const ytd = new Decimal(r.pl.farmingGrossIncome.currentYear);
    const full = r.pl.monthsElapsed > 0 ? ytd.times(months).dividedBy(r.pl.monthsElapsed) : ytd;
    const own = r.engine.links;
    for (const l of own) {
      const pct = l.profitPct == null ? (own.length === 1 ? 100 : 0) : l.profitPct;
      farming.set(l.personId, (farming.get(l.personId) ?? new Decimal(0)).plus(full.times(pct).dividedBy(100)));
    }
  }
  const farmNet = dSum(federal.entities.filter((e) => farmIds.has(e.companyId)).flatMap((e) => e.shares.map((s) => sumCharacters(s.share))));
  const otherNet = Decimal.max(new Decimal(0), new Decimal(federal.exact.totalIncome).minus(farmNet));
  const primary = persons.find((p) => p.role === 'primary') ?? persons[0]!;
  return {
    byPerson: persons.map((p) => {
      const f = farming.get(p.id) ?? new Decimal(0);
      const total = p.id === primary.id ? f.plus(otherNet) : f;
      return { personId: p.id, farming: f.toFixed(4), fishing: '0', totalGross: total.toFixed(4) };
    }),
  };
}

/**
 * R3-09: prior-year farmer leg from the books. Farming gross = the provider's prior-year
 * farming income of each farm entity (a complete year, not run-rated) split by the
 * CURRENT link percentages; total gross = farming gross + the prior-year AGI on the
 * primary (AGI already contains the farm's net, so the ratio is understated — a taxpayer
 * who fails this leg can still enter real figures). Null when there is nothing to test.
 */
function farmerPriorYearFromBooks(runs: EntityRun[], farmIds: Set<string>, priorYearAgi: string | null, persons: PersonDTO[]): FarmerYearGross | null {
  if (priorYearAgi == null || farmIds.size === 0) return null;
  const farming = new Map<string, DecJs>(persons.map((p) => [p.id, new Decimal(0)]));
  let any = false;
  for (const r of runs) {
    if (!r.engine || !r.pl || !farmIds.has(r.engine.companyId)) continue;
    const prior = new Decimal(r.pl.farmingGrossIncome.priorYear);
    if (prior.isZero()) continue;
    any = true;
    const own = r.engine.links;
    for (const l of own) {
      const pct = l.profitPct == null ? (own.length === 1 ? 100 : 0) : l.profitPct;
      farming.set(l.personId, (farming.get(l.personId) ?? new Decimal(0)).plus(prior.times(pct).dividedBy(100)));
    }
  }
  if (!any) return null;
  const primary = persons.find((p) => p.role === 'primary') ?? persons[0]!;
  const agi = Decimal.max(new Decimal(0), new Decimal(priorYearAgi));
  return {
    byPerson: persons.map((p) => {
      const f = farming.get(p.id) ?? new Decimal(0);
      return { personId: p.id, farming: f.toFixed(4), fishing: '0', totalGross: (p.id === primary.id ? f.plus(agi) : f).toFixed(4) };
    }),
  };
}

const toEnginePayment = (p: EstimatePaymentDTO): EstimatePayment => ({
  id: p.id, date: p.date!, amount: p.amount, source: p.source, jurisdiction: p.jurisdiction, transactionId: p.transactionId, memo: p.memo,
});

function overpaymentFor(payments: EstimatePaymentDTO[], jurisdiction: string): { amount: string } | null {
  const rows = payments.filter((p) => p.jurisdiction === jurisdiction && p.source === 'prior_year_overpayment' && !p.date);
  return rows.length ? { amount: dSum(rows.map((r) => r.amount)) } : null;
}

async function assemble(scope: FirmScope, req: EstimateRequest, g: Gathered, opts: EstimateOptions, today: Date, hash: string): Promise<EstimateResultDTO> {
  const warnings: TaxEstimatorWarning[] = [...g.warnings];
  const taxYear = req.taxYear;
  const filingStatus = g.taxpayerFilingStatus;
  const parameters = parameterMapFromRows(g.paramsDto.parameters);
  const y = g.year.year;

  // Entities.
  const runs = await runEntities(scope, req, g, opts, today, warnings);
  const individual = runs.filter((r) => r.engine) as Array<EntityRun & { engine: EngineEntity; pl: TaxBasisPl }>;
  // Q45: businesses outside MyBooks join the same engine input (C corps go to the entity-level path).
  const outsideRuns = runOutside(g);
  const outsideIndividual = outsideRuns.filter((r) => r.dto.path === 'individual');
  const engineEntities = [...individual.map((r) => r.engine), ...outsideIndividual.map((r) => r.engine)];
  const individualLinkIds = new Set(engineEntities.flatMap((e) => e.links.map((l) => l.linkId)));

  // Adjustments (GL-linked: actuals through the entity's month + plan / run-rate).
  const months = await adjustmentMonths(scope, req, g, runs, today, warnings);
  const typeById = new Map(g.types.map((t) => [t.id, t]));
  const usable = g.adjustments.filter((a) => {
    if (!typeById.has(a.adjustmentTypeId)) {
      warnings.push({ code: 'TE_ADJUSTMENT_TYPE_MISSING', severity: 'warning', message: `Adjustment "${a.label}" has an unknown type; left out.`, details: { adjustmentId: a.id } });
      return false;
    }
    if (a.linkId && !individualLinkIds.has(a.linkId)) {
      warnings.push({ code: 'TE_ADJUSTMENT_LINK_EXCLUDED', severity: 'warning', message: `Adjustment "${a.label || a.adjustmentTypeName}" belongs to an entity that is not in this estimate (out of scope, C corporation or skipped); left out.`, details: { adjustmentId: a.id } });
      return false;
    }
    return true;
  });
  const adjustmentsFor = (periodMonths: number | null) => usable.map((a) => {
    const m = months.get(a.id) ?? a.monthly;
    const monthly = periodMonths == null ? m : m.map((v, i) => (i < periodMonths ? v : 0));
    return engineAdjustmentFromDto({ ...a, monthly }, typeById.get(a.adjustmentTypeId)!);
  });

  // Federal.
  const persons = g.persons.map((p) => enginePersonFromDto(p, y, personYearInputsFromDto(y, p.role)));
  const engineYear = engineYearFromDto(y);
  const engineDependents = g.dependents.map(engineDependentFromDto);
  const federalInput: FederalEngineInput = {
    taxYear, filingStatus, parameters, persons, dependents: engineDependents, entities: engineEntities, adjustments: adjustmentsFor(null), year: engineYear,
    qbi: { manualDeduction: null },
    otherTaxes: { additionalMedicareTax: null, niit: null, niiAllocableDeductions: y.niiAllocableDeductions ?? null },
  };
  const federal = runEngine(() => computeFederal(federalInput));

  // Schedule AI period actuals (snapshot → provider through the period month → unavailable).
  const periods = await schAiPeriods(taxYear);
  const periodActuals: Array<FederalEngineInput | null> = [];
  const scheduleAi: SchAiPeriodSourceDTO[] = [];
  let prorated = false;
  for (const p of periods) {
    let snapshotEntities = 0;
    let liveEntities = 0;
    let available = individual.length > 0 || outsideIndividual.length > 0;
    const ents: EngineEntity[] = [];
    for (const r of individual) {
      if (!available) break;
      const snap = g.snapshots.get(`${p.periodIndex}|${r.engine.tenantId}|${r.engine.companyId}`);
      // Q46: a period column uses actuals only — never the prior-year trend.
      if (snap) { ents.push({ ...r.engine, ...snap, priorYearTrend: undefined }); snapshotEntities++; continue; }
      if (r.pl.throughMonth < p.periodMonth) { available = false; break; }
      const ppl = r.pl.throughMonth === p.periodMonth ? r.pl
        : await getTaxBasisPl(scope, { tenantId: r.engine.tenantId, companyId: r.engine.companyId, taxYear, throughMonth: p.periodMonth }, { today, skipCache: opts.skipProviderCache });
      ents.push({ ...r.engine, ...periodFiguresFromPl(ppl, p.months), priorYearTrend: undefined });
      liveEntities++;
    }
    // Q45: outside businesses — full-year entries spread evenly; YTD entries prorated up to their
    // through month (a later period end makes the column unavailable, like books not reaching it).
    for (const r of outsideIndividual) {
      if (!available) break;
      const pe = outsidePeriodEntity(r.engine, p.months);
      if (!pe) { available = false; break; }
      ents.push(pe);
    }
    if (!available) {
      periodActuals.push(null);
      scheduleAi.push({ periodIndex: p.periodIndex, periodEnd: p.periodEnd, source: 'unavailable', snapshotEntities: 0, liveEntities: 0 });
      continue;
    }
    const pp = periodPersons(persons, p.months);
    const py = periodYear(engineYear, p.months);
    const nonZero = (v: string | null) => v != null && Number(v) !== 0;
    if (persons.some((x) => nonZero(x.w2Wages) || nonZero(x.sch1a.qualifiedTips) || nonZero(x.sch1a.qualifiedOvertime) || nonZero(x.sch1a.carLoanInterest))
      || Object.values(engineYear.itemized).some(nonZero)) prorated = true;
    periodActuals.push({ ...federalInput, persons: pp, entities: ents, adjustments: adjustmentsFor(p.months), year: py });
    scheduleAi.push({
      periodIndex: p.periodIndex, periodEnd: p.periodEnd, snapshotEntities, liveEntities,
      source: snapshotEntities > 0 && liveEntities > 0 ? 'mixed' : snapshotEntities > 0 ? 'snapshot' : 'live',
      ...(outsideIndividual.length > 0 ? { outsideEntities: outsideIndividual.length } : {}),
    });
  }
  if (prorated) {
    warnings.push({ code: 'TE_SCH_AI_INPUTS_PRORATED', severity: 'info', message: 'Schedule AI: full-year person inputs (outside W-2 wages, Schedule 1-A amounts, itemized deductions) were prorated by months to each period end.' });
  }

  // Farmer / fisherman (§6654(i)).
  // R3-05: the entity override is tri-state. `false` ("not a farmer") is honoured: that
  // entity is never a farm source, and an explicit false anywhere wins over a true elsewhere
  // (warned) — the conservative choice, regular quarterly installments.
  const overrideOf = (r: EntityRun) => r.company.settings.settings.farmerOverride;
  const farmIds = new Set(individual
    .filter((r) => overrideOf(r) !== false && (r.engine.entityType === 'sch_f' || overrideOf(r) === true))
    .map((r) => r.engine.companyId));
  const anyTrue = runs.some((r) => overrideOf(r) === true);
  const anyFalse = runs.some((r) => overrideOf(r) === false);
  const farmerOverride: boolean | null = anyFalse ? false : anyTrue ? true : null;
  if (anyFalse && (anyTrue || farmIds.size > 0)) {
    warnings.push({ code: 'TE_FARMER_OVERRIDE_CONFLICT', severity: 'warning', message: 'One linked entity is marked "not a farmer" while another is a farm (Schedule F or marked "farmer"); the "not a farmer" override was applied to the taxpayer, so the regular installment rules are used.' });
  }
  const fg = y.farmerGross ?? {};
  // Q45: an outside Schedule F has no gross-income figures, so it never makes the farmer test run on
  // its own; with manual gross figures on the annual settings the test runs as usual.
  if (outsideIndividual.some((r) => r.engine.entityType === 'sch_f') && !fg.current) {
    warnings.push({ code: 'TE_OUTSIDE_FARM_GROSS_MANUAL', severity: 'info', message: 'A Schedule F business outside MyBooks is not tested for the farmer / fisherman rules automatically (no gross-income figures). Enter the gross-income figures on the annual settings to apply the test.' });
  }
  let farmer: FarmerResult | null = null;
  if (farmIds.size > 0 || fg.current || fg.prior || farmerOverride !== null) {
    const currentYear = fg.current ? farmerYearFromManual(fg.current, g.persons) : farmerYearFromBooks(runs, farmIds, federal, g.persons);
    if (!fg.current) warnings.push({ code: 'TE_FARMER_GROSS_FROM_BOOKS', severity: 'info', message: 'Farmer test: gross farming income comes from the books (run-rated to the full year) and other income at its net amount. Enter the gross-income figures on the annual settings to confirm.' });
    // R3-09: without manual prior-year figures, the prior-year leg uses the provider's
    // prior-year farming gross from the books and the prior-year AGI (conservative).
    let priorYear: FarmerYearGross | null = fg.prior ? farmerYearFromManual(fg.prior, g.persons) : null;
    if (!priorYear) {
      priorYear = farmerPriorYearFromBooks(runs, farmIds, y.priorYearAgi, g.persons);
      if (priorYear) {
        warnings.push({ code: 'TE_FARMER_PRIOR_GROSS_FROM_BOOKS', severity: 'info', message: 'Farmer test, prior year: gross farming income comes from the books; total gross income is approximated as that farming income plus the prior-year AGI (conservative). Enter the prior-year gross-income figures on the annual settings to confirm.' });
      } else {
        warnings.push({ code: 'TE_FARMER_PRIOR_GROSS_MISSING', severity: 'info', message: 'Farmer test: no prior-year gross-income figures were entered and the books have no prior-year farming income (or no prior-year AGI is on file), so only the current year was tested.' });
      }
    }
    const primary = g.persons.find((p) => p.role === 'primary') ?? g.persons[0]!;
    farmer = runEngine(() => computeFarmer({
      taxYear, filingStatus, parameters, primaryPersonId: primary.id, currentYear, priorYear,
      farmerOverride, isFisherman: y.isFisherman ?? false,
      tax: { currentYearTax: federal.federalTotal, priorYearTax: y.priorYearTax, priorYearFullTwelveMonths: y.priorYearTwelveMonths && y.priorYearFiled, priorYearAgi: y.priorYearAgi },
    }));
  }
  const farmerRules = farmer?.qualifies === true;

  // Federal vouchers. Q34: the ROUNDED federal total is the current-year tax.
  const ledgerPayments = g.ledger.payments;
  const enginePayments = ledgerPayments.filter((p) => p.date).map(toEnginePayment);
  const priorYear = { tax: y.priorYearTax, agi: y.priorYearAgi, twelveMonths: y.priorYearTwelveMonths, filed: y.priorYearFiled };
  const federalEstimates = runEngine(() => computeFederalEstimates({
    taxYear, filingStatus, parameters, currentYearTax: federal.federalTotal, currentYearAgi: federal.exact.agi,
    withholding: String(y.withholding.federal ?? 0), priorYear, rule: g.year.rule, ruleSource: g.year.ruleSource,
    payments: enginePayments, priorYearOverpayment: overpaymentFor(ledgerPayments, FEDERAL),
    scheduleAi: farmerRules ? null : { base: federalInput, baseResult: federal, periodActuals, calc: computeFederal },
    policies: farmerRules ? { safeHarbor: FARMER_SAFE_HARBOR_POLICY, installments: FARMER_INSTALLMENT_POLICY, schAi: null } : undefined,
  }));

  // States. Q34: the ROUNDED net state tax is each state's current-year tax.
  let state: StateResult | null = null;
  const stateEstimates: JurisdictionEstimate[] = [];
  if (g.stateRows.length > 0) {
    const jurisdictions = g.stateRules.map(jurisdictionFromStateRules);
    const gateOf = (r: StateRowForEngine): Partial<StateGateInputs> => ({
      withholding: r.dto.withholding ?? String(y.withholding.states?.[r.dto.state] ?? 0),
      credits: r.dto.otherCredits ?? '0',
      priorYearLiability: r.priorYearTax,
      grossIncome: r.dto.grossIncome ?? null,
      priorYearGrossIncome: r.dto.priorYearGrossIncome ?? null,
      nonWithheldIncome: r.dto.nonWithheldIncome ?? null,
      exemptions: r.dto.exemptions ?? null,
      deductions: r.dto.stateDeductions ?? null,
    });
    const rows = g.stateRows.map((r) => stateRowFromDto(r.dto, gateOf(r)));
    const sourcing = [
      ...individual.map((r) => ({ companyId: r.engine.companyId, stateSourcing: r.company.settings.settings.stateSourcing })),
      ...outsideIndividual.map((r) => ({ companyId: r.def.id, stateSourcing: r.def.stateSourcing })),
    ];
    state = runEngine(() => computeState({
      taxYear, filingStatus, parameters, federal: federalFiguresFromResult(federal), rows, jurisdictions, entities: sourcedEntitiesFromFederal(federal, sourcing),
      // Q44: personal exemptions count the filers (two on a joint return, whether or not the spouse is on file),
      // dependent exemptions the dependents active this year.
      household: { filers: filingStatus === 'mfj' ? JOINT_RETURN_FILERS : 1, dependents: activeDependents(engineDependents, taxYear).length },
    }));
    for (const rr of state.rows) {
      const src = g.stateRows.find((r) => r.dto.state === rr.state)!;
      const engineRow = rows.find((r) => r.state === rr.state)!;
      let priorAgi = src.priorYearAgi;
      if (priorAgi == null && y.priorYearAgi != null) {
        priorAgi = y.priorYearAgi;
        warnings.push({ code: 'TE_STATE_PRIOR_AGI_FEDERAL_PROXY', severity: 'info', message: `${rr.state}: no prior-year state AGI on file; the prior-year federal AGI was used for the state's high-AGI test.`, details: { state: rr.state } });
      }
      stateEstimates.push(runEngine(() => computeStateEstimates({
        taxYear, filingStatus, parameters, state: rr.state, jurisdiction: jurisdictions.find((j) => j.state === rr.state) ?? null,
        stateTax: rr.netTax, currentYearAgi: federal.exact.agi, gate: rr.gate, withholding: engineRow.gate.withholding,
        priorYear: { tax: src.priorYearTax, agi: priorAgi, twelveMonths: y.priorYearTwelveMonths, filed: y.priorYearFiled },
        rule: g.year.rule, ruleSource: g.year.ruleSource, payments: enginePayments, priorYearOverpayment: overpaymentFor(ledgerPayments, rr.state),
      })));
    }
  }
  const stateJurisdictions = new Set(g.stateRows.map((r) => r.dto.state));
  const orphanPayments = ledgerPayments.filter((p) => p.jurisdiction !== FEDERAL && !stateJurisdictions.has(p.jurisdiction));
  if (orphanPayments.length > 0) {
    warnings.push({ code: 'TE_PAYMENT_STATE_NOT_IN_SCENARIO', severity: 'warning', message: `Payments to ${[...new Set(orphanPayments.map((p) => p.jurisdiction))].join(', ')} are on file but the scenario has no state row for them; they are not applied.` });
  }

  // C corporations (entity level). Prior-year tax, look-back taxable incomes and state
  // apportionment are not stored yet (Q34): current-year rule, no state tax.
  const ccorps: CcorpResult[] = [];
  for (const r of runs.filter((x) => x.dto.path === 'c_corp' && x.pl)) {
    const pl = r.pl!;
    const taxable = sumCharacters(projectCharacters(pl.byCharacter, pl.recurring, pl.monthsElapsed, pl.monthsRemaining));
    try {
      ccorps.push(runEngine(() => computeCcorp({
        taxYear, parameters, tenantId: pl.tenantId, companyId: pl.companyId, companyName: pl.companyName,
        fiscalYearStartMonth: r.company.settings.resolved.fiscalYearStartMonth, taxableIncome: taxable,
        largeCorporation: r.company.settings.settings.largeCorporation, priorYearsTaxableIncome: null, priorYear: null, states: [],
      })));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      warnings.push({ code: err.code ?? 'TE_CCORP_FAILED', severity: 'warning', message: `${pl.companyName}: ${err.message}`, details: { companyId: pl.companyId } });
    }
  }
  // Q45: an outside C corporation — entity level on the entered taxable income (projected for YTD entry),
  // calendar year, not a large corporation.
  for (const r of outsideRuns.filter((x) => x.dto.path === 'c_corp')) {
    const taxable = sumCharacters(projectCharacters(r.engine.ytd, r.engine.recurringYtd, r.engine.monthsElapsed, r.engine.monthsRemaining));
    try {
      ccorps.push(runEngine(() => computeCcorp({
        taxYear, parameters, tenantId: OUTSIDE_TENANT_ID, companyId: r.def.id, companyName: r.def.name,
        fiscalYearStartMonth: 1, taxableIncome: taxable, largeCorporation: false, priorYearsTaxableIncome: null, priorYear: null, states: [],
      })));
      warnings.push({ code: 'TE_OUTSIDE_CCORP_DEFAULTS', severity: 'info', message: `${r.def.name} (outside MyBooks): estimated as a calendar-year C corporation that is not a large corporation, on the entered taxable income.`, details: { outsideEntityId: r.def.id } });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      warnings.push({ code: err.code ?? 'TE_CCORP_FAILED', severity: 'warning', message: `${r.def.name}: ${err.message}`, details: { outsideEntityId: r.def.id } });
    }
  }
  if (ccorps.length > 0) {
    warnings.push({ code: 'TE_CCORP_INPUTS_LIMITED', severity: 'warning', message: 'C corporation estimates use the current-year rule only and no state tax: prior-year tax, prior taxable incomes and state apportionment are not stored yet.' });
  }

  const stateTotal = state ? state.stateTotal : '0';
  const statePenalty = dSum(stateEstimates.map((e) => e.penalty?.total ?? '0'));
  const allWarnings = dedupeWarnings([
    ...warnings, ...federal.warnings, ...(state?.warnings ?? []), ...federalEstimates.warnings,
    ...stateEstimates.flatMap((e) => e.warnings), ...(farmer?.warnings ?? []), ...ccorps.flatMap((c) => c.warnings),
  ]);
  return {
    taxpayerId: req.taxpayerId, taxYear, scenarioId: req.scenarioId, scenarioName: g.scenarioName, filingStatus,
    engineVersion: TAX_ENGINE_VERSION, computedAt: new Date().toISOString(), cached: false, inputsHash: hash,
    safeHarborRule: g.year.rule, safeHarborRuleSource: g.year.ruleSource,
    entities: [...runs.map((r) => r.dto), ...outsideRuns.map((r) => r.dto)], federal, state, federalEstimates, stateEstimates, farmer, ccorps,
    payments: ledgerPayments, scheduleAi,
    summary: {
      // The combined total rounds the UNROUNDED sum (oracle `total`), not the sum of the rounded lines.
      federalTotal: federal.federalTotal, stateTotal, total: R(dAdd(federal.exact.federalTotal, state ? state.exact.stateTotal : '0')),
      federalRequiredAnnualPayment: federalEstimates.safeHarbor.requiredAnnualPayment, federalUnpaid: federalEstimates.totals.unpaid,
      federalPenalty: federalEstimates.penalty?.total ?? '0', statePenalty: R(statePenalty), marginalRate: federal.regularTax.marginalOrdinaryRate,
    },
    warnings: allWarnings,
    parametersUsed: uniqueParams([
      federal.parametersUsed, state?.parametersUsed ?? [], federalEstimates.parametersUsed, ...stateEstimates.map((e) => e.parametersUsed),
      farmer?.parametersUsed ?? [], ...ccorps.map((c) => c.parametersUsed),
    ]),
    rulesUsed: uniqueRules([state?.rulesUsed ?? [], ...stateEstimates.map((e) => e.rulesUsed)]),
    adjustments: usable.map((a): EstimateAdjustmentSummaryDTO => {
      const t = typeById.get(a.adjustmentTypeId)!;
      return {
        id: a.id, label: a.label, typeName: t.name, typeCode: t.code ?? null, kind: t.kind,
        fullYearAmount: dSum((months.get(a.id) ?? a.monthly).map((v) => String(v))), monthly: [...(months.get(a.id) ?? a.monthly)], cadence: a.cadence, glLinked: a.glLinked,
        nonRecurring: a.nonRecurring, personId: a.personId, linkId: a.linkId,
      };
    }),
    disclaimerText: g.firmSettings.effectiveDisclaimerText,
    portalShows: (g.taxpayer.portalShows as PortalShows | null) ?? g.firmSettings.portalShows,
    firmSafeHarborDefault: g.firmSettings.safeHarborDefault,
  };
}

/** Assemble + attach the assumptions block (Phase 12): one place, so the cache, the snapshot and the PDF agree. */
async function assembleWithAssumptions(scope: FirmScope, req: EstimateRequest, g: Gathered, opts: EstimateOptions, today: Date, hash: string): Promise<EstimateResultDTO> {
  const result = await assemble(scope, req, g, opts, today, hash);
  return { ...result, assumptions: buildEstimateAssumptions(result, { disclaimerText: result.disclaimerText }) };
}

// ── Encrypted estimate cache (D9) ───────────────────────────────────────
// The cached estimate contains prior-year tax / AGI and figures derived from them
// (safe-harbor amounts, required payments): tax return information. Redis holds only
// AES-256-GCM ciphertext (utils/encryption.ts); a value that does not decrypt — a
// rotated key or a pre-v2 plaintext entry — is a cache miss, never an error.

export function estimateCacheKey(scope: FirmScope, req: Pick<EstimateRequest, 'taxpayerId' | 'scenarioId'>, hash: string): string {
  return `te:estimate:${CACHE_VERSION}:${scope.firmId}:${req.taxpayerId}:${req.scenarioId}:${hash}`;
}

async function cacheGetEstimate(key: string): Promise<EstimateResultDTO | null> {
  const hit = await tbCacheGet<{ enc?: unknown }>(key);
  if (!hit || typeof hit.enc !== 'string') return null;
  try {
    return JSON.parse(decrypt(hit.enc)) as EstimateResultDTO;
  } catch {
    return null;
  }
}

async function cacheSetEstimate(key: string, result: EstimateResultDTO): Promise<void> {
  await tbCacheSet(key, { enc: encrypt(JSON.stringify(result)) });
}

/** POST .../estimate — live compute, Redis-cached by GL stamps + inputs hash. */
export async function computeEstimate(scope: FirmScope, req: EstimateRequest, opts: EstimateOptions = {}): Promise<EstimateResultDTO> {
  return (await computeEstimateWithInputs(scope, req, opts)).result;
}

/** What the estimate read, for the immutable snapshot (Phase 12). Server-internal: holds DECRYPTED prior-year figures. */
export interface EstimateInputsForSnapshot {
  taxpayer: TaxpayerRow;
  firmSettings: FirmSettingsDTO;
  scenarioName: string;
  year: Gathered['year'];
  persons: PersonDTO[];
  dependents: DependentDTO[];
  links: LinkDTO[];
  /** Q45: outside businesses with the year's amounts, as used. */
  outsideEntities: OutsideEntityDTO[];
  companies: Array<{
    tenantId: string; companyId: string; companyName: string | null; glVersionStamp: number; configVersion: string; settings: EntitySettingsResponse;
    /** Q46: present only when a prior-year method was selected — the method and the PY figures used. */
    projectionMethod?: ProjectionMethod; priorYear?: PriorYearTrendInputs | null;
  }>;
  adjustments: AdjustmentDTO[];
  types: AdjustmentTypeDTO[];
  stateRows: StateRowForEngine[];
  federalParameters: Gathered['paramsDto'];
  stateRules: StateRulesDTO[];
  payments: EstimatePaymentDTO[];
  schAiFigures: Array<{ key: string; figures: SchAiFigures }>;
}

/** Live compute plus the inputs it read. `req.refresh` bypasses (but still refills) the encrypted cache. */
export async function computeEstimateWithInputs(
  scope: FirmScope, req: EstimateRequest, opts: EstimateOptions = {},
): Promise<{ result: EstimateResultDTO; inputs: EstimateInputsForSnapshot }> {
  const today = opts.today ?? new Date();
  // D18: a user on the taxpayer's staff list reads it with its linked tenants (full data).
  scope = await scopeForTaxpayer(scope, req.taxpayerId);
  const g = withPaymentsAsOf(await gather(scope, req), opts.paymentsAsOf);
  const hash = inputsHash(scope, req, g, today);
  const inputs: EstimateInputsForSnapshot = {
    taxpayer: g.taxpayer, firmSettings: g.firmSettings, scenarioName: g.scenarioName, year: g.year, persons: g.persons, dependents: g.dependents, links: g.links,
    outsideEntities: g.outside,
    companies: g.companies.map((c) => ({
      tenantId: c.tenantId, companyId: c.companyId, companyName: c.companyName, glVersionStamp: c.glVersionStamp, configVersion: c.configVersion, settings: c.settings,
      ...(c.projectionMethod !== 'run_rate' ? { projectionMethod: c.projectionMethod, priorYear: c.priorYear } : {}),
    })),
    adjustments: g.adjustments, types: g.types, stateRows: g.stateRows, federalParameters: g.paramsDto, stateRules: g.stateRules,
    payments: g.ledger.payments, schAiFigures: [...g.snapshots.entries()].map(([key, figures]) => ({ key, figures })),
  };
  const key = estimateCacheKey(scope, req, hash);
  if (!req.refresh) {
    const hit = await cacheGetEstimate(key);
    if (hit) return { result: { ...hit, cached: true }, inputs };
  }
  const result: EstimateResultDTO = { ...(await assembleWithAssumptions(scope, req, g, opts, today, hash)), elevatedAccess: isElevated(scope) };
  await cacheSetEstimate(key, result);
  return { result, inputs };
}

/** QA D13: drop payments dated after `asOf` (not paid yet as of that day). */
function withPaymentsAsOf(g: Gathered, asOf: string | undefined): Gathered {
  if (!asOf) return g;
  const later = g.ledger.payments.filter((p) => p.date != null && p.date > asOf);
  if (later.length === 0) return g;
  return {
    ...g,
    ledger: { ...g.ledger, payments: g.ledger.payments.filter((p) => p.date == null || p.date <= asOf) },
    warnings: [...g.warnings, {
      code: 'TE_PAYMENTS_AFTER_AS_OF', severity: 'info',
      message: `${later.length} payment(s) dated after ${asOf} are not counted as paid yet.`,
      details: { asOf, count: later.length },
    }],
  };
}

// ── Snapshot readiness ──────────────────────────────────────────────────

/**
 * GET .../readiness — can this year's estimate be finalized: books readiness per in-scope
 * linked company, links that left the scope (D1), and which Schedule AI columns are
 * reached, closed and frozen by snapshots.
 */
export async function getEstimateReadiness(
  scope: FirmScope, taxpayerId: string, taxYear: number, opts: { today?: Date; throughMonth?: string } = {},
): Promise<EstimateReadinessDTO> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  scope = await scopeForTaxpayer(scope, taxpayerId); // D18
  const today = opts.today ?? new Date();
  const links = (await listLinks(scope, taxpayerId, taxYear)).data;
  const warnings: TaxEstimatorWarning[] = [];
  const byCompany = new Map<string, { tenantId: string; companyId: string; companyName: string | null; count: number; inScope: boolean }>();
  for (const l of links) {
    const k = `${l.tenantId}|${l.companyId}`;
    const inScope = !l.outOfScope && isTenantInScope(scope, l.tenantId);
    const prev = byCompany.get(k);
    if (prev) prev.count++;
    else byCompany.set(k, { tenantId: l.tenantId, companyId: l.companyId, companyName: inScope ? l.companyName : null, count: 1, inScope });
  }
  const entities: EstimateReadinessEntityDTO[] = [];
  const viaList = (tenantId: string) => (scope.elevation && !scope.elevation.baseTenantIds.includes(tenantId) ? { viaStaffList: true } : {});
  let outOfScopeLinks = 0;
  for (const c of byCompany.values()) {
    if (!c.inScope) {
      outOfScopeLinks += c.count;
      const w = scopeWarningForLink(scope, c.tenantId, 'A linked company');
      if (w) warnings.push(w);
      entities.push({ tenantId: c.tenantId, companyId: c.companyId, companyName: null, linkCount: c.count, inScope: false, readiness: null, error: null });
      continue;
    }
    try {
      // QA D20: the range the summary is showing ("Actuals through"), else each entity's default.
      const readiness = await getReadiness(scope, { tenantId: c.tenantId, companyId: c.companyId, taxYear, throughMonth: opts.throughMonth }, { today });
      warnings.push(...readiness.warnings.map((w) => ({ ...w, details: { ...(w.details ?? {}), companyId: c.companyId } })));
      // Q46: a selected prior-year method that would fall back to the run rate.
      const trend = await priorYearTrendReadinessWarning(scope, { ...c, entityType: readiness.entity.entityType ?? null }, taxYear, opts.throughMonth, { today });
      if (trend) warnings.push(trend);
      entities.push({ tenantId: c.tenantId, companyId: c.companyId, companyName: c.companyName, linkCount: c.count, inScope: true, readiness, error: null, ...viaList(c.tenantId) });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      entities.push({ tenantId: c.tenantId, companyId: c.companyId, companyName: c.companyName, linkCount: c.count, inScope: true, readiness: null, error: err.message, ...viaList(c.tenantId) });
      warnings.push({ code: err.code ?? 'TE_READINESS_FAILED', severity: 'warning', message: `${c.companyName ?? 'A linked company'}: ${err.message}` });
    }
  }
  const individual = entities.filter((e) => e.inScope && e.readiness && e.readiness.entity.entityType && e.readiness.entity.entityType !== 'c_corp');
  const snapshots = await listSnapshots(scope, taxpayerId, taxYear);
  const complete = lastCompleteMonth(today);
  const schAiPeriods_: EstimateReadinessPeriodDTO[] = (await schAiPeriods(taxYear)).map((p) => ({
    periodIndex: p.periodIndex, periodEnd: p.periodEnd, periodMonth: p.periodMonth, reached: p.periodMonth <= complete,
    closedForAllEntities: individual.length > 0 && individual.every((e) => (e.readiness!.lastClosedMonth ?? '') >= p.periodMonth),
    snapshotsCaptured: snapshots.filter((s) => s.periodIndex === p.periodIndex && individual.some((e) => e.tenantId === s.tenantId && e.companyId === s.companyId)).length,
    entitiesExpected: individual.length,
  }));
  // Q45: outside businesses are entered by hand — never "not closed"; one info line each.
  for (const o of (await listOutsideEntities(scope, taxpayerId, taxYear)).data) {
    if (!o.year) continue;
    const how = o.year.entryMode === 'ytd' ? `year to date through month ${o.year.throughMonth}` : 'full-year amounts';
    warnings.push({ code: 'TE_OUTSIDE_ENTITY_ENTERED', severity: 'info', message: `${o.name}: outside MyBooks, entered manually (${how}); no books readiness check applies.`, details: { outsideEntityId: o.id } });
  }
  const deduped = dedupeWarnings(warnings);
  return {
    taxpayerId, taxYear, entities, outOfScopeLinks, schAiPeriods: schAiPeriods_,
    ready: outOfScopeLinks === 0 && entities.every((e) => !e.error) && !deduped.some((w) => w.severity === 'warning'),
    warnings: deduped,
  };
}
