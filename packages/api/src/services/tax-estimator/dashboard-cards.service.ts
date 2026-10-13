// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q52 — dashboard cards (Kurt, 2026-10-13; OPEN-QUESTIONS.md Q52).
//
// COMPANY DASHBOARD (GET /api/v1/dashboard/tax-estimates), for the taxpayers linked to the
// active company, only when TAX_ESTIMATOR_V1 is ON for the company's tenant:
//   staff  — callers passing the Tax Estimator gates in this tenant (the Report Pack gate:
//            session, not a client user, `tax_estimator` read, member of the firm managing
//            the tenant, tenant in their D1 scope) see every linked taxpayer D17 / D18 lets
//            them see, with the engine's penalty and "Not computed yet" rows.
//   owner  — the tenant's `owner` user (not passing the staff gates) sees ONLY the
//            taxpayers they personally are: a taxpayer mapped to an ACTIVE portal contact of
//            this tenant whose e-mail equals the owner user's e-mail (case-insensitive) and who
//            holds `tax_estimates_access` on this company — the exact portal access predicate
//            (portal-estimates.service `visible`) keyed by e-mail. That contact can already open
//            the same figures in the client portal, so the card shows nothing new. Portal-style
//            data only (the portal allow-list projection; no penalty, other owners, rates,
//            traces or adjustments); a taxpayer with no figures is omitted.
//            Q51 portal options: the card follows the contact's per-contact options — with
//            "Quarterly estimates" off the next voucher and paid-vs-required are ABSENT (the
//            projected total stays, as in the portal). When several active contacts of the
//            tenant carry the owner's e-mail, the most restrictive combination (AND of the
//            switches) of ALL of them applies (portal-options `mostRestrictiveOptionsForContacts`).
//            Scenario: the one the portal shows by default — Base (live: Base's cache entry;
//            snapshot: Base's latest finalized snapshot only, never a shared what-if's).
//   anyone else — `null` (cards hidden), indistinguishable from "flag off / nothing linked".
//   Q54 (Kurt, 2026-10-13): a taxpayer appears on ANY company dashboard (staff and owner alike)
//   only when its switch `show_on_company_dashboard` ("Show on linked company dashboards",
//   migration 0215) is ON — default OFF. No qualifying taxpayer → `null` (the section is gone);
//   a staff Refresh of a switched-off taxpayer is the uniform 404. The firm-wide cards below
//   are NOT affected (staff tool).
//
// FIRM-WIDE (GET /api/v1/tax-estimator/dashboard, Tax Estimator home): "Vouchers due in the
// next 30 days" and "Behind on payments" across every taxpayer `visibleTaxpayerFilter` lets
// the caller see.
//
// DATA SOURCE — never a live computation on page load (Q52 decision 4):
//   company cards: (1) the Redis-cached live estimate when its cache key matches today's inputs
//     (`peekCachedEstimate`: gather + inputs hash, no engine / P&L provider), (2) else the latest
//     finalized snapshot (reason finalize / vouchers), (3) else "Not computed yet" (staff) / omitted
//     (owner). The owner audience follows the taxpayer's `portal_shows` like the portal: `snapshot`
//     → the snapshot only; `live` → the portal's own cache entry (firm-wide scope, payments as of
//     today), then the snapshot.
//   firm cards: the newest of (a) the stored summary of the latest live Base estimate whose tenant
//     set the viewer covers (dashboard-summaries.service) and (b) the latest finalized snapshot
//     the viewer may open; else the taxpayer counts as not computed.
//   Every figure is the portal's as-of projection (`toPortalEstimate` → `installmentsAsOf`) of the
//   engine result plus the engine's own penalty — no tax math here (shared/dashboard-api.ts).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  CompanyTaxEstimatesDTO, EstimateResultDTO, FirmBehindDTO, FirmTaxEstDashboardDTO, FirmVoucherDueDTO, PortalShows,
  TaxEstDashboardJurisdictionDTO, TaxEstDashboardSource, TaxEstDashboardTaxpayerDTO,
} from '@kis-books/shared';
import {
  TAX_EST_DASHBOARD_WINDOW_DAYS, dRoundDollars, dSub, dashboardJurisdictionFigures, dashboardTotals, isBehind, portalDefaultYear,
  vouchersDueWithin,
} from '@kis-books/shared';
import { db } from '../../db/index.js';
import { portalContactCompanies, portalContacts, tenantFirmAssignments, users } from '../../db/schema/index.js';
import { taxEstLinks, taxEstTaxpayerContacts, taxEstTaxpayers } from '../../db/schema/tax-estimator-taxpayers.js';
import { taxEstScenarios, taxEstYears } from '../../db/schema/tax-estimator-years.js';
import { taxEstSnapshots } from '../../db/schema/tax-estimator-estimate.js';
import { AppError } from '../../utils/errors.js';
import { allowedTenantIds, UNRESTRICTED_VIEWER, visibleTaxpayerFilter, type FirmScope } from './firm-scope.service.js';
import { getFirmSettings } from './firm-settings.service.js';
import { computeEstimate, peekCachedEstimate } from './estimate.service.js';
import { getSnapshot } from './estimate-snapshots.service.js';
import { listPackTaxpayers } from './estimate-documents.service.js';
import { toPortalEstimate, type FullPortalEstimate } from './portal-estimates.service.js';
import { mostRestrictiveOptionsForContacts } from './portal-options.service.js';
import { loadDashboardSummaries, payloadAsEstimate } from './dashboard-summaries.service.js';
import { loadTaxpayerForFirm, scenarioNotFound, taxpayerNotFound } from './year-access.js';

