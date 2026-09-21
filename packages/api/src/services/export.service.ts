// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';


// Defeat CSV formula injection. Excel / Google Sheets / Numbers treat cells
// starting with `=`, `+`, `-`, `@`, TAB, CR as a formula — so a customer
// displayName of `=HYPERLINK("http://evil",A1)` opens as a live hyperlink in
// the accountant's exported CSV. OWASP's recommended mitigation: prefix any
// cell starting with one of those characters with a leading apostrophe, which
// the spreadsheet strips on open and which neutralizes the formula parser.
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
// A genuine negative number (-1, -1.50, -1,234.56) leads with '-' but is not a
// formula — it must export as a number, not get apostrophe-quoted into text.
// Anchored, so a crafted "-1+HYPERLINK(...)" still trips FORMULA_TRIGGER_RE.
const NEGATIVE_NUMBER_RE = /^-\d[\d,]*(\.\d+)?$/;
export function neutralizeCsvFormula(s: string): string {
  if (NEGATIVE_NUMBER_RE.test(s)) return s;
  return FORMULA_TRIGGER_RE.test(s) ? `'${s}` : s;
}

// Exported so other CSV-emitting routes (audit export, future reports)
// can reuse the same formula-neutralization + quote-escape pipeline
// instead of re-implementing it. Treats Date instances as ISO strings.
export function toCsvRow(values: (string | number | Date | null | undefined)[]): string {
  return values.map((v) => {
    if (v === null || v === undefined) return '""';
    const stringified = v instanceof Date ? v.toISOString() : String(v);
    const neutralized = neutralizeCsvFormula(stringified);
    return `"${neutralized.replace(/"/g, '""')}"`;
  }).join(',');
}

export interface ExportFile {
  csv: string;
  /** Data rows, excluding the header line. */
  rowCount: number;
}

export interface FullExportOptions {
  /** Inclusive YYYY-MM-DD bounds on transaction date. Applies to the
   *  transactions and journal-lines files only — accounts, contacts, items
   *  and tags are master data and always export in full. */
  startDate?: string;
  endDate?: string;
}

export const EXPORT_FILE_NAMES = [
  'accounts.csv', 'contacts.csv', 'items.csv', 'tags.csv', 'transactions.csv', 'journal_lines.csv',
] as const;
export type ExportFileName = typeof EXPORT_FILE_NAMES[number];

/** Files whose contents change with the date range (the rest are master data). */
export const DATED_EXPORT_FILES: ReadonlySet<ExportFileName> = new Set(['transactions.csv', 'journal_lines.csv']);

type Row = Record<string, unknown>;

// db.execute() rows are untyped; coerce each picked cell to what toCsvRow
// accepts. Booleans become "true"/"false", numerics arrive as strings from
// pg and pass through unchanged (no float round-trip).
function toCell(v: unknown): string | number | Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || v instanceof Date) return v;
  return String(v);
}

function buildCsv(header: string[], rows: Row[], columns: string[]): ExportFile {
  if (header.length !== columns.length) throw new Error('export header/column mismatch');
  let csv = header.join(',') + '\n';
  for (const r of rows) csv += toCsvRow(columns.map((c) => toCell(r[c]))) + '\n';
  return { csv, rowCount: rows.length };
}

