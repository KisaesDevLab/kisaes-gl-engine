// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, contacts, transactions, journalLines } from '../db/schema/index.js';

// Defeat CSV formula injection. Excel / Google Sheets / Numbers treat cells
// starting with `=`, `+`, `-`, `@`, TAB, CR as a formula — so a customer
// displayName of `=HYPERLINK("http://evil",A1)` opens as a live hyperlink in
// the accountant's exported CSV. OWASP's recommended mitigation: prefix any
// cell starting with one of those characters with a leading apostrophe, which
// the spreadsheet strips on open and which neutralizes the formula parser.
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
function neutralizeCsvFormula(s: string): string {
  return FORMULA_TRIGGER_RE.test(s) ? `'${s}` : s;
}

function toCsvRow(values: (string | number | null | undefined)[]): string {
  return values.map((v) => {
    if (v === null || v === undefined) return '""';
    const neutralized = neutralizeCsvFormula(String(v));
    return `"${neutralized.replace(/"/g, '""')}"`;
  }).join(',');
}

export async function fullExport(tenantId: string): Promise<Record<string, string>> {
  // Accounts CSV
  const accts = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId)).orderBy(accounts.accountNumber, accounts.name);
  let accountsCsv = 'Account Number,Name,Type,Detail Type,Balance,Active,System\n';
  for (const a of accts) {
    accountsCsv += toCsvRow([a.accountNumber, a.name, a.accountType, a.detailType, a.balance, String(a.isActive), String(a.isSystem)]) + '\n';
  }

  // Contacts CSV
  const ctcts = await db.select().from(contacts).where(eq(contacts.tenantId, tenantId)).orderBy(contacts.displayName);
  let contactsCsv = 'Display Name,Type,Company,Email,Phone,Active\n';
  for (const c of ctcts) {
    contactsCsv += toCsvRow([c.displayName, c.contactType, c.companyName, c.email, c.phone, String(c.isActive)]) + '\n';
  }

  // Transactions CSV
  const txns = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.status, t.total, t.memo,
      t.invoice_status, t.amount_paid, t.balance_due,
      c.display_name as contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
    ORDER BY t.txn_date DESC, t.created_at DESC
  `);
  let transactionsCsv = 'ID,Type,Number,Date,Status,Total,Memo,Contact,Invoice Status,Amount Paid,Balance Due\n';
  for (const t of txns.rows as any[]) {
    transactionsCsv += toCsvRow([t.id, t.txn_type, t.txn_number, t.txn_date, t.status, t.total, t.memo, t.contact_name, t.invoice_status, t.amount_paid, t.balance_due]) + '\n';
  }

  // Journal Lines CSV — ADR 0XX §6.3 gains a `line_tag` column for
  // per-line tag export. Joined off the tags table via optional FK.
  const lines = await db.execute(sql`
    SELECT jl.id, jl.transaction_id, jl.account_id, jl.debit, jl.credit, jl.description,
      a.name as account_name, a.account_number,
      tag.name as line_tag,
      t.txn_date, t.txn_type
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN tags tag ON tag.id = jl.tag_id
    WHERE jl.tenant_id = ${tenantId}
    ORDER BY t.txn_date, jl.line_order
  `);
  let journalLinesCsv = 'ID,Transaction ID,Account Number,Account Name,Debit,Credit,Description,Line Tag,Date,Type\n';
  for (const l of lines.rows as any[]) {
    journalLinesCsv += toCsvRow([l.id, l.transaction_id, l.account_number, l.account_name, l.debit, l.credit, l.description, l.line_tag, l.txn_date, l.txn_type]) + '\n';
  }

  return {
    'accounts.csv': accountsCsv,
    'contacts.csv': contactsCsv,
    'transactions.csv': transactionsCsv,
    'journal_lines.csv': journalLinesCsv,
  };
}
