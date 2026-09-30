// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// HTML renderer for report-ready financial statements. ONE renderer feeds
// both the browser's live preview (one document of paper-sized sheets) and
// the server's PDF (one full HTML document per section, printed by
// Chromium with the section's own @page size so paper / orientation can
// differ per statement). Fonts are embedded via @font-face — data URIs
// for PDF (the renderer blocks the network), URLs for the preview.

import type { FsFrontMatter, FsPageSetup, FsStyle, FsStyleElement } from '../schemas.js';
import type { FsRenderedReport, FsRenderedStatement, FsRow } from '../model.js';
import { fsFont } from '../fonts.js';
import { fsBalanceSheetDateLine } from '../titles.js';

export interface FsLetterhead {
  displayName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  logoDataUri?: string | null;
  letterheadAlign?: 'left' | 'center';
}

export type FsFontSource =
  | { mode: 'data'; files: Record<string, string> } // file → base64
  | { mode: 'url'; baseUrl: string }
  | { mode: 'none' };

export interface FsDocumentInput {
  report: FsRenderedReport;
  style: FsStyle;
  frontMatter: FsFrontMatter;
  letterhead?: FsLetterhead | null;
  // Resolved (variables substituted) + sanitized letter.
  letter?: { title: string; bodyHtml: string } | null;
  fonts: FsFontSource;
  // PDF pass 2: page numbers for the table of contents (section id → page).
  tocPages?: Record<string, number> | null;
  draftWatermark?: boolean;
}

export type FsSectionKind = 'cover' | 'toc' | 'letter' | 'statement' | 'divider' | 'schedule';

export interface FsHtmlSection {
  id: string;
  kind: FsSectionKind;
  tocLabel: string | null;
  pageSetup: FsPageSetup;
  // Page chrome stamped after rendering (PDF) / drawn on the sheet (preview).
  footer: boolean;
  pageNumber: boolean;
  bodyHtml: string; // inner HTML (no <html> wrapper)
}

const esc = (s: string): string => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ─── Page geometry ─────────────────────────────────────────────────

export function fsPageSizeIn(p: FsPageSetup): { width: number; height: number } {
  const base = p.paper === 'legal' ? { width: 8.5, height: 14 } : p.paper === 'a4' ? { width: 8.27, height: 11.69 } : { width: 8.5, height: 11 };
  return p.orientation === 'landscape' ? { width: base.height, height: base.width } : base;
}

// ─── Numbers ───────────────────────────────────────────────────────

export function fsFormatAmount(v: number | null, style: FsStyle): string {
  if (v === null) return '';
  const d = style.number.decimals;
  if (Math.abs(v) < (d === 0 ? 0.5 : 0.005)) return style.number.zero === 'dash' ? '—' : (d === 0 ? '0' : '0.00');
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (v < 0) return style.number.negative === 'parens' ? `(${s})` : `-${s}`;
  return s;
}

export function fsFormatPct(v: number | null, style: FsStyle): string {
  if (v === null) return '';
  if (v === 0) return style.number.zero === 'dash' ? '—' : '0.0%';
  const s = `${Math.abs(v).toFixed(1)}%`;
  return v < 0 ? (style.number.negative === 'parens' ? `(${s})` : `-${s}`) : s;
}

// ─── CSS ───────────────────────────────────────────────────────────

function fontFaceCss(style: FsStyle, fonts: FsFontSource): string {
  if (fonts.mode === 'none') return '';
  const def = fsFont(style.fontKey);
  return def.faces.map((f) => {
    let src: string;
    if (fonts.mode === 'data') {
      const b64 = fonts.files[f.file];
      if (!b64) return '';
      src = `url(data:font/ttf;base64,${b64}) format('truetype')`;
    } else {
      // No ".ttf" in the URL: the web container's nginx serves any *.ttf
      // path as a static asset (regex location beats the /api/ proxy).
      src = `url('${fonts.baseUrl.replace(/\/$/, '')}/${f.file.replace(/\.ttf$/, '')}') format('truetype')`;
    }
    return `@font-face{font-family:'${def.cssFamily}';src:${src};font-weight:${f.weight};font-style:${f.style};font-display:block}`;
  }).join('\n');
}

function elCss(style: FsStyle, el: FsStyleElement): string {
  const e = style.elements[el];
  return `font-size:${e.sizePt}pt;font-weight:${e.bold ? 700 : 400};font-style:${e.italic ? 'italic' : 'normal'};${e.caps ? 'text-transform:uppercase;letter-spacing:.02em;' : ''}${e.align ? `text-align:${e.align};` : ''}`;
}

