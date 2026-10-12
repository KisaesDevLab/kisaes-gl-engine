// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator estimate PDF (Phase 11; reused by the Phase 13 Report Pack section).
// A pure function of EstimateResultDTO rendered with pdf-lib (the same vector approach
// as check printing — no HTML / Puppeteer). It never recomputes tax: every figure is read
// from the DTO the engine produced. The disclaimer and assumptions are placeholders until
// the Phase 13 assumptions page replaces `renderAssumptionsPlaceholder`.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { EstimateResultDTO } from '@kis-books/shared';

export const DEFAULT_ESTIMATE_DISCLAIMER = 'Projection based on bookkeeping records and the assumptions listed. Not a tax return.';

export interface EstimatePdfOptions {
  taxpayerName?: string | null;
  firmName?: string | null;
  /** Firm-configured disclaimer; falls back to the default text. */
  disclaimer?: string | null;
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

/** Standard-font text must be WinAnsi; replace anything the font cannot encode. */
function safe(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/§/g, 'Sec. ')
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
    for (const w of words) {
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

function renderAssumptionsPlaceholder(w: Writer, r: EstimateResultDTO) {
  w.heading('Assumptions');
  w.wrap('The full assumptions page (rate mode, closed months used, non-recurring exclusions, GL reclass totals, adjustments, safe-harbor source, state methods and parameter statuses) is added with the Report Pack section.', 9, 0, MUTED);
  w.wrap(`Safe-harbor rule: ${r.safeHarborRule} (source: ${r.safeHarborRuleSource}). Engine ${r.engineVersion}.`);
  const provisional = r.parametersUsed.filter((p) => p.status !== 'verified');
  if (provisional.length > 0) w.wrap(`${provisional.length} federal parameter(s) are not yet verified: ${provisional.slice(0, 8).map((p) => p.key).join(', ')}${provisional.length > 8 ? ', ...' : ''}.`);
  const unverifiedRules = r.rulesUsed.filter((p) => p.status !== 'verified');
  if (unverifiedRules.length > 0) w.wrap(`${unverifiedRules.length} state rule(s) are not yet verified (${[...new Set(unverifiedRules.map((p) => p.state))].join(', ')}).`);
}

/** Render one scenario's estimate as a PDF. Pure apart from pdf-lib; safe to call from a worker. */
export async function renderEstimatePdf(r: EstimateResultDTO, opts: EstimatePdfOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(safe(`${r.taxYear} Tax Estimate - ${opts.taxpayerName ?? ''}`));
  const w = new Writer(doc, font, bold, `${r.taxYear} tax estimate - ${r.scenarioName} - engine ${r.engineVersion}`);

  w.text(opts.firmName ?? 'Tax Estimator', MARGIN, 9, { color: MUTED });
  w.y -= 18;
  w.text(`${r.taxYear} Tax Estimate`, MARGIN, 20, { bold: true });
  w.y -= 16;
  if (opts.taxpayerName) { w.text(opts.taxpayerName, MARGIN, 11, { bold: true }); w.y -= 14; }
  w.text(`Scenario: ${r.scenarioName}   Filing status: ${r.filingStatus.toUpperCase()}   Computed: ${r.computedAt.slice(0, 10)}`, MARGIN, 9, { color: MUTED });
  w.y -= 8;

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
    w.row([`  ${num(sh.currentYear.pct) * 100}% of current-year tax`, usd(sh.currentYear.amount)], cols);
    w.row([`  ${sh.priorYear.pct == null ? 'Prior-year' : `${num(sh.priorYear.pct) * 100}% of prior-year`} tax${sh.priorYear.available ? '' : ' (unavailable)'}`, sh.priorYear.amount == null ? 'n/a' : usd(sh.priorYear.amount)], cols);
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

  // Warnings
  if (r.warnings.length > 0) {
    w.heading('Warnings');
    for (const wn of r.warnings.slice(0, 40)) w.wrap(`- ${wn.message}`, 8.5);
  }

  renderAssumptionsPlaceholder(w, r);

  w.heading('Disclaimer');
  w.wrap(opts.disclaimer?.trim() || DEFAULT_ESTIMATE_DISCLAIMER, 9);

  w.finish();
  return doc.save();
}
