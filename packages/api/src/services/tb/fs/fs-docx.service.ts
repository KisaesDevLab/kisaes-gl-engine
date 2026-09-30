// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Word export of report-ready financial statements, for final wording
// edits in Word. One section per statement / schedule (own paper,
// orientation, margins); the title block lives in the section header so
// it repeats; footer text + a PAGE field; real tables with a repeating
// column-heading row, single / double rules as cell borders, and fonts
// named by their Office equivalents (the PDF's metric-compatible fonts).

import {
  AlignmentType, BorderStyle, Document, Footer, Header, HorizontalPositionRelativeFrom, ImageRun, Packer, PageBreak, PageNumber, PageOrientation, Paragraph,
  TextWrappingType, VerticalPositionRelativeFrom,
  Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType,
  type ISectionOptions,
} from 'docx';
import {
  fsColumnWidthsIn, fsFont, fsFormatAmount, fsFormatPct, fsPageSizeIn,
  type FsFrontMatter, type FsLetterhead, type FsPageSetup, type FsRenderedReport, type FsRenderedStatement, type FsRow, type FsStyle,
} from '@kis-books/shared';
import { imageInfoFromDataUri } from './image-size.js';

const TW = 1440; // twips per inch
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE };

function pageProps(p: FsPageSetup) {
  const portrait = fsPageSizeIn({ ...p, orientation: 'portrait' });
  return {
    page: {
      size: {
        width: Math.round(portrait.width * TW),
        height: Math.round(portrait.height * TW),
        orientation: p.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
      },
      margin: {
        top: Math.round(p.margins.top * TW), right: Math.round(p.margins.right * TW),
        bottom: Math.round(p.margins.bottom * TW), left: Math.round(p.margins.left * TW),
        header: Math.round(Math.min(0.5, p.margins.top / 2) * TW), footer: Math.round(Math.min(0.5, p.margins.bottom / 2) * TW),
      },
    },
  };
}

function run(text: string, font: string, sizePt: number, bold = false, italic = false, caps = false): TextRun {
  return new TextRun({ text: caps ? text.toUpperCase() : text, font, size: Math.round(sizePt * 2), bold, italics: italic });
}

function footerFor(style: FsStyle, font: string, showText: boolean, showNumber: boolean): Footer {
  const e = style.elements.footer;
  const children: Paragraph[] = [];
  const right = style.footer.pageNumber.position === 'bottom_right';
  if (showText && style.footer.text.trim()) {
    children.push(new Paragraph({ alignment: right ? AlignmentType.LEFT : AlignmentType.CENTER, children: [run(style.footer.text.trim(), font, e.sizePt, e.bold, e.italic)] }));
  }
  const fmt = style.footer.pageNumber.format;
  if (showNumber && fmt !== 'none') {
    const pre = fmt === 'dash_n' ? '- ' : fmt === 'page_n' || fmt === 'page_n_of_total' ? 'Page ' : '';
    const post = fmt === 'dash_n' ? ' -' : '';
    const parts: Array<TextRun> = [
      new TextRun({ text: pre, font, size: Math.round(e.sizePt * 2) }),
      new TextRun({ children: [PageNumber.CURRENT], font, size: Math.round(e.sizePt * 2) }),
    ];
    if (fmt === 'page_n_of_total') parts.push(new TextRun({ text: ' of ', font, size: Math.round(e.sizePt * 2) }), new TextRun({ children: [PageNumber.TOTAL_PAGES], font, size: Math.round(e.sizePt * 2) }));
    if (post) parts.push(new TextRun({ text: post, font, size: Math.round(e.sizePt * 2) }));
    children.push(new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.CENTER, children: parts }));
  }
  return new Footer({ children: children.length ? children : [new Paragraph({})] });
}

function titleHeader(report: FsRenderedReport, st: FsRenderedStatement, style: FsStyle, font: string): Header {
  const align = style.titleBlock.align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT;
  const el = style.elements;
  return new Header({
    children: [
      new Paragraph({ alignment: align, children: [run(report.meta.companyName, font, el.companyName.sizePt, el.companyName.bold, el.companyName.italic, el.companyName.caps)] }),
      new Paragraph({ alignment: align, children: [run(st.scheduleNo ? `${st.scheduleNo} — ${st.title}` : st.title, font, el.statementTitle.sizePt, el.statementTitle.bold, el.statementTitle.italic, el.statementTitle.caps)] }),
      new Paragraph({ alignment: align, spacing: { after: 200 }, children: [run(st.dateLine, font, el.dateLine.sizePt, el.dateLine.bold, el.dateLine.italic, el.dateLine.caps)] }),
    ],
  });
}