const FINALIZED_REASONS = ['finalize', 'vouchers'];
const R = dRoundDollars;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface CardOptions { today?: Date }

interface Figures {
  result: EstimateResultDTO;
  source: TaxEstDashboardSource;
  asOf: string;
}

// ── shared building blocks ──────────────────────────────────────────────

/** The portal allow-list projection as of `today` (no firm name / disclaimer needed on a card). */
function project(f: Figures, taxpayer: { id: string; displayName: string }, today: string): FullPortalEstimate {
  return toPortalEstimate(f.result, { taxpayer, source: f.source, asOf: f.asOf, firmName: null, disclaimer: '', today });
}

/** jurisdiction → the engine's penalty total (staff only). */
function penaltiesOf(r: EstimateResultDTO): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of [r.federalEstimates, ...r.stateEstimates]) m.set(e.jurisdiction, e.penalty?.total ?? '0');
  return m;
}

/** jurisdiction → return due date (end of the penalty period; a prior year stops counting as "behind" after it). */
function returnDueOf(r: EstimateResultDTO): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of [r.federalEstimates, ...r.stateEstimates]) if (e.returnDueDate) m.set(e.jurisdiction, e.returnDueDate);
  return m;
}

function jurisdictionFigures(p: FullPortalEstimate, r: EstimateResultDTO, today: string, withPenalty: boolean): TaxEstDashboardJurisdictionDTO[] {
  const pen = penaltiesOf(r);
  return p.jurisdictions.map((j) => dashboardJurisdictionFigures(j, today, withPenalty ? (pen.get(j.jurisdiction) ?? '0') : null));
}

function card(
  taxpayer: { id: string; displayName: string }, taxYear: number, f: Figures | null, snapshotTotal: { total: string; at: string } | null,
  today: string, withPenalty: boolean, showInstallments = true,
): TaxEstDashboardTaxpayerDTO {
  if (!f) {
    return {
      taxpayerId: taxpayer.id, displayName: taxpayer.displayName, taxYear, status: 'not_computed', source: null, asOf: null,
      booksThrough: null, totals: null, changeSinceSnapshot: null, jurisdictions: [], shortfall: '0', penalty: withPenalty ? '0' : null,
    };
  }
  const p = project(f, taxpayer, today);
  const jurisdictions = jurisdictionFigures(p, f.result, today, withPenalty);
  const t = dashboardTotals(jurisdictions, withPenalty);
  const out: TaxEstDashboardTaxpayerDTO = {
    taxpayerId: taxpayer.id, displayName: taxpayer.displayName, taxYear, status: 'ok', source: f.source, asOf: f.asOf,
    booksThrough: p.booksThrough, totals: p.totals,
    changeSinceSnapshot: f.source === 'live' && snapshotTotal ? { amount: R(dSub(p.totals.total, R(snapshotTotal.total))), snapshotAt: snapshotTotal.at } : null,
    jurisdictions, shortfall: t.shortfall, penalty: t.penalty,
  };
  // Q51: the portal option is off → absent keys (never empty-but-present), like the portal DTO.
  if (!showInstallments) { delete out.jurisdictions; delete out.shortfall; }
  return out;
}

