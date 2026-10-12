// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator estimate PDF (Phase 11; Phase 13 assumptions page, firm header,
// snapshot provenance). ONE renderer for the standalone Print / Download, the
// snapshot download and the Report Pack `tax-estimate` section (D15). A pure
// function of EstimateResultDTO rendered with pdf-lib (the same vector approach as
// check printing — no HTML / Puppeteer). It never recomputes tax: every figure is
// read from the DTO the engine produced, and the assumptions page prints the
// Phase 12 assumptions block (buildEstimateAssumptions) section by section.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  buildEstimateAssumptions, DEFAULT_DISCLAIMER_TEXT,
  type AssumptionBadge, type EstimateAssumptionsDTO, type EstimateResultDTO, type SnapshotReason,
} from '@kis-books/shared';

export interface EstimatePdfOptions {
  taxpayerName?: string | null;
  /** Firm name printed in the header (the firm that prepared the estimate). */
  firmName?: string | null;
  /** Firm-configured disclaimer; used only when the result carries no assumptions block. */
  disclaimer?: string | null;
  /** Set when the PDF prints a frozen snapshot (every PDF the app issues is one). */
  snapshot?: { id: string; createdAt: string; reason: SnapshotReason } | null;
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const LINE = 13;
const INK = rgb(0.09, 0.1, 0.12);
const MUTED = rgb(0.35, 0.38, 0.41);
const RULE = rgb(0.8, 0.8, 0.78);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const usd = (v: unknown): string => {
  const n = Math.round(num(v));
  const s = Math.abs(n).toLocaleString('en-US');
  return n < 0 ? `-$${s}` : `$${s}`;
};
const pct = (v: unknown, places = 1): string => `${(num(v) * 100).toFixed(places)}%`;
/** Percent with float noise trimmed: 1.1 → "110", 0.9 → "90", 0.6667 → "66.67". */
const pctShort = (v: unknown): string => String(Number((num(v) * 100).toFixed(2)));

/** Standard-font text must be WinAnsi; replace anything the font cannot encode. */
function safe(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/§/g, 'Sec. ')
    .replace(/[^\x20-\x7E -ÿ]/g, '?');
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(readonly doc: PDFDocument, readonly font: PDFFont, readonly bold: PDFFont, private readonly footer: string) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }
  ensure(h: number) {
    if (this.y - h < MARGIN + 20) this.newPage();
  }
  text(t: string, x: number, size = 9, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; right?: boolean } = {}) {
    const f = opts.bold ? this.bold : this.font;
    const s = safe(t);
    const w = f.widthOfTextAtSize(s, size);
    this.page.drawText(s, { x: opts.right ? x - w : x, y: this.y, size, font: f, color: opts.color ?? INK });
  }
  heading(t: string) {
    this.ensure(30);
    this.y -= 8;
    this.text(t, MARGIN, 12, { bold: true });
    this.y -= 4;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= LINE;
  }
  wrap(t: string, size = 9, indent = 0, color = INK) {
    const maxW = PAGE_W - 2 * MARGIN - indent;
    const words = safe(t).split(/\s+/);
    let line = '';
    const flush = () => { this.ensure(LINE); this.text(line, MARGIN + indent, size, { color }); this.y -= LINE; line = ''; };
    for (const word of words) {
      // A token wider than the line (JSON values, long codes) is hard-broken.
      let w = word;
      while (this.font.widthOfTextAtSize(w, size) > maxW) {
        if (line) flush();
        let cut = w.length - 1;
        while (cut > 1 && this.font.widthOfTextAtSize(w.slice(0, cut), size) > maxW) cut--;
        line = w.slice(0, cut);
        flush();
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (this.font.widthOfTextAtSize(next, size) > maxW && line) { flush(); line = w; } else line = next;
    }
    if (line) flush();
  }
  /** Table row; the first column is left-aligned text, the others right-aligned at the given right edges. */
  row(cells: string[], rights: number[], opts: { bold?: boolean; muted?: boolean; size?: number } = {}) {
    this.ensure(LINE);
    const size = opts.size ?? 9;
    const color = opts.muted ? MUTED : INK;
    this.text(cells[0] ?? '', MARGIN, size, { bold: opts.bold, color });
    for (let i = 1; i < cells.length; i++) this.text(cells[i] ?? '', rights[i - 1] as number, size, { bold: opts.bold, color, right: true });
    this.y -= LINE;
  }
  finish() {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      p.drawText(safe(`${this.footer}   Page ${i + 1} of ${pages.length}`), { x: MARGIN, y: MARGIN - 14, size: 7.5, font: this.font, color: MUTED });
    });
  }
}