function cell(children: Paragraph[], width: number, borders?: Record<string, unknown>): TableCell {
  return new TableCell({
    children, width: { size: width, type: WidthType.DXA }, verticalAlign: VerticalAlign.BOTTOM,
    borders: { ...NO_BORDERS, ...(borders ?? {}) },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
}

function statementTables(st: FsRenderedStatement, style: FsStyle, font: string): Array<Table | Paragraph> {
  const size = fsPageSizeIn(st.pageSetup);
  const usable = Math.round((size.width - st.pageSetup.margins.left - st.pageSetup.margins.right) * TW);
  // Same widths as the PDF (captions keep a readable minimum).
  const w = fsColumnWidthsIn(st, style);
  const gap = Math.round(w.gap * TW);
  const sign = Math.round(w.sign * TW);
  const amt = Math.round(w.amount * TW);
  const pctW = Math.round(w.pct * TW);
  const colWidths = st.columns.map((c) => (c.kind === 'pct' || c.kind === 'variance_pct' ? [gap, pctW] : [gap, sign, amt]));
  const used = colWidths.flat().reduce((s, w) => s + w, 0);
  const capW = Math.max(Math.round(TW), usable - used);
  const el = style.elements;

  const headerRow = st.columns.some((c) => c.label || c.sublabel)
    ? new TableRow({
      tableHeader: true,
      children: [
        cell([new Paragraph({})], capW),
        ...st.columns.flatMap((c, i) => {
          const ws = colWidths[i]!;
          const label = new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              run(c.label, font, el.columnHeader.sizePt, el.columnHeader.bold, el.columnHeader.italic),
              ...(c.sublabel ? [new TextRun({ text: c.sublabel, break: 1, font, size: Math.round(el.columnHeader.sizePt * 2), bold: el.columnHeader.bold, italics: el.columnHeader.italic })] : []),
            ],
          });
          const bottom = { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' } };
          return ws.length === 3
            ? [cell([new Paragraph({})], ws[0]!), new TableCell({ children: [label], columnSpan: 2, width: { size: ws[1]! + ws[2]!, type: WidthType.DXA }, borders: { ...NO_BORDERS, ...bottom } })]
            : [cell([new Paragraph({})], ws[0]!), cell([label], ws[1]!, bottom)];
        }),
      ],
    })
    : null;

  const rowFor = (r: FsRow): TableRow => {
    const e = el[r.styleRole === 'sectionHeading' ? 'sectionHeading' : r.styleRole];
    const sizePt = e.sizePt + (r.sizeDelta ?? 0);
    const bold = r.bold ?? e.bold;
    const italic = r.italic ?? e.italic;
    const caps = r.caps ?? e.caps ?? false;
    const caption = r.scheduleRef ? `${r.caption} (${r.scheduleRef})` : r.caption;
    const capPara = new Paragraph({
      indent: { left: Math.round(Math.max(0, r.level) * style.indentPt * 20) },
      children: r.kind === 'blank' ? [] : [run(caption, font, sizePt, bold, italic, caps)],
    });
    const numeric = r.kind !== 'heading' && r.kind !== 'text' && r.kind !== 'blank';
    const rule = {
      ...(r.ruleAbove === 'single' ? { top: { style: BorderStyle.SINGLE, size: 4, color: '000000' } } : {}),
      ...(r.ruleBelow === 'single' ? { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' } } : {}),
      ...(r.ruleBelow === 'double' ? { bottom: { style: BorderStyle.DOUBLE, size: 4, color: '000000' } } : {}),
    };
    const cells: TableCell[] = [cell([capPara], capW)];
    st.columns.forEach((c, i) => {
      const ws = colWidths[i]!;
      const v = r.values[i] ?? null;
      cells.push(cell([new Paragraph({})], ws[0]!));
      if (ws.length === 3) {
        const txt = numeric ? fsFormatAmount(v, style) : '';
        const b = numeric && (v !== null || r.ruleBelow !== 'none' || r.ruleAbove !== 'none') ? rule : {};
        cells.push(cell([new Paragraph({ children: r.dollarSign && txt ? [run('$', font, sizePt, bold, italic)] : [] })], ws[1]!, b));
        const pad = txt && !txt.endsWith(')') && style.number.negative === 'parens' ? ' ' : '';
        cells.push(cell([new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(txt + pad, font, sizePt, bold, italic)] })], ws[2]!, b));
      } else {
        const txt = numeric ? fsFormatPct(v, style) : '';
        cells.push(cell([new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(txt, font, sizePt, bold, italic)] })], ws[1]!));
      }
    });
    return new TableRow({ children: cells, cantSplit: true });
  };

  // Split at page breaks into separate tables.
  const out: Array<Table | Paragraph> = [];
  let chunk: FsRow[] = [];
  const flush = (breakAfter: boolean) => {
    if (chunk.length) {
      out.push(new Table({
        layout: TableLayoutType.FIXED,
        width: { size: capW + used, type: WidthType.DXA },
        columnWidths: [capW, ...colWidths.flat()],
        borders: { ...NO_BORDERS, insideHorizontal: NONE, insideVertical: NONE },
        rows: [...(headerRow ? [headerRow] : []), ...chunk.map(rowFor)],
      }));
    }
    if (breakAfter) out.push(new Paragraph({ children: [new PageBreak()] }));
    chunk = [];
  };
  for (const r of st.rows) {
    if (r.kind === 'page_break') { flush(true); continue; }
    if (r.breakBefore && chunk.length) flush(true);
    chunk.push(r);
  }
  flush(false);
  return out;
}

