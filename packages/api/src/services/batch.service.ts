// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql, ilike, inArray, desc } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { accounts, contacts, transactions, journalLines } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as expenseService from './expense.service.js';
import * as depositService from './deposit.service.js';
import * as invoiceService from './invoice.service.js';
import * as creditMemoService from './credit-memo.service.js';
import * as journalEntryService from './journal-entry.service.js';
import * as ledger from './ledger.service.js';
import * as billService from './bill.service.js';
import { escapeLike } from '../utils/sql-like.js';
import DecimalLib from 'decimal.js';
import { BATCH_MAX_ROWS } from '@kis-books/shared';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

/** A number or numeric string as a Decimal; anything unparseable is 0 (the single-type shape's old leniency). */
function lenientDecimal(v: number | string | undefined): DecimalValue {
  if (v === undefined || v === '') return new Decimal(0);
  try {
    const d = new Decimal(typeof v === 'number' ? String(v) : v.trim());
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

// ─── Fuzzy Matching ──────────────────────────────────────────────

export async function resolveContactByName(tenantId: string, name: string, contactType?: string) {
  if (!name.trim()) return { match: null, suggestions: [], isExact: false };

  // Exact match
  const exact = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.displayName, name.trim())),
  });
  if (exact) return { match: exact, suggestions: [], isExact: true };

  // Case-insensitive
  const ciRows = await db.select().from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), ilike(contacts.displayName, escapeLike(name.trim()))))
    .limit(1);
  if (ciRows.length > 0) return { match: ciRows[0]!, suggestions: [], isExact: false };

  // Fuzzy — search for partial matches
  const fuzzyRows = await db.select().from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), ilike(contacts.displayName, `%${escapeLike(name.trim())}%`)))
    .limit(3);

  return { match: null, suggestions: fuzzyRows, isExact: false };
}

export async function resolveAccountByName(tenantId: string, name: string) {
  if (!name.trim()) return { match: null, suggestions: [], isExact: false };

  // Exact match by name
  const exact = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.name, name.trim())),
  });
  if (exact) return { match: exact, suggestions: [], isExact: true };

  // Exact match by account number
  const byNum = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, name.trim())),
  });
  if (byNum) return { match: byNum, suggestions: [], isExact: true };

  // Case-insensitive
  const ciRows = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), ilike(accounts.name, escapeLike(name.trim()))))
    .limit(1);
  if (ciRows.length > 0) return { match: ciRows[0]!, suggestions: [], isExact: false };

  // Fuzzy
  const fuzzyRows = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), ilike(accounts.name, `%${escapeLike(name.trim())}%`)))
    .limit(3);

  return { match: null, suggestions: fuzzyRows, isExact: false };
}

// ─── Account autofill for a selected contact ─────────────────────
// P&L (category) account types — the "Account" column on a batch line
// posts to one of these. Balance-sheet types (asset/liability/equity)
// are the cash / AR / AP / clearing side of the entry and must never be
// suggested as the category.
const CATEGORY_ACCOUNT_TYPES = ['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'];

export type SuggestedAccountSource = 'default' | 'recent';

// Suggest the category account to prefill when a contact is picked on a
// batch line: (1) the contact's configured default expense account, else
// (2) the most-recently-used category account from a prior transaction
// with that contact. Returns null when neither is available.
export async function suggestAccountForContact(
  tenantId: string,
  contactId: string,
): Promise<{ accountId: string | null; source: SuggestedAccountSource | null }> {
  if (!contactId) return { accountId: null, source: null };

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
  });
  if (!contact) return { accountId: null, source: null };

  // 1. Configured default wins.
  if (contact.defaultExpenseAccountId) {
    return { accountId: contact.defaultExpenseAccountId, source: 'default' };
  }

  // 2. Most recent category account posted on a transaction for this
  //    contact. Ordered by transaction date, then insertion order.
  const rows = await db
    .select({ accountId: journalLines.accountId })
    .from(transactions)
    .innerJoin(journalLines, eq(journalLines.transactionId, transactions.id))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.contactId, contactId),
      inArray(accounts.accountType, CATEGORY_ACCOUNT_TYPES),
      eq(accounts.isActive, true),
    ))
    .orderBy(desc(transactions.txnDate), desc(transactions.createdAt))
    .limit(1);

  return rows[0]?.accountId
    ? { accountId: rows[0].accountId, source: 'recent' }
    : { accountId: null, source: null };
}

