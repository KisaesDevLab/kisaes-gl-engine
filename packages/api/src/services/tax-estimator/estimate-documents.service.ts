// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 13 — issued documents (MODULE.md D15, "Scenarios, snapshots,
// standards"). Every estimate PDF the app hands out is printed FROM a frozen
// snapshot, so what was given to a client can always be reproduced:
//
//   standalone Print / Download  → snapshot reason 'pdf'         → renderEstimatePdf (preparer)
//   Report Pack `tax-estimate`   → snapshot reason 'report_pack' → renderEstimatePdf (client, R4-04)
//   snapshot history Download    → the existing snapshot         → renderEstimatePdf (preparer)
//
// The Report Pack section is a client deliverable, so it prints the CLIENT variant (no
// readiness codes, unverified-parameter dumps, engine version or prior-year AGI notes);
// the staff screens keep the full working paper. A pack run that carries the section is
// stored encrypted, short-lived, and readable only by its requester while they still pass
// these gates (report-packs.routes.ts, report-pack.service.ts — R4-01 / R4-10).
//
// Report Pack gating (the pack builder, the ad-hoc /reports/tax-estimate endpoint and
// the worker that renders a run): the pack's tenant must be managed by a firm the
// requester belongs to (or the requester is a super admin), TAX_ESTIMATOR_V1 must be
// on for that tenant, and the requester's firm scope (D1: firm assignments ∩ the
// requester's tenant access) must reach it. The taxpayer must belong to that firm and
// be linked to the pack's company for the tax year.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { can, type EstimateSnapshotDTO, type SnapshotReason, type TaxEstimatePackTaxpayerDTO } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { tenantFeatureFlags, tenantFirmAssignments, userTenantAccess, users } from '../../db/schema/index.js';
import * as permissionService from '../permission.service.js';
import { taxEstLinks, taxEstTaxpayers } from '../../db/schema/tax-estimator-taxpayers.js';
import { taxEstScenarios } from '../../db/schema/tax-estimator-years.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import * as firmsService from '../firms.service.js';
import { isTenantInScope, resolveScope, type FirmScope } from './firm-scope.service.js';
import { createSnapshot, getSnapshot, type CreateSnapshotRequest } from './estimate-snapshots.service.js';
import { renderEstimatePdf, type EstimatePdfAudience } from './estimate-pdf.service.js';
import type { EstimateOptions } from './estimate.service.js';
import type { Actor } from './year-access.js';

export interface IssuedPdf {
  bytes: Uint8Array;
  filename: string;
  snapshotId: string;
}

const slugify = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'taxpayer';

async function firmName(firmId: string): Promise<string | null> {
  try {
    return (await firmsService.getById(firmId)).name;
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
}

/** Print a snapshot. The figures, assumptions and disclaimer are the FROZEN ones. */
export async function renderSnapshotPdf(scope: FirmScope, snap: EstimateSnapshotDTO, audience: EstimatePdfAudience = 'preparer'): Promise<IssuedPdf> {
  const p = snap.payload;
  const name = p.inputs.taxpayer.displayName;
  const bytes = await renderEstimatePdf({ ...p.result, assumptions: p.assumptions }, {
    taxpayerName: name,
    firmName: await firmName(scope.firmId),
    disclaimer: p.disclaimerText,
    snapshot: { id: snap.id, createdAt: snap.createdAt, reason: snap.reason },
    audience,
  });
  return { bytes, filename: `tax-estimate-${snap.taxYear}-${slugify(name)}.pdf`, snapshotId: snap.id };
}

/**
 * R3-06 / R3-16: return information leaving the system is audited — one `download` row
 * per PDF, under the caller's active tenant, METADATA ONLY (never figures; the snapshot id
 * leads to the frozen, encrypted payload).
 */
async function auditDownload(scope: FirmScope, actor: Actor, snap: EstimateSnapshotDTO, issued: boolean): Promise<void> {
  await auditLog(actor.tenantId, 'download', 'tax_est_snapshot', snap.id, null, {
    firmId: scope.firmId, taxpayerId: snap.taxpayerId, taxYear: snap.taxYear, scenarioId: snap.scenarioId,
    snapshotReason: snap.reason, format: 'pdf', issued, payloadSha256: snap.payloadSha256,
  }, actor.userId);
}

/**
 * Freeze a snapshot with `reason`, then print it (standalone PDF, Report Pack section).
 * R4-09: a 'pdf' / 'report_pack' issue with the same inputs on the same day reuses the
 * snapshot already frozen for it (createSnapshot `reuseSameDay`) instead of storing another.
 */
export async function issueEstimatePdf(
  scope: FirmScope, actor: Actor, req: CreateSnapshotRequest & { reason: SnapshotReason }, opts: EstimateOptions = {},
  audience: EstimatePdfAudience = 'preparer',
): Promise<IssuedPdf> {
  const snap = await createSnapshot(scope, actor, req, opts, { reuseSameDay: true });
  const pdf = await renderSnapshotPdf(scope, snap, audience);
  await auditDownload(scope, actor, snap, true);
  return pdf;
}

/** GET /snapshots/:id/pdf — re-print an existing snapshot (no new snapshot; the download is audited). */
export async function snapshotPdf(scope: FirmScope, actor: Actor, snapshotId: string): Promise<IssuedPdf> {
  const snap = await getSnapshot(scope, snapshotId);
  const pdf = await renderSnapshotPdf(scope, snap);
  await auditDownload(scope, actor, snap, false);
  return pdf;
}

// ── Report Pack section ─────────────────────────────────────────────────

const notAvailable = () => AppError.notFound('Feature not available');

/**
 * The firm scope a Report Pack request in `tenantId` acts under: the firm that actively
 * manages the tenant, the requester's membership in it (super admins: the firm's full
 * managed set), the tenant inside the scope, and the flag (QA D9: this tenant or another
 * tenant of the firm in the caller's scope, i.e. the practice tenant). Anything else
 * is a 404 (the section does not exist for this caller).
 */
export async function resolvePackScope(tenantId: string, userId: string, isSuperAdmin: boolean): Promise<FirmScope> {
  const [assignment] = await db.select({ firmId: tenantFirmAssignments.firmId }).from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)))
    .limit(1);
  if (!assignment) throw notAvailable();
  let scope: FirmScope;
  try {
    scope = await resolveScope(userId, isSuperAdmin, assignment.firmId);
  } catch (err) {
    if (err instanceof AppError) throw notAvailable();
    throw err;
  }
  if (!isTenantInScope(scope, tenantId)) throw notAvailable();
  // QA D9 (MODULE.md D5): the firm turns the module on in its PRACTICE tenant(s), where staff
  // work; a pack is built inside the client company. The section is offered when the flag is
  // ON in the pack's tenant OR in any other tenant of the same firm inside the caller's D1 scope.
  if (!(await packFlagOn(tenantId, scope))) throw notAvailable();
  return scope;
}

