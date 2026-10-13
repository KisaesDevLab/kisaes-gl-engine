// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 13 — the client-portal view (MODULE.md "Access", D5, D10;
// UI-SPEC §05).
//
// WHO SEES WHAT. A portal contact sees a taxpayer only when ALL hold:
//   - the taxpayer is mapped to this contact (tax_est_taxpayer_contacts),
//   - the taxpayer is active and belongs to the firm that actively manages the
//     contact's tenant (a taxpayer of another firm is invisible),
//   - the taxpayer is linked, for the tax year, to a company of the contact's tenant on
//     which the contact holds portal_contact_companies.tax_estimates_access,
//   - the year has annual settings.
// The router adds CLIENT_PORTAL_V1 + TAX_ESTIMATOR_V1 on the CONTACT's tenant. Anything
// else is a 404 that does not distinguish "no such taxpayer" from "not yours".
//
// WHAT IT CONTAINS. `toPortalEstimate` is an ALLOW-LIST projection of the engine result:
// the taxpayer's own totals, voucher due dates / amounts / payments per jurisdiction,
// payment dates and amounts, the as-of label and the firm disclaimer. Persons, other
// owners, links, entities, adjustments, rates, traces, parameters, readiness and the
// safe-harbor workings (incl. prior-year tax / AGI, D9) never leave this file.
//
// PER-CONTACT OPTIONS (Q51). `applyPortalOptions` then drops what the contact's
// tax_est_portal_contact_options row switches off (installments / next payment, payments on
// record) and adds the calculation summary (shared/portal-summary.ts, its own allow-list) when
// switched on — as absent keys, never hidden ones. Staff share what-if scenarios one by one
// (tax_est_scenarios.show_in_portal); Base is always offered. The voucher PDF needs
// `quarterly_estimates`, the portal-safe estimate PDF (rendered from the filtered DTO) `pdf_download`. The estimate is computed /
// cached once for everyone; the options are applied per request after it.
//
// LIVE vs SNAPSHOT (D10). Default live: computed on request through the same scoped
// service as the staff screen (encrypted Redis cache keyed by GL stamps + inputs hash)
// under the FIRM's full managed-tenant set — the portal contact has no user, and the
// output is only the taxpayer-level figures the firm chose to share. When the taxpayer's
// portal_shows (else the firm default) is 'snapshot', the latest finalized snapshot
// (reason finalize / vouchers) is shown instead, or nothing yet.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type {
  EstimateResultDTO, PortalContactTaxOptionsDTO, PortalShows, PortalTaxEstimateDTO, PortalTaxEstimateListItemDTO, PortalTaxEstimateResponseDTO,
  PortalTaxJurisdictionDTO, PortalTaxPaymentDTO, SnapshotReason,
} from '@kis-books/shared';
import { DEFAULT_DISCLAIMER_TEXT, STATE_NAMES, buildPortalCalcSummary, dRoundDollars, installmentsAsOf, portalDefaultYear } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { portalContactCompanies, tenantFirmAssignments } from '../../db/schema/index.js';
import { taxEstLinks, taxEstTaxpayerContacts, taxEstTaxpayers } from '../../db/schema/tax-estimator-taxpayers.js';
import { taxEstScenarios, taxEstYears } from '../../db/schema/tax-estimator-years.js';
import { taxEstSnapshots } from '../../db/schema/tax-estimator-estimate.js';
import { AppError } from '../../utils/errors.js';
import * as firmsService from '../firms.service.js';
import { allowedTenantIds, UNRESTRICTED_VIEWER, type FirmScope } from './firm-scope.service.js';
import { getFirmSettings } from './firm-settings.service.js';
import { computeEstimate, type EstimateOptions } from './estimate.service.js';
import { getSnapshot } from './estimate-snapshots.service.js';
import { renderPortalEstimatePdf } from './portal-estimate-pdf.service.js';
import { estimatePdfFilename } from './estimate-documents.service.js';
import { optionsForContact } from './portal-options.service.js';

export interface PortalCaller {
  contactId: string;
  tenantId: string;
  /** The portal's active company; when set, only taxpayers linked to it are visible. */
  companyId?: string | null;
}

