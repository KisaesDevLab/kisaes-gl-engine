// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Transactions list → CSV / PDF export.
//
// The export is the WHOLE list the operator is looking at — every page of
// the current filters, search, date range and sort — one row per
// transaction. It reuses ledger.listTransactions (same tenant + company
// scoping, same filter and sort SQL) with paging replaced by a cap.
//
// Columns follow the General Ledger report: Date | Type | Ref # | Name |
// Description | Account / Category | Tag | Debit | Credit (no running
// balance), then a totals row. CSV has Tag after Credit and adds Status.
// Tag is the same value in both: the distinct tag names on the
// transaction's lines, joined with '; '.
//
// Debit / Credit — the same rules the list screen uses:
//   - Void transactions are reversed, so they show 0 / 0 (and add nothing
//     to the totals), exactly like the list's 0 amount.
//   - Filtered to an account: that account's own debit and credit on the
//     transaction — the list's Debit / Credit columns (register view).
//   - Otherwise: the debits and credits posted to the transaction's
//     category account(s) — the account(s) the Account / Category column
//     names (one name, or "Split" for several). An expense debits its
//     expense, a deposit credits its income.
//   - A transaction with no category side (a transfer between two banks, a
//     bill or customer payment) shows its full amount — the list's Amount —
//     in both columns, as a balanced entry.

import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { TXN_TYPE_LABELS, formatIsoUS } from '@kis-books/shared';
import { db } from '../db/index.js';
import * as ledger from './ledger.service.js';
import { escapeHtml, toPdf, toReportHtml } from './report-export.service.js';
import { toCsvRow } from './export.service.js';
import { stampPageFooter } from './pdf-merge.util.js';
import { safeTimeZone } from './transaction-report.service.js';

/** Row caps. PDF is lower: past ~10,000 rows (~300 landscape pages) a
 *  printout stops being useful and rendering gets slow. Mutable so the
 *  route tests can exercise truncation without seeding 50,000 rows. */
export const TXN_EXPORT_LIMITS = { csv: 50_000, pdf: 10_000 };

export type TxnExportFormat = 'csv' | 'pdf';

export interface TxnExportFilters {
  txnType?: string;
  status?: string;
  contactId?: string | string[];
  accountId?: string;
  tagId?: string;
  source?: string;
  basis?: 'cash' | 'accrual';
  startDate?: string;
  endDate?: string;
  search?: string;
  sortBy?: 'date' | 'type' | 'number' | 'payee' | 'memo' | 'category' | 'amount' | 'status' | 'dueDate' | 'balanceDue' | 'invoiceStatus';
  sortDir?: 'asc' | 'desc';
}

export interface TxnExportRow {
  date: string;
  type: string;
  ref: string;
  name: string;
  description: string;
  category: string;
  debit: Decimal | null;
  credit: Decimal | null;
  tag: string;
  status: string;
}

export interface TxnExport {
  rows: TxnExportRow[];
  totals: { debit: Decimal; credit: Decimal };
  /** Transactions matching the filters (before the cap). */
  matched: number;
  truncated: boolean;
  cap: number;
  companyName: string;
  dateLabel: string;
  /** Human-readable filter lines for the PDF header. */
  filterLines: string[];
}

const TYPE_LABELS: Record<string, string> = { ...TXN_TYPE_LABELS };

const SORT_LABELS: Record<string, string> = {
  date: 'Date', type: 'Type', number: 'Ref #', payee: 'Name', memo: 'Description',
  category: 'Account / Category', amount: 'Amount', status: 'Status',
  dueDate: 'Due date', balanceDue: 'Balance due', invoiceStatus: 'Invoice status',
};

function typeLabel(txnType: string, ajeNumber: number | null | undefined): string {
  if (txnType === 'aje') return ajeNumber ? `AJE-${String(ajeNumber).padStart(3, '0')}` : 'AJE';
  return TYPE_LABELS[txnType] ?? txnType;
}

function dec(v: string | null | undefined): Decimal {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  try { return new Decimal(v); } catch { return new Decimal(0); }
}

type ListRow = Awaited<ReturnType<typeof ledger.listTransactions>>['data'][number];