async function packFlagOn(tenantId: string, scope: FirmScope): Promise<boolean> {
  const tenants = [...new Set([tenantId, ...scope.allowedTenantIds])];
  const [row] = await db.select({ tenantId: tenantFeatureFlags.tenantId }).from(tenantFeatureFlags)
    .where(and(inArray(tenantFeatureFlags.tenantId, tenants), eq(tenantFeatureFlags.flagKey, 'TAX_ESTIMATOR_V1'), eq(tenantFeatureFlags.enabled, true)))
    .limit(1);
  return !!row;
}

/**
 * Worker path: the run records only the requester; re-derive EVERYTHING the request-side
 * gate (middleware/tax-estimator-scope.ts `taxEstimateReportScope`) checked, at render
 * time (R4-03): the user is active and not a client user, holds the `tax_estimator`
 * resource in THIS tenant (role from their tenant access row, as switch-tenant issues it;
 * a super admin without a row is 'owner'), then firm membership, flag and D1 scope.
 * The request's `authKind` cannot change after the fact: a non-session caller never gets
 * `allow_tax_estimate` on its run, and the renderer refuses runs without it.
 */
export async function resolvePackScopeForUser(tenantId: string, userId: string): Promise<FirmScope> {
  const [u] = await db.select({ isSuperAdmin: users.isSuperAdmin, isActive: users.isActive, userType: users.userType })
    .from(users).where(eq(users.id, userId));
  if (!u || u.isActive === false || u.userType === 'client') throw notAvailable();
  const superAdmin = u.isSuperAdmin === true;
  const [access] = await db.select({ role: userTenantAccess.role, isActive: userTenantAccess.isActive }).from(userTenantAccess)
    .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.tenantId, tenantId)))
    .limit(1);
  if (!superAdmin && (!access || access.isActive === false)) throw notAvailable();
  const perms = await permissionService.getEffectivePermissions(tenantId, userId, access?.role ?? 'owner', 'staff', superAdmin);
  if (!can(perms, 'tax_estimator', 'read')) throw notAvailable();
  return resolvePackScope(tenantId, userId, superAdmin);
}