// ─── Validation ──────────────────────────────────────────────────

interface BatchRow {
  rowNumber: number;
  date?: string;
  refNo?: string;
  contactName?: string;
  accountName?: string;
  memo?: string;
  amount?: number | string;
  debit?: number | string;
  credit?: number | string;
  description?: string;
  dueDate?: string;
  invoiceNo?: string;
  // ADR 0XX §4 / build-plan Phase 8 — per-row tag flows straight onto
  // the single split line this row produces. Optional; when absent the
  // service-layer default-tag resolver still gets a chance to fill it
  // from item/vendor/bank-rule sources.
  tagId?: string | null;
  // Picked in the grid — preferred over the name lookup when present.
  accountId?: string | null;
  contactId?: string | null;
}

// Types that post against the bank / credit-card account chosen at the
// top of the grid. Without it the create calls below would hit a
// null pay-from / deposit-to account.
const CONTEXT_ACCOUNT_TYPES = new Set(['expense', 'deposit', 'credit_card_charge', 'credit_card_credit', 'customer_payment']);

interface RowResult {
  rowNumber: number;
  status: 'valid' | 'invalid' | 'warning';
  resolvedContactId: string | null;
  resolvedAccountId: string | null;
  errors: Array<{ field: string; message: string }>;
  newContact?: { displayName: string; contactType: string };
}

