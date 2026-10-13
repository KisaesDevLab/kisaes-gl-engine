// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q51 — the PORTAL-SAFE estimate PDF (Kurt, 2026-10-13: "Portal-safe PDF").
//
// A pure renderer fed ONLY by the option-filtered PortalTaxEstimateDTO the portal JSON carries
// (portal-estimates.service applyPortalOptions), plus the shown scenario's name. It cannot print
// more than the contact may see in the JSON: the header (taxpayer, year, firm, as-of / source,
// books-through), the projected total (always), the calculation summary (only when the DTO has
// it), the installments and next payment (only when the DTO has jurisdictions), the payments on
// record (only when the DTO has payments) and the firm disclaimer. Never the staff
// EstimateResultDTO, so no entity totals, other owners, ownership %, rates, traces, warnings or
// adjustment detail can reach it. It is NOT the Report Pack client copy.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PortalTaxEstimateDTO } from '@kis-books/shared';
import { LINE, MARGIN, MUTED, RIGHT, Writer, paragraphs } from './estimate-pdf.service.js';

const usd = (v: unknown): string => {
  const n = Math.round(Number(v) || 0);
  const s = Math.abs(n).toLocaleString('en-US');
  return n < 0 ? `-$${s}` : `$${s}`;
};
const nz = (v: string) => Number(v) !== 0;

export interface PortalPdfMeta {
  /** The scenario shown (staff-named); null = not stated (Base). */
  scenarioName: string | null;
}

export async function renderPortalEstimatePdf(e: PortalTaxEstimateDTO, meta: PortalPdfMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(`${e.taxYear} tax estimate - ${e.taxpayer.displayName}`.replace(/[^\x20-\x7E]/g, '?'));
  const footer = `${e.firmName ? `${e.firmName} - ` : ''}${e.taxYear} tax estimate - ${e.taxpayer.displayName}`;
  const w = new Writer(doc, font, bold, footer);
  const cols = [RIGHT];

  // Header
  w.text(e.firmName?.trim() || 'Tax estimate', MARGIN, 11, { bold: true });
  w.y -= 26;
  w.text(`Your ${e.taxYear} tax estimate`, MARGIN, 20, { bold: true });
  w.y -= 16;
  w.text(e.taxpayer.displayName, MARGIN, 11, { bold: true });
  w.y -= 14;
  if (meta.scenarioName) { w.text(`Scenario: ${meta.scenarioName}`, MARGIN, 9, { color: MUTED }); w.y -= LINE; }
  const asOf = e.source === 'live' ? `Live estimate as of ${e.asOf.slice(0, 16).replace('T', ' ')} UTC` : `Prepared ${e.asOf.slice(0, 10)}`;
  w.text(`${asOf}${e.booksThrough ? ` - based on your books through ${e.booksThrough}` : ''}`, MARGIN, 9, { color: MUTED });
  w.y -= LINE;

  // Projected total (always)
  w.heading(`Projected ${e.taxYear} total`);
  w.row(['Federal', usd(e.totals.federal)], cols);
  w.row(['State', usd(e.totals.state)], cols);
  w.row(['Total estimated tax', usd(e.totals.total)], cols, { bold: true });

  // Calculation summary (only when shared)
  const s = e.calculationSummary;
  if (s) {
    w.heading('How your estimate is calculated');
    w.wrap('Full-year projection. Business amounts are your share.', 8.5, 0, MUTED);
    for (const b of s.businesses) w.row([b.name || 'Business', usd(b.amount)], cols);
    for (const o of s.otherIncome) w.row([o.label, usd(o.amount)], cols);
    w.row(['Total income', usd(s.totalIncome)], cols, { bold: true });
    if (nz(s.adjustmentsTotal)) w.row(['Adjustments to income', usd(`-${s.adjustmentsTotal}`)], cols);
    w.row(['Adjusted gross income', usd(s.agi)], cols, { bold: true });
    w.row([s.deduction.kind === 'itemized' ? 'Itemized deductions' : 'Standard deduction', usd(`-${s.deduction.amount}`)], cols);
    if (nz(s.additionalDeductions)) w.row(['Additional deductions', usd(`-${s.additionalDeductions}`)], cols);
    if (nz(s.qbiDeduction)) w.row(['Qualified business income deduction', usd(`-${s.qbiDeduction}`)], cols);
    w.row(['Taxable income', usd(s.taxableIncome)], cols, { bold: true });
    w.row(['Income tax', usd(s.regularTax)], cols);
    if (nz(s.credits)) w.row(['Credits', usd(`-${s.credits}`)], cols);
    if (nz(s.selfEmploymentTax)) w.row(['Self-employment tax', usd(s.selfEmploymentTax)], cols);
    if (nz(s.additionalMedicareTax)) w.row(['Additional Medicare tax', usd(s.additionalMedicareTax)], cols);
    if (nz(s.niit)) w.row(['Net investment income tax', usd(s.niit)], cols);
    w.row(['Federal total', usd(s.federalTotal)], cols, { bold: true });
    for (const st of s.states) w.row([st.label, usd(st.amount)], cols);
    if (s.states.length > 0) w.row(['State total', usd(s.stateTotal)], cols, { bold: true });
    w.row(['Total estimated tax', usd(s.total)], cols, { bold: true });
  }

  // Quarterly estimates (only when shared)
  if (e.jurisdictions) {
    w.heading('Estimated payments');
    const vc = [MARGIN + 250, MARGIN + 330, MARGIN + 410, RIGHT];
    for (const j of e.jurisdictions) {
      w.ensure(3 * LINE);
      w.text(j.label, MARGIN, 9.5, { bold: true });
      w.y -= LINE;
      if (!j.estimatesRequired || j.installments.length === 0) { w.wrap('No estimated payments required.', 8.5, 12, MUTED); continue; }
      w.row(['  Installment / due', 'Amount', 'Paid', 'Remaining'], vc, { bold: true, size: 8 });
      for (const i of j.installments) {
        w.row([`  ${i.label}  due ${i.dueDate}${i.status === 'paid' ? '  (paid)' : ''}`, usd(i.amount), usd(i.paid), usd(i.remaining)], vc, { size: 8.5 });
      }
      if (j.nextPayment) w.wrap(`Next payment: ${usd(j.nextPayment.amount)} by ${j.nextPayment.dueDate} (includes any earlier unpaid amount).`, 8.5, 12);
    }
  }

  // Payments on record (only when shared)
  if (e.payments) {
    w.heading('Payments on record');
    if (e.payments.length === 0) w.wrap('No payments on record yet.', 8.5, 0, MUTED);
    const label = (code: string) => e.jurisdictions?.find((j) => j.jurisdiction === code)?.label ?? (code === 'federal' ? 'Federal (IRS)' : code);
    for (const p of e.payments) w.row([`${label(p.jurisdiction)} - ${p.date ?? 'prior-year overpayment'}`, usd(p.amount)], cols);
  }

  w.heading('Disclaimer');
  for (const para of paragraphs(e.disclaimer)) w.wrap(para, 8.5, 0, MUTED);
  w.finish();
  return doc.save();
}
