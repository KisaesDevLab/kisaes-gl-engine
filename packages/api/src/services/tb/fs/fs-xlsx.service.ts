// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Excel export of report-ready financial statements: one sheet per
// statement / schedule, detail lines as values, every subtotal / total as
// a live formula (SUM / ±terms from the engine's row formulas) whose
// cached result is the statement value, accounting number formats, rules
// as cell borders, and print setup (paper, orientation, margins, repeat
// title rows, footer + page number).

import ExcelJS from 'exceljs';
import { fsFont, type FsRenderedReport, type FsRenderedStatement, type FsRow, type FsStyle } from '@kis-books/shared';

const PAPER: Record<string, number> = { letter: 1, legal: 5, a4: 9 };

function colLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function sheetName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${i++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

function numFmt(style: FsStyle, dollar: boolean): string {
  const d = style.number.decimals === 2 ? '.00' : '';
  const zero = style.number.zero === 'dash' ? '"–"' : `0${d}`;
  const neg = style.number.negative === 'parens' ? `(#,##0${d})` : `-#,##0${d}`;
  const cur = dollar ? '$' : '';
  return `${cur}#,##0${d}_);${cur}${neg};${cur}${zero}_)`;
}

// "B8+B9-B10" or "SUM(B8:B12)" for a formula over row numbers.
function formulaText(col: string, terms: Array<{ row: number; sign: 1 | -1 }>): string {
  if (!terms.length) return '0';
  const allPos = terms.every((t) => t.sign === 1);
  const sorted = [...terms].sort((a, b) => a.row - b.row);
  if (allPos && sorted.length > 2 && sorted.every((t, i) => i === 0 || t.row === sorted[i - 1]!.row + 1)) {
    return `SUM(${col}${sorted[0]!.row}:${col}${sorted[sorted.length - 1]!.row})`;
  }
  return terms.map((t, i) => `${t.sign === -1 ? '-' : i === 0 ? '' : '+'}${col}${t.row}`).join('');
}

function addStatementSheet(wb: ExcelJS.Workbook, report: FsRenderedReport, st: FsRenderedStatement, style: FsStyle, used: Set<string>) {
  const font = fsFont(style.fontKey).msEquivalent;
  const ws = wb.addWorksheet(sheetName(st.scheduleNo ? `${st.scheduleNo} ${st.title}` : st.title, used), {
    pageSetup: {
      paperSize: PAPER[st.pageSetup.paper] as ExcelJS.PaperSize,
      orientation: st.pageSetup.orientation,
      margins: { ...st.pageSetup.margins, header: 0.3, footer: 0.3 },
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
    },
    views: [{ showGridLines: false }],
  });
  const nCols = st.columns.length;
  ws.getColumn(1).width = 46;
  st.columns.forEach((c, i) => { ws.getColumn(i + 2).width = c.kind === 'pct' || c.kind === 'variance_pct' ? 9 : 15; });

  const el = style.elements;
  const lastCol = colLetter(nCols + 1);
  const titleRow = (r: number, text: string, e: typeof el.companyName) => {
    ws.mergeCells(`A${r}:${lastCol}${r}`);
    const cell = ws.getCell(`A${r}`);
    cell.value = e.caps ? text.toUpperCase() : text;
    cell.font = { name: font, size: e.sizePt, bold: e.bold, italic: e.italic };
    cell.alignment = { horizontal: style.titleBlock.align === 'center' ? 'center' : 'left' };
  };
  titleRow(1, report.meta.companyName, el.companyName);
  titleRow(2, st.scheduleNo ? `${st.scheduleNo} — ${st.title}` : st.title, el.statementTitle);
  titleRow(3, st.dateLine, el.dateLine);
  let headerRows = 3;
  if (st.columns.some((c) => c.label || c.sublabel)) {
    headerRows = 5;
    st.columns.forEach((c, i) => {
      const cell = ws.getCell(5, i + 2);
      cell.value = c.sublabel ? `${c.label}\n${c.sublabel}` : c.label;
      cell.font = { name: font, size: el.columnHeader.sizePt, bold: el.columnHeader.bold, italic: el.columnHeader.italic };
      cell.alignment = { horizontal: 'right', wrapText: true };
      cell.border = { bottom: { style: 'thin' } };
    });
  }
  ws.pageSetup.printTitlesRow = `1:${headerRows}`;
  const footerText = style.footer.text.replace(/&/g, '&&');
  ws.headerFooter.oddFooter = `&C${footerText}${footerText ? '\n' : ''}&P`;

  const first = headerRows + 2;
  const sheetRow = (i: number) => first + i;
  st.rows.forEach((r: FsRow, i) => {
    const rowNo = sheetRow(i);
    const e = el[r.styleRole === 'sectionHeading' ? 'sectionHeading' : r.styleRole];
    const f = { name: font, size: e.sizePt + (r.sizeDelta ?? 0), bold: r.bold ?? e.bold, italic: r.italic ?? e.italic };
    if (r.kind === 'blank' || r.kind === 'page_break') {
      if (r.kind === 'page_break') ws.getRow(rowNo).addPageBreak();
      return;
    }
    const cap = ws.getCell(rowNo, 1);
    const caption = r.scheduleRef ? `${r.caption} (${r.scheduleRef})` : r.caption;
    cap.value = (r.caps || e.caps) ? caption.toUpperCase() : caption;
    cap.font = f;
    cap.alignment = { indent: Math.max(0, r.level), wrapText: r.kind === 'text' };
    if (r.kind === 'heading' || r.kind === 'text') return;
    st.columns.forEach((c, ci) => {
      const cell = ws.getCell(rowNo, ci + 2);
      const v = r.values[ci];
      const letter = colLetter(ci + 2);
      if (v === null || v === undefined) return;
      cell.font = f;
      if (c.kind === 'pct' || c.kind === 'variance_pct') {
        cell.value = v / 100;
        cell.numFmt = style.number.negative === 'parens' ? '0.0%;(0.0%);"–"' : '0.0%';
        return;
      }
      if (c.kind === 'variance_amt') {
        const cy = st.columns.findIndex((x) => x.kind === 'amount');
        const py = st.columns.findIndex((x, xi) => x.kind === 'amount' && xi > cy);
        cell.value = cy >= 0 && py >= 0 ? { formula: `${colLetter(cy + 2)}${rowNo}-${colLetter(py + 2)}${rowNo}`, result: v } : v;
      } else if (report.meta.columnMode === 'side_by_side' && c.key === 'P' && r.kind !== 'heading') {
        // Total column = the month / quarter columns across the row.
        const refs = st.columns.map((x, xi) => (x.kind === 'amount' && x.key !== 'P' ? `${colLetter(xi + 2)}${rowNo}` : null)).filter((x): x is string => !!x);
        cell.value = { formula: `SUM(${refs.join(',')})`, result: v };
      } else if (r.formula) {
        const terms = r.formula.kind === 'sum' ? r.formula.rows.map((row) => ({ row: sheetRow(row), sign: 1 as const })) : r.formula.terms.map((t) => ({ row: sheetRow(t.row), sign: t.sign }));
        cell.value = { formula: formulaText(letter, terms), result: v };
      } else {
        cell.value = v;
      }
      cell.numFmt = numFmt(style, r.dollarSign);
      const border: Partial<ExcelJS.Borders> = {};
      if (r.ruleAbove === 'single') border.top = { style: 'thin' };
      if (r.ruleBelow === 'single') border.bottom = { style: 'thin' };
      if (r.ruleBelow === 'double') border.bottom = { style: 'double' };
      if (border.top || border.bottom) cell.border = border;
    });
  });
}

export async function buildFsXlsx(report: FsRenderedReport, style: FsStyle): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vibe MyBooks';
  wb.created = new Date();
  const used = new Set<string>();
  for (const st of report.statements) addStatementSheet(wb, report, st, style, used);
  for (const sc of report.schedules) addStatementSheet(wb, report, sc, style, used);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
