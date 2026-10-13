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
  buildCalcSections, buildEstimateAssumptions, calcEntityTypeLabel, DEFAULT_DISCLAIMER_TEXT, presentEngineText, presentWarningMessage, recommendedHarborRule,
  type AssumptionBadge, type CalcLine, type EstimateAssumptionsDTO, type EstimateEntityOwnerDTO, type EstimateResultDTO, type SnapshotReason,
} from '@kis-books/shared';

export interface EstimatePdfOptions {
  taxpayerName?: string | null;
  /** Firm name printed in the header (the firm that prepared the estimate). */
  firmName?: string | null;
  /** Firm-configured disclaimer; used only when the result carries no assumptions block. */
  disclaimer?: string | null;
  /** Set when the PDF prints a frozen snapshot (every PDF the app issues is one). */
  snapshot?: { id: string; createdAt: string; reason: SnapshotReason } | null;
  /**
   * R4-04. 'preparer' (default): the full working paper — warnings, every assumptions
   * section (readiness codes, unverified / provisional parameters, engine approximations,
   * safe-harbor workings incl. the prior-year AGI notes), verify markers and the engine
   * version. 'client': the deliverable a client may hold — summary, federal / state
   * figures, safe-harbor AMOUNTS, vouchers, the projection / exclusion assumptions and the
   * disclaimer; nothing a preparer still has to review. The Report Pack section is 'client'.
   */
  audience?: EstimatePdfAudience;
}

export type EstimatePdfAudience = 'preparer' | 'client';

/** Assumptions sections a client deliverable carries (R4-04): method / months, exclusions. */
const CLIENT_ASSUMPTION_SECTIONS: ReadonlySet<string> = new Set(['projection', 'non_recurring', 'dependents']);

/**
 * Q44: the federal credit rows — the dependent credits on their own lines when the result has
 * them (older results / snapshots carry only the two totals).
 */
function creditRows(c: EstimateResultDTO['federal']['credits'], kind: 'nonrefundable' | 'refundable'): Array<[string, string]> {
  if (c.careCredit === undefined) return kind === 'nonrefundable' ? [['Nonrefundable credits', c.nonrefundableAllowed]] : [['Refundable credits', c.refundable]];
  const positive = (v: string | undefined) => v != null && Number(v) !== 0;
  if (kind === 'nonrefundable') {
    const rows: Array<[string, string]> = [];
    if (positive(c.careCredit)) rows.push(['Child and dependent care credit', c.careCredit]);
    if (positive(c.childTaxCredit)) rows.push(['Child tax credit / credit for other dependents', c.childTaxCredit]);
    rows.push([rows.length ? 'Other nonrefundable credits' : 'Nonrefundable credits', c.otherNonrefundableAllowed]);
    return rows;
  }
  return positive(c.additionalChildTaxCredit)
    ? [['Additional child tax credit (refundable)', c.additionalChildTaxCredit], ['Other refundable credits', c.otherRefundable]]
    : [['Refundable credits', c.otherRefundable]];
}

const PAGE_W = 612;
const PAGE_H = 792;
export const MARGIN = 48;
export const LINE = 13;
const INK = rgb(0.09, 0.1, 0.12);
export const MUTED = rgb(0.35, 0.38, 0.41);
const RULE = rgb(0.8, 0.8, 0.78);
/** Vertical space a heading() takes (gap, title, rule). */
const HEADING_H = 8 + 4 + LINE;
/** Body lines a heading keeps with it on its page (keep-with-next). */
const KEEP_WITH_NEXT_LINES = 3;

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

/**
 * Standard-font text must be WinAnsi; replace anything the font cannot encode. Control
 * whitespace (newline, tab, CR) becomes a space first (R4-05: it used to print as "?");
 * callers that want line breaks split into paragraphs before calling (see `paragraphs`).
 */
function safe(text: string): string {
  return text.replace(/[\t\n\v\f\r]/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/§/g, 'Sec. ')
    .replace(/[^\x20-\x7E -ÿ]/g, '?');
}

