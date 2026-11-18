// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Spreadsheet documents (U-268, imports-transactions-v1): kind
// `transactions`, the Generic multi-line layout. One row is one line; rows with
// the same group_id are one document (an invoice, a bill or a journal entry).
//
// Columns (header row, any order, case-insensitive):
//   group_id, type (invoice | bill | journal_entry), date, number, name,
//   due_date, memo, line_account, line_item, line_description, line_amount,
//   line_debit, line_credit, line_tag
//
// - The header cells (type, date, number, name, due_date, memo) may repeat on
//   every row of a group or be blank after the first; two different values in
//   one group are IMPORT_MIXED_GROUP {field}.
// - Invoice and bill lines take line_amount (signed, exact; blank is
//   IMPORT_AMOUNT_INVALID). Journal entry lines take line_debit / line_credit,
//   or a signed line_amount (positive = debit); a zero line is dropped; the
//   entry must balance exactly (IMPORT_UNBALANCED).
// - Amounts are exact Decimals (U-260): spreadsheet number cells are read as
//   their raw value; more than 4 places, exponents and the like are refused.
//   Invoice lines carry at most 2 places (an invoice is computed to the cent).
// - Names, accounts, items and tags are matched at upload (validateAgainstDb)
//   and again at commit (IMPORT_UNKNOWN_REF {field}); nothing is created.
// - No sales tax (Q-P31i).

import type { CanonicalTxnDocument, CanonicalTxnLine, ImportValidationError, TxnDocType } from '@kis-books/shared';
import { readGrid, toIsoDate } from './generic.js';
import { importAmountError, importAmountText, isImportAmount, parseImportAmount, Decimal } from '../import-amount.js';

/** The column names, in the canonical order (the Generic template's header row). */
export const TXN_COLUMNS = [
  'group_id', 'type', 'date', 'number', 'name', 'due_date', 'memo',
  'line_account', 'line_item', 'line_description', 'line_amount', 'line_debit', 'line_credit', 'line_tag',
] as const;
export type TxnColumn = (typeof TXN_COLUMNS)[number];

const HEADER_FIELDS = ['type', 'date', 'number', 'name', 'due_date', 'memo'] as const;
type HeaderField = (typeof HEADER_FIELDS)[number];

const TYPE_MAP: Record<string, TxnDocType> = {
  invoice: 'invoice',
  bill: 'bill',
  journal_entry: 'journal_entry',
  'journal entry': 'journal_entry',
  journal: 'journal_entry',
  'general journal': 'journal_entry',
};

interface RawRow {
  rowNumber: number;
  cells: Partial<Record<TxnColumn, string>>;
  raw: Partial<Record<TxnColumn, unknown>>;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();

/** A real calendar date (2026-02-30 is not), or null. */
function isoDate(cell: string): string | null {
  let iso = toIsoDate(cell);
  // A spreadsheet date cell holds its serial number (days since 1899-12-30).
  if (!iso && /^\d{5}$/.test(cell)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(cell) * 86_400_000);
    iso = d.toISOString().slice(0, 10);
  }
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d ? iso : null;
}

function err(rowNumber: number, field: string | undefined, code: string, message: string): ImportValidationError {
  return { rowNumber, ...(field ? { field } : {}), code, message };
}

export function parseTransactions(gridRows: string[][]): { documents: CanonicalTxnDocument[]; errors: ImportValidationError[]; lineCount: number } {
  const documents: CanonicalTxnDocument[] = [];
  const errors: ImportValidationError[] = [];
  const h = gridRows.findIndex((r) => {
    const cells = (r ?? []).map((c) => text(c).toLowerCase());
    return cells.includes('type') && cells.includes('date')
      && (cells.includes('line_amount') || cells.includes('line_debit') || cells.includes('line_credit'));
  });
  if (h === -1) {
    return {
      documents, lineCount: 0,
      errors: [err(0, undefined, 'IMPORT_HEADER_NOT_FOUND', `Could not find the header row (need columns: type, date and line_amount or line_debit / line_credit; all: ${TXN_COLUMNS.join(', ')}).`)],
    };
  }
  const header = (gridRows[h] ?? []).map((c) => text(c).toLowerCase());
  const col = new Map<TxnColumn, number>();
  for (const c of TXN_COLUMNS) {
    const i = header.indexOf(c);
    if (i !== -1) col.set(c, i);
  }

  // Group the rows (first appearance order); a blank group_id is a document of its own.
  const groups = new Map<string, RawRow[]>();
  let lineCount = 0;
  for (let i = h + 1; i < gridRows.length; i++) {
    const r = gridRows[i] ?? [];
    const cells: RawRow['cells'] = {};
    const raw: RawRow['raw'] = {};
    let any = false;
    for (const [c, idx] of col) {
      raw[c] = r[idx];
      const t = text(r[idx]);
      if (t) { cells[c] = t; any = true; }
    }
    if (!any) continue;
    lineCount++;
    const rowNumber = i + 1;
    const key = cells.group_id ? `g:${cells.group_id}` : `r:${rowNumber}`;
    const list = groups.get(key) ?? [];
    list.push({ rowNumber, cells, raw });
    groups.set(key, list);
  }

  for (const rows of groups.values()) {
    const doc = documentOf(rows, errors);
    if (doc) documents.push(doc);
  }
  return { documents, errors, lineCount };
}

