// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q52 — dashboard summaries (migration 0212_tax_est_dashboard_summaries).
//
// WHAT. A compact, encrypted copy of the parts of a LIVE estimate the dashboard cards need
// (the voucher schedule with the engine's own payment-application record, the payment
// ledger, the totals and the penalty), stored per taxpayer-year and per tenant set, so the
// firm-wide cards never compute estimates when the page loads (Q52 decision 4).
//
// WHEN. `recordDashboardSummary` is called by the estimate service every time it computes OR
// serves (cache hit) an estimate of the BASE scenario for the default range and without the
// portal's as-of payment filter — i.e. exactly what the staff estimate screen shows. A newer
// computation for the same tenant set replaces the row; an unchanged one (same inputs hash)
// is a no-op write. Failures are logged and swallowed: the cards are an optimisation and
// must never fail an estimate.
//
// WHO SEES A ROW. `tenant_ids` = the books tenants the estimate read (the snapshot rule,
// estimate-snapshots.service `tenantsOf`). The firm cards use a row only when the viewer's
// effective scope for that taxpayer (D17 / D18: `scopeForTaxpayer`) covers every one of
// them — the same test a snapshot passes before it is shown — AND the row covers every
// linked tenant of that year the viewer reaches (otherwise it would understate). See
// dashboard-cards.service.ts.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { EstimateResultDTO, JurisdictionEstimate } from '@kis-books/shared';
import { OUTSIDE_TENANT_ID } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxEstDashboardSummaries } from '../../db/schema/tax-estimator-dashboard.js';
import { taxEstScenarios } from '../../db/schema/tax-estimator-years.js';
import { decrypt, encrypt } from '../../utils/encryption.js';
import { log } from '../../utils/logger.js';
import type { FirmScope } from './firm-scope.service.js';
import type { EstimateInputsForSnapshot, EstimateOptions, EstimateRequest } from './estimate.service.js';

/** The jurisdiction estimate minus trace / rules / safe-harbor workings; the penalty keeps only its total. */
type LiteJurisdiction = Pick<JurisdictionEstimate, 'jurisdiction' | 'taxYear' | 'estimatesRequired' | 'installments' | 'payments' | 'totals' | 'returnDueDate'>
  & { penalty: { total: string } | null };

/** Decrypted `summary_encrypted`. Only what the portal projection + the cards read. */
export interface DashboardSummaryPayload {
  v: 1;
  taxpayerId: string;
  taxYear: number;
  scenarioId: string;
  computedAt: string;
  engineVersion: string;
  summary: { total: string; federalTotal: string; stateTotal: string };
  entities: Array<{ path: string; throughMonth: string | null }>;
  federalEstimates: LiteJurisdiction;
  stateEstimates: LiteJurisdiction[];
  payments: Array<{ id: string; jurisdiction: string; date: string | null; amount: string }>;
}

export interface StoredDashboardSummary {
  taxpayerId: string;
  taxYear: number;
  tenantIds: string[];
  computedAt: Date;
  payload: DashboardSummaryPayload;
}

const lite = (e: JurisdictionEstimate): LiteJurisdiction => ({
  jurisdiction: e.jurisdiction, taxYear: e.taxYear, estimatesRequired: e.estimatesRequired, installments: e.installments,
  payments: e.payments, totals: e.totals, returnDueDate: e.returnDueDate, penalty: e.penalty ? { total: e.penalty.total } : null,
});

export function toDashboardPayload(r: EstimateResultDTO): DashboardSummaryPayload {
  return {
    v: 1, taxpayerId: r.taxpayerId, taxYear: r.taxYear, scenarioId: r.scenarioId, computedAt: r.computedAt, engineVersion: r.engineVersion,
    summary: { total: r.summary.total, federalTotal: r.summary.federalTotal, stateTotal: r.summary.stateTotal },
    entities: r.entities.map((e) => ({ path: e.path, throughMonth: e.throughMonth ?? null })),
    federalEstimates: lite(r.federalEstimates),
    stateEstimates: r.stateEstimates.map(lite),
    payments: r.payments.map((p) => ({ id: p.id, jurisdiction: p.jurisdiction, date: p.date, amount: p.amount })),
  };
}

/**
 * The payload in the shape `toPortalEstimate` and the cards read (taxYear, summary, entities'
 * path / throughMonth, the jurisdiction estimates with their penalty total and return due date,
 * and the payment ledger). Nothing else is read, so the missing fields of the full result are
 * never touched.
 */
export function payloadAsEstimate(p: DashboardSummaryPayload): EstimateResultDTO {
  return p as unknown as EstimateResultDTO;
}