async function baseScenarioId(taxpayerId: string, taxYear: number): Promise<string | null> {
  const [s] = await db.select({ id: taxEstScenarios.id }).from(taxEstScenarios)
    .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear), eq(taxEstScenarios.isBase, true)));
  return s?.id ?? null;
}

/** Latest finalized snapshot id per (taxpayer, year) in the firm — metadata only (one query). */
async function latestFinalized(firmId: string, taxpayerIds: readonly string[], years: readonly number[], scenarioId?: string) {
  const out = new Map<string, { id: string; createdAt: Date; tenantIds: string[] }>();
  if (taxpayerIds.length === 0 || years.length === 0) return out;
  const rows = await db.selectDistinctOn([taxEstSnapshots.taxpayerId, taxEstSnapshots.taxYear], {
    id: taxEstSnapshots.id, taxpayerId: taxEstSnapshots.taxpayerId, taxYear: taxEstSnapshots.taxYear,
    createdAt: taxEstSnapshots.createdAt, tenantIds: taxEstSnapshots.tenantIds,
  }).from(taxEstSnapshots)
    .where(and(
      eq(taxEstSnapshots.firmId, firmId), inArray(taxEstSnapshots.taxpayerId, [...taxpayerIds]),
      inArray(taxEstSnapshots.taxYear, [...years]), inArray(taxEstSnapshots.reason, FINALIZED_REASONS),
      // Q51 / Q52 (Kurt 2026-10-13): every dashboard card reads Base snapshots only — a finalized
      // what-if never stands in for the estimate (owner and staff alike).
      scenarioId
        ? eq(taxEstSnapshots.scenarioId, scenarioId)
        : inArray(taxEstSnapshots.scenarioId, db.select({ id: taxEstScenarios.id }).from(taxEstScenarios).where(eq(taxEstScenarios.isBase, true))),
    ))
    .orderBy(taxEstSnapshots.taxpayerId, taxEstSnapshots.taxYear, desc(taxEstSnapshots.createdAt), desc(taxEstSnapshots.id));
  for (const r of rows) out.set(`${r.taxpayerId}|${r.taxYear}`, { id: r.id, createdAt: r.createdAt, tenantIds: r.tenantIds });
  return out;
}

/** The snapshot's frozen result, when this scope may open it (visibility + D1 tenant coverage); else null. */
async function readSnapshot(scope: FirmScope, snapshotId: string): Promise<{ result: EstimateResultDTO; createdAt: string } | null> {
  try {
    const s = await getSnapshot(scope, snapshotId);
    return { result: s.payload.result, createdAt: s.createdAt };
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) return null;
    throw err;
  }
}

/** Cache peek that treats "cannot estimate" (no persons, hidden …) as not computed. */
async function peek(scope: FirmScope, taxpayerId: string, taxYear: number, scenarioId: string, opts: { today: Date; paymentsAsOf?: string }) {
  try {
    return await peekCachedEstimate(scope, { taxpayerId, taxYear, scenarioId }, opts);
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) return null;
    throw err;
  }
}

/**
 * Staff + owner: cached live → latest finalized snapshot → none, Base scenario only (Kurt
 * 2026-10-13: dashboards always reflect Base; what-ifs stay on the taxpayer page).
 */