/** Debit / Credit for one list row — see the header comment for the rules. */
export function deriveDebitCredit(row: Pick<ListRow, 'status' | 'accountDebit' | 'accountCredit' | 'categoryDebit' | 'categoryCredit' | 'lineCategories' | 'displayTotal' | 'total'>, accountFiltered: boolean): { debit: Decimal; credit: Decimal } {
  if (row.status === 'void') return { debit: new Decimal(0), credit: new Decimal(0) };
  if (accountFiltered) return { debit: dec(row.accountDebit), credit: dec(row.accountCredit) };
  if (row.lineCategories && row.lineCategories.length > 0) {
    return { debit: dec(row.categoryDebit), credit: dec(row.categoryCredit) };
  }
  const amount = dec(row.displayTotal ?? row.total);
  return { debit: amount, credit: amount };
}

/** Plain-number money for CSV: 2 decimals, no separators. Blank for zero
 *  on a normal row (register style, like the list); void rows print 0.00
 *  so the reversal is explicit. */
function csvMoney(v: Decimal | null): string {
  return v === null ? '' : v.toFixed(2);
}

/** GL-style money for the PDF: thousands separators, 2 decimals. */
function pdfMoney(v: Decimal | null): string {
  if (v === null) return '';
  const n = Number(v.toFixed(2));
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function lookupNames(tenantId: string, companyId: string, f: TxnExportFilters) {
  const one = async (q: ReturnType<typeof sql>) => {
    const r = await db.execute(q);
    return (r.rows as Array<{ label: string | null }>)[0]?.label ?? null;
  };
  const companyName = (await one(sql`SELECT business_name AS label FROM companies WHERE id = ${companyId} AND tenant_id = ${tenantId}`)) || 'Company';
  // Every lookup is tenant-scoped, so a foreign id can only ever resolve to
  // nothing (and the list query returns nothing for it either).
  const account = f.accountId
    ? await one(sql`SELECT trim(concat_ws(' ', account_number, name)) AS label FROM accounts WHERE id = ${f.accountId} AND tenant_id = ${tenantId}`)
    : null;
  const contactIds = Array.isArray(f.contactId) ? f.contactId : f.contactId ? [f.contactId] : [];
  const contactNames: string[] = [];
  for (const id of contactIds) {
    const n = await one(sql`SELECT display_name AS label FROM contacts WHERE id = ${id} AND tenant_id = ${tenantId}`);
    if (n) contactNames.push(n);
  }
  const tag = f.tagId ? await one(sql`SELECT name AS label FROM tags WHERE id = ${f.tagId} AND tenant_id = ${tenantId}`) : null;
  return { companyName, account, contactNames, tag };
}

function describeDates(f: TxnExportFilters): string {
  if (f.startDate && f.endDate) return `${formatIsoUS(f.startDate)} to ${formatIsoUS(f.endDate)}`;
  if (f.startDate) return `From ${formatIsoUS(f.startDate)}`;
  if (f.endDate) return `Through ${formatIsoUS(f.endDate)}`;
  return 'All dates';
}

function describeSort(f: TxnExportFilters): string {
  const key = f.sortBy ?? 'date';
  const dir = f.sortBy ? (f.sortDir === 'asc' ? 'asc' : 'desc') : 'desc';
  const label = SORT_LABELS[key] ?? key;
  if (key === 'date') return `${label} (${dir === 'asc' ? 'oldest first' : 'newest first'})`;
  return `${label} (${dir === 'asc' ? 'ascending' : 'descending'})`;
}

export async function buildTransactionListExport(
  tenantId: string,
  companyId: string,
  filters: TxnExportFilters,
  format: TxnExportFormat,
): Promise<TxnExport> {
  const cap = TXN_EXPORT_LIMITS[format];
  const accountFiltered = !!filters.accountId;
  const list = await ledger.listTransactions(tenantId, {
    ...filters,
    // The list sends sortDir only alongside sortBy; mirror that.
    sortDir: filters.sortBy ? filters.sortDir : undefined,
    limit: cap,
    offset: 0,
    withCategoryAmounts: !accountFiltered,
  }, companyId);

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  const rows: TxnExportRow[] = list.data.map((t) => {
    const { debit, credit } = deriveDebitCredit(t, accountFiltered);
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    const cats = t.lineCategories ?? [];
    const tagsOnLines = t.lineTags ?? [];
    const isVoid = t.status === 'void';
    return {
      date: t.txnDate ?? '',
      type: typeLabel(t.txnType, t.ajeNumber),
      ref: t.txnNumber ?? '',
      name: t.contactName ?? '',
      description: t.memo ?? '',
      category: cats.length === 0 ? '' : cats.length === 1 ? cats[0]! : 'Split',
      debit: isVoid || !debit.isZero() ? debit : null,
      credit: isVoid || !credit.isZero() ? credit : null,
      tag: tagsOnLines.join('; '),
      status: t.status ?? '',
    };
  });

  const names = await lookupNames(tenantId, companyId, filters);
  const filterLines: string[] = [];
  if (filters.txnType) filterLines.push(`Type: ${TYPE_LABELS[filters.txnType] ?? filters.txnType}`);
  if (filters.status) filterLines.push(`Status: ${filters.status.charAt(0).toUpperCase()}${filters.status.slice(1)}`);
  if (filters.accountId) filterLines.push(`Account: ${names.account ?? 'Unknown account'}`);
  if (names.contactNames.length) filterLines.push(`Name: ${names.contactNames.join(', ')}`);
  else if (filters.contactId && (!Array.isArray(filters.contactId) || filters.contactId.length)) filterLines.push('Name: Unknown contact');
  if (filters.tagId) filterLines.push(`Tag: ${names.tag ?? 'Unknown tag'}`);
  if (filters.basis) filterLines.push(`Basis: ${filters.basis === 'cash' ? 'Cash' : 'Accrual'}`);
  if (filters.source) filterLines.push(`Source: ${filters.source}`);
  if (filters.search) filterLines.push(`Search: "${filters.search}"`);
  filterLines.push(`Sorted by: ${describeSort(filters)}`);

  return {
    rows,
    totals: { debit: totalDebit, credit: totalCredit },
    matched: Number(list.total),
    truncated: Number(list.total) > rows.length,
    cap,
    companyName: names.companyName,
    dateLabel: describeDates(filters),
    filterLines,
  };
}

export function truncationNote(x: Pick<TxnExport, 'rows' | 'matched'>): string {
  return `Export truncated: first ${x.rows.length.toLocaleString('en-US')} of ${x.matched.toLocaleString('en-US')} matching transactions. Narrow the date range or filters to export the rest.`;
}

export const CSV_HEADER = ['Date', 'Type', 'Ref #', 'Name', 'Description', 'Account / Category', 'Debit', 'Credit', 'Tag', 'Status'];

/** RFC 4180 CSV (every field quoted, "" escapes, CRLF records) with the
 *  shared formula-injection guard (export.service toCsvRow). Starts with a
 *  UTF-8 byte-order mark so Excel reads names and memos with accents or
 *  dashes correctly instead of guessing a legacy code page. */
export function toTransactionListCsv(x: TxnExport): string {
  const lines: string[] = [toCsvRow(CSV_HEADER)];
  for (const r of x.rows) {
    lines.push(toCsvRow([r.date, r.type, r.ref, r.name, r.description, r.category, csvMoney(r.debit), csvMoney(r.credit), r.tag, r.status]));
  }
  lines.push(toCsvRow(['', '', '', '', 'Total', '', x.totals.debit.toFixed(2), x.totals.credit.toFixed(2), '', '']));
  if (x.truncated) lines.push(toCsvRow([truncationNote(x), '', '', '', '', '', '', '', '', '']));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// Landscape letter leaves ~900px of table. To fit Tag, every fixed
// column gave up some width and cells use 5px side padding (TABLE_STYLE)
// instead of the report chrome's 8px, so Description — the flex column —
// keeps ~145px. `wrap` breaks long unspaced values (tag names) inside the
// column instead of letting them push the amounts off the page.
const PDF_COLUMNS: Array<{ key: keyof TxnExportRow; label: string; width?: string; right?: boolean; wrap?: boolean }> = [
  { key: 'date', label: 'Date', width: '64px' },
  { key: 'type', label: 'Type', width: '72px' },
  { key: 'ref', label: 'Ref #', width: '50px' },
  { key: 'name', label: 'Name', width: '110px' },
  { key: 'description', label: 'Description' },
  { key: 'category', label: 'Account / Category', width: '120px' },
  { key: 'tag', label: 'Tag', width: '96px', wrap: true },
  { key: 'debit', label: 'Debit', width: '76px', right: true },
  { key: 'credit', label: 'Credit', width: '76px', right: true },
];
const TABLE_STYLE = '<style>table.txn-list th,table.txn-list td{padding-left:5px;padding-right:5px}</style>';

/** The report-table markup (same classes as reports.routes buildHtmlTable)
 *  inside the shared report chrome (toReportHtml), so the printout matches
 *  the General Ledger PDF. */
export function toTransactionListHtml(x: TxnExport): string {
  const cell = (v: string, right?: boolean, width?: string, wrap?: boolean) => {
    const styles = [width ? `width:${width}` : '', wrap ? 'overflow-wrap:anywhere' : ''].filter(Boolean).join(';');
    return `<td${right ? ' class="amount"' : ''}${styles ? ` style="${styles}"` : ''}>${escapeHtml(v)}</td>`;
  };
  const header = PDF_COLUMNS.map((c) =>
    `<th${c.right ? ' class="amount"' : ''}${c.width ? ` style="width:${c.width}"` : ''}>${escapeHtml(c.label)}</th>`).join('');
  const body = x.rows.map((r) => `<tr>${PDF_COLUMNS.map((c) => {
    const v = r[c.key];
    return cell(c.right ? pdfMoney(v as Decimal | null) : String(v ?? ''), c.right, c.width, c.wrap);
  }).join('')}</tr>`).join('');
  const totalCells = PDF_COLUMNS.map((c) => {
    if (c.key === 'debit') return cell(pdfMoney(x.totals.debit), true);
    if (c.key === 'credit') return cell(pdfMoney(x.totals.credit), true);
    if (c.key === 'category') return cell('Total');
    return '<td></td>';
  }).join('');
  const empty = x.rows.length === 0
    ? `<tr><td colspan="${PDF_COLUMNS.length}" style="text-align:center;color:#6b7280">No transactions match these filters.</td></tr>`
    : '';
  const meta = [
    ...x.filterLines.map((l) => `<div>${escapeHtml(l)}</div>`),
    x.truncated ? `<div style="color:#b45309;font-weight:600">${escapeHtml(truncationNote(x))}</div>` : '',
  ].join('');
  const table = `<div class="meta" style="margin-top:-14px">${meta}</div>`
    + `${TABLE_STYLE}<table class="txn-list"><thead><tr>${header}</tr></thead><tbody>${empty}${body}`
    + `<tr class="total-row" style="font-weight:700;border-top:2px solid #111">${totalCells}</tr></tbody></table>`;
  return toReportHtml('Transactions', x.companyName, x.dateLabel, table);
}

export function printedLabel(now: Date, timeZone: string | undefined): string {
  const tz = safeTimeZone(timeZone);
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(now);
  // "10/12/2026, 3:04 PM CDT" → "Printed 10/12/2026 3:04 PM CDT"
  // ICU puts a narrow no-break space before AM/PM; the stamped footer
  // font (Helvetica, WinAnsi) cannot encode it.
  return `Printed ${s.replace(',', '').replace(/[\u202f\u00a0]/g, ' ')}`;
}

export async function toTransactionListPdf(x: TxnExport, opts: { timeZone?: string; now?: Date } = {}): Promise<Buffer> {
  const rendered = await toPdf(toTransactionListHtml(x), { orientation: 'landscape' });
  const doc = await PDFDocument.load(rendered);
  await stampPageFooter(doc, { pageNumbers: true, footer: printedLabel(opts.now ?? new Date(), opts.timeZone) });
  return Buffer.from(await doc.save());
}

export function exportFileName(format: TxnExportFormat, now: Date = new Date()): string {
  return `Transactions_${now.toISOString().slice(0, 10)}.${format}`;
}