export async function validateBatch(tenantId: string, txnType: string, contextAccountId: string | null, rows: BatchRow[]): Promise<{ validCount: number; invalidCount: number; rows: RowResult[] }> {
  const results: RowResult[] = [];
  let validCount = 0, invalidCount = 0;

  if (CONTEXT_ACCOUNT_TYPES.has(txnType) && !contextAccountId) {
    throw AppError.badRequest('Choose the bank or credit card account at the top of the batch first.');
  }

  // Validate context account exists (if required)
  if (contextAccountId) {
    const ctxAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, contextAccountId)),
    });
    if (!ctxAccount) throw AppError.badRequest('Context account not found');
  }

  for (const row of rows) {
    const errors: Array<{ field: string; message: string }> = [];
    let resolvedContactId: string | null = null;
    let resolvedAccountId: string | null = null;
    let newContact: { displayName: string; contactType: string } | undefined;

    // Date required
    if (!row.date) errors.push({ field: 'date', message: 'Date is required' });

    // Amount required (except JE which uses debit/credit)
    if (txnType !== 'journal_entry') {
      const amt = lenientDecimal(row.amount);
      if (!amt.greaterThan(0)) errors.push({ field: 'amount', message: 'Amount must be greater than 0' });
    } else {
      const d = lenientDecimal(row.debit);
      const c = lenientDecimal(row.credit);
      if (d.isZero() && c.isZero()) errors.push({ field: 'debit', message: 'Debit or credit is required' });
      if (d.greaterThan(0) && c.greaterThan(0)) errors.push({ field: 'debit', message: 'Cannot have both debit and credit' });
    }

    // Resolve account: the picked id first (tenant-scoped), else by name.
    if (row.accountId) {
      const picked = await db.query.accounts.findFirst({
        where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, row.accountId)),
      });
      if (picked) resolvedAccountId = picked.id;
      else errors.push({ field: 'account_name', message: 'Selected account was not found' });
    } else if (row.accountName) {
      const resolved = await resolveAccountByName(tenantId, row.accountName);
      if (resolved.match) {
        resolvedAccountId = resolved.match.id;
      } else if (resolved.suggestions.length > 0) {
        const suggestion = resolved.suggestions[0]!;
        errors.push({ field: 'account_name', message: `Account '${row.accountName}' not found. Did you mean '${suggestion.name}'?` });
      } else {
        errors.push({ field: 'account_name', message: `Account '${row.accountName}' not found` });
      }
    } else if (txnType !== 'customer_payment') {
      errors.push({ field: 'account_name', message: 'Account is required' });
    }

    // Resolve contact: the picked id first (tenant-scoped), else by name.
    if (row.contactId) {
      const picked = await db.query.contacts.findFirst({
        where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, row.contactId)),
      });
      if (picked) resolvedContactId = picked.id;
      else errors.push({ field: 'contact_name', message: 'Selected contact was not found' });
    } else if (row.contactName) {
      const contactTypeForResolve = ['invoice', 'credit_memo', 'customer_payment'].includes(txnType) ? 'customer' : 'vendor';
      const resolved = await resolveContactByName(tenantId, row.contactName, contactTypeForResolve);
      if (resolved.match) {
        resolvedContactId = resolved.match.id;
      } else {
        // Will auto-create
        newContact = { displayName: row.contactName, contactType: contactTypeForResolve };
      }
    } else if (['invoice', 'credit_memo', 'customer_payment'].includes(txnType)) {
      errors.push({ field: 'contact_name', message: 'Customer is required' });
    } else if (txnType === 'bill') {
      errors.push({ field: 'contact_name', message: 'Vendor is required' });
    }

    const status = errors.length > 0 ? 'invalid' : newContact ? 'warning' : 'valid';
    if (status === 'valid' || status === 'warning') validCount++;
    else invalidCount++;

    results.push({ rowNumber: row.rowNumber, status, resolvedContactId, resolvedAccountId, errors, newContact });
  }

  // JE balance validation per ref group: exact decimals, no tolerance
  // (U-71), the same rule the ledger applies when the entry posts (U-65).
  if (txnType === 'journal_entry') {
    const groups = new Map<string, { debits: DecimalValue; credits: DecimalValue; rowNumbers: number[] }>();
    for (const row of rows) {
      const key = `${row.date}|${row.refNo || row.rowNumber}`;
      if (!groups.has(key)) groups.set(key, { debits: new Decimal(0), credits: new Decimal(0), rowNumbers: [] });
      const g = groups.get(key)!;
      g.debits = g.debits.plus(lenientDecimal(row.debit));
      g.credits = g.credits.plus(lenientDecimal(row.credit));
      g.rowNumbers.push(row.rowNumber);
    }
    for (const [, group] of groups) {
      if (!group.debits.equals(group.credits)) {
        for (const rn of group.rowNumbers) {
          const r = results.find((r) => r.rowNumber === rn);
          if (r) {
            if (r.status !== 'invalid') { invalidCount++; validCount--; }
            r.status = 'invalid';
            r.errors.push({ field: 'debit', message: `Journal entry group does not balance: debits ${group.debits.toFixed(2)} != credits ${group.credits.toFixed(2)}` });
          }
        }
      }
    }
  }

  return { validCount: Math.max(0, validCount), invalidCount, rows: results };
}

// ─── Save ────────────────────────────────────────────────────────