/** Option choices: the firm's active taxpayers linked to this company, with the years they are linked for. */
export async function listPackTaxpayers(scope: FirmScope, tenantId: string, companyId: string): Promise<TaxEstimatePackTaxpayerDTO[]> {
  if (!isTenantInScope(scope, tenantId)) return [];
  const rows = await db.selectDistinct({ id: taxEstTaxpayers.id, displayName: taxEstTaxpayers.displayName, taxYear: taxEstLinks.taxYear })
    .from(taxEstLinks)
    .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstLinks.taxpayerId))
    .where(and(
      eq(taxEstTaxpayers.firmId, scope.firmId), eq(taxEstTaxpayers.isActive, true),
      eq(taxEstLinks.tenantId, tenantId), eq(taxEstLinks.companyId, companyId),
    ))
    .orderBy(asc(taxEstTaxpayers.displayName), desc(taxEstLinks.taxYear));
  const byId = new Map<string, TaxEstimatePackTaxpayerDTO>();
  for (const r of rows) {
    const t = byId.get(r.id) ?? { id: r.id, displayName: r.displayName, years: [] };
    if (!t.years.includes(r.taxYear)) t.years.push(r.taxYear);
    byId.set(r.id, t);
  }
  // QA D10: the scenarios of the linked years feed the builder's optional scenario picker.
  const ids = [...byId.keys()];
  if (ids.length > 0) {
    const sc = await db.select({ id: taxEstScenarios.id, name: taxEstScenarios.name, taxYear: taxEstScenarios.taxYear, isBase: taxEstScenarios.isBase, taxpayerId: taxEstScenarios.taxpayerId })
      .from(taxEstScenarios).where(inArray(taxEstScenarios.taxpayerId, ids))
      .orderBy(desc(taxEstScenarios.taxYear), desc(taxEstScenarios.isBase), asc(taxEstScenarios.sortOrder), asc(taxEstScenarios.name));
    for (const s of sc) {
      const t = byId.get(s.taxpayerId);
      if (!t || !t.years.includes(s.taxYear)) continue;
      (t.scenarios ??= []).push({ id: s.id, name: s.name, taxYear: s.taxYear, isBase: s.isBase });
    }
  }
  return [...byId.values()];
}

export interface PackSectionRequest {
  tenantId: string;
  companyId: string;
  taxpayerId: string | null | undefined;
  scenarioId?: string | null;
  /** 'YYYY-MM-DD': its calendar year is the tax year; a month-end date sets "actuals through". */
  asOfDate: string;
}

const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Tax year + optional through month from an as-of date (pure; exported for tests). */
export function packPeriod(asOfDate: string): { taxYear: number; throughMonth?: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOfDate);
  if (!m) throw AppError.badRequest('The tax estimate needs an as-of date (YYYY-MM-DD)', 'TE_PACK_AS_OF_REQUIRED');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return d === lastDayOfMonth(y, mo) ? { taxYear: y, throughMonth: `${m[1]}-${m[2]}` } : { taxYear: y };
}

/**
 * Render the Report Pack `tax-estimate` section (also the ad-hoc /reports/tax-estimate PDF):
 * the CLIENT variant of the estimate PDF (R4-04). Without an explicit scenario it prints
 * the BASE scenario or nothing (R4-06) — never whichever what-if happens to come first.
 */
export async function renderPackSection(scope: FirmScope, actor: Actor, req: PackSectionRequest, opts: EstimateOptions = {}): Promise<IssuedPdf> {
  if (!req.taxpayerId) throw AppError.badRequest('Pick a taxpayer for the Tax Estimate section', 'TE_PACK_TAXPAYER_REQUIRED');
  if (!isTenantInScope(scope, req.tenantId)) throw notAvailable();
  const { taxYear, throughMonth } = packPeriod(req.asOfDate);
  // The taxpayer must belong to the firm AND be linked to THIS company for the year.
  const [link] = await db.select({ id: taxEstLinks.id }).from(taxEstLinks)
    .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstLinks.taxpayerId))
    .where(and(
      eq(taxEstLinks.taxpayerId, req.taxpayerId), eq(taxEstTaxpayers.firmId, scope.firmId),
      eq(taxEstLinks.tenantId, req.tenantId), eq(taxEstLinks.companyId, req.companyId), eq(taxEstLinks.taxYear, taxYear),
    ))
    .limit(1);
  if (!link) {
    throw new AppError(404, `The taxpayer is not linked to this company for ${taxYear}`, 'TE_TAXPAYER_NOT_LINKED');
  }
  const scenarios = await db.select({ id: taxEstScenarios.id, isBase: taxEstScenarios.isBase }).from(taxEstScenarios)
    .where(and(eq(taxEstScenarios.taxpayerId, req.taxpayerId), eq(taxEstScenarios.taxYear, taxYear)));
  const scenario = req.scenarioId ? scenarios.find((s) => s.id === req.scenarioId) : scenarios.find((s) => s.isBase);
  if (!scenario) throw new AppError(404, `No ${taxYear} scenario exists for this taxpayer`, 'TE_SCENARIO_NOT_FOUND');
  return issueEstimatePdf(scope, actor, {
    taxpayerId: req.taxpayerId, taxYear, scenarioId: scenario.id, throughMonth, reason: 'report_pack',
  }, opts, 'client');
}