export function fsDocumentCss(style: FsStyle, fonts: FsFontSource): string {
  const def = fsFont(style.fontKey);
  const family = `'${def.cssFamily}', ${def.category === 'serif' ? "'Times New Roman', serif" : 'Arial, sans-serif'}`;
  const amountW = style.amountColumnWidthIn;
  const titleAlign = style.titleBlock.align;
  return `${fontFaceCss(style, fonts)}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:#000}
body{font-family:${family};font-size:${style.baseSizePt}pt;line-height:${style.lineHeight};-webkit-print-color-adjust:exact;print-color-adjust:exact;font-variant-numeric:tabular-nums lining-nums}
.fs-title{text-align:${titleAlign};margin:0 0 14pt}
.fs-title .co{${elCss(style, 'companyName')};${titleAlign === 'center' ? 'text-align:center;' : ''}}
.fs-title .st{${elCss(style, 'statementTitle')};${titleAlign === 'center' ? 'text-align:center;' : ''}}
.fs-title .dl{${elCss(style, 'dateLine')};${titleAlign === 'center' ? 'text-align:center;' : ''}}
table.fs{width:100%;border-collapse:collapse;table-layout:fixed}
table.fs td,table.fs th{padding:0.6pt 0;vertical-align:bottom}
table.fs col.cap{width:auto}
table.fs col.sign{width:9pt}
table.fs col.amt{width:${amountW}in}
table.fs col.pct{width:${Math.max(0.55, amountW * 0.55)}in}
table.fs col.gap{width:12pt}
th.colh{${elCss(style, 'columnHeader')};text-align:right;border-bottom:0.75pt solid #000;padding-bottom:1pt;white-space:nowrap}
th.colh.center{text-align:center}
td.cap{padding-right:6pt;overflow-wrap:anywhere}
td.amt{text-align:right;white-space:nowrap}
td.sign{text-align:left;white-space:nowrap}
td.pct{text-align:right;white-space:nowrap}
tr.r-detail td{${elCss(style, 'detail')}}
tr.r-subtotal td{${elCss(style, 'subtotal')}}
tr.r-total td{${elCss(style, 'total')}}
tr.r-heading td{${elCss(style, 'sectionHeading')}}
tr.r-text td{${elCss(style, 'text')}}
tr.r-blank td{height:${style.baseSizePt * style.lineHeight}pt}
td.ra-single{border-top:0.75pt solid #000}
td.rb-single{border-bottom:0.75pt solid #000}
td.rb-double{border-bottom:2.4pt double #000}
.np{visibility:hidden}
.ref{font-style:italic;font-weight:400}
.fs-footer{${elCss(style, 'footer')}}
.cover{display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;min-height:7in}
.cover .co{${elCss(style, 'companyName')};font-size:${style.elements.companyName.sizePt + 6}pt;margin-bottom:10pt}
.cover .t{${elCss(style, 'statementTitle')};font-size:${style.elements.statementTitle.sizePt + 4}pt}
.cover .d{${elCss(style, 'dateLine')};margin-top:8pt}
.cover .sub{margin-top:4pt}
.cover .firm{margin-top:1.8in;${elCss(style, 'dateLine')}}
.divider{display:flex;align-items:center;justify-content:center;min-height:7in;${elCss(style, 'statementTitle')};font-size:${style.elements.statementTitle.sizePt + 4}pt;text-align:center}
.toc h1{${elCss(style, 'statementTitle')};text-align:center;margin:0 0 20pt}
.toc table{width:100%;border-collapse:collapse}
.toc td{padding:4pt 0;${elCss(style, 'detail')}}
.toc td.pg{text-align:right;width:0.6in}
.toc tr.grp td{padding-top:10pt;font-weight:700}
.toc tr.sub td.lbl{padding-left:14pt}
.lh{margin:0 0 22pt}
.lh.center{text-align:center}
.lh img{max-height:0.9in;max-width:3in;display:block;margin-bottom:6pt}
.lh.center img{margin-left:auto;margin-right:auto}
.lh .n{font-weight:700;font-size:${style.baseSizePt + 3}pt}
.lh .a{font-size:${Math.max(7, style.baseSizePt - 1.5)}pt}
.letter h1{${elCss(style, 'statementTitle')};text-align:center;margin:0 0 14pt}
.letter .body p{margin:0 0 9pt}
.draft-wm{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:72pt;color:rgba(0,0,0,.06);transform:rotate(-30deg);pointer-events:none;font-weight:700}
.chunk+.chunk{break-before:page}
`;
}