export async function saveBatch(
  tenantId: string,
  txnType: string,
  contextAccountId: string | null,
  rows: BatchRow[],
  options: { autoCreateContacts?: boolean; skipInvalid?: boolean } = {},
  userId?: string,
  companyId?: string,
) {
  // Validate first
  const validation = await validateBatch(tenantId, txnType, contextAccountId, rows);

  if (!options.skipInvalid && validation.invalidCount > 0) {
    throw AppError.badRequest(`Batch has ${validation.invalidCount} invalid rows. Fix errors or enable skip_invalid.`);
  }

  const savedTxns: Array<{ id: string; txnNumber: string | null; rowNumber: number }> = [];
  const createdContacts: Array<{ displayName: string; id: string }> = [];

  // Process each valid row
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const vr = validation.rows[i]!;
    if (vr.status === 'invalid' && !options.skipInvalid) continue;
    if (vr.status === 'invalid' && options.skipInvalid) continue;

    let contactId = vr.resolvedContactId;
    const accountId = vr.resolvedAccountId;

    // Auto-create contact if needed
    if (!contactId && vr.newContact && options.autoCreateContacts) {
      const [newContact] = await db.insert(contacts).values({
        tenantId,
        contactType: vr.newContact.contactType as any,
        displayName: vr.newContact.displayName,
      }).returning();
      if (newContact) {
        contactId = newContact.id;
        createdContacts.push({ displayName: newContact.displayName, id: newContact.id });
      }
    }

    const amount = String(row.amount || '0');
    // Each service returns a different concrete transaction-record type;
    // they all share the `id` + `txnNumber` shape we read below. Use
    // the minimal contract so callers stay loosely coupled to the
    // service return signatures. `undefined` initial — not all switch
    // cases below assign, and the post-switch `if (txn)` skips unset
    // rows.
    let txn: { id: string; txnNumber: string | null } | undefined;

    switch (txnType) {
      case 'expense':
      case 'credit_card_charge':
        // Use the multi-line `lines[]` form so the per-row tag
        // round-trips — the single-line shortcut on CreateExpenseInput
        // does not carry a tagId field.
        txn = await expenseService.createExpense(tenantId, {
          txnDate: row.date!,
          // Ref No. column (check / receipt #) — was silently dropped.
          txnNumber: row.refNo?.trim() || undefined,
          contactId: contactId || undefined,
          payFromAccountId: contextAccountId!,
          lines: [{
            expenseAccountId: accountId!,
            amount,
            description: row.memo,
            tagId: row.tagId ?? null,
          }],
          memo: row.memo,
        }, userId, companyId);
        break;

      case 'deposit':
        txn = await depositService.createDeposit(tenantId, {
          txnDate: row.date!,
          depositToAccountId: contextAccountId!,
          // Deposits carry the payer per line; the Received From column
          // was previously dropped on save.
          lines: [{ accountId: accountId!, amount, description: row.memo, tagId: row.tagId ?? null, contactId: contactId || null }],
          memo: row.memo,
        }, userId, companyId);
        break;

      case 'credit_card_credit':
        // DR: CC account, CR: Expense account (reversal)
        txn = await ledger.postTransaction(tenantId, {
          txnType: 'customer_refund',
          txnDate: row.date!,
          contactId: contactId || undefined,
          memo: row.memo,
          total: amount,
          lines: [
            { accountId: contextAccountId!, debit: amount, credit: '0', tagId: row.tagId ?? null },
            { accountId: accountId!, debit: '0', credit: amount, tagId: row.tagId ?? null },
          ],
        }, userId, companyId);
        break;

      case 'invoice':
        txn = await invoiceService.createInvoice(tenantId, {
          txnDate: row.date!,
          contactId: contactId!,
          dueDate: row.dueDate,
          lines: [{
            accountId: accountId!,
            description: row.description || row.memo || undefined,
            quantity: '1',
            unitPrice: amount,
            tagId: row.tagId ?? null,
          }],
          memo: row.memo,
        }, userId, companyId);
        break;

      case 'bill':
        txn = await billService.createBill(tenantId, {
          contactId: contactId!,
          txnDate: row.date!,
          dueDate: row.dueDate,
          vendorInvoiceNumber: row.invoiceNo,
          memo: row.memo,
          lines: [{
            accountId: accountId!,
            description: row.description || row.memo || undefined,
            amount,
            tagId: row.tagId ?? null,
          }],
        }, userId, companyId);
        break;

      case 'credit_memo':
        txn = await creditMemoService.createCreditMemo(tenantId, {
          txnDate: row.date!,
          contactId: contactId!,
          lines: [{
            accountId: accountId!,
            description: row.description || row.memo || undefined,
            quantity: '1',
            unitPrice: amount,
            tagId: row.tagId ?? null,
          }],
          memo: row.memo,
        }, userId, companyId);
        break;

      case 'journal_entry':
        // Group handled separately below
        break;

      case 'customer_payment':
        // Find AR account
        const arAccount = await db.query.accounts.findFirst({
          where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')),
        });
        txn = await ledger.postTransaction(tenantId, {
          txnType: 'customer_payment',
          txnDate: row.date!,
          txnNumber: row.refNo?.trim() || undefined,
          contactId: contactId || undefined,
          memo: row.memo,
          total: amount,
          lines: [
            { accountId: contextAccountId!, debit: amount, credit: '0', tagId: row.tagId ?? null },
            { accountId: arAccount?.id || contextAccountId!, debit: '0', credit: amount, tagId: row.tagId ?? null },
          ],
        }, userId, companyId);
        break;
    }

    if (txn) {
      savedTxns.push({ id: txn.id, txnNumber: txn.txnNumber, rowNumber: row.rowNumber });
    }
  }

  // Handle journal entries grouped by date+refNo
  if (txnType === 'journal_entry') {
    const groups = new Map<string, BatchRow[]>();
    for (const row of rows) {
      const vr = validation.rows.find((r) => r.rowNumber === row.rowNumber);
      if (vr?.status === 'invalid') continue;
      const key = `${row.date}|${row.refNo || `auto-${row.rowNumber}`}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    for (const [, groupRows] of groups) {
      const lines = [];
      for (const row of groupRows) {
        const vr = validation.rows.find((r) => r.rowNumber === row.rowNumber);
        lines.push({
          accountId: vr?.resolvedAccountId || '',
          debit: String(row.debit || '0'),
          credit: String(row.credit || '0'),
          description: row.memo || row.description,
          tagId: row.tagId ?? null,
        });
      }

      // The batch JE grid has no name column: the A/R / A/P name rule
      // (U-58) is not applied to it.
      const txn = await journalEntryService.createJournalEntry(tenantId, {
        txnDate: groupRows[0]!.date!,
        memo: groupRows[0]!.memo,
        lines,
      }, userId, companyId, { arApNames: false });

      for (const row of groupRows) {
        savedTxns.push({ id: txn.id, txnNumber: txn.txnNumber, rowNumber: row.rowNumber });
      }
    }
  }

  // Audit log for batch
  await auditLog(tenantId, 'create', 'batch', null, null, {
    txnType,
    savedCount: new Set(savedTxns.map((t) => t.id)).size,
    createdContacts: createdContacts.length,
  }, userId);

  return {
    // Transactions, not rows: a journal entry's lines share one id.
    savedCount: new Set(savedTxns.map((t) => t.id)).size,
    skippedCount: rows.length - savedTxns.length,
    createdContacts,
    transactions: savedTxns,
  };
}

// ─── CSV Parsing ─────────────────────────────────────────────────

/**
 * Splits CSV text into records (RFC 4180): quoted fields may hold the
 * delimiter, doubled quotes and line breaks; CRLF, LF and CR all end a
 * record. A UTF-8 byte-order mark is dropped; blank records are skipped.
 * An unterminated quote is a 400 CSV_MALFORMED naming the record it starts
 * in. The delimiter is a tab when the header line has one, else a comma.
 */
export function parseCsvRecords(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let headerEnd = 0;
  for (let q = false; headerEnd < src.length; headerEnd++) {
    const ch = src[headerEnd];
    if (ch === '"') q = !q;
    else if (!q && (ch === '\n' || ch === '\r')) break;
  }
  const delim = src.slice(0, headerEnd).includes('\t') ? '\t' : ',';

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let quoteStartRecord = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      quoteStartRecord = records.length + 1;
    } else if (ch === delim) {
      record.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field.trim());
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw AppError.badRequest(
      `The CSV file has a quoted field that never ends (it starts on line ${quoteStartRecord} of the file's records).`,
      'CSV_MALFORMED',
    );
  }
  if (field !== '' || record.length > 0) {
    record.push(field.trim());
    records.push(record);
  }
  return records.filter((r) => r.some((f) => f !== ''));
}