/** One group's document, or null (its problems pushed to `errors`). */
function documentOf(rows: RawRow[], errors: ImportValidationError[]): CanonicalTxnDocument | null {
  const first = rows[0]!;
  const before = errors.length;

  // Header fields: one value per group (blank rows inherit it).
  const head: Partial<Record<HeaderField, string>> = {};
  for (const f of HEADER_FIELDS) {
    for (const r of rows) {
      const v = r.cells[f];
      if (v === undefined) continue;
      const norm = f === 'type' ? (TYPE_MAP[v.toLowerCase().replace(/\s+/g, ' ')] ?? `?${v.toLowerCase()}`)
        : f === 'date' || f === 'due_date' ? (isoDate(v) ?? v) : v;
      if (head[f] === undefined) head[f] = norm;
      else if (head[f] !== norm) {
        errors.push(err(r.rowNumber, f, 'IMPORT_MIXED_GROUP', `Row ${r.rowNumber}: this document's ${f} differs from its first row.`));
        break;
      }
    }
  }
  if (errors.length > before) return null;

  const typeRow = rows.find((r) => r.cells.type);
  const docType = head.type && !head.type.startsWith('?') ? head.type as TxnDocType : undefined;
  if (!typeRow) {
    errors.push(err(first.rowNumber, 'type', 'IMPORT_MISSING_FIELD', `Row ${first.rowNumber}: type is blank (invoice, bill or journal_entry).`));
  } else if (!docType) {
    errors.push(err(typeRow.rowNumber, 'type', 'IMPORT_UNKNOWN_TYPE', `Row ${typeRow.rowNumber}: type must be invoice, bill or journal_entry.`));
  }
  const dateRow = rows.find((r) => r.cells.date);
  const date = dateRow ? isoDate(dateRow.cells.date!) : null;
  if (!dateRow) errors.push(err(first.rowNumber, 'date', 'IMPORT_MISSING_FIELD', `Row ${first.rowNumber}: date is blank.`));
  else if (!date) errors.push(err(dateRow.rowNumber, 'date', 'IMPORT_BAD_DATE', `Row ${dateRow.rowNumber}: date is not a date (YYYY-MM-DD or MM/DD/YYYY).`));
  const dueRow = rows.find((r) => r.cells.due_date);
  const dueDate = dueRow ? isoDate(dueRow.cells.due_date!) : null;
  if (dueRow && !dueDate) errors.push(err(dueRow.rowNumber, 'due_date', 'IMPORT_BAD_DATE', `Row ${dueRow.rowNumber}: due_date is not a date.`));
  if (docType && docType !== 'journal_entry' && !head.name) {
    errors.push(err(first.rowNumber, 'name', 'IMPORT_MISSING_FIELD', `Row ${first.rowNumber}: an ${docType === 'invoice' ? 'invoice needs its customer' : 'bill needs its vendor'} (name).`));
  }
  if (!docType) return null;

  const lines: CanonicalTxnLine[] = [];
  for (const r of rows) {
    const c = r.cells;
    let amount: InstanceType<typeof Decimal> | null = null;
    if (docType === 'journal_entry') {
      if (c.line_item) {
        errors.push(err(r.rowNumber, 'line_item', 'IMPORT_FIELD_NOT_ALLOWED', `Row ${r.rowNumber}: a journal entry line takes an account, not an item.`));
        continue;
      }
      if (c.line_amount !== undefined && (c.line_debit !== undefined || c.line_credit !== undefined)) {
        errors.push(err(r.rowNumber, 'line_amount', 'IMPORT_AMOUNT_INVALID', `Row ${r.rowNumber}: give line_amount or line_debit / line_credit, not both.`));
        continue;
      }
      if (c.line_amount === undefined && c.line_debit === undefined && c.line_credit === undefined) {
        errors.push(importAmountError(r.rowNumber, 'line_debit', ''));
        continue;
      }
      if (c.line_amount !== undefined) {
        const a = parseImportAmount(r.raw.line_amount, { signed: true });
        if (!isImportAmount(a)) { errors.push(importAmountError(r.rowNumber, 'line_amount', r.raw.line_amount)); continue; }
        amount = a;
      } else {
        const d = parseImportAmount(r.raw.line_debit);
        const k = parseImportAmount(r.raw.line_credit);
        if (!isImportAmount(d)) { errors.push(importAmountError(r.rowNumber, 'line_debit', r.raw.line_debit)); continue; }
        if (!isImportAmount(k)) { errors.push(importAmountError(r.rowNumber, 'line_credit', r.raw.line_credit)); continue; }
        amount = d.minus(k);
      }
      if (!c.line_account) {
        errors.push(err(r.rowNumber, 'line_account', 'IMPORT_MISSING_FIELD', `Row ${r.rowNumber}: line_account is blank.`));
        continue;
      }
      if (amount.isZero()) continue; // a zero journal line posts nothing
    } else {
      if (c.line_amount === undefined && (c.line_debit !== undefined || c.line_credit !== undefined)) {
        errors.push(err(r.rowNumber, 'line_amount', 'IMPORT_AMOUNT_INVALID', `Row ${r.rowNumber}: ${docType} lines take line_amount, not line_debit / line_credit.`));
        continue;
      }
      const a = parseImportAmount(r.raw.line_amount, { signed: true, blank: 'invalid' });
      if (!isImportAmount(a)) { errors.push(importAmountError(r.rowNumber, 'line_amount', r.raw.line_amount)); continue; }
      if (docType === 'invoice' && a.decimalPlaces() > 2) {
        errors.push(err(r.rowNumber, 'line_amount', 'IMPORT_AMOUNT_CENTS', `Row ${r.rowNumber}: an invoice line amount has at most 2 decimal places.`));
        continue;
      }
      if (!c.line_account && !c.line_item) {
        errors.push(err(r.rowNumber, 'line_account', 'IMPORT_MISSING_FIELD', `Row ${r.rowNumber}: give line_account or line_item.`));
        continue;
      }
      amount = a;
    }
    lines.push({
      rowNumber: r.rowNumber,
      amount: importAmountText(amount),
      ...(c.line_account ? { account: c.line_account } : {}),
      ...(c.line_item ? { item: c.line_item } : {}),
      ...(c.line_description ? { description: c.line_description } : {}),
      ...(c.line_tag ? { tag: c.line_tag } : {}),
    });
  }
  if (errors.length > before) return null;

  const sum = lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
  if (docType === 'journal_entry') {
    if (lines.length === 0) {
      errors.push(err(first.rowNumber, 'line_debit', 'IMPORT_AMOUNT_INVALID', `Row ${first.rowNumber}: this journal entry has no amounts.`));
      return null;
    }
    if (!sum.isZero()) {
      errors.push(err(first.rowNumber, undefined, 'IMPORT_UNBALANCED', `Row ${first.rowNumber}: this journal entry's debits and credits differ by ${importAmountText(sum.abs())}.`));
      return null;
    }
  } else if (!sum.greaterThan(0)) {
    errors.push(err(first.rowNumber, 'line_amount', 'IMPORT_DOCUMENT_TOTAL', `Row ${first.rowNumber}: this ${docType}'s total must be above zero.`));
    return null;
  }
  return {
    rowNumber: first.rowNumber,
    groupId: first.cells.group_id ?? null,
    docType,
    date: date!,
    ...(head.number ? { number: head.number } : {}),
    ...(head.name ? { name: head.name } : {}),
    ...(docType !== 'journal_entry' && dueDate ? { dueDate } : {}),
    ...(head.memo ? { memo: head.memo } : {}),
    lines,
  };
}

/** Reads the upload (CSV UTF-8 or .xlsx; number cells exact). */
export async function parseTransactionsFile(buf: Buffer) {
  return parseTransactions(await readGrid(buf));
}
