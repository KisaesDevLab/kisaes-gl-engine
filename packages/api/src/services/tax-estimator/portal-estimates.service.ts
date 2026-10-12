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
// LIVE vs SNAPSHOT (D10). Default live: computed on request through the same scoped
// service as the staff screen (encrypted Redis cache keyed by GL stamps + inputs hash)
// under the FIRM's full managed-tenant set — the portal contact has no user, and the
// output is only the taxpayer-level figures the firm chose to share. When the taxpayer's
// portal_shows (else the firm default) is 'snapshot', the latest finalized snapshot
// (reason finalize / vouchers) is shown instead, or nothing yet.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type {
  EstimateResultDTO, PortalShows, PortalTaxEstimateDTO, PortalTaxEstimateListItemDTO, PortalTaxEstimateResponseDTO,
  PortalTaxJurisdictionDTO,
} from '@kis-books/shared';
import { DEFAULT_DISCLAIMER_TEXT, STATE_NAMES, dRoundDollars, portalDefaultYear } from '@kis-books/shared';
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

/**
 * The ALLOW-LIST projection. Reads only voucher / payment / total fields; adding a field
 * here is a privacy decision (see PortalTaxEstimateDTO and the route test's key list).
 */
export function toPortalEstimate(r: EstimateResultDTO, meta: {
  taxpayer: { id: string; displayName: string }; source: 'live' | 'snapshot'; asOf: string; firmName: string | null; disclaimer: string;
  /** QA D12: the client's "today" (YYYY-MM-DD); the next payment is the next UPCOMING due date. */
  today: string;
}): PortalTaxEstimateDTO {
  const jurisdictions: PortalTaxJurisdictionDTO[] = [r.federalEstimates, ...r.stateEstimates].map((e) => {
    const installments = e.estimatesRequired ? e.installments.map((i) => ({
      label: i.label, dueDate: i.dueDate, amount: R(i.netRequired), paid: R(i.estimatesApplied), remaining: R(i.unpaid),
      status: i.status, paidOn: i.paidInFullOn ?? null,
    })) : [];
    // QA D12: the next payment is the first installment due today or later that still needs money
    // (its catch-up amount carries any earlier unpaid balance). Past-due installments stay in the
    // list, flagged; they are never presented as the "next" date.
    const next = e.estimatesRequired
      ? e.installments.find((i) => i.dueDate >= meta.today && Number(i.catchUpAmount) > 0)
      : undefined;
    return {
      jurisdiction: e.jurisdiction,
      label: jurisdictionLabel(e.jurisdiction),
      estimatesRequired: e.estimatesRequired,
      installments,
      nextPayment: next ? { label: next.label, dueDate: next.dueDate, amount: R(next.catchUpAmount) } : null,
      totals: {
        required: R(e.totals.required), withholding: R(e.totals.withholding),
        estimatesPaid: R(e.totals.estimatesPaid), remaining: R(e.totals.unpaid),
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

/** GET /api/portal/tax-estimates/:taxpayerId?year= */
export async function getForContact(
  caller: PortalCaller, taxpayerId: string, year: number | undefined, opts: EstimateOptions = {},
): Promise<PortalTaxEstimateResponseDTO> {
  const firmId = await firmForTenant(caller.tenantId);
  if (!firmId) throw notFound();
  const rows = await visible(caller, firmId, taxpayerId);
  if (rows.length === 0) throw notFound();
  const taxYear = year ?? defaultYear(rows.map((r) => r.taxYear));
  if (taxYear == null || !rows.some((r) => r.taxYear === taxYear)) throw notFound();
  const taxpayer = { id: rows[0]!.id, displayName: rows[0]!.displayName };

  // The firm's full managed set: the portal has no user to intersect with (D1 note above).
  // D17: the portal is governed by the contact mapping, not staff visibility.
  const scope: FirmScope = { firmId, firmRole: 'firm_readonly', allowedTenantIds: await allowedTenantIds(firmId, '', true), viewer: UNRESTRICTED_VIEWER };
  const [tp] = await db.select({ portalShows: taxEstTaxpayers.portalShows }).from(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, taxpayerId));
  const firm = await getFirmSettings(scope);
  const shows: PortalShows = (tp?.portalShows as PortalShows | null) ?? firm.portalShows;
  const name = await firmName(firmId);
  const today = (opts.today ?? new Date()).toISOString().slice(0, 10);

  if (shows === 'snapshot') {
    const [snap] = await db.select({ id: taxEstSnapshots.id }).from(taxEstSnapshots)
      .where(and(
        eq(taxEstSnapshots.firmId, firmId), eq(taxEstSnapshots.taxpayerId, taxpayerId), eq(taxEstSnapshots.taxYear, taxYear),
        inArray(taxEstSnapshots.reason, FINALIZED_REASONS),
      ))
      .orderBy(desc(taxEstSnapshots.createdAt), desc(taxEstSnapshots.id))
      .limit(1);
    if (!snap) return { estimate: null, unavailableReason: 'no_snapshot' };
    let s;
    try {
      s = await getSnapshot(scope, snap.id);
    } catch (err) {
      // A snapshot including a client the firm no longer manages is not shown (D1).
      if (err instanceof AppError && err.statusCode === 404) return { estimate: null, unavailableReason: 'no_snapshot' };
      throw err;
    }
    return {
      estimate: toPortalEstimate(s.payload.result, {
        taxpayer, source: 'snapshot', asOf: s.createdAt, firmName: name, today,
        disclaimer: s.payload.disclaimerText?.trim() || DEFAULT_DISCLAIMER_TEXT,
      }),
      unavailableReason: null,
    };
  }

  const scenarios = await db.select({ id: taxEstScenarios.id, isBase: taxEstScenarios.isBase }).from(taxEstScenarios)
    .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, taxYear)));
  // R4-06: the BASE scenario or nothing — never a what-if that happens to sort first.
  const base = scenarios.find((s) => s.isBase);
  if (!base) throw notFound();
  // QA D13: as-of semantics — a payment dated after today is not paid yet.
  const result = await computeEstimate(scope, { taxpayerId, taxYear, scenarioId: base.id }, { ...opts, paymentsAsOf: today });
  return {
    estimate: toPortalEstimate(result, {
      taxpayer, source: 'live', asOf: result.computedAt, firmName: name, today,
      disclaimer: result.disclaimerText?.trim() || firm.effectiveDisclaimerText || DEFAULT_DISCLAIMER_TEXT,
    }),
    unavailableReason: null,
  };
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
  const due = e.jurisdictions.filter((j) => j.estimatesRequired && j.installments.some((i) => Number(i.remaining) > 0));
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