const RIGHT = PAGE_W - MARGIN;

const BADGE_TEXT: Record<AssumptionBadge, string> = {
  verify: 'VERIFY', estimate_may_differ: 'ESTIMATE MAY DIFFER', unverified: 'UNVERIFIED', provisional: 'PROVISIONAL',
};

const REASON_TEXT: Record<SnapshotReason, string> = {
  finalize: 'finalized', vouchers: 'vouchers issued', pdf: 'PDF issued', report_pack: 'report pack',
};

/** The assumptions block the estimate carries, else one built from it (pre-Phase-12 cache entries). */
export function assumptionsFor(r: EstimateResultDTO, disclaimer?: string | null): EstimateAssumptionsDTO {
  return r.assumptions ?? buildEstimateAssumptions(r, { disclaimerText: disclaimer ?? r.disclaimerText ?? null });
}

/** Assumptions page: every section of the Phase 12 block in order, the disclaimer last (its own heading). */
function renderAssumptions(w: Writer, a: EstimateAssumptionsDTO) {
  w.newPage();
  w.text('Assumptions', MARGIN, 14, { bold: true });
  w.y -= 18;
  w.wrap('Everything this estimate assumed, approximated or could not verify. Items marked VERIFY or UNVERIFIED need a preparer\'s review before the figures are relied on.', 8.5, 0, MUTED);
  for (const section of a.sections) {
    if (section.id === 'disclaimer') continue;
    w.heading(section.title);
    if (section.items.length === 0) { w.wrap('None.', 8.5, 0, MUTED); continue; }
    for (const item of section.items) {
      const badge = item.badge ? ` [${BADGE_TEXT[item.badge]}]` : '';
      w.wrap(`${item.label}${badge}: ${item.detail}`, 8.5, 8);
    }
  }
}