// ─── Statement tables ──────────────────────────────────────────────

function titleBlock(report: FsRenderedReport, st: FsRenderedStatement, continued: boolean): string {
  return `<div class="fs-title"><div class="co">${esc(report.meta.companyName)}</div><div class="st">${esc(st.scheduleNo ? `${st.scheduleNo} — ${st.title}` : st.title)}${continued ? ' (Continued)' : ''}</div><div class="dl">${esc(st.dateLine)}</div></div>`;
}

function colgroup(st: FsRenderedStatement): string {
  const cols: string[] = ['<col class="cap">'];
  st.columns.forEach((c) => {
    cols.push('<col class="gap">');
    if (c.kind === 'amount' || c.kind === 'variance_amt') cols.push('<col class="sign">', '<col class="amt">');
    else cols.push('<col class="pct">');
  });
  return `<colgroup>${cols.join('')}</colgroup>`;
}

function headerRow(st: FsRenderedStatement): string {
  if (!st.columns.some((c) => c.label)) return '';
  const cells: string[] = ['<th></th>'];
  st.columns.forEach((c) => {
    cells.push('<th></th>');
    const span = c.kind === 'amount' || c.kind === 'variance_amt' ? 2 : 1;
    cells.push(`<th class="colh${span === 2 ? '' : ' center'}" colspan="${span}">${esc(c.label)}</th>`);
  });
  return `<tr>${cells.join('')}</tr>`;
}

function rowHtml(r: FsRow, st: FsRenderedStatement, style: FsStyle): string {
  if (r.kind === 'blank') return `<tr class="r-blank"><td colspan="${1 + st.columns.reduce((s, c) => s + 1 + (c.kind === 'amount' || c.kind === 'variance_amt' ? 2 : 1), 0)}"></td></tr>`;
  const indent = Math.max(0, r.level) * style.indentPt;
  const inline: string[] = [];
  if (r.bold !== undefined) inline.push(`font-weight:${r.bold ? 700 : 400}`);
  if (r.italic !== undefined) inline.push(`font-style:${r.italic ? 'italic' : 'normal'}`);
  if (r.caps) inline.push('text-transform:uppercase');
  const role = r.styleRole === 'sectionHeading' ? 'sectionHeading' : r.styleRole;
  if (r.sizeDelta) inline.push(`font-size:${style.elements[role].sizePt + r.sizeDelta}pt`);
  const inl = inline.length ? ` style="${inline.join(';')}"` : '';
  const ref = r.scheduleRef ? ` <span class="ref">(${esc(r.scheduleRef)})</span>` : '';
  const cells: string[] = [`<td class="cap" style="padding-left:${indent}pt">${esc(r.caption)}${ref}</td>`];
  const ruleCls = (r.ruleAbove === 'single' ? ' ra-single' : '') + (r.ruleBelow === 'single' ? ' rb-single' : r.ruleBelow === 'double' ? ' rb-double' : '');
  st.columns.forEach((c, i) => {
    cells.push('<td></td>');
    const v = r.values[i] ?? null;
    const numeric = r.kind !== 'heading' && r.kind !== 'text';
    if (c.kind === 'amount' || c.kind === 'variance_amt') {
      const txt = numeric ? fsFormatAmount(v, style) : '';
      const showRule = numeric && (v !== null || r.ruleBelow !== 'none' || r.ruleAbove !== 'none');
      const cls = showRule ? ruleCls : '';
      const pad = txt && !txt.endsWith(')') && style.number.negative === 'parens' ? '<span class="np">)</span>' : '';
      cells.push(`<td class="sign${cls}">${r.dollarSign && txt ? '$' : ''}</td><td class="amt${cls}">${esc(txt)}${pad}</td>`);
    } else {
      const txt = numeric ? fsFormatPct(v, style) : '';
      const pad = txt && !txt.endsWith(')') && style.number.negative === 'parens' ? '<span class="np">)</span>' : '';
      cells.push(`<td class="pct">${esc(txt)}${pad}</td>`);
    }
  });
  const cls = r.kind === 'heading' ? (r.styleRole === 'sectionHeading' ? 'heading' : r.styleRole) : r.kind;
  return `<tr class="r-${cls}"${inl}>${cells.join('')}</tr>`;
}