const notFound = () => new AppError(404, 'Tax estimate not found', 'TE_PORTAL_FORBIDDEN');
const FINALIZED_REASONS = ['finalize', 'vouchers'];

/** The firm that actively manages the contact's tenant (null = none: nothing to show). */
async function firmForTenant(tenantId: string): Promise<string | null> {
  const [row] = await db.select({ firmId: tenantFirmAssignments.firmId }).from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)))
    .limit(1);
  return row?.firmId ?? null;
}

/** (taxpayer, year) pairs the contact may open — the access predicate in ONE query. */
async function visible(caller: PortalCaller, firmId: string, taxpayerId?: string) {
  return db.selectDistinct({ id: taxEstTaxpayers.id, displayName: taxEstTaxpayers.displayName, taxYear: taxEstLinks.taxYear })
    .from(taxEstTaxpayerContacts)
    .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstTaxpayerContacts.taxpayerId))
    .innerJoin(taxEstLinks, and(eq(taxEstLinks.taxpayerId, taxEstTaxpayers.id), eq(taxEstLinks.tenantId, caller.tenantId)))
    .innerJoin(portalContactCompanies, and(
      eq(portalContactCompanies.contactId, caller.contactId),
      eq(portalContactCompanies.companyId, taxEstLinks.companyId),
      eq(portalContactCompanies.taxEstimatesAccess, true),
    ))
    .innerJoin(taxEstYears, and(eq(taxEstYears.taxpayerId, taxEstTaxpayers.id), eq(taxEstYears.taxYear, taxEstLinks.taxYear)))
    .where(and(
      eq(taxEstTaxpayerContacts.portalContactId, caller.contactId),
      eq(taxEstTaxpayers.firmId, firmId),
      eq(taxEstTaxpayers.isActive, true),
      caller.companyId ? eq(taxEstLinks.companyId, caller.companyId) : undefined,
      taxpayerId ? eq(taxEstTaxpayers.id, taxpayerId) : undefined,
    ))
    .orderBy(taxEstTaxpayers.displayName, desc(taxEstLinks.taxYear));
}

/** GET /api/portal/tax-estimates — the taxpayers (and years) this contact may open. */
export async function listForContact(caller: PortalCaller): Promise<PortalTaxEstimateListItemDTO[]> {
  const firmId = await firmForTenant(caller.tenantId);
  if (!firmId) return [];
  const byId = new Map<string, PortalTaxEstimateListItemDTO>();
  for (const r of await visible(caller, firmId)) {
    const t = byId.get(r.id) ?? { id: r.id, displayName: r.displayName, years: [] };
    if (!t.years.includes(r.taxYear)) t.years.push(r.taxYear);
    byId.set(r.id, t);
  }
  return [...byId.values()];
}

/** Default year: the newest year not after the current calendar year, else the newest (shared with the portal page). */
export const defaultYear = portalDefaultYear;

const R = (v: string | null | undefined) => dRoundDollars(v ?? '0');

function jurisdictionLabel(j: string): string {
  if (j === 'federal') return 'Federal (IRS)';
  return (STATE_NAMES as Record<string, string>)[j] ?? j;
}

/** The projection before the per-contact options (Q51): every section present. */
export type FullPortalEstimate = PortalTaxEstimateDTO & { jurisdictions: PortalTaxJurisdictionDTO[]; payments: PortalTaxPaymentDTO[] };

/**
 * The ALLOW-LIST projection. Reads only voucher / payment / total fields; adding a field
 * here is a privacy decision (see PortalTaxEstimateDTO and the route test's key list).
 */
