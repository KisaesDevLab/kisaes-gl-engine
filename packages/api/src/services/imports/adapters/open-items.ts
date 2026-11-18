// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Open-item reports (U-264, qbd-open-items-v1): A/R "Open Invoices" and A/P
// "Unpaid Bills Detail" as of a date, from QuickBooks Desktop (Latin-1 CSV),
// QuickBooks Online and the Generic template (CSV or .xlsx). One parser reads
// all three: the columns are found by name, the report's own "as of" date is
// read from the lines above the header.
//
// Columns: Type, Date, Num, Open Balance (required); Name, Due Date and
// Amount (optional). Without a Name column the customer or vendor is the
// group heading above the rows, as QuickBooks Desktop prints it (a job's
// heading under its customer's gives "Customer:Job").
//
// Each row is one open item. Its open balance decides the document: a
// positive balance is an invoice or bill, a negative one a credit memo or
// vendor credit (QuickBooks "Payment" rows are unapplied payments: credit
// memos, P31 spike C9). The Type must be one this file knows
// (OPEN_INVOICE_TYPE_MAP / UNPAID_BILL_TYPE_MAP), else the row is an error.
// A zero balance row is left out; an empty report is valid.

import {
  OPEN_INVOICE_TYPE_MAP,
  UNPAID_BILL_TYPE_MAP,
  type CanonicalOpenItemRow,
  type ImportValidationError,
  type OpenItemDocType,
  type SourceSystem,
} from '@kis-books/shared';
import { parseCsvText, parseXlsxBuffer } from '../../payroll-parse.service.js';
import { Decimal, importAmountError, importAmountText, isImportAmount, parseImportAmount, xlsxNumberText } from '../import-amount.js';

export type OpenItemKind = 'open_invoices' | 'unpaid_bills';

const TYPE_LABELS = ['type', 'transaction type'];
const DATE_LABELS = ['date'];
const NUM_LABELS = ['num', 'no.', 'number', 'ref no.'];
const OPEN_LABELS = ['open balance'];
const DUE_LABELS = ['due date'];
const AMOUNT_LABELS = ['amount', 'original amount'];
const NAME_LABELS: Record<OpenItemKind, string[]> = {
  open_invoices: ['name', 'customer', 'customer name', 'customer full name'],
  unpaid_bills: ['name', 'vendor', 'vendor name', 'vendor display name', 'supplier'],
};

async function readGrid(buf: Buffer, sourceSystem: SourceSystem): Promise<string[][]> {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return parseXlsxBuffer(buf, { numberText: xlsxNumberText });
  // QuickBooks Desktop writes Latin-1 (ISO-8859-1); the others UTF-8.
  const text = sourceSystem === 'quickbooks_desktop' ? buf.toString('latin1') : buf.toString('utf8');
  return parseCsvText(text.replace(/^﻿/, ''));
}

const norm = (c: string | undefined) => (c ?? '').trim().toLowerCase();

function colAny(header: string[], labels: string[]): number {
  for (const l of labels) {
    const i = header.findIndex((c) => norm(c) === l);
    if (i !== -1) return i;
  }
  return -1;
}

function findHeader(grid: string[][]): number {
  for (let i = 0; i < grid.length; i++) {
    const h = grid[i] ?? [];
    if (colAny(h, TYPE_LABELS) !== -1 && colAny(h, DATE_LABELS) !== -1 && colAny(h, OPEN_LABELS) !== -1) return i;
  }
  return -1;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** ISO, M/D/YY(YY), or "Oct 31, 26" / "October 31, 2026" → YYYY-MM-DD; null otherwise. */
export function openItemDate(raw: string | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  let y: string | undefined;
  let m: string | undefined;
  let d: string | undefined;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  const named = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/);
  if (iso) [, y, m, d] = iso;
  else if (us) { m = us[1]!.padStart(2, '0'); d = us[2]!.padStart(2, '0'); y = us[3]!.length === 2 ? `20${us[3]}` : us[3]; }
  else if (named) {
    m = MONTHS[named[1]!.slice(0, 3).toLowerCase()];
    d = named[2]!.padStart(2, '0');
    y = named[3]!.length === 2 ? `20${named[3]}` : named[3];
  }
  if (!y || !m || !d) return null;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return null;
  return `${y}-${m}-${d}`;
}