/** The books tenants an estimate read — mirror of estimate-snapshots.service `tenantsOf`. */
export function tenantsUsed(i: EstimateInputsForSnapshot, r: EstimateResultDTO): string[] {
  const ids = new Set<string>();
  for (const c of i.companies) ids.add(c.tenantId);
  for (const l of i.links) ids.add(l.tenantId);
  for (const e of r.entities) if (e.source !== 'outside' && e.tenantId !== OUTSIDE_TENANT_ID) ids.add(e.tenantId);
  for (const a of i.adjustments) if (a.tenantId) ids.add(a.tenantId);
  for (const p of i.payments) if (p.tenantId) ids.add(p.tenantId);
  return [...ids].sort();
}

const tenantSetKey = (ids: readonly string[]) => createHash('sha256').update([...ids].sort().join(',')).digest('hex');

/**
 * Store / refresh the summary of a live estimate. Only the Base scenario, default range and
 * no as-of payment filter (what the staff estimate screen shows) are stored. Never throws.
 */
export async function recordDashboardSummary(
  scope: FirmScope, req: EstimateRequest, opts: EstimateOptions, result: EstimateResultDTO, inputs: EstimateInputsForSnapshot,
): Promise<void> {
  if (req.throughMonth || opts.paymentsAsOf) return;
  try {
    const [scenario] = await db.select({ isBase: taxEstScenarios.isBase }).from(taxEstScenarios)
      .where(and(eq(taxEstScenarios.id, req.scenarioId), eq(taxEstScenarios.taxpayerId, req.taxpayerId)));
    if (!scenario?.isBase) return;
    const tenantIds = tenantsUsed(inputs, result);
    const values = {
      firmId: scope.firmId, taxpayerId: req.taxpayerId, taxYear: req.taxYear, scenarioId: req.scenarioId,
      tenantSetKey: tenantSetKey(tenantIds), tenantIds, inputsHash: result.inputsHash, engineVersion: result.engineVersion,
      computedAt: new Date(result.computedAt), summaryEncrypted: encrypt(JSON.stringify(toDashboardPayload(result))),
    };
    await db.insert(taxEstDashboardSummaries).values(values).onConflictDoUpdate({
      target: [taxEstDashboardSummaries.firmId, taxEstDashboardSummaries.taxpayerId, taxEstDashboardSummaries.taxYear, taxEstDashboardSummaries.tenantSetKey],
      set: {
        scenarioId: values.scenarioId, tenantIds: values.tenantIds, inputsHash: values.inputsHash, engineVersion: values.engineVersion,
        computedAt: values.computedAt, summaryEncrypted: values.summaryEncrypted, updatedAt: new Date(),
      },
      // A replayed older result (cache hit of an earlier computation) never overwrites a newer one.
      setWhere: sql`${taxEstDashboardSummaries.inputsHash} IS DISTINCT FROM excluded.inputs_hash AND excluded.computed_at >= ${taxEstDashboardSummaries.computedAt}`,
    });
  } catch (err) {
    log.warn({ component: 'tax-estimator', event: 'dashboard_summary_write_failed', taxpayerId: req.taxpayerId, message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Every stored summary for these taxpayers and years in the firm (newest first). Rows that do
 * not decrypt (rotated key without the sweep) are skipped — the card falls back to the
 * snapshot / "not computed".
 */
export async function loadDashboardSummaries(firmId: string, taxpayerIds: readonly string[], years: readonly number[]): Promise<StoredDashboardSummary[]> {
  if (taxpayerIds.length === 0 || years.length === 0) return [];
  const rows = await db.select().from(taxEstDashboardSummaries)
    .where(and(
      eq(taxEstDashboardSummaries.firmId, firmId),
      inArray(taxEstDashboardSummaries.taxpayerId, [...taxpayerIds]),
      inArray(taxEstDashboardSummaries.taxYear, [...years]),
    ))
    .orderBy(sql`${taxEstDashboardSummaries.computedAt} DESC`);
  const out: StoredDashboardSummary[] = [];
  for (const r of rows) {
    try {
      out.push({ taxpayerId: r.taxpayerId, taxYear: r.taxYear, tenantIds: r.tenantIds, computedAt: r.computedAt, payload: JSON.parse(decrypt(r.summaryEncrypted)) as DashboardSummaryPayload });
    } catch {
      log.debug({ component: 'tax-estimator', event: 'dashboard_summary_unreadable', taxpayerId: r.taxpayerId });
    }
  }
  return out;
}