// Minimal HTML → paragraphs for the accountant's report (p / br / div,
// b / strong, i / em, u). Word is the editing surface, so plain structure
// is enough.
function htmlParagraphs(html: string, font: string, sizePt: number): Paragraph[] {
  const blocks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .split(/<\/(?:p|div|h[1-6]|li)>/i)
    .map((b) => b.replace(/<(p|div|h[1-6]|li|ul|ol)\b[^>]*>/gi, ''));
  const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const paras: Paragraph[] = [];
  for (const block of blocks) {
    if (!block.replace(/<[^>]+>/g, '').trim()) continue;
    const runs: TextRun[] = [];
    let bold = false; let italic = false; let underline = false;
    for (const part of block.split(/(<[^>]+>)/)) {
      if (!part) continue;
      const tag = /^<\s*(\/?)\s*(b|strong|i|em|u)\b/i.exec(part);
      if (tag) {
        const on = tag[1] !== '/';
        const t = tag[2]!.toLowerCase();
        if (t === 'b' || t === 'strong') bold = on; else if (t === 'i' || t === 'em') italic = on; else underline = on;
        continue;
      }
      if (part.startsWith('<')) continue;
      decode(part).split('\n').forEach((line, i) => {
        runs.push(new TextRun({ text: line, font, size: Math.round(sizePt * 2), bold, italics: italic, underline: underline ? {} : undefined, break: i > 0 ? 1 : undefined }));
      });
    }
    paras.push(new Paragraph({ spacing: { after: 160 }, children: runs }));
  }
  return paras;
}

export interface FsDocxInput {
  report: FsRenderedReport;
  style: FsStyle;
  frontMatter: FsFrontMatter;
  letterhead: FsLetterhead | null;
  letter: { title: string; bodyHtml: string } | null;
}