async function figuresFor(
  scope: FirmScope, taxpayerId: string, taxYear: number,
  opts: { today: Date; paymentsAsOf?: string; liveAllowed: boolean },
): Promise<{ figures: Figures | null; snapshot: { total: string; at: string } | null }> {
  let live: EstimateResultDTO | null = null;
  const base = await baseScenarioId(taxpayerId, taxYear);
  // R4-06: without a Base scenario the portal shows nothing; every dashboard card follows it (Q52, Base only).
  if (!base) return { figures: null, snapshot: null };
  if (opts.liveAllowed) live = await peek(scope, taxpayerId, taxYear, base, opts);
  const snapMeta = (await latestFinalized(scope.firmId, [taxpayerId], [taxYear], base)).get(`${taxpayerId}|${taxYear}`);
  const snap = snapMeta ? await readSnapshot(scope, snapMeta.id) : null;
  const snapshot = snap ? { total: snap.result.summary.total, at: snap.createdAt } : null;
  if (live) return { figures: { result: live, source: 'live', asOf: live.computedAt }, snapshot };
  if (snap) return { figures: { result: snap.result, source: 'snapshot', asOf: snap.createdAt }, snapshot };
  return { figures: null, snapshot: null };
}

// ── company dashboard: staff ────────────────────────────────────────────

/** Q54: of these taxpayer ids, the ones switched to "Show on linked company dashboards". */
async function shownOnCompanyDashboard(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ id: taxEstTaxpayers.id }).from(taxEstTaxpayers)
    .where(and(inArray(taxEstTaxpayers.id, [...ids]), eq(taxEstTaxpayers.showOnCompanyDashboard, true)));
  return new Set(rows.map((r) => r.id));
}

/** D17 / D18 / Q54 visible, active, linked to this company AND switched onto company dashboards. */
async function staffCardTaxpayers(scope: FirmScope, tenantId: string, companyId: string) {
  const linked = await listPackTaxpayers(scope, tenantId, companyId);
  const shown = await shownOnCompanyDashboard(linked.map((t) => t.id));
  return linked.filter((t) => shown.has(t.id));
}

/** Staff audience. `scope` = the Report Pack gate's scope for the company's tenant (resolvePackScope). */
export async function companyCardsForStaff(scope: FirmScope, tenantId: string, companyId: string, opts: CardOptions = {}): Promise<CompanyTaxEstimatesDTO | null> {
  const now = opts.today ?? new Date();
  const today = isoDay(now);
  const linked = await staffCardTaxpayers(scope, tenantId, companyId);
  if (linked.length === 0) return null;
  const taxpayers: TaxEstDashboardTaxpayerDTO[] = [];
  for (const t of linked) {
    const taxYear = portalDefaultYear(t.years, now);
    if (taxYear == null) continue;
    const { figures, snapshot } = await figuresFor(scope, t.id, taxYear, { today: now, liveAllowed: true });
    taxpayers.push(card({ id: t.id, displayName: t.displayName }, taxYear, figures, snapshot, today, true));
  }
  return taxpayers.length > 0 ? { audience: 'staff', today, taxpayers } : null;
}

/** Staff "Refresh" on a company card: one live compute for one linked taxpayer, then its card. */
export async function refreshCompanyCard(
  scope: FirmScope, tenantId: string, companyId: string, taxpayerId: string, opts: CardOptions = {},
): Promise<TaxEstDashboardTaxpayerDTO> {
  const now = opts.today ?? new Date();
  const t = (await staffCardTaxpayers(scope, tenantId, companyId)).find((x) => x.id === taxpayerId);
  if (!t) throw taxpayerNotFound();
  const taxYear = portalDefaultYear(t.years, now);
  if (taxYear == null) throw taxpayerNotFound();
  const base = await baseScenarioId(t.id, taxYear);
  if (!base) throw scenarioNotFound();
  await computeEstimate(scope, { taxpayerId: t.id, taxYear, scenarioId: base }, { today: now });
  const { figures, snapshot } = await figuresFor(scope, t.id, taxYear, { today: now, liveAllowed: true });
  return card({ id: t.id, displayName: t.displayName }, taxYear, figures, snapshot, isoDay(now), true);
}

// ── company dashboard: owner ────────────────────────────────────────────

async function firmForTenant(tenantId: string): Promise<string | null> {
  const [row] = await db.select({ firmId: tenantFirmAssignments.firmId }).from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)))
    .limit(1);
  return row?.firmId ?? null;
}

/** The owner user's e-mail (null when none). */
async function ownerEmail(userId: string): Promise<string | null> {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return u?.email || null;
}