export function parseCsv(csvText: string, txnType: string, columnMapping?: Record<string, number>): BatchRow[] {
  const records = parseCsvRecords(csvText);
  if (records.length < 2) throw AppError.badRequest('The CSV file needs a header row and at least one data row.', 'CSV_EMPTY');
  if (records.length - 1 > BATCH_MAX_ROWS) {
    throw AppError.badRequest(
      `The CSV file has ${records.length - 1} data rows; a batch can have at most ${BATCH_MAX_ROWS}. Split the file and import it in parts.`,
      'CSV_TOO_MANY_ROWS',
    );
  }

  const headers = records[0]!.map((h) => h.toLowerCase());

  // Auto-map columns if no mapping provided
  const mapping = columnMapping || autoMapColumns(headers, txnType);

  const rows: BatchRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const cols = records[i]!;

    const getCol = (key: string) => {
      const idx = mapping[key];
      return idx !== undefined ? cols[idx] : undefined;
    };

    rows.push({
      rowNumber: i,
      date: normalizeDate(getCol('date') || ''),
      refNo: getCol('ref_no') || getCol('ref') || undefined,
      contactName: getCol('payee') || getCol('customer') || getCol('contact') || getCol('received_from') || getCol('name') || undefined,
      accountName: getCol('account') || getCol('category') || undefined,
      memo: getCol('memo') || getCol('description') || undefined,
      amount: parseAmount(getCol('amount')),
      debit: parseAmount(getCol('debit')),
      credit: parseAmount(getCol('credit')),
      description: getCol('description') || undefined,
      dueDate: normalizeDate(getCol('due_date') || ''),
      invoiceNo: getCol('invoice_no') || getCol('invoice') || undefined,
    });
  }

  return rows;
}