export async function fullExport(tenantId: string, opts: FullExportOptions = {}): Promise<Record<ExportFileName, ExportFile>> {
  // Accounts — parent resolved to its number/name so a hierarchy survives
  // the round trip into another system without needing our UUIDs.
  const accts = await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type, a.description,
      a.balance, a.is_active, a.is_system, a.system_tag,
      p.account_number AS parent_account_number, p.name AS parent_name
    FROM accounts a
    LEFT JOIN accounts p ON p.id = a.parent_id
    WHERE a.tenant_id = ${tenantId}
    ORDER BY a.account_number, a.name
  `);
  const accountsFile = buildCsv(
    ['ID', 'Account Number', 'Name', 'Type', 'Detail Type', 'Description', 'Parent Account Number', 'Parent Account', 'Balance', 'Active', 'System', 'System Tag'],
    accts.rows,
    ['id', 'account_number', 'name', 'account_type', 'detail_type', 'description', 'parent_account_number', 'parent_name', 'balance', 'is_active', 'is_system', 'system_tag'],
  );

  // Contacts — full card (addresses, terms, 1099 fields) so a vendor/customer
  // list can be re-imported elsewhere. tax_id is included: this export is
  // gated on company_settings:update and 1099 filing needs it.
  const ctcts = await db.execute(sql`
    SELECT c.id, c.display_name, c.contact_type, c.company_name, c.first_name, c.last_name,
      c.email, c.phone,
      c.billing_line1, c.billing_line2, c.billing_city, c.billing_state, c.billing_zip, c.billing_country,
      c.shipping_line1, c.shipping_line2, c.shipping_city, c.shipping_state, c.shipping_zip, c.shipping_country,
      c.default_payment_terms, c.default_terms_days, c.opening_balance, c.opening_balance_date,
      c.tax_id, c.vendor_account_number, c.is_1099_eligible, c.notes, c.is_active,
      ea.account_number AS default_expense_account_number, ea.name AS default_expense_account,
      tag.name AS default_tag
    FROM contacts c
    LEFT JOIN accounts ea ON ea.id = c.default_expense_account_id
    LEFT JOIN tags tag ON tag.id = c.default_tag_id
    WHERE c.tenant_id = ${tenantId}
    ORDER BY c.display_name
  `);
  const contactsFile = buildCsv(
    ['ID', 'Display Name', 'Type', 'Company', 'First Name', 'Last Name', 'Email', 'Phone',
      'Billing Line 1', 'Billing Line 2', 'Billing City', 'Billing State', 'Billing Zip', 'Billing Country',
      'Shipping Line 1', 'Shipping Line 2', 'Shipping City', 'Shipping State', 'Shipping Zip', 'Shipping Country',
      'Payment Terms', 'Terms Days', 'Opening Balance', 'Opening Balance Date',
      'Tax ID', 'Vendor Account Number', '1099 Eligible', 'Default Expense Account Number', 'Default Expense Account', 'Default Tag', 'Notes', 'Active'],
    ctcts.rows,
    ['id', 'display_name', 'contact_type', 'company_name', 'first_name', 'last_name', 'email', 'phone',
      'billing_line1', 'billing_line2', 'billing_city', 'billing_state', 'billing_zip', 'billing_country',
      'shipping_line1', 'shipping_line2', 'shipping_city', 'shipping_state', 'shipping_zip', 'shipping_country',
      'default_payment_terms', 'default_terms_days', 'opening_balance', 'opening_balance_date',
      'tax_id', 'vendor_account_number', 'is_1099_eligible', 'default_expense_account_number', 'default_expense_account', 'default_tag', 'notes', 'is_active'],
  );

  // Items (products & services)
  const itms = await db.execute(sql`
    SELECT i.id, i.name, i.description, i.unit_price, i.is_taxable, i.is_active,
      ia.account_number AS income_account_number, ia.name AS income_account,
      tag.name AS default_tag
    FROM items i
    LEFT JOIN accounts ia ON ia.id = i.income_account_id
    LEFT JOIN tags tag ON tag.id = i.default_tag_id
    WHERE i.tenant_id = ${tenantId}
    ORDER BY i.name
  `);
  const itemsFile = buildCsv(
    ['ID', 'Name', 'Description', 'Unit Price', 'Income Account Number', 'Income Account', 'Taxable', 'Default Tag', 'Active'],
    itms.rows,
    ['id', 'name', 'description', 'unit_price', 'income_account_number', 'income_account', 'is_taxable', 'default_tag', 'is_active'],
  );

  // Tags (the QuickBooks "Class" equivalent) with their group.
  const tgs = await db.execute(sql`
    SELECT t.id, t.name, t.description, t.color, t.is_active, g.name AS group_name
    FROM tags t
    LEFT JOIN tag_groups g ON g.id = t.group_id
    WHERE t.tenant_id = ${tenantId}
    ORDER BY g.sort_order NULLS LAST, g.name, t.sort_order, t.name
  `);
  const tagsFile = buildCsv(
    ['ID', 'Group', 'Name', 'Description', 'Color', 'Active'],
    tgs.rows,
    ['id', 'group_name', 'name', 'description', 'color', 'is_active'],
  );

  // Optional inclusive txn_date window, shared by the two dated files.
  const dateFilter = sql.join([
    opts.startDate ? sql`AND t.txn_date >= ${opts.startDate}::date` : sql``,
    opts.endDate ? sql`AND t.txn_date <= ${opts.endDate}::date` : sql``,
  ], sql` `);

  // Transactions (one row per document)
  const txns = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.status, t.total, t.memo,
      t.invoice_status, t.amount_paid, t.balance_due,
      c.display_name as contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId} ${dateFilter}
    ORDER BY t.txn_date DESC, t.created_at DESC
  `);
  const transactionsFile = buildCsv(
    ['ID', 'Type', 'Number', 'Date', 'Status', 'Total', 'Memo', 'Contact', 'Invoice Status', 'Amount Paid', 'Balance Due'],
    txns.rows,
    ['id', 'txn_type', 'txn_number', 'txn_date', 'status', 'total', 'memo', 'contact_name', 'invoice_status', 'amount_paid', 'balance_due'],
  );

  // Journal Lines (one row per posting) — ADR 0XX §6.3 gains a `line_tag`
  // column for per-line tag export. Joined off the tags table via optional FK.
  const lines = await db.execute(sql`
    SELECT jl.id, jl.transaction_id, jl.account_id, jl.debit, jl.credit, jl.description,
      a.name as account_name, a.account_number,
      tag.name as line_tag,
      t.txn_date, t.txn_type, t.txn_number, t.status,
      c.display_name as contact_name
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN tags tag ON tag.id = jl.tag_id
    WHERE jl.tenant_id = ${tenantId} ${dateFilter}
    ORDER BY t.txn_date, t.created_at, jl.line_order
  `);
  const journalLinesFile = buildCsv(
    ['ID', 'Transaction ID', 'Date', 'Type', 'Number', 'Status', 'Contact', 'Account Number', 'Account Name', 'Debit', 'Credit', 'Description', 'Line Tag'],
    lines.rows,
    ['id', 'transaction_id', 'txn_date', 'txn_type', 'txn_number', 'status', 'contact_name', 'account_number', 'account_name', 'debit', 'credit', 'description', 'line_tag'],
  );

  return {
    'accounts.csv': accountsFile,
    'contacts.csv': contactsFile,
    'items.csv': itemsFile,
    'tags.csv': tagsFile,
    'transactions.csv': transactionsFile,
    'journal_lines.csv': journalLinesFile,
  };
}