/** Shared page writer (also used by the Q51 portal-safe PDF, portal-estimate-pdf.service.ts). */
export class Writer {
  page!: PDFPage;
  y = 0;
  /** Drawn at the top of every page this writer adds while set (a table's repeated header). */
  onNewPage?: () => void;
  constructor(readonly doc: PDFDocument, readonly font: PDFFont, readonly bold: PDFFont, private readonly footer: string) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
    this.onNewPage?.();
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
  /**
   * Section heading. Keep-with-next: when fewer than `keepLines` body lines fit below it, it
   * starts the next page instead of being stranded at the foot of this one.
   */
  heading(t: string, keepLines = KEEP_WITH_NEXT_LINES) {
    this.ensure(HEADING_H + keepLines * LINE);
    this.y -= 8;
    this.text(t, MARGIN, 12, { bold: true });
    this.y -= 4;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= LINE;
  }
  /** Firm-typed text (the disclaimer): each line is its own wrapped paragraph (R4-05). */
  paragraphs(t: string, size = 9, indent = 0, color = INK) {
    const paras = paragraphs(t);
    paras.forEach((p, i) => {
      this.wrap(p, size, indent, color);
      if (i < paras.length - 1) this.y -= LINE / 3;
    });
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
  /** Word-wrap `t` into lines no wider than `maxW` (no drawing). */
  lines(t: string, size: number, maxW: number, font: PDFFont = this.font): string[] {
    const out: string[] = [];
    let line = '';
    for (const word of safe(t).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > maxW) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out;
  }
  finish() {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      p.drawText(safe(`${this.footer}   Page ${i + 1} of ${pages.length}`), { x: MARGIN, y: MARGIN - 14, size: 7.5, font: this.font, color: MUTED });
    });
  }
}

export const RIGHT = PAGE_W - MARGIN;

/** Split firm-typed text on newlines into trimmed, non-empty paragraphs (R4-05). */
export function paragraphs(t: string): string[] {
  return t.replace(/\r\n?/g, '\n').split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
}

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

/**
 * Assumptions page: every section of the Phase 12 block in order, the disclaimer last
 * (its own heading). The client audience gets only CLIENT_ASSUMPTION_SECTIONS, unbadged.
 */
function renderAssumptions(w: Writer, a: EstimateAssumptionsDTO, audience: EstimatePdfAudience) {
  const client = audience === 'client';
  w.newPage();
  w.text('Assumptions', MARGIN, 14, { bold: true });
  w.y -= 18;
  w.wrap(client
    ? 'How the figures in this estimate were projected. Your accountant can explain any of them.'
    : 'Everything this estimate assumed, approximated or could not verify. Items marked VERIFY or UNVERIFIED need a preparer\'s review before the figures are relied on.', 8.5, 0, MUTED);
  for (const section of a.sections) {
    if (section.id === 'disclaimer') continue;
    if (client && !CLIENT_ASSUMPTION_SECTIONS.has(section.id)) continue;
    w.heading(section.title);
    if (section.items.length === 0) { w.wrap('None.', 8.5, 0, MUTED); continue; }
    for (const item of section.items) {
      const badge = item.badge && !client ? ` [${BADGE_TEXT[item.badge]}]` : '';
      // QA D19: through the shared presenter at render time too, so a snapshot frozen with
      // raw engine text (JSON values, base keys, unformatted money) prints for people.
      w.wrap(`${item.label}${badge}: ${presentEngineText(item.detail)}`, 8.5, 8);
    }
  }
}

/** "Carlos Rivera 100%, Maria Rivera 50% (loss 40%)": profit %, the loss % only when it differs. */
export function ownersText(owners: EstimateEntityOwnerDTO[]): string {
  const p = (v: unknown) => `${Number(num(v).toFixed(2))}%`;
  return owners.map((o) => `${o.displayName} ${p(o.profitPct)}${num(o.lossPct) !== num(o.profitPct) ? ` (loss ${p(o.lossPct)})` : ''}`).join(', ');
}