/** Render one scenario's estimate as a PDF. Pure apart from pdf-lib; safe to call from a worker. */
export async function renderEstimatePdf(r: EstimateResultDTO, opts: EstimatePdfOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(safe(`${r.taxYear} Tax Estimate - ${opts.taxpayerName ?? ''}`));
  const w = new Writer(doc, font, bold, `${opts.firmName?.trim() ? `${opts.firmName.trim()} - ` : ''}${r.taxYear} tax estimate - ${r.scenarioName} - engine ${r.engineVersion}`);

  const assumptions = assumptionsFor(r, opts.disclaimer);
  // Firm header: the preparing firm's name, then the document title and who it is for.
  w.text(opts.firmName?.trim() || 'Tax estimate', MARGIN, 11, { bold: true });
  w.text(`Prepared ${r.computedAt.slice(0, 10)}`, RIGHT, 8.5, { color: MUTED, right: true });
  w.y -= 6;
  w.page.drawLine({ start: { x: MARGIN, y: w.y }, end: { x: RIGHT, y: w.y }, thickness: 0.8, color: RULE });
  w.y -= 26;
  w.text(`${r.taxYear} Tax Estimate`, MARGIN, 20, { bold: true });
  w.y -= 16;
  if (opts.taxpayerName) { w.text(`Prepared for ${opts.taxpayerName}`, MARGIN, 11, { bold: true }); w.y -= 14; }
  w.text(`Scenario: ${r.scenarioName}   Filing status: ${r.filingStatus.toUpperCase()}   Computed: ${r.computedAt.slice(0, 10)}`, MARGIN, 9, { color: MUTED });
  w.y -= LINE;
  if (opts.snapshot) {
    w.text(`Snapshot ${opts.snapshot.id.slice(0, 8)} (${REASON_TEXT[opts.snapshot.reason]}) frozen ${opts.snapshot.createdAt.slice(0, 16).replace('T', ' ')} UTC`, MARGIN, 8.5, { color: MUTED });
    w.y -= LINE;
  }
  const through = r.entities.map((e) => e.throughMonth).filter((m): m is string => !!m).sort()[0];
  if (through) { w.text(`Books through ${through} (actuals); later months projected at the run-rate.`, MARGIN, 8.5, { color: MUTED }); w.y -= LINE; }

  // Entities in the estimate (C corps are entity level, outside the taxpayer totals).
  if (r.entities.length > 0) {
    w.heading('Businesses included');
    const ec = [RIGHT - 200, RIGHT - 90, RIGHT];
    w.row(['Business', 'Type', 'Path', 'Through'], ec, { bold: true, size: 8 });
    for (const e of r.entities) {
      w.row([e.companyName, (e.entityType ?? 'unknown').replace('_', ' '), e.path === 'c_corp' ? 'entity level' : e.path, e.throughMonth ?? '-'], ec, { size: 8.5 });
      if (e.path === 'skipped' && e.skippedReason) w.wrap(`Skipped: ${e.skippedReason}`, 8, 12, MUTED);
    }
  }

  // Summary
  w.heading('Summary');
  const cols = [RIGHT - 160, RIGHT];
  w.row(['Federal total', usd(r.summary.federalTotal)], cols);
  w.row(['State total', usd(r.summary.stateTotal)], cols);
  w.row(['Total estimated tax', usd(r.summary.total)], cols, { bold: true });
  w.row(['Marginal federal rate', pct(r.summary.marginalRate)], cols);
  w.row(['Federal required annual payment', usd(r.summary.federalRequiredAnnualPayment)], cols);
  w.row(['Federal unpaid after payments', usd(r.summary.federalUnpaid)], cols);
  w.row(['Estimated underpayment penalty (federal / state)', `${usd(r.summary.federalPenalty)} / ${usd(r.summary.statePenalty)}`], cols);

  // Federal
  const f = r.federal;
  w.heading('Federal calculation (full-year projection)');
  const fed: Array<[string, string, boolean?]> = [
    ['Total income', f.income.totalIncome], ['Adjustments to income', f.adjustmentsToIncome.total], ['Adjusted gross income', f.agi, true],
    [`Deduction (${f.deductions.chosen})`, f.deductions.deduction], ['Qualified business income deduction', f.qbi.deduction],
    ['Taxable income', f.taxableIncome, true], [`Regular tax (${f.regularTax.method})`, f.regularTax.tax],
    ['Nonrefundable credits', f.credits.nonrefundableAllowed], ['Self-employment tax', f.seTax],
    ['Additional Medicare tax', f.additionalMedicareTax], ['Net investment income tax', f.niit],
    ['Refundable credits', f.credits.refundable], ['Federal total', f.federalTotal, true],
  ];
  for (const [label, v, b] of fed) w.row([label, usd(v)], cols, { bold: b });

  // State
  w.heading('State calculation');
  if (!r.state || r.state.rows.length === 0) w.wrap('No state rows on this scenario.', 9, 0, MUTED);
  else {
    for (const s of r.state.rows) {
      const tag = s.residency === 'resident' ? 'resident' : 'nonresident';
      w.row([`${s.state} (${tag})${s.verify ? ' - unverified' : ''}`, usd(s.netTax)], cols);
      if (s.method === 'nonresident_flat') w.wrap('Nonresident: effective-rate estimate; most states compute nonresident tax by ratio of the full return.', 8, 12, MUTED);
      if (num(s.creditForOtherStates) > 0) w.wrap(`Less credit for other-state tax: ${usd(s.creditForOtherStates)}`, 8, 12, MUTED);
    }
    w.row(['State total', usd(r.state.stateTotal)], cols, { bold: true });
  }

  // Safe harbor + vouchers per jurisdiction
  const all = [r.federalEstimates, ...r.stateEstimates];
  w.heading('Safe harbor');
  for (const e of all) {
    const sh = e.safeHarbor;
    w.ensure(3 * LINE);
    w.text(`${e.jurisdiction === 'federal' ? 'Federal' : e.jurisdiction}${e.verify ? ' (verify)' : ''} - recommended: ${sh.appliedRule}`, MARGIN, 9, { bold: true });
    w.y -= LINE;
    w.row([`  ${pctShort(sh.currentYear.pct)}% of current-year tax`, usd(sh.currentYear.amount)], cols);
    w.row([`  ${sh.priorYear.pct == null ? 'Prior-year' : `${pctShort(sh.priorYear.pct)}% of prior-year`} tax${sh.priorYear.available ? '' : ' (unavailable)'}`, sh.priorYear.amount == null ? 'n/a' : usd(sh.priorYear.amount)], cols);
    w.row(['  Required annual payment', usd(sh.requiredAnnualPayment)], cols, { bold: true });
  }

  w.heading('Payment vouchers');
  const vc = [MARGIN + 230, MARGIN + 290, MARGIN + 350, MARGIN + 420, RIGHT];
  for (const e of all) {
    w.ensure(4 * LINE);
    w.text(`${e.jurisdiction === 'federal' ? 'Federal' : e.jurisdiction}`, MARGIN, 9, { bold: true });
    w.y -= LINE;
    if (!e.estimatesRequired || e.installments.length === 0) { w.wrap(`No estimated payments required: ${e.estimatesRequiredReason}`, 8.5, 12, MUTED); continue; }
    w.row(['  Installment / due', 'Regular', 'Sch AI', 'Paid', 'Penalty', 'Pay now'], vc, { bold: true, size: 8 });
    const penalties = e.penalty?.installments ?? [];
    for (const i of e.installments) {
      w.row([`  ${i.label}  ${i.dueDate}  ${i.status}`, usd(i.regularInstallment), i.annualizedInstallment == null ? '-' : usd(i.annualizedInstallment),
        usd(i.estimatesApplied), usd(penalties[i.index]?.penalty ?? '0'), usd(i.catchUpAmount)], vc, { size: 8.5 });
    }
    if (e.penalty) w.row(['  Estimated penalty', '', '', '', usd(e.penalty.total), ''], vc, { size: 8.5, bold: true });
  }

  // Farmer / fisherman rules (single installment, file-and-pay relief).
  if (r.farmer) {
    const fm = r.farmer;
    w.heading(`${fm.label === 'fisherman' ? 'Fisherman' : 'Farmer'} estimated-tax rules`);
    w.wrap(fm.qualifies
      ? `Qualifies (${fm.basis.replace('_', ' ')} gross-income test): ${fm.installments.length === 1 ? 'one installment' : `${fm.installments.length} installments`}; filing and paying by ${fm.fileAndPayByDate} removes the installment requirement.`
      : 'Does not meet the gross-income test; the regular quarterly schedule applies.', 9);
    if (fm.qualifies && fm.requiredAnnualPayment) w.row(['  Required annual payment', usd(fm.requiredAnnualPayment.required)], cols, { bold: true });
    for (const inst of fm.qualifies ? fm.installments : []) w.row([`  Installment ${inst.number} due ${inst.dueDate}`, pct(inst.pct, 0)], cols);
    if (fm.fileAndPayNote) w.wrap(fm.fileAndPayNote, 8, 12, MUTED);
  }

  // Linked C corporations: entity level, not in the taxpayer totals.
  for (const c of r.ccorps) {
    w.heading(`C corporation: ${c.companyName} (fiscal ${c.fiscalYearStart} to ${c.fiscalYearEnd})`);
    w.row(['Taxable income', usd(c.taxableIncome)], cols);
    w.row([`Federal tax (${pct(c.rate, 0)})`, usd(c.federalTax)], cols);
    for (const st of c.states) w.row([`${st.state} tax (${pct(st.apportionmentPct, 1)} apportioned)`, usd(st.tax)], cols);
    w.row(['Total corporate tax', usd(c.totalTax)], cols, { bold: true });
    w.row([`Required annual payment${c.largeCorporation ? ' (large corporation)' : ''}`, usd(c.requiredAnnualPayment.required)], cols, { bold: true });
    if (!c.estimatesRequired) w.wrap('Estimated payments are not required at this tax level; the schedule is shown for reference.', 8, 12, MUTED);
    for (const inst of c.installments) {
      w.row([`  Installment ${inst.number} due ${inst.dueDate}${num(inst.recapture) > 0 ? ' (incl. recapture)' : ''}`, usd(inst.required)], cols, { size: 8.5 });
    }
  }

  // Warnings
  if (r.warnings.length > 0) {
    w.heading('Warnings');
    for (const wn of r.warnings.slice(0, 40)) w.wrap(`- ${wn.message}`, 8.5);
  }

  renderAssumptions(w, assumptions);

  w.heading('Disclaimer');
  w.wrap(assumptions.disclaimerText?.trim() || opts.disclaimer?.trim() || DEFAULT_DISCLAIMER_TEXT, 9);

  w.finish();
  return doc.save();
}