/** Every ACTIVE portal contact of the tenant carrying this e-mail (case-insensitive). */
async function ownerContactIds(tenantId: string, email: string): Promise<string[]> {
  const rows = await db.select({ id: portalContacts.id }).from(portalContacts)
    .where(and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.status, 'active'), sql`lower(${portalContacts.email}) = lower(${email})`));
  return rows.map((r) => r.id);
}

/**
 * The taxpayers (and years) the owner user personally is, for this company: the portal
 * access predicate with the contact found by the user's e-mail (see the header).
 */
async function ownerTaxpayers(email: string, tenantId: string, companyId: string, firmId: string) {
  return db.selectDistinct({
    id: taxEstTaxpayers.id, displayName: taxEstTaxpayers.displayName, portalShows: taxEstTaxpayers.portalShows, taxYear: taxEstLinks.taxYear,
  })
    .from(portalContacts)
    .innerJoin(taxEstTaxpayerContacts, eq(taxEstTaxpayerContacts.portalContactId, portalContacts.id))
    .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstTaxpayerContacts.taxpayerId))
    .innerJoin(taxEstLinks, and(eq(taxEstLinks.taxpayerId, taxEstTaxpayers.id), eq(taxEstLinks.tenantId, tenantId), eq(taxEstLinks.companyId, companyId)))
    .innerJoin(portalContactCompanies, and(
      eq(portalContactCompanies.contactId, portalContacts.id),
      eq(portalContactCompanies.companyId, taxEstLinks.companyId),
      eq(portalContactCompanies.taxEstimatesAccess, true),
    ))
    .innerJoin(taxEstYears, and(eq(taxEstYears.taxpayerId, taxEstTaxpayers.id), eq(taxEstYears.taxYear, taxEstLinks.taxYear)))
    .where(and(
      eq(portalContacts.tenantId, tenantId),
      eq(portalContacts.status, 'active'),
      sql`lower(${portalContacts.email}) = lower(${email})`,
      eq(taxEstTaxpayers.firmId, firmId),
      eq(taxEstTaxpayers.isActive, true),
      eq(taxEstTaxpayers.showOnCompanyDashboard, true), // Q54: the per-taxpayer switch (default OFF)
    ))
    .orderBy(taxEstTaxpayers.displayName, desc(taxEstLinks.taxYear));
}

/** Owner audience: portal-style figures for the taxpayers the owner personally is; null = nothing to show. */
export async function companyCardsForOwner(userId: string, tenantId: string, companyId: string, opts: CardOptions = {}): Promise<CompanyTaxEstimatesDTO | null> {
  const now = opts.today ?? new Date();
  const today = isoDay(now);
  const firmId = await firmForTenant(tenantId);
  if (!firmId) return null;
  const email = await ownerEmail(userId);
  if (!email) return null;
  const rows = await ownerTaxpayers(email, tenantId, companyId, firmId);
  if (rows.length === 0) return null;
  // Q51: the contact's per-contact portal options; several contacts with this e-mail → most restrictive.
  const options = await mostRestrictiveOptionsForContacts(tenantId, await ownerContactIds(tenantId, email));
  // The portal's scope: the firm's full managed set, contact mapping governs (D17 item 6).
  const scope: FirmScope = { firmId, firmRole: 'firm_readonly', allowedTenantIds: await allowedTenantIds(firmId, '', true), viewer: UNRESTRICTED_VIEWER };
  const firm = await getFirmSettings(scope);
  const byId = new Map<string, { id: string; displayName: string; portalShows: string | null; years: number[] }>();
  for (const r of rows) {
    const t = byId.get(r.id) ?? { id: r.id, displayName: r.displayName, portalShows: r.portalShows, years: [] };
    if (!t.years.includes(r.taxYear)) t.years.push(r.taxYear);
    byId.set(r.id, t);
  }
  const taxpayers: TaxEstDashboardTaxpayerDTO[] = [];
  for (const t of byId.values()) {
    const taxYear = portalDefaultYear(t.years, now);
    if (taxYear == null) continue;
    const shows: PortalShows = (t.portalShows as PortalShows | null) ?? firm.portalShows;
    // QA D13 as-of semantics, exactly the portal's live request (same cache entry).
    const { figures, snapshot } = await figuresFor(scope, t.id, taxYear, { today: now, paymentsAsOf: today, liveAllowed: shows === 'live' });
    if (!figures) continue; // the owner never sees "not computed"
    taxpayers.push(card({ id: t.id, displayName: t.displayName }, taxYear, figures, snapshot, today, false, options.quarterlyEstimates));
  }
  return taxpayers.length > 0 ? { audience: 'owner', today, taxpayers } : null;
}