export async function buildFsDocx(input: FsDocxInput): Promise<Buffer> {
  const { report, style, frontMatter } = input;
  const font = fsFont(style.fontKey).msEquivalent;
  const el = style.elements;
  const sections: ISectionOptions[] = [];
  const empty = new Footer({ children: [new Paragraph({})] });
  const dateLine = report.meta.bsDateLine;

  if (frontMatter.cover.enabled) {
    sections.push({
      properties: pageProps(style.page),
      footers: { default: empty },
      children: [
        new Paragraph({ spacing: { before: 3600 }, alignment: AlignmentType.CENTER, children: [run(report.meta.companyName, font, el.companyName.sizePt + 6, true, false, el.companyName.caps)] }),
        new Paragraph({ spacing: { before: 200 }, alignment: AlignmentType.CENTER, children: [run(frontMatter.cover.title || 'Financial Statements', font, el.statementTitle.sizePt + 4, true)] }),
        new Paragraph({ spacing: { before: 160 }, alignment: AlignmentType.CENTER, children: [run(dateLine, font, el.dateLine.sizePt)] }),
        ...(frontMatter.cover.subtitle ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(frontMatter.cover.subtitle, font, el.dateLine.sizePt)] })] : []),
        ...(frontMatter.cover.showFirmName !== false && input.letterhead?.displayName
          ? [new Paragraph({ spacing: { before: 2600 }, alignment: AlignmentType.CENTER, children: [run(input.letterhead.displayName, font, el.dateLine.sizePt)] })]
          : []),
      ],
    });
  }

  let numberingStarted = false;
  const numbered = () => {
    const first = !numberingStarted;
    numberingStarted = true;
    return first ? { pageNumbers: { start: 1 } } : {};
  };

  if (frontMatter.letter.enabled && input.letter) {
    const lh = input.letterhead;
    const align = lh?.letterheadAlign === 'center' ? AlignmentType.CENTER : lh?.letterheadAlign === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
    const content = lh?.letterheadContent ?? 'both';
    const logo = imageInfoFromDataUri(lh?.logoDataUri);
    const showLogo = !!logo && content !== 'text';
    const showText = content !== 'logo' || !logo;
    const lhParas: Paragraph[] = [];
    if (showLogo && logo) {
      const PX = 96; // docx sizes images in 96-dpi pixels
      const pg = fsPageSizeIn(style.page);
      const contentW = pg.width - style.page.margins.left - style.page.margins.right;
      const aspect = logo.height / logo.width;
      const size = lh?.logoSize ?? 'small';
      let wIn: number;
      if (size === 'full_bleed') wIn = pg.width;
      else if (size === 'content_width') wIn = contentW;
      else wIn = Math.min(contentW, (size === 'medium' ? 1.5 : 0.9) / aspect);
      const transformation = { width: Math.round(wIn * PX), height: Math.round(wIn * aspect * PX) };
      if (size === 'full_bleed') {
        // Floating, anchored to the page corner; text flows below it.
        lhParas.push(new Paragraph({ children: [new ImageRun({
          type: logo.type, data: logo.bytes, transformation,
          floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
            verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
            wrap: { type: TextWrappingType.TOP_AND_BOTTOM },
          },
        })] }));
        // Keep the first line of text below the banner.
        const below = Math.max(0, wIn * aspect - style.page.margins.top) * TW + 200;
        lhParas.push(new Paragraph({ spacing: { before: Math.round(below) }, children: [] }));
      } else {
        lhParas.push(new Paragraph({ alignment: size === 'content_width' ? AlignmentType.LEFT : align, spacing: { after: 120 }, children: [new ImageRun({ type: logo.type, data: logo.bytes, transformation })] }));
      }
    }
    if (showText) {
      if (lh?.displayName) lhParas.push(new Paragraph({ alignment: align, children: [run(lh.displayName, font, style.baseSizePt + 3, true)] }));
      const cityLine = [lh?.city, [lh?.state, lh?.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      for (const l of [lh?.addressLine1, lh?.addressLine2, cityLine, [lh?.phone, lh?.email, lh?.website].filter(Boolean).join(' · ')]) {
        if (l) lhParas.push(new Paragraph({ alignment: align, children: [run(l, font, Math.max(7, style.baseSizePt - 1.5))] }));
      }
    }
    sections.push({
      properties: { ...pageProps(style.page), ...numbered() },
      footers: { default: footerFor(style, font, false, true) },
      children: [
        ...lhParas,
        new Paragraph({ spacing: { before: 360, after: 240 }, alignment: AlignmentType.CENTER, children: [run(input.letter.title, font, el.statementTitle.sizePt, true)] }),
        ...htmlParagraphs(input.letter.bodyHtml, font, style.baseSizePt),
      ],
    });
  }

  for (const st of report.statements) {
    sections.push({
      properties: { ...pageProps(st.pageSetup), ...numbered() },
      headers: { default: titleHeader(report, st, style, font) },
      footers: { default: footerFor(style, font, style.footer.onStatements, true) },
      children: statementTables(st, style, font),
    });
  }
  if (report.schedules.length) {
    sections.push({
      properties: { ...pageProps(style.page), ...numbered() },
      footers: { default: footerFor(style, font, false, true) },
      children: [new Paragraph({ spacing: { before: 4000 }, alignment: AlignmentType.CENTER, children: [run('SUPPLEMENTARY INFORMATION', font, el.statementTitle.sizePt + 4, true)] })],
    });
    for (const sc of report.schedules) {
      sections.push({
        properties: { ...pageProps(sc.pageSetup), ...numbered() },
        headers: { default: titleHeader(report, sc, style, font) },
        footers: { default: footerFor(style, font, style.footer.onSchedules, true) },
        children: statementTables(sc, style, font),
      });
    }
  }

  const doc = new Document({
    creator: 'Vibe MyBooks',
    title: `${report.meta.companyName} — Financial Statements`,
    styles: { default: { document: { run: { font, size: Math.round(style.baseSizePt * 2) } } } },
    sections,
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
