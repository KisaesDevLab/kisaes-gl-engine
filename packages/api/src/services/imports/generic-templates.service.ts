// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Builds the downloadable Generic import sample workbooks (.xlsx) from the
// shared column definitions in generic-columns.ts, so the template a user
// downloads always matches exactly what the Generic adapter parses.

import type { ImportKind } from '@kis-books/shared';
import { GENERIC_TEMPLATES, type GenericTemplate } from './adapters/generic-columns.js';

/** Human filename for a kind's sample workbook. */
export function sampleFileName(kind: ImportKind): string {
  const t = GENERIC_TEMPLATES[kind];
  const slug = t.sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `vibe-mybooks-${slug}-template.xlsx`;
}

async function newWorkbook() {
  const ExcelJS = await import('exceljs');
  return new ExcelJS.default.Workbook();
}

/** Build a single-kind sample .xlsx: a data sheet (headers + one example row)
 *  plus an Instructions sheet describing each column. */
export async function buildSampleWorkbook(kind: ImportKind): Promise<Buffer> {
  const template: GenericTemplate = GENERIC_TEMPLATES[kind];
  const wb = await newWorkbook();

  // ── Data sheet ──
  const ws = wb.addWorksheet(template.sheetName);
  const headers = template.columns.map((c) => c.header);
  const headerRow = ws.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  // One example row so the user sees the expected shape.
  ws.addRow(template.columns.map((c) => c.example));
  template.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = Math.max(14, Math.min(40, c.header.length + 6));
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Instructions sheet ──
  const info = wb.addWorksheet('Instructions');
  info.getColumn(1).width = 26;
  info.getColumn(2).width = 12;
  info.getColumn(3).width = 70;
  const title = info.addRow([template.sheetName]);
  title.font = { bold: true, size: 14 };
  info.addRow([template.description]);
  info.addRow([]);
  const th = info.addRow(['Column', 'Required', 'Notes']);
  th.font = { bold: true };
  for (const c of template.columns) {
    info.addRow([c.header, c.required ? 'Yes' : 'No', c.note ?? '']);
  }
  info.addRow([]);
  info.addRow(['Tip', '', 'Keep the header row exactly as-is. Delete the example row before uploading.']);

  const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return Buffer.from(out);
}