const AS_OF_RE = /([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/;

/**
 * The report's own date, from the lines above the header: the cell that says
 * "As of …" (QuickBooks prints it under the title), else the first date there
 * (a "prepared on" date above the title must not win over "As of").
 */
function scrapeReportDate(grid: string[][], headerIdx: number): string | null {
  let first: string | null = null;
  for (let i = 0; i < headerIdx; i++) {
    for (const cell of grid[i] ?? []) {
      const m = (cell ?? '').match(AS_OF_RE);
      const iso = m ? openItemDate(m[1]) : null;
      if (!iso) continue;
      if (/\bas\s+of\b/i.test(cell ?? '')) return iso;
      first ??= iso;
    }
  }
  return first;
}

function docTypeFor(kind: OpenItemKind, negative: boolean): OpenItemDocType {
  if (kind === 'open_invoices') return negative ? 'credit_memo' : 'invoice';
  return negative ? 'vendor_credit' : 'bill';
}

export function parseOpenItems(
  buf: Buffer,
  kind: OpenItemKind,
  sourceSystem: SourceSystem,
): Promise<{ rows: CanonicalOpenItemRow[]; errors: ImportValidationError[]; reportDate: string | null }> {
  return readGrid(buf, sourceSystem).then((grid) => parseGrid(grid, kind));
}

function parseGrid(
  grid: string[][],
  kind: OpenItemKind,
): { rows: CanonicalOpenItemRow[]; errors: ImportValidationError[]; reportDate: string | null } {
  const rows: CanonicalOpenItemRow[] = [];
  const errors: ImportValidationError[] = [];
  const headerIdx = findHeader(grid);
  if (headerIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: kind === 'open_invoices'
        ? 'Could not find the Open Invoices columns (Type, Date, Num, Open Balance). Did you upload the right report?'
        : 'Could not find the Unpaid Bills columns (Type, Date, Num, Open Balance). Did you upload the right report?',
    });
    return { rows, errors, reportDate: null };
  }
  const reportDate = scrapeReportDate(grid, headerIdx);
  const header = grid[headerIdx]!;
  const iType = colAny(header, TYPE_LABELS);
  const iDate = colAny(header, DATE_LABELS);
  const iNum = colAny(header, NUM_LABELS);
  const iOpen = colAny(header, OPEN_LABELS);
  const iDue = colAny(header, DUE_LABELS);
  const iAmount = colAny(header, AMOUNT_LABELS);
  const iName = colAny(header, NAME_LABELS[kind]);
  const typeMap = kind === 'open_invoices' ? OPEN_INVOICE_TYPE_MAP : UNPAID_BILL_TYPE_MAP;
  // Group headings (no Name column): the heading text at each indent column.
  const groupCols = Math.min(...[iType, iDate, iOpen].filter((i) => i >= 0));
  const groups: string[] = [];

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const typeText = (r[iType] ?? '').trim();
    if (!typeText) {
      // A heading, a subtotal ("Total Acme") or a blank line.
      if (iName === -1) {
        for (let c = 0; c < groupCols; c++) {
          const t = (r[c] ?? '').trim();
          if (!t) continue;
          if (/^total\b/i.test(t)) groups.length = Math.min(groups.length, c);
          else { groups.length = c; groups[c] = t; }
          break;
        }
      }
      continue;
    }
    if (/^total\b/i.test(typeText)) continue;

    const side = typeMap[typeText.toLowerCase()];
    if (!side) {
      errors.push({
        rowNumber, field: 'Type', code: 'IMPORT_UNKNOWN_TYPE',
        message: `Unknown ${kind === 'open_invoices' ? 'Open Invoices' : 'Unpaid Bills'} type "${typeText}".`,
      });
      continue;
    }
    const open = parseImportAmount(r[iOpen], { signed: true, blank: 'invalid' });
    if (!isImportAmount(open)) {
      errors.push(importAmountError(rowNumber, 'Open Balance', r[iOpen]));
      continue;
    }
    if (open.isZero()) continue;
    // Documents post to the cent: an open balance with more places can't be matched exactly.
    if (open.decimalPlaces() > 2) {
      errors.push({
        rowNumber, field: 'Open Balance', code: 'IMPORT_OPEN_ITEM_CENTS',
        message: `Open balance "${(r[iOpen] ?? '').trim()}" has more than 2 decimal places.`,
      });
      continue;
    }
    const negative = open.isNegative();
    if ((side === 'charge' && negative) || (side === 'credit' && !negative)) {
      errors.push({
        rowNumber, field: 'Open Balance', code: 'IMPORT_OPEN_ITEM_SIGN',
        message: `A ${typeText} row should have a ${side === 'charge' ? 'positive' : 'negative'} open balance.`,
      });
      continue;
    }
    const date = openItemDate(r[iDate]);
    if (!date) {
      errors.push({ rowNumber, field: 'Date', code: 'IMPORT_BAD_DATE', message: `Could not parse date "${(r[iDate] ?? '').trim()}".` });
      continue;
    }
    let dueDate: string | undefined;
    if (iDue !== -1 && (r[iDue] ?? '').trim()) {
      const d = openItemDate(r[iDue]);
      if (!d) {
        errors.push({ rowNumber, field: 'Due Date', code: 'IMPORT_BAD_DATE', message: `Could not parse due date "${(r[iDue] ?? '').trim()}".` });
        continue;
      }
      dueDate = d;
    }
    let originalAmount: string | undefined;
    if (iAmount !== -1 && (r[iAmount] ?? '').trim()) {
      const a = parseImportAmount(r[iAmount], { signed: true });
      if (!isImportAmount(a)) {
        errors.push(importAmountError(rowNumber, 'Amount', r[iAmount]));
        continue;
      }
      originalAmount = importAmountText(a);
    }
    const name = iName !== -1 ? (r[iName] ?? '').trim() : groups.filter(Boolean).join(':');
    if (!name) {
      errors.push({
        rowNumber, field: 'Name', code: 'IMPORT_OPEN_ITEM_NO_NAME',
        message: kind === 'open_invoices' ? 'This open item has no customer.' : 'This open item has no vendor.',
      });
      continue;
    }
    const number = iNum !== -1 ? (r[iNum] ?? '').trim() : '';
    rows.push({
      rowNumber,
      sourceType: typeText,
      docType: docTypeFor(kind, negative),
      date,
      ...(number ? { number } : {}),
      name,
      ...(dueDate ? { dueDate } : {}),
      openBalance: importAmountText(open),
      ...(originalAmount !== undefined ? { originalAmount } : {}),
    });
  }
  return { rows, errors, reportDate };
}

/** The exact sum of the rows' open balances. */
export function openItemsTotal(rows: CanonicalOpenItemRow[]): string {
  return rows.reduce((s, r) => s.plus(r.openBalance), new Decimal(0)).toFixed(2);
}