/** Truncate a one-line label with "..." so it never runs into the money columns. */
function fit(w: Writer, t: string, size: number, maxW: number, bold = false): string {
  const f = bold ? w.bold : w.font;
  let s = safe(t);
  if (f.widthOfTextAtSize(s, size) <= maxW) return s;
  while (s.length > 1 && f.widthOfTextAtSize(`${s}...`, size) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

const CALC_YTD_RIGHT = RIGHT - 110;
const CALC_LABEL_W = CALC_YTD_RIGHT - 90 - MARGIN;
const CALC_SUB = 7.5;
const CALC_SUB_LINE = 9.5;
/** Space under a line's last sub-line before the next line. */
const CALC_SUB_GAP = 4;
const SUBTOTAL_FILL = rgb(0.95, 0.95, 0.94);

/**
 * "Detailed calculation" (owner request 2026-10-12): the web Calculation view on its own page(s),
 * the same lines from the shared buildCalcSections (no tax math here), with the YTD tax basis and
 * projected columns. The column header repeats on continuation pages. Both audiences; no trace or
 * formula text for either, and the client copy drops the preparer review chips ("Verify").
 */
function renderDetailedCalculation(w: Writer, r: EstimateResultDTO, audience: EstimatePdfAudience) {
  const client = audience === 'client';
  const columns = () => {
    w.text('Line', MARGIN, 8, { bold: true, color: MUTED });
    w.text('YTD tax basis', CALC_YTD_RIGHT, 8, { bold: true, color: MUTED, right: true });
    w.text(`${r.taxYear} Projected`, RIGHT, 8, { bold: true, color: MUTED, right: true });
    w.y -= 5;
    w.page.drawLine({ start: { x: MARGIN, y: w.y }, end: { x: RIGHT, y: w.y }, thickness: 0.6, color: RULE });
    w.y -= LINE;
  };
  w.onNewPage = undefined;
  w.newPage();
  w.text('Detailed calculation', MARGIN, 14, { bold: true });
  w.y -= 18;
  w.wrap('Each line of the estimate: the year-to-date tax basis from the books and the full-year projection the tax is computed on.', 8.5, 0, MUTED);
  w.y -= 4;
  columns();
  w.onNewPage = () => {
    w.text('Detailed calculation (continued)', MARGIN, 11, { bold: true });
    w.y -= 16;
    columns();
  };
  const lineHeight = (subs: string[]) => (subs.length ? (subs.length + 1) * CALC_SUB_LINE + CALC_SUB_GAP : LINE);
  const subLines = (l: CalcLine) => (l.sub ? w.lines(l.sub, CALC_SUB, CALC_LABEL_W - 8) : []);
  let sections: ReturnType<typeof buildCalcSections>;
  try {
    sections = buildCalcSections(r);
  } catch {
    // A frozen snapshot missing calculation fields still prints; only this page is skipped.
    w.onNewPage = undefined;
    w.wrap('The detailed calculation is not available for this estimate.', 9, 0, MUTED);
    return;
  }
  for (const section of sections) {
    // Keep-with-next: a group heading starts the next page unless its first lines (up to
    // KEEP_WITH_NEXT_LINES) fit below it.
    const keep = section.lines.slice(0, KEEP_WITH_NEXT_LINES).reduce((h, l) => h + lineHeight(subLines(l)), 0);
    w.ensure(LINE + 4 + keep);
    w.y -= 4;
    w.text(section.title, MARGIN, 9.5, { bold: true });
    w.y -= LINE;
    for (const l of section.lines) {
      const subs = subLines(l);
      w.ensure(lineHeight(subs));
      const chips = (l.chips ?? []).filter((c) => !(client && c.review)).map((c) => ` [${c.text}]`).join('');
      if (l.bold) w.page.drawRectangle({ x: MARGIN - 4, y: w.y - 3.5, width: RIGHT - MARGIN + 8, height: LINE, color: SUBTOTAL_FILL });
      // Entity totals print muted (reference only, not in the section total); owner shares indent under them.
      const x = l.indent ? MARGIN + 12 : MARGIN;
      const tone = l.muted ? { color: MUTED } : {};
      w.text(fit(w, `${l.label}${chips}`, 9, CALC_LABEL_W - (x - MARGIN), l.bold), x, 9, { bold: l.bold, ...tone });
      if (l.ytd != null) w.text(usd(l.ytd), CALC_YTD_RIGHT, 9, { bold: l.bold, right: true, ...tone });
      w.text(l.projected == null ? '-' : usd(l.projected), RIGHT, 9, { bold: l.bold, right: true, ...tone });
      if (subs.length === 0) { w.y -= LINE; continue; }
      w.y -= CALC_SUB_LINE;
      for (const s of subs) { w.text(s, MARGIN + 8, CALC_SUB, { color: MUTED }); w.y -= CALC_SUB_LINE; }
      w.y -= CALC_SUB_GAP;
    }
  }
  w.onNewPage = undefined;
}

/** Render one scenario's estimate as a PDF. Pure apart from pdf-lib; safe to call from a worker. */
export async function renderEstimatePdf(r: EstimateResultDTO, opts: EstimatePdfOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(safe(`${r.taxYear} Tax Estimate - ${opts.taxpayerName ?? ''}`));
  const audience: EstimatePdfAudience = opts.audience ?? 'preparer';
  const client = audience === 'client';
  // Preparer-only markers (R4-04): verify flags and the engine version.
  const mark = (on: boolean | undefined, text: string) => (on && !client ? text : '');
  const w = new Writer(doc, font, bold, `${opts.firmName?.trim() ? `${opts.firmName.trim()} - ` : ''}${r.taxYear} tax estimate - ${r.scenarioName}${client ? '' : ` - engine ${r.engineVersion}`}`);

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
      // Q45: a business outside MyBooks prints "entered" and its entry (full year / YTD month), not a books range.
      const o = e.source === 'outside' ? e.outside : undefined;
      const through = o ? (o.entryMode === 'ytd' && o.throughMonth ? `YTD ${r.taxYear}-${String(o.throughMonth).padStart(2, '0')}` : 'full year') : (e.throughMonth ?? '-');
      const path = e.path === 'c_corp' ? 'entity level' : e.source === 'outside' ? 'entered' : e.path;
      w.row([e.companyName, calcEntityTypeLabel(e.entityType), path, through], ec, { size: 8.5 });
      if (o) w.wrap(`Outside MyBooks, entered manually: ${o.amountBasis === 'owner_share' ? `amounts are the owner's share (K-1)${o.statedProfitPct != null ? `, ${o.statedProfitPct}% owned (informational)` : ''}` : 'amounts are the entity total, allocated by the owner %'}.`, 8, 12, MUTED);
      // Owner request 2026-10-12: who owns it, from the links (absent on older results / snapshots).
      if (e.owners?.length) w.wrap(`Owners: ${ownersText(e.owners)}`, 8, 12, MUTED);
      if (e.path === 'skipped' && e.skippedReason) w.wrap(`Skipped: ${presentEngineText(e.skippedReason)}`, 8, 12, MUTED);
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
    ...creditRows(f.credits, 'nonrefundable'), ['Self-employment tax', f.seTax],
    ['Additional Medicare tax', f.additionalMedicareTax], ['Net investment income tax', f.niit],
    ...creditRows(f.credits, 'refundable'), ['Federal total', f.federalTotal, true],
  ];
  for (const [label, v, b] of fed) w.row([label, usd(v)], cols, { bold: b });

  // State
  w.heading('State calculation');
  if (!r.state || r.state.rows.length === 0) w.wrap('No state rows on this scenario.', 9, 0, MUTED);
  else {
    for (const s of r.state.rows) {
      const tag = s.residency === 'resident' ? 'resident' : 'nonresident';
      // QA D18: the same review marker as the screen ("Verify"), preparer copy only.
      w.row([`${s.state} (${tag})${mark(s.verify, ' - verify')}`, usd(s.netTax)], cols);
      if (s.method === 'nonresident_flat') w.wrap('Nonresident: effective-rate estimate; most states compute nonresident tax by ratio of the full return.', 8, 12, MUTED);
      if (s.exemptions && num(s.exemptions) > 0) w.wrap(`Personal / dependent exemptions off the base: ${usd(s.exemptions)}`, 8, 12, MUTED);
      if (s.exemptionCredits && num(s.exemptionCredits) > 0) w.wrap(`Less personal / dependent exemption credits: ${usd(s.exemptionCredits)}`, 8, 12, MUTED);
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
    // QA D8 / D19: name the recommended rule in words (under "lesser of", the lower available amount).
    const rec = recommendedHarborRule(sh) === 'prior_year' ? 'prior-year rule' : 'current-year rule';
    w.text(`${e.jurisdiction === 'federal' ? 'Federal' : e.jurisdiction}${mark(e.verify, ' (verify)')} - recommended: ${rec}${sh.appliedRule === 'lesser_of' ? ' (lesser of the two)' : ''}`, MARGIN, 9, { bold: true });
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
    if (!e.estimatesRequired || e.installments.length === 0) { w.wrap(`No estimated payments required: ${presentEngineText(e.estimatesRequiredReason)}`, 8.5, 12, MUTED); continue; }
    w.row(['  Installment / due', 'Regular', 'Sch AI', 'Paid', 'Penalty', 'Pay now'], vc, { bold: true, size: 8 });
    const penalties = e.penalty?.installments ?? [];
    for (const i of e.installments) {
      w.row([`  ${i.label}  ${i.dueDate}  ${i.status}`, usd(i.regularInstallment), i.annualizedInstallment == null ? '-' : usd(i.annualizedInstallment),
        usd(i.estimatesApplied), usd(penalties[i.index]?.penalty ?? '0'), usd(i.catchUpAmount)], vc, { size: 8.5 });
    }
    if (e.penalty) w.row(['  Estimated penalty', '', '', '', usd(e.penalty.total), ''], vc, { size: 8.5, bold: true });
  }

  // Owner request 2026-10-12: page break after the vouchers, then the screen's Calculation view.
  renderDetailedCalculation(w, r, audience);

  // Farmer / fisherman rules (single installment, file-and-pay relief).
  if (r.farmer) {
    const fm = r.farmer;
    w.heading(`${fm.label === 'fisherman' ? 'Fisherman' : 'Farmer'} estimated-tax rules`);
    w.wrap(fm.qualifies
      ? `Qualifies (${fm.basis.replace('_', ' ')} gross-income test): ${fm.installments.length === 1 ? 'one installment' : `${fm.installments.length} installments`}; filing and paying by ${fm.fileAndPayByDate} removes the installment requirement.`
      : 'Does not meet the gross-income test; the regular quarterly schedule applies.', 9);
    if (fm.qualifies && fm.requiredAnnualPayment) w.row(['  Required annual payment', usd(fm.requiredAnnualPayment.required)], cols, { bold: true });
    for (const inst of fm.qualifies ? fm.installments : []) w.row([`  Installment ${inst.number} due ${inst.dueDate}`, pct(inst.pct, 0)], cols);
    if (fm.fileAndPayNote) w.wrap(presentEngineText(fm.fileAndPayNote), 8, 12, MUTED);
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

  // Warnings (preparer only: readiness codes and engine notes are review items, R4-04)
  if (!client && r.warnings.length > 0) {
    w.heading('Warnings');
    for (const wn of r.warnings.slice(0, 40)) w.wrap(`- ${presentWarningMessage(wn)}`, 8.5);
  }

  renderAssumptions(w, assumptions, audience);

  w.heading('Disclaimer');
  w.paragraphs(assumptions.disclaimerText?.trim() || opts.disclaimer?.trim() || DEFAULT_DISCLAIMER_TEXT, 9);

  w.finish();
  return doc.save();
}
