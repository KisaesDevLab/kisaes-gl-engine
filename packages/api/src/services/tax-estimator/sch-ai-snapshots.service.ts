// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Schedule AI period snapshots (Phase 10b, MODULE.md "Schedule AI", D7, Q34).
//
// Form 2210 Schedule AI annualizes ACTUAL tax-basis figures from Jan 1 through each
// period end (3/31, 5/31, 8/31; the 12/31 column is the projection). The estimate reads
// those actuals live from the P&L provider (requested through the period month) unless a
// snapshot exists: a snapshot freezes a closed period's column so later book edits do not
// move it. A snapshot row stores the ENGINE entity figures for one (period, linked
// company) — never links, which always come from the current taxpayer setup.
import { and, asc, eq } from 'drizzle-orm';
import type {
  CaptureSchAiSnapshotsInput, EngineEntity, LinkDTO, SchAiSnapshotDTO, TaxBasisPl, TaxEstimatorWarning,
} from '@kis-books/shared';
import { dDiv, dMul, engineEntityFromTaxBasisPl } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxEstSchAiSnapshots } from '../../db/schema/tax-estimator-estimate.js';
import { AppError } from '../../utils/errors.js';
import { isElevated, isTenantInScope, scopeForTaxpayer, type FirmScope } from './firm-scope.service.js';
import { getTaxBasisPl } from './pl-provider.service.js';
import { getEntitySettings } from './entity-settings.service.js';
import { getParameters } from './tax-parameters.service.js';
import { listLinks } from './taxpayers.service.js';
import { lastCompleteMonth } from './periods.js';
import { auditYears, loadTaxpayerForFirm, type Actor } from './year-access.js';

const PERIOD_MONTHS_KEY = 'sch_ai.period_months';
const MONTHS_PER_YEAR = 12;
/** Columns BEFORE the last one (the last is the full-year projection). */
export const SNAPSHOT_PERIODS = 3;

/** Engine entity figures for one period, without links / scope / per-entity flags. */
export type SchAiFigures = Omit<EngineEntity, 'tenantId' | 'companyId' | 'links' | 'isSstb' | 'rentalQbiTradeOrBusiness' | 'warnings'>;