function autoMapColumns(headers: string[], txnType: string): Record<string, number> {
  const mapping: Record<string, number> = {};
  const aliases: Record<string, string[]> = {
    date: ['date', 'txn_date', 'transaction date', 'trans date', 'posted date'],
    ref_no: ['ref', 'ref no', 'ref_no', 'reference', 'check no', 'check #', 'num'],
    payee: ['payee', 'vendor', 'paid to', 'name', 'customer', 'received from'],
    account: ['account', 'category', 'expense account', 'revenue account', 'gl account'],
    memo: ['memo', 'description', 'note', 'notes', 'detail'],
    amount: ['amount', 'total', 'payment', 'deposit', 'charge'],
    debit: ['debit', 'dr'],
    credit: ['credit', 'cr'],
    due_date: ['due date', 'due_date'],
    invoice_no: ['invoice', 'invoice no', 'invoice_no', 'inv #'],
  };

  for (const [key, names] of Object.entries(aliases)) {
    for (let i = 0; i < headers.length; i++) {
      if (names.includes(headers[i]!)) {
        mapping[key] = i;
        break;
      }
    }
  }

  return mapping;
}

function normalizeDate(raw: string): string {
  if (!raw) return '';
  // Try ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // Try MM/DD/YYYY
  const mdy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1]!.padStart(2, '0')}-${mdy[2]!.padStart(2, '0')}`;
  // Try YYYY/MM/DD
  const ymd = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2]!.padStart(2, '0')}-${ymd[3]!.padStart(2, '0')}`;
  return raw;
}

/**
 * A CSV amount as an exact decimal STRING (U-73), never a float: currency
 * signs, thousands separators and spaces dropped, "(12.50)" and "12.50-"
 * become "-12.50", ".5" becomes "0.5", the digits otherwise as written. No
 * rounding: a third decimal stays for the client to round (Q-232). An empty
 * cell is undefined; text that is not a number comes back trimmed, as it
 * was, so row validation names it.
 */
export function parseAmount(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  let cleaned = text.replace(/[$£€,\s]/g, '');
  let negative = false;
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) { negative = true; cleaned = cleaned.slice(1, -1); }
  if (cleaned.endsWith('-')) { negative = !negative; cleaned = cleaned.slice(0, -1); }
  if (cleaned.startsWith('-')) { negative = !negative; cleaned = cleaned.slice(1); }
  else if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return text;
  const [intPart = '', frac = ''] = cleaned.split('.');
  const int = intPart.replace(/^0+(?=\d)/, '') || '0';
  const value = frac ? `${int}.${frac}` : int;
  return negative && !/^0(\.0*)?$/.test(value) ? `-${value}` : value;
}