// ── firm-wide ───────────────────────────────────────────────────────────

/**
 * Effective tenant set per taxpayer for the viewer, as `scopeForTaxpayer` would build it, for
 * many taxpayers in one query (D18: a listed user also reads the taxpayer's actively managed
 * linked tenants).
 */
async function effectiveTenantSets(scope: FirmScope, taxpayerIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const base = new Set(scope.allowedTenantIds);
  const out = new Map<string, Set<string>>();
  for (const id of taxpayerIds) out.set(id, base);
  const v = scope.viewer;
  if (v.bypass || !v.userId || taxpayerIds.length === 0) return out;
  const rows = (await db.execute(sql`SELECT DISTINCT tel.taxpayer_id::text AS taxpayer_id, tel.tenant_id::text AS tenant_id
    FROM tax_est_links tel
    JOIN tax_est_taxpayer_staff tes ON tes.taxpayer_id = tel.taxpayer_id AND tes.firm_id = ${scope.firmId}::uuid AND tes.user_id = ${v.userId}::uuid
    JOIN tenant_firm_assignments tfa ON tfa.tenant_id = tel.tenant_id AND tfa.firm_id = ${scope.firmId}::uuid AND tfa.is_active = true
    WHERE tel.taxpayer_id IN (${sql.join(taxpayerIds.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows as Array<{ taxpayer_id: string; tenant_id: string }>;
  for (const r of rows) {
    const cur = out.get(r.taxpayer_id)!;
    if (cur.has(r.tenant_id)) continue;
    const widened = cur === base ? new Set(base) : cur;
    widened.add(r.tenant_id);
    out.set(r.taxpayer_id, widened);
  }
  return out;
}

/** Tenants of each (taxpayer, year)'s links that the firm still actively manages. */
async function linkTenants(firmId: string, taxpayerIds: readonly string[], years: readonly number[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (taxpayerIds.length === 0) return out;
  const rows = await db.selectDistinct({ taxpayerId: taxEstLinks.taxpayerId, taxYear: taxEstLinks.taxYear, tenantId: taxEstLinks.tenantId })
    .from(taxEstLinks)
    .innerJoin(tenantFirmAssignments, and(
      eq(tenantFirmAssignments.tenantId, taxEstLinks.tenantId), eq(tenantFirmAssignments.firmId, firmId), eq(tenantFirmAssignments.isActive, true),
    ))
    .where(and(inArray(taxEstLinks.taxpayerId, [...taxpayerIds]), inArray(taxEstLinks.taxYear, [...years])));
  for (const r of rows) {
    const k = `${r.taxpayerId}|${r.taxYear}`;
    const s = out.get(k) ?? new Set<string>();
    s.add(r.tenantId);
    out.set(k, s);
  }
  return out;
}

const subset = (a: Iterable<string>, b: Set<string>) => { for (const x of a) if (!b.has(x)) return false; return true; };

/**
 * GET /tax-estimator/dashboard — firm-wide cards for every taxpayer the caller may see.
 * null = the caller sees no active taxpayer (the cards are hidden).
 */
export async function firmDashboard(scope: FirmScope, opts: CardOptions = {}): Promise<FirmTaxEstDashboardDTO | null> {
  const now = opts.today ?? new Date();
  const today = isoDay(now);
  const Y = now.getUTCFullYear();
  const years = [Y - 1, Y];
  const visible = await db.select({ id: taxEstTaxpayers.id, displayName: taxEstTaxpayers.displayName }).from(taxEstTaxpayers)
    .where(and(visibleTaxpayerFilter(scope), eq(taxEstTaxpayers.isActive, true)))
    .orderBy(taxEstTaxpayers.displayName);
  if (visible.length === 0) return null;
  const ids = visible.map((t) => t.id);
  const names = new Map(visible.map((t) => [t.id, t.displayName]));
  const [eff, links, summaries, snaps, yearRows] = await Promise.all([
    effectiveTenantSets(scope, ids),
    linkTenants(scope.firmId, ids, years),
    loadDashboardSummaries(scope.firmId, ids, years),
    latestFinalized(scope.firmId, ids, years),
    db.select({ taxpayerId: taxEstYears.taxpayerId, taxYear: taxEstYears.taxYear }).from(taxEstYears)
      .where(and(inArray(taxEstYears.taxpayerId, ids), inArray(taxEstYears.taxYear, years))),
  ]);

  const vouchersDue: FirmVoucherDueDTO[] = [];
  const behind: FirmBehindDTO[] = [];
  const notComputed: FirmTaxEstDashboardDTO['notComputed'] = [];
  for (const { taxpayerId, taxYear } of yearRows.sort((a, b) => a.taxYear - b.taxYear)) {
    const k = `${taxpayerId}|${taxYear}`;
    const mine = eff.get(taxpayerId)!;
    const reach = [...(links.get(k) ?? [])].filter((t) => mine.has(t));
    // Newest stored live summary the viewer may see in full and that is not missing a company they reach.
    const summary = summaries.find((s) => s.taxpayerId === taxpayerId && s.taxYear === taxYear
      && subset(s.tenantIds, mine) && subset(reach, new Set(s.tenantIds)));
    const snapMeta = snaps.get(k);
    let figures: Figures | null = null;
    if (snapMeta && subset(snapMeta.tenantIds, mine) && (!summary || snapMeta.createdAt > summary.computedAt)) {
      const snap = await readSnapshot(scope, snapMeta.id);
      if (snap) figures = { result: snap.result, source: 'snapshot', asOf: snap.createdAt };
    }
    if (!figures && summary) figures = { result: payloadAsEstimate(summary.payload), source: 'live', asOf: summary.computedAt.toISOString() };
    const displayName = names.get(taxpayerId) ?? '';
    if (!figures) {
      if (taxYear === Y) notComputed.push({ taxpayerId, displayName, taxYear });
      continue;
    }
    const p = project(figures, { id: taxpayerId, displayName }, today);
    for (const v of vouchersDueWithin(p.jurisdictions, today, TAX_EST_DASHBOARD_WINDOW_DAYS)) {
      vouchersDue.push({ taxpayerId, displayName, taxYear, ...v, source: figures.source, asOf: figures.asOf });
    }
    // A year stops counting as "behind" once its return is due (the penalty period has ended).
    const due = returnDueOf(figures.result);
    const open = jurisdictionFigures(p, figures.result, today, true).filter((j) => today <= (due.get(j.jurisdiction) ?? `${taxYear + 1}-04-15`));
    const t = dashboardTotals(open, true);
    if (isBehind(t.shortfall)) {
      behind.push({ taxpayerId, displayName, taxYear, shortfall: t.shortfall, penalty: t.penalty ?? '0', source: figures.source, asOf: figures.asOf });
    }
  }
  vouchersDue.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.displayName.localeCompare(b.displayName) || a.jurisdiction.localeCompare(b.jurisdiction));
  behind.sort((a, b) => Number(b.shortfall) - Number(a.shortfall) || a.displayName.localeCompare(b.displayName));
  return { today, windowDays: TAX_EST_DASHBOARD_WINDOW_DAYS, vouchersDue, behind, notComputed, visibleTaxpayers: visible.length };
}

/** POST /tax-estimator/dashboard/taxpayers/:id/years/:taxYear/refresh — one live compute of the Base scenario (stores its summary). */
export async function refreshFirmCard(scope: FirmScope, taxpayerId: string, taxYear: number, opts: CardOptions = {}): Promise<{ computedAt: string }> {
  await loadTaxpayerForFirm(scope, taxpayerId); // D17 / D18: hidden = 404
  const base = await baseScenarioId(taxpayerId, taxYear);
  if (!base) throw scenarioNotFound();
  const r = await computeEstimate(scope, { taxpayerId, taxYear, scenarioId: base }, { today: opts.today });
  return { computedAt: r.computedAt };
}