export interface SchAiPeriodDef {
  periodIndex: number;
  /** Months Jan 1 → period end (3, 5, 8). */
  months: number;
  /** 'YYYY-MM'. */
  periodMonth: string;
  /** 'YYYY-MM-DD'. */
  periodEnd: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function lastDay(year: number, month: number): string {
  return `${year}-${pad2(month)}-${pad2(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
}

/** Period definitions from `sch_ai.period_months` (default 3 / 5 / 8 when the parameter is absent). */
export async function schAiPeriods(taxYear: number): Promise<SchAiPeriodDef[]> {
  const params = await getParameters(taxYear);
  const row = params.parameters.find((p) => p.key === PERIOD_MONTHS_KEY);
  const fallback = [3, 5, 8];
  const raw = Array.isArray(row?.value) && row.value.every((v) => typeof v === 'number') ? (row.value as number[]) : fallback;
  return raw.slice(0, SNAPSHOT_PERIODS).map((m, i) => ({
    periodIndex: i, months: m, periodMonth: `${taxYear}-${pad2(m)}`, periodEnd: lastDay(taxYear, m),
  }));
}

/**
 * P&L provider result through a period month → the period's engine figures. The provider's
 * `w2Wages.effective` is a FULL-YEAR figure (override or projection) and the Schedule AI
 * annualizer multiplies the period figure by the factor, so the period figure is the books
 * YTD — or, with an override, the override prorated to the period's months.
 */
export function periodFiguresFromPl(pl: TaxBasisPl, periodMonths: number): SchAiFigures {
  const e = engineEntityFromTaxBasisPl(pl, [], { isSstb: false, rentalQbiTradeOrBusiness: false });
  const w2 = pl.w2Wages.override != null ? dDiv(dMul(pl.w2Wages.override, String(periodMonths)), String(MONTHS_PER_YEAR)) : pl.w2Wages.ytd;
  return {
    companyName: e.companyName, entityType: e.entityType, monthsElapsed: e.monthsElapsed, monthsRemaining: e.monthsRemaining,
    ytd: e.ytd, recurringYtd: e.recurringYtd, ownerItems: e.ownerItems, guaranteedPayments: e.guaranteedPayments,
    officerWages: e.officerWages, taxDepreciationBookYtd: e.taxDepreciationBookYtd, w2WagesEffective: w2, ubia: e.ubia,
  };
}

/** Stored figures for in-scope tenants only, keyed `${periodIndex}|${tenantId}|${companyId}`. */
export async function loadSnapshotFigures(scope: FirmScope, taxpayerId: string, taxYear: number): Promise<Map<string, SchAiFigures>> {
  scope = await scopeForTaxpayer(scope, taxpayerId); // D18
  const rows = await db.select().from(taxEstSchAiSnapshots).where(and(
    eq(taxEstSchAiSnapshots.firmId, scope.firmId), eq(taxEstSchAiSnapshots.taxpayerId, taxpayerId), eq(taxEstSchAiSnapshots.taxYear, taxYear),
  ));
  const out = new Map<string, SchAiFigures>();
  for (const r of rows) {
    if (!isTenantInScope(scope, r.tenantId)) continue; // D1
    out.set(`${r.periodIndex}|${r.tenantId}|${r.companyId}`, r.figures as unknown as SchAiFigures);
  }
  return out;
}

export async function listSnapshots(scope: FirmScope, taxpayerId: string, taxYear: number): Promise<SchAiSnapshotDTO[]> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  scope = await scopeForTaxpayer(scope, taxpayerId); // D18
  const rows = await db.select().from(taxEstSchAiSnapshots).where(and(
    eq(taxEstSchAiSnapshots.firmId, scope.firmId), eq(taxEstSchAiSnapshots.taxpayerId, taxpayerId), eq(taxEstSchAiSnapshots.taxYear, taxYear),
  )).orderBy(asc(taxEstSchAiSnapshots.periodIndex), asc(taxEstSchAiSnapshots.capturedAt));
  return rows.filter((r) => isTenantInScope(scope, r.tenantId)).map((r) => ({
    id: r.id, periodIndex: r.periodIndex, periodEnd: String(r.periodEnd).slice(0, 10), tenantId: r.tenantId, companyId: r.companyId,
    companyName: typeof r.figures['companyName'] === 'string' ? r.figures['companyName'] : null,
    throughMonth: r.throughMonth, glVersionStamp: r.glVersionStamp, capturedAt: r.capturedAt.toISOString(), capturedBy: r.capturedBy,
  }));
}

/** In-scope linked companies of the year (distinct), excluding out-of-scope links (D1). */
export function inScopeCompanies(scope: FirmScope, links: ReadonlyArray<LinkDTO>): Array<{ tenantId: string; companyId: string; companyName: string | null }> {
  const m = new Map<string, { tenantId: string; companyId: string; companyName: string | null }>();
  for (const l of links) {
    if (l.outOfScope || !isTenantInScope(scope, l.tenantId)) continue;
    m.set(`${l.tenantId}|${l.companyId}`, { tenantId: l.tenantId, companyId: l.companyId, companyName: l.companyName });
  }
  return [...m.values()];
}

/**
 * Capture (or re-capture with `replace`) the period actuals of every in-scope linked
 * individual-path entity. Only periods whose month is complete can be captured.
 */
export async function captureSnapshots(
  scope: FirmScope, actor: Actor, taxpayerId: string, taxYear: number, input: CaptureSchAiSnapshotsInput, opts: { today?: Date } = {},
): Promise<{ captured: SchAiSnapshotDTO[]; skipped: TaxEstimatorWarning[] }> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  // D18: a listed user captures the taxpayer's linked companies even outside their own reach
  // (estimator figures only; the books themselves stay closed to them).
  scope = await scopeForTaxpayer(scope, taxpayerId);
  const today = opts.today ?? new Date();
  const periods = (await schAiPeriods(taxYear)).filter((p) => input.periodIndex === undefined || p.periodIndex === input.periodIndex);
  const complete = lastCompleteMonth(today);
  const links = (await listLinks(scope, taxpayerId, taxYear)).data;
  const companies = inScopeCompanies(scope, links);
  const skipped: TaxEstimatorWarning[] = [];
  if (input.periodIndex !== undefined && periods.every((p) => p.periodMonth > complete)) {
    throw AppError.unprocessableEntity('That Schedule AI period has not ended yet', 'TE_SCH_AI_PERIOD_OPEN');
  }
  const existing = await db.select({ periodIndex: taxEstSchAiSnapshots.periodIndex, tenantId: taxEstSchAiSnapshots.tenantId, companyId: taxEstSchAiSnapshots.companyId })
    .from(taxEstSchAiSnapshots)
    .where(and(eq(taxEstSchAiSnapshots.firmId, scope.firmId), eq(taxEstSchAiSnapshots.taxpayerId, taxpayerId), eq(taxEstSchAiSnapshots.taxYear, taxYear)));
  const have = new Set(existing.map((e) => `${e.periodIndex}|${e.tenantId}|${e.companyId}`));

  // Read every period's figures first (provider calls stay outside the transaction), then
  // write them and the audit row atomically (auditLog with the executor).
  const toWrite: Array<typeof taxEstSchAiSnapshots.$inferInsert> = [];
  // R3-08: resolve the entity type FIRST. A C corporation (or a company with no tax type)
  // has no individual Schedule AI column, and a fiscal-year C corp would reject calendar
  // period months (TE_THROUGH_OUT_OF_RANGE) — skip it before the provider is asked.
  const individual: typeof companies = [];
  for (const c of companies) {
    let entityType: string | null = null;
    let name: string | null = c.companyName;
    try {
      const es = await getEntitySettings(scope, c.tenantId, c.companyId, taxYear); // Q49: the year's type
      entityType = es.resolved.entityType;
      name = es.resolved.companyName ?? name;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push({ code: 'TE_SCH_AI_ENTITY_SKIPPED', severity: 'info', message: `${name ?? 'A linked company'}: ${err.message}; not captured.`, details: { tenantId: c.tenantId, companyId: c.companyId } });
      continue;
    }
    if (!entityType || entityType === 'c_corp') {
      skipped.push({ code: 'TE_SCH_AI_ENTITY_SKIPPED', severity: 'info', message: `${name ?? 'A linked company'}: ${entityType ? 'C corporations have no individual Schedule AI column' : 'no tax entity type'}; not captured.`, details: { tenantId: c.tenantId, companyId: c.companyId } });
      continue;
    }
    individual.push(c);
  }
  for (const p of periods) {
    if (p.periodMonth > complete) {
      skipped.push({ code: 'TE_SCH_AI_PERIOD_OPEN', severity: 'info', message: `The ${p.periodEnd} period has not ended; nothing captured.`, details: { periodIndex: p.periodIndex } });
      continue;
    }
    for (const c of individual) {
      const key = `${p.periodIndex}|${c.tenantId}|${c.companyId}`;
      if (have.has(key) && !input.replace) continue;
      let pl: TaxBasisPl;
      try {
        pl = await getTaxBasisPl(scope, { tenantId: c.tenantId, companyId: c.companyId, taxYear, throughMonth: p.periodMonth }, { today });
      } catch (err) {
        // One entity that cannot be read never fails the whole capture (runEntities pattern).
        if (!(err instanceof AppError)) throw err;
        skipped.push({ code: err.code ?? 'TE_SCH_AI_ENTITY_SKIPPED', severity: 'warning', message: `${c.companyName ?? 'A linked company'} (${p.periodEnd}): ${err.message}; not captured.`, details: { tenantId: c.tenantId, companyId: c.companyId, periodIndex: p.periodIndex } });
        continue;
      }
      if (!pl.entityType || pl.entityType === 'c_corp') {
        skipped.push({ code: 'TE_SCH_AI_ENTITY_SKIPPED', severity: 'info', message: `${pl.companyName}: ${pl.entityType ? 'C corporations have no individual Schedule AI column' : 'no tax entity type'}; not captured.`, details: { tenantId: c.tenantId, companyId: c.companyId } });
        continue;
      }
      const figures = periodFiguresFromPl(pl, p.months);
      toWrite.push({
        firmId: scope.firmId, taxpayerId, taxYear, periodIndex: p.periodIndex, periodEnd: p.periodEnd, tenantId: c.tenantId, companyId: c.companyId,
        throughMonth: pl.throughMonth, glVersionStamp: pl.glVersionStamp, figures: figures as unknown as Record<string, unknown>, capturedBy: actor.userId,
      });
    }
  }
  if (toWrite.length > 0) {
    await db.transaction(async (tx) => {
      for (const v of toWrite) {
        await tx.insert(taxEstSchAiSnapshots).values(v).onConflictDoUpdate({
          target: [taxEstSchAiSnapshots.taxpayerId, taxEstSchAiSnapshots.taxYear, taxEstSchAiSnapshots.periodIndex, taxEstSchAiSnapshots.tenantId, taxEstSchAiSnapshots.companyId],
          set: { periodEnd: v.periodEnd, throughMonth: v.throughMonth, glVersionStamp: v.glVersionStamp, figures: v.figures, capturedBy: actor.userId, capturedAt: new Date() },
        });
      }
      await auditYears(scope, actor, 'update', 'tax_est_sch_ai_snapshots', taxpayerId, null,
        { taxYear, periods: periods.map((p) => p.periodIndex), written: toWrite.length, replace: input.replace, ...(isElevated(scope) ? { elevated: true } : {}) }, tx);
    });
  }
  return { captured: await listSnapshots(scope, taxpayerId, taxYear), skipped };
}