// Split rows at page_break rows / breakBefore so each chunk is its own
// table (Chromium ignores break-before on table rows).
function chunks(rows: FsRow[]): FsRow[][] {
  const out: FsRow[][] = [[]];
  for (const r of rows) {
    if (r.kind === 'page_break') { if (out[out.length - 1]!.length) out.push([]); continue; }
    if (r.breakBefore && out[out.length - 1]!.length) out.push([]);
    out[out.length - 1]!.push(r);
  }
  return out.filter((c) => c.length);
}

export function fsStatementHtml(report: FsRenderedReport, st: FsRenderedStatement, style: FsStyle): string {
  return chunks(st.rows).map((rows, i) => `<div class="chunk">${titleBlock(report, st, i > 0)}<table class="fs">${colgroup(st)}<thead>${headerRow(st)}</thead><tbody>${rows.map((r) => rowHtml(r, st, style)).join('')}</tbody></table></div>`).join('');
}

// ─── Front matter ──────────────────────────────────────────────────

function letterheadHtml(lh: FsLetterhead | null | undefined): string {
  if (!lh || !(lh.displayName || lh.logoDataUri)) return '';
  const cityLine = [lh.city, [lh.state, lh.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const contact = [lh.phone, lh.email, lh.website].filter(Boolean).join(' · ');
  const logo = lh.logoDataUri && /^data:image\/(png|jpeg);base64,/.test(lh.logoDataUri) ? `<img src="${lh.logoDataUri}" alt="">` : '';
  return `<div class="lh${lh.letterheadAlign === 'center' ? ' center' : ''}">${logo}${lh.displayName ? `<div class="n">${esc(lh.displayName)}</div>` : ''}<div class="a">${[lh.addressLine1, lh.addressLine2, cityLine].filter(Boolean).map((x) => esc(x!)).join('<br>')}${contact ? `<br>${esc(contact)}` : ''}</div></div>`;
}

export function fsBuildSections(input: FsDocumentInput): FsHtmlSection[] {
  const { report, style, frontMatter } = input;
  const sections: FsHtmlSection[] = [];
  const base = style.page;
  const pyYear = report.meta.columnMode === 'cy_py';
  const dateLine = fsBalanceSheetDateLine({
    fyStart: report.meta.fyStart, periodEnd: report.meta.periodEnd, mode: report.meta.columnMode,
    priorPeriodEnd: pyYear ? `${Number(report.meta.periodEnd.slice(0, 4)) - 1}${report.meta.periodEnd.slice(4)}` : null,
  });

  if (frontMatter.cover.enabled) {
    sections.push({
      id: 'cover', kind: 'cover', tocLabel: null, pageSetup: base, footer: false, pageNumber: false,
      bodyHtml: `<div class="cover"><div class="co">${esc(report.meta.companyName)}</div><div class="t">${esc(frontMatter.cover.title || 'Financial Statements')}</div><div class="d">${esc(dateLine)}</div>${frontMatter.cover.subtitle ? `<div class="sub">${esc(frontMatter.cover.subtitle)}</div>` : ''}${frontMatter.cover.showFirmName !== false && input.letterhead?.displayName ? `<div class="firm">${esc(input.letterhead.displayName)}</div>` : ''}</div>`,
    });
  }

  const body: FsHtmlSection[] = [];
  if (frontMatter.letter.enabled && input.letter) {
    body.push({
      id: 'letter', kind: 'letter', tocLabel: input.letter.title, pageSetup: base, footer: false, pageNumber: true,
      bodyHtml: `<div class="letter">${letterheadHtml(input.letterhead)}<h1>${esc(input.letter.title)}</h1><div class="body">${input.letter.bodyHtml}</div></div>`,
    });
  }
  for (const st of report.statements) {
    body.push({
      id: st.id, kind: 'statement', tocLabel: st.title, pageSetup: st.pageSetup,
      footer: style.footer.onStatements, pageNumber: true,
      bodyHtml: fsStatementHtml(report, st, style),
    });
  }
  if (report.schedules.length) {
    body.push({
      id: 'supplementary', kind: 'divider', tocLabel: 'Supplementary Information', pageSetup: base, footer: false, pageNumber: true,
      bodyHtml: `<div class="divider">SUPPLEMENTARY INFORMATION</div>`,
    });
    for (const sc of report.schedules) {
      body.push({
        id: sc.id, kind: 'schedule', tocLabel: `${sc.scheduleNo} — ${sc.title}`, pageSetup: sc.pageSetup,
        footer: style.footer.onSchedules, pageNumber: true,
        bodyHtml: fsStatementHtml(report, sc, style),
      });
    }
  }

  if (frontMatter.toc.enabled && body.length) {
    const pages = input.tocPages ?? {};
    const rows = body.map((s) => {
      const pg = pages[s.id];
      const cls = s.kind === 'divider' ? 'grp' : s.kind === 'schedule' ? 'sub' : '';
      return `<tr class="${cls}"><td class="lbl">${esc(s.tocLabel ?? '')}</td><td class="pg">${pg ? pg : ''}</td></tr>`;
    }).join('');
    sections.push({
      id: 'toc', kind: 'toc', tocLabel: null, pageSetup: base, footer: false, pageNumber: false,
      bodyHtml: `<div class="toc"><div class="fs-title"><div class="co">${esc(report.meta.companyName)}</div></div><h1>${esc(frontMatter.toc.title || 'Table of Contents')}</h1><table><tr><td></td><td class="pg" style="font-size:${Math.max(7, input.style.baseSizePt - 2)}pt">Page</td></tr>${rows}</table></div>`,
    });
  }
  sections.push(...body);
  return sections;
}

// Full HTML document for ONE section (PDF path).
export function fsSectionDocument(section: FsHtmlSection, input: FsDocumentInput): string {
  const size = fsPageSizeIn(section.pageSetup);
  const m = section.pageSetup.margins;
  // Bottom margin keeps room for the stamped footer / page number.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fsDocumentCss(input.style, input.fonts)}
@page{size:${size.width}in ${size.height}in;margin:${m.top}in ${m.right}in ${m.bottom}in ${m.left}in}
</style></head><body>${input.draftWatermark ? '<div class="draft-wm">DRAFT</div>' : ''}${section.bodyHtml}</body></html>`;
}

// One preview document of paper-sized sheets (browser path).
export function fsPreviewDocument(input: FsDocumentInput): string {
  const sections = fsBuildSections(input);
  let page = 0;
  const sheets = sections.map((s) => {
    const size = fsPageSizeIn(s.pageSetup);
    const m = s.pageSetup.margins;
    if (s.pageNumber) page++;
    const pn = s.pageNumber && input.style.footer.pageNumber.format !== 'none' ? fsPageNumberText(input.style.footer.pageNumber.format, page, null) : '';
    const footer = s.footer && input.style.footer.text ? esc(input.style.footer.text) : '';
    const posRight = input.style.footer.pageNumber.position === 'bottom_right';
    return `<section class="sheet" data-section="${esc(s.id)}" style="width:${size.width}in;min-height:${size.height}in;padding:${m.top}in ${m.right}in ${m.bottom}in ${m.left}in">
${s.bodyHtml}
<div class="sheet-foot" style="left:${m.left}in;right:${m.right}in;bottom:${Math.max(0.2, m.bottom / 2 - 0.1)}in"><div class="fs-footer" style="text-align:${posRight ? 'left' : 'center'}">${footer}</div>${pn ? `<div class="fs-footer" style="text-align:${posRight ? 'right' : 'center'}">${esc(pn)}</div>` : ''}</div>
</section>`;
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fsDocumentCss(input.style, input.fonts)}
html,body{background:#e5e7eb}
body{padding:24px 0}
.sheet{position:relative;background:#fff;margin:0 auto 24px;box-shadow:0 1px 4px rgba(0,0,0,.25)}
.sheet .chunk+.chunk{border-top:1px dashed #9ca3af;margin-top:18pt;padding-top:18pt}
.sheet-foot{position:absolute;display:flex;flex-direction:column;gap:2pt}
</style></head><body>${sheets}</body></html>`;
}

export function fsPageNumberText(format: FsStyle['footer']['pageNumber']['format'], n: number, total: number | null): string {
  switch (format) {
    case 'n': return String(n);
    case 'dash_n': return `- ${n} -`;
    case 'page_n': return `Page ${n}`;
    case 'page_n_of_total': return total ? `Page ${n} of ${total}` : `Page ${n}`;
    default: return '';
  }
}

export { esc as fsEscapeHtml };
