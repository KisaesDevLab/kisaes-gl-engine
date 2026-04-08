import { eq, and, sql, ilike } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { accounts, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as expenseService from './expense.service.js';
import * as depositService from './deposit.service.js';
import * as invoiceService from './invoice.service.js';
import * as creditMemoService from './credit-memo.service.js';
import * as journalEntryService from './journal-entry.service.js';
import * as ledger from './ledger.service.js';
import * as billService from './bill.service.js';

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
    .where(and(eq(contacts.tenantId, tenantId), ilike(contacts.displayName, name.trim())))
    .limit(1);
  if (ciRows.length > 0) return { match: ciRows[0]!, suggestions: [], isExact: false };

  // Fuzzy — search for partial matches
  const fuzzyRows = await db.select().from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), ilike(contacts.displayName, `%${name.trim()}%`)))
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
    .where(and(eq(accounts.tenantId, tenantId), ilike(accounts.name, name.trim())))
    .limit(1);
  if (ciRows.length > 0) return { match: ciRows[0]!, suggestions: [], isExact: false };

  // Fuzzy
  const fuzzyRows = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), ilike(accounts.name, `%${name.trim()}%`)))
    .limit(3);

  return { match: null, suggestions: fuzzyRows, isExact: false };
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
}

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
      const amt = parseFloat(String(row.amount || '0'));
      if (!amt || amt <= 0) errors.push({ field: 'amount', message: 'Amount must be greater than 0' });
    } else {
      const d = parseFloat(String(row.debit || '0'));
      const c = parseFloat(String(row.credit || '0'));
      if (d === 0 && c === 0) errors.push({ field: 'debit', message: 'Debit or credit is required' });
      if (d > 0 && c > 0) errors.push({ field: 'debit', message: 'Cannot have both debit and credit' });
    }

    // Resolve account name
    if (row.accountName) {
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

    // Resolve contact name
    if (row.contactName) {
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

  // JE balance validation per ref group
  if (txnType === 'journal_entry') {
    const groups = new Map<string, { debits: number; credits: number; rowNumbers: number[] }>();
    for (const row of rows) {
      const key = `${row.date}|${row.refNo || row.rowNumber}`;
      if (!groups.has(key)) groups.set(key, { debits: 0, credits: 0, rowNumbers: [] });
      const g = groups.get(key)!;
      g.debits += parseFloat(String(row.debit || '0'));
      g.credits += parseFloat(String(row.credit || '0'));
      g.rowNumbers.push(row.rowNumber);
    }
    for (const [, group] of groups) {
      if (Math.abs(group.debits - group.credits) > 0.01) {
        for (const rn of group.rowNumbers) {
          const r = results.find((r) => r.rowNumber === rn);
          if (r) {
            r.status = 'invalid';
            r.errors.push({ field: 'debit', message: `Journal entry group does not balance: debits ${group.debits.toFixed(2)} != credits ${group.credits.toFixed(2)}` });
            invalidCount++;
            validCount--;
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
    let txn: any;

    switch (txnType) {
      case 'expense':
      case 'credit_card_charge':
        txn = await expenseService.createExpense(tenantId, {
          txnDate: row.date!,
          contactId: contactId || undefined,
          payFromAccountId: contextAccountId!,
          expenseAccountId: accountId!,
          amount,
          memo: row.memo,
        }, userId);
        break;

      case 'deposit':
        txn = await depositService.createDeposit(tenantId, {
          txnDate: row.date!,
          depositToAccountId: contextAccountId!,
          lines: [{ accountId: accountId!, amount, description: row.memo }],
          memo: row.memo,
        }, userId);
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
            { accountId: contextAccountId!, debit: amount, credit: '0' },
            { accountId: accountId!, debit: '0', credit: amount },
          ],
        }, userId);
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
          }],
          memo: row.memo,
        }, userId);
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
          }],
        }, userId);
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
          }],
          memo: row.memo,
        }, userId);
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
          contactId: contactId || undefined,
          memo: row.memo,
          total: amount,
          lines: [
            { accountId: contextAccountId!, debit: amount, credit: '0' },
            { accountId: arAccount?.id || contextAccountId!, debit: '0', credit: amount },
          ],
        }, userId);
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
        });
      }

      const txn = await journalEntryService.createJournalEntry(tenantId, {
        txnDate: groupRows[0]!.date!,
        memo: groupRows[0]!.memo,
        lines,
      }, userId);

      for (const row of groupRows) {
        savedTxns.push({ id: txn.id, txnNumber: txn.txnNumber, rowNumber: row.rowNumber });
      }
    }
  }

  // Audit log for batch
  await auditLog(tenantId, 'create', 'batch', null, null, {
    txnType,
    savedCount: savedTxns.length,
    createdContacts: createdContacts.length,
  }, userId);

  return {
    savedCount: savedTxns.length,
    skippedCount: rows.length - savedTxns.length,
    createdContacts,
    transactions: savedTxns,
  };
}

// ─── CSV Parsing ─────────────────────────────────────────────────

// Parse a single CSV line respecting quoted fields
function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

export function parseCsv(csvText: string, txnType: string, columnMapping?: Record<string, number>): BatchRow[] {
  const lines = csvText.split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw AppError.badRequest('CSV must have header + data rows');

  // Auto-detect delimiter
  const firstLine = lines[0]!;
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const headers = parseCsvLine(firstLine, delimiter).map((h) => h.toLowerCase());

  // Auto-map columns if no mapping provided
  const mapping = columnMapping || autoMapColumns(headers, txnType);

  const rows: BatchRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!, delimiter);

    const getCol = (key: string) => {
      const idx = mapping[key];
      return idx !== undefined ? cols[idx] : undefined;
    };

    const amountRaw = getCol('amount') || '0';
    const amount = parseAmount(amountRaw);

    rows.push({
      rowNumber: i,
      date: normalizeDate(getCol('date') || ''),
      refNo: getCol('ref_no') || getCol('ref') || undefined,
      contactName: getCol('payee') || getCol('customer') || getCol('contact') || getCol('received_from') || getCol('name') || undefined,
      accountName: getCol('account') || getCol('category') || undefined,
      memo: getCol('memo') || getCol('description') || undefined,
      amount,
      debit: parseAmount(getCol('debit') || '0'),
      credit: parseAmount(getCol('credit') || '0'),
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

function parseAmount(raw: string): number {
  if (!raw) return 0;
  // Remove currency symbols, commas, whitespace
  const cleaned = raw.replace(/[$£€,\s]/g, '');
  // Handle parentheses for negatives: (500.00) → -500.00
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    return -parseFloat(cleaned.slice(1, -1));
  }
  return parseFloat(cleaned) || 0;
}