export function toPortalEstimate(r: EstimateResultDTO, meta: {
  taxpayer: { id: string; displayName: string }; source: 'live' | 'snapshot'; asOf: string; firmName: string | null; disclaimer: string;
  /** QA D12: the client's "today" (YYYY-MM-DD); the next payment is the next UPCOMING due date. */
  today: string;
}): FullPortalEstimate {
  const jurisdictions: PortalTaxJurisdictionDTO[] = [r.federalEstimates, ...r.stateEstimates].map((e) => {
    // QA2-01 / D13: status, paid, remaining, the next payment and the totals are all AS OF
    // the client's today. The engine credits every known amount whatever its date (a
    // post-dated payment, a later installment's withholding share), which would show a
    // past-due installment as "Paid" on a future date. A frozen snapshot is projected the
    // same way; its stored figures are not changed.
    const asOf = e.payments ? installmentsAsOf(e, r.payments, meta.today) : null;
    const rows = e.estimatesRequired ? e.installments.map((i, k) => {
      const a = asOf?.installments[k];
      return a
        ? { label: i.label, dueDate: i.dueDate, amount: R(i.netRequired), paid: a.paid, remaining: a.remaining, status: a.status, paidOn: a.paidOn, catchUp: a.catchUpAmount }
        : { label: i.label, dueDate: i.dueDate, amount: R(i.netRequired), paid: R(i.estimatesApplied), remaining: R(i.unpaid), status: i.status, paidOn: i.paidInFullOn ?? null, catchUp: R(i.catchUpAmount) };
    }) : [];
    // QA D12: the next payment is the first installment due today or later that still needs money
    // (its catch-up amount carries any earlier unpaid balance). Past-due installments stay in the
    // list, flagged; they are never presented as the "next" date.
    const next = rows.find((i) => i.dueDate >= meta.today && Number(i.catchUp) > 0);
    return {
      jurisdiction: e.jurisdiction,
      label: jurisdictionLabel(e.jurisdiction),
      estimatesRequired: e.estimatesRequired,
      installments: rows.map(({ catchUp: _catchUp, ...i }) => i),
      nextPayment: next ? { label: next.label, dueDate: next.dueDate, amount: next.catchUp } : null,
      totals: {
        required: R(e.totals.required), withholding: R(e.totals.withholding),
        estimatesPaid: asOf ? asOf.estimatesPaid : R(e.totals.estimatesPaid), remaining: asOf ? asOf.remaining : R(e.totals.unpaid),
      },
    };
  });
  const through = r.entities.filter((e) => e.path === 'individual').map((e) => e.throughMonth).filter((m): m is string => !!m).sort()[0] ?? null;
  return {
    taxpayer: { id: meta.taxpayer.id, displayName: meta.taxpayer.displayName },
    taxYear: r.taxYear,
    source: meta.source,
    asOf: meta.asOf,
    booksThrough: through,
    firmName: meta.firmName,
    disclaimer: meta.disclaimer,
    totals: { total: R(r.summary.total), federal: R(r.summary.federalTotal), state: R(r.summary.stateTotal) },
    jurisdictions,
    // QA D13: a payment dated after today is not "on record" yet.
    payments: r.payments
      .filter((p) => p.date == null || p.date <= meta.today)
      .map((p) => ({ date: p.date, jurisdiction: p.jurisdiction, amount: R(p.amount) }))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
  };
}

async function firmName(firmId: string): Promise<string | null> {
  try {
    return (await firmsService.getById(firmId)).name;
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
}

export interface PortalScenarioPick {
  /** Requested scenario (?scenarioId=); absent = Base (or the first offered). */
  scenarioId?: string;
}

/**
 * Everything one portal request resolves to. `response` is the per-contact, option-filtered
 * DTO the route sends; `full` is the unfiltered allow-list projection (voucher PDF) and
 * `result` the engine result it came from (audit metadata only; the portal-safe PDF reads `response`). Neither leaves the server.
 */
export interface ResolvedPortalEstimate {
  response: PortalTaxEstimateResponseDTO;
  options: PortalContactTaxOptionsDTO;
  full: FullPortalEstimate | null;
  result: EstimateResultDTO | null;
  taxpayer: { id: string; displayName: string };
  firmName: string | null;
  disclaimer: string | null;
  snapshot: { id: string; createdAt: string; reason: SnapshotReason } | null;
  scenarioId: string | null;
  /** Q51: the shown scenario's name (staff-named, as the picker shows it). */
  scenarioName: string | null;
}

/**
 * Q51: drop the sections this contact may not see (server-side: an absent key, never a
 * hidden one) and add the calculation summary when shared. Runs per request on the computed
 * estimate, AFTER the shared Redis cache, so one contact's options never reach another.
 */
export function applyPortalOptions(e: PortalTaxEstimateDTO, r: EstimateResultDTO, o: PortalContactTaxOptionsDTO): PortalTaxEstimateDTO {
  const out: PortalTaxEstimateDTO = { ...e };
  if (!o.quarterlyEstimates) delete out.jurisdictions;
  if (!o.paymentsOnRecord) delete out.payments;
  if (o.calculationSummary) {
    try {
      out.calculationSummary = buildPortalCalcSummary(r);
    } catch {
      // A frozen snapshot that cannot be summarised still shows the rest of the estimate.
    }
  }
  return out;
}

/** Resolve the contact's view of one taxpayer-year (and scenario). Every miss is the uniform 404. */
export async function resolveForContact(
  caller: PortalCaller, taxpayerId: string, year: number | undefined, opts: EstimateOptions = {}, pick: PortalScenarioPick = {},
): Promise<ResolvedPortalEstimate> {
  const firmId = await firmForTenant(caller.tenantId);
  if (!firmId) throw notFound();
  const rows = await visible(caller, firmId, taxpayerId);
  if (rows.length === 0) throw notFound();
  const taxYear = year ?? defaultYear(rows.map((r) => r.taxYear));
  if (taxYear == null || !rows.some((r) => r.taxYear === taxYear)) throw notFound();
  const taxpayer = { id: rows[0]!.id, displayName: rows[0]!.displayName };
  const options = await optionsForContact(caller.tenantId, caller.contactId);

  // The firm's full managed set: the portal has no user to intersect with (D1 note above).
  // D17: the portal is governed by the contact mapping, not staff visibility.
  const scope: FirmScope = { firmId, firmRole: 'firm_readonly', allowedTenantIds: await allowedTenantIds(firmId, '', true), viewer: UNRESTRICTED_VIEWER };
  const [tp] = await db.select({ portalShows: taxEstTaxpayers.portalShows }).from(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, taxpayerId));
  const firm = await getFirmSettings(scope);
  const shows: PortalShows = (tp?.portalShows as PortalShows | null) ?? firm.portalShows;
  const name = await firmName(firmId);
  const today = (opts.today ?? new Date()).toISOString().slice(0, 10);

  // Q51: the scenarios staff share — Base always, plus what-ifs marked show_in_portal. R4-06:
  // without a Base there is nothing to show, never a what-if in its place.
  const scenarios = await db.select({ id: taxEstScenarios.id, name: taxEstScenarios.name, isBase: taxEstScenarios.isBase, showInPortal: taxEstScenarios.showInPortal })
    .from(taxEstScenarios)
    .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear)))
    .orderBy(desc(taxEstScenarios.isBase), asc(taxEstScenarios.sortOrder), asc(taxEstScenarios.createdAt));
  const base = scenarios.find((s) => s.isBase);
  if (!base) throw notFound();
  const shared = scenarios.filter((s) => s.isBase || s.showInPortal);

  const resolved = (r: Omit<ResolvedPortalEstimate, 'options' | 'taxpayer' | 'firmName'>): ResolvedPortalEstimate => ({ ...r, options, taxpayer, firmName: name });
  const withPicker = (offered: typeof shared, chosen: string | null, body: PortalTaxEstimateResponseDTO): PortalTaxEstimateResponseDTO => {
    const out: PortalTaxEstimateResponseDTO = { ...body };
    if (offered.length > 1 && chosen) {
      out.scenarios = offered.map((s) => ({ id: s.id, name: s.name, isBase: s.isBase }));
      out.scenarioId = chosen;
    }
    if (options.pdfDownload && body.estimate) out.pdfDownload = true;
    return out;
  };

  if (shows === 'snapshot') {
    // Per scenario: its latest FINALIZED snapshot; a shared scenario without one is not offered.
    const latest = new Map<string, string>();
    for (const s of shared) {
      const [snap] = await db.select({ id: taxEstSnapshots.id }).from(taxEstSnapshots)
        .where(and(
          eq(taxEstSnapshots.firmId, firmId), eq(taxEstSnapshots.taxpayerId, taxpayerId), eq(taxEstSnapshots.taxYear, taxYear),
          eq(taxEstSnapshots.scenarioId, s.id), inArray(taxEstSnapshots.reason, FINALIZED_REASONS),
        ))
        .orderBy(desc(taxEstSnapshots.createdAt), desc(taxEstSnapshots.id))
        .limit(1);
      if (snap) latest.set(s.id, snap.id);
    }
    const offered = shared.filter((s) => latest.has(s.id));
    if (pick.scenarioId && !offered.some((s) => s.id === pick.scenarioId)) throw notFound();
    const chosen = pick.scenarioId ?? offered[0]?.id ?? null;
    const none = () => resolved({
      response: { estimate: null, unavailableReason: 'no_snapshot' }, full: null, result: null, disclaimer: null, snapshot: null, scenarioId: null, scenarioName: null,
    });
    if (!chosen) return none();
    let s;
    try {
      s = await getSnapshot(scope, latest.get(chosen)!);
    } catch (err) {
      // A snapshot including a client the firm no longer manages is not shown (D1).
      if (err instanceof AppError && err.statusCode === 404) return none();
      throw err;
    }
    const disclaimer = s.payload.disclaimerText?.trim() || DEFAULT_DISCLAIMER_TEXT;
    const full = toPortalEstimate(s.payload.result, { taxpayer, source: 'snapshot', asOf: s.createdAt, firmName: name, today, disclaimer });
    return resolved({
      response: withPicker(offered, chosen, { estimate: applyPortalOptions(full, s.payload.result, options), unavailableReason: null }),
      full, result: { ...s.payload.result, assumptions: s.payload.assumptions }, disclaimer: s.payload.disclaimerText ?? null,
      snapshot: { id: s.id, createdAt: s.createdAt, reason: s.reason }, scenarioId: chosen,
      scenarioName: offered.find((x) => x.id === chosen)?.name ?? null,
    });
  }

  if (pick.scenarioId && !shared.some((s) => s.id === pick.scenarioId)) throw notFound();
  const chosen = pick.scenarioId ?? base.id;
  // QA D13: as-of semantics — a payment dated after today is not paid yet. The estimate
  // itself is the shared (Redis-cached) staff computation; options are applied after it.
  const result = await computeEstimate(scope, { taxpayerId, taxYear, scenarioId: chosen }, { ...opts, paymentsAsOf: today });
  const disclaimer = result.disclaimerText?.trim() || firm.effectiveDisclaimerText || DEFAULT_DISCLAIMER_TEXT;
  const full = toPortalEstimate(result, { taxpayer, source: 'live', asOf: result.computedAt, firmName: name, today, disclaimer });
  return resolved({
    response: withPicker(shared, chosen, { estimate: applyPortalOptions(full, result, options), unavailableReason: null }),
    full, result, disclaimer, snapshot: null, scenarioId: chosen,
    scenarioName: shared.find((x) => x.id === chosen)?.name ?? null,
  });
}

/** GET /api/portal/tax-estimates/:taxpayerId?year=&scenarioId= */
export async function getForContact(
  caller: PortalCaller, taxpayerId: string, year: number | undefined, opts: EstimateOptions = {}, pick: PortalScenarioPick = {},
): Promise<PortalTaxEstimateResponseDTO> {
  return (await resolveForContact(caller, taxpayerId, year, opts, pick)).response;
}

/**
 * Q51 (Kurt: "Portal-safe PDF"): the estimate PDF a portal contact downloads, rendered ONLY
 * from the option-filtered portal DTO (portal-estimate-pdf.service), so it never shows more
 * than the portal JSON. Not the Report Pack client copy.
 */
export async function renderPortalSafePdf(r: ResolvedPortalEstimate): Promise<{ bytes: Uint8Array; filename: string }> {
  const e = r.response.estimate;
  if (!e) throw notFound();
  const bytes = await renderPortalEstimatePdf(e, { scenarioName: r.scenarioName });
  return { bytes, filename: estimatePdfFilename(e.taxYear, r.taxpayer.displayName, r.scenarioName) };
}

// ── Voucher PDF (built from the projected DTO only, so it cannot carry more) ──

const usd = (v: string) => {
  const n = Math.round(Number(v) || 0);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
};
const winAnsi = (t: string) => t.replace(/[\t\n\v\f\r]/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

/**
 * One page per jurisdiction that requires estimates: the remaining installments to pay.
 * R4-05: the firm disclaimer prints one paragraph per line it was typed with, and a long
 * disclaimer continues on a new page instead of running past the bottom margin.
 */
export async function renderVouchersPdf(e: PortalTaxEstimateDTO): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(winAnsi(`${e.taxYear} estimated tax payment vouchers - ${e.taxpayer.displayName}`));
  const W = 612;
  const M = 54;
  const ink = rgb(0.09, 0.1, 0.12);
  const muted = rgb(0.35, 0.38, 0.41);
  const due = (e.jurisdictions ?? []).filter((j) => j.estimatesRequired && j.installments.some((i) => Number(i.remaining) > 0));
  const pages = due.length > 0 ? due : [null];
  const FOOTER_Y = M - 20;
  for (const j of pages) {
    let page = doc.addPage([W, 792]);
    let y = 792 - M;
    const text = (t: string, x: number, size: number, b = false, color = ink) => page.drawText(winAnsi(t), { x, y, size, font: b ? bold : font, color });
    /** Room for one more disclaimer line above the footer; else continue on a new page. */
    const room = (h: number) => {
      if (y - h >= FOOTER_Y + 14) return;
      page = doc.addPage([W, 792]);
      y = 792 - M;
      text(`${e.taxYear} estimated tax payment voucher - ${e.taxpayer.displayName} (continued)`, M, 9, true, muted);
      y -= 20;
    };
    if (e.firmName) { text(e.firmName, M, 10, true, muted); y -= 22; }
    text(`${e.taxYear} estimated tax payment voucher`, M, 18, true); y -= 20;
    text(`${e.taxpayer.displayName}`, M, 11, true); y -= 16;
    if (!j) {
      text('No estimated tax payments are due.', M, 10); y -= 16;
    } else {
      text(j.label, M, 13, true); y -= 20;
      text('Installment', M, 9, true); text('Due date', M + 150, 9, true); text('Amount', M + 260, 9, true); text('Paid', M + 340, 9, true); text('Pay', M + 420, 9, true);
      y -= 14;
      for (const i of j.installments) {
        if (Number(i.remaining) <= 0) continue;
        text(i.label, M, 10); text(i.dueDate, M + 150, 10); text(usd(i.amount), M + 260, 10); text(usd(i.paid), M + 340, 10); text(usd(i.remaining), M + 420, 10, true);
        y -= 15;
      }
      y -= 8;
      if (j.nextPayment) { text(`Next payment: ${usd(j.nextPayment.amount)} by ${j.nextPayment.dueDate} (includes any earlier unpaid amount).`, M, 10, true); y -= 16; }
      const how = j.jurisdiction === 'federal'
        ? 'Pay online through IRS Direct Pay or EFTPS (choose Form 1040-ES, estimated tax), or mail a check with Form 1040-ES.'
        : `Pay through the ${j.label} department of revenue's estimated-payment options. Ask your accountant if you are unsure.`;
      text(how, M, 8.5, false, muted); y -= 14;
    }
    y -= 10;
    // Firm disclaimer: one paragraph per typed line, each wrapped to the page width.
    const paras = e.disclaimer.replace(/\r\n?/g, '\n').split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
    paras.forEach((para, pi) => {
      let line = '';
      const flush = () => { room(11); text(line, M, 8, false, muted); y -= 11; };
      for (const word of winAnsi(para).split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, 8) > W - 2 * M && line) { flush(); line = word; } else line = next;
      }
      if (line) flush();
      if (pi < paras.length - 1) y -= 4;
    });
    y = FOOTER_Y;
    text(`Figures as of ${e.asOf.slice(0, 10)}.`, M, 8, false, muted);
  }
  return doc.save();
}
