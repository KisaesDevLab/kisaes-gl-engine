// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Grouped batch entry (U-67–U-74): `{ groups: [{ txn_type,
// context_account_id, rows }] }`, validated together and saved in ONE
// database transaction. Any failing row rolls back every posting, every
// auto-created contact and every check-number advance of the request.
//
//   - amounts are exact decimal strings (Decimal, no tolerance, no
//     rounding: the client rounds to the cent before sending);
//   - accounts, contacts and tags resolve inside the tenant AND company
//     scope (company_id NULL or the active company);
//   - rows dated on or before the company's closing date need the
//     closing-date password (or the staff confirmation where the single
//     forms accept it): 423 / 403 carry the row numbers;
//   - check rows post through createCheck (number unique per bank account,
//     counter advanced, print later), deposit and card-credit rows through
//     the deposit service, expense and card-charge rows through the
//     expense service, journal entry groups through createJournalEntry
//     with the A/R / A/P name rule;
//   - every transaction is marked source 'batch', source_id = batchId;
//   - an Idempotency-Key replays the stored result of the same body and
//     refuses a different body (409), scoped by tenant and company.

import crypto from 'crypto';
import DecimalLib from 'decimal.js';
import { and, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { BatchGroupRow, BatchGroupTxnType, CreateJournalEntryInput, WriteCheckInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { accounts, batchSaveRequests, contacts, tags, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { escapeLike } from '../utils/sql-like.js';
import * as ledger from './ledger.service.js';
import * as checkService from './check.service.js';
import * as expenseService from './expense.service.js';
import * as depositService from './deposit.service.js';
import * as journalEntryService from './journal-entry.service.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

const MONEY_RE = /^-?\d{1,15}(\.\d{1,4})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHECK_NUMBER_RE = /^\d{1,9}$/;
const REF_MAX: Record<BatchGroupTxnType, number> = {
  check: 9, expense: 50, credit_card_charge: 50, credit_card_credit: 50, deposit: 50, journal_entry: 20,
};

export interface BatchGroup {
  txn_type: BatchGroupTxnType;
  context_account_id?: string | null;
  rows: BatchGroupRow[];
}

export interface RowError { field: string; message: string; code?: string }

export interface GroupRowResult {
  rowNumber: number;
  groupIndex: number;
  txnType: BatchGroupTxnType;
  status: 'valid' | 'invalid' | 'warning';
  resolvedContactId: string | null;
  resolvedAccountId: string | null;
  errors: RowError[];
  /** A name that matches no contact; created on save with auto_create_contacts. */
  newContact?: { displayName: string; contactType: 'vendor' | 'customer' };
  /** Dated on or before the closing date: saving it needs the closing-date password. */
  closedPeriod: boolean;
  /** journal_entry rows: the entry (group of rows) this row belongs to. */
  entryKey?: string;
}

export interface GroupValidation {
  validCount: number;
  invalidCount: number;
  closingDate: string | null;
  closingPasswordRequired: boolean;
  closedPeriodRowNumbers: number[];
  rows: GroupRowResult[];
}

/** Category account per row; contact defaults to auto-create per row type. */
const CONTACT_TYPE: Record<BatchGroupTxnType, 'vendor' | 'customer' | null> = {
  check: 'vendor', expense: 'vendor', credit_card_charge: 'vendor', credit_card_credit: 'vendor',
  deposit: 'customer', journal_entry: null,
};

/** Context account type each group posts against. */
const CONTEXT_TYPES: Record<Exclude<BatchGroupTxnType, 'journal_entry'>, string[]> = {
  check: ['asset'],
  deposit: ['asset'],
  expense: ['asset', 'liability'],
  credit_card_charge: ['liability'],
  credit_card_credit: ['liability'],
};

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function parseMoney(raw: string | undefined, field: string, errors: RowError[]): DecimalValue | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (!MONEY_RE.test(s)) {
    errors.push({ field, message: `${field} must be a decimal amount with at most 4 decimal places`, code: 'VALIDATION_ERROR' });
    return null;
  }
  return new Decimal(s);
}

function inScope<T extends { companyId: string | null }>(companyId: string) {
  return (r: T) => r.companyId === null || r.companyId === companyId;
}

// Per-request lookup caches: a 10,000-row paste names the same few accounts
// and payees over and over.
class Resolver {
  private accountsById = new Map<string, { id: string; accountType: string } | null>();
  private accountsByName = new Map<string, { id: string; accountType: string } | null>();
  private contactsById = new Map<string, { id: string; displayName: string } | null>();
  private contactsByName = new Map<string, { id: string; displayName: string } | null>();
  private tagsById = new Map<string, boolean>();

  constructor(private ex: DbOrTx, private tenantId: string, private companyId: string) {}

  private accountScope() {
    return and(eq(accounts.tenantId, this.tenantId), or(isNull(accounts.companyId), eq(accounts.companyId, this.companyId)));
  }

  private contactScope() {
    return and(eq(contacts.tenantId, this.tenantId), or(isNull(contacts.companyId), eq(contacts.companyId, this.companyId)));
  }

  async accountById(id: string) {
    if (!this.accountsById.has(id)) {
      const [row] = await this.ex.select({ id: accounts.id, accountType: accounts.accountType }).from(accounts)
        .where(and(this.accountScope(), eq(accounts.id, id))).limit(1);
      this.accountsById.set(id, row ?? null);
    }
    return this.accountsById.get(id)!;
  }

  /** Exact name, exact account number, then case-insensitive name. */
  async accountByName(name: string) {
    const key = name.trim();
    if (!this.accountsByName.has(key)) {
      const cols = { id: accounts.id, accountType: accounts.accountType };
      let [row] = await this.ex.select(cols).from(accounts).where(and(this.accountScope(), eq(accounts.name, key))).limit(1);
      if (!row) [row] = await this.ex.select(cols).from(accounts).where(and(this.accountScope(), eq(accounts.accountNumber, key))).limit(1);
      if (!row) [row] = await this.ex.select(cols).from(accounts).where(and(this.accountScope(), ilike(accounts.name, escapeLike(key)))).limit(1);
      this.accountsByName.set(key, row ?? null);
    }
    return this.accountsByName.get(key)!;
  }

  async contactById(id: string) {
    if (!this.contactsById.has(id)) {
      const [row] = await this.ex.select({ id: contacts.id, displayName: contacts.displayName }).from(contacts)
        .where(and(this.contactScope(), eq(contacts.id, id))).limit(1);
      this.contactsById.set(id, row ?? null);
    }
    return this.contactsById.get(id)!;
  }

  /**
   * Exact display name, then case-insensitive; a contact of the row's type
   * (or 'both') wins over one of another type, so a vendor and a customer
   * sharing a name resolve to the vendor on a check and the customer on a
   * deposit.
   */
  async contactByName(name: string, preferred: 'vendor' | 'customer' | null) {
    const key = `${preferred ?? '*'}|${name.trim()}`;
    if (!this.contactsByName.has(key)) {
      const cols = { id: contacts.id, displayName: contacts.displayName, contactType: contacts.contactType };
      const exact = await this.ex.select(cols).from(contacts)
        .where(and(this.contactScope(), eq(contacts.displayName, name.trim()))).limit(20);
      const pool = exact.length > 0 ? exact : await this.ex.select(cols).from(contacts)
        .where(and(this.contactScope(), ilike(contacts.displayName, escapeLike(name.trim())))).limit(20);
      const typed = preferred ? pool.find((c) => c.contactType === preferred || c.contactType === 'both') : undefined;
      const hit = typed ?? pool[0];
      this.contactsByName.set(key, hit ? { id: hit.id, displayName: hit.displayName } : null);
    }
    return this.contactsByName.get(key)!;
  }

  async tagInScope(id: string) {
    if (!this.tagsById.has(id)) {
      const [row] = await this.ex.select({ id: tags.id, companyId: tags.companyId }).from(tags)
        .where(and(eq(tags.tenantId, this.tenantId), eq(tags.id, id))).limit(1);
      this.tagsById.set(id, !!row && inScope(this.companyId)(row));
    }
    return this.tagsById.get(id)!;
  }
}

/** What the save posts for one row, worked out by validation. */
interface PlannedRow {
  row: BatchGroupRow;
  result: GroupRowResult;
  amount: DecimalValue | null;
  debit: DecimalValue | null;
  credit: DecimalValue | null;
  contactName: string | null;
  checkNumber: number | null;
}

interface PlannedGroup {
  group: BatchGroup;
  groupIndex: number;
  rows: PlannedRow[];
}

async function readClosingDate(ex: DbOrTx, tenantId: string, companyId: string) {
  const res = await ex.execute(sql`
    SELECT to_char(lock_date, 'YYYY-MM-DD') AS lock_date, closing_password_hash IS NOT NULL AS password_set
    FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId}
  `);
  const row = (res.rows as Array<{ lock_date: string | null; password_set: boolean }>)[0];
  return { lockDate: row?.lock_date ?? null, passwordSet: row?.password_set === true };
}

function jeEntryKey(row: BatchGroupRow): string {
  if (row.entry) return `entry:${row.entry}`;
  if (row.refNo?.trim()) return `ref:${row.date ?? ''}|${row.refNo.trim()}`;
  return `row:${row.rowNumber}`;
}

async function validateContextAccount(resolver: Resolver, group: BatchGroup, groupIndex: number) {
  if (group.txn_type === 'journal_entry') {
    if (group.context_account_id) {
      throw new AppError(400, 'A journal entry group has no context account', 'BATCH_CONTEXT_ACCOUNT_INVALID', { groupIndex });
    }
    return;
  }
  if (!group.context_account_id) {
    throw new AppError(400, 'Choose the bank or credit card account for this group first.', 'BATCH_CONTEXT_ACCOUNT_REQUIRED', { groupIndex });
  }
  const acct = await resolver.accountById(group.context_account_id);
  if (!acct) {
    throw new AppError(400, 'The bank or credit card account was not found in this company', 'BATCH_CONTEXT_ACCOUNT_INVALID', { groupIndex });
  }
  if (!CONTEXT_TYPES[group.txn_type].includes(acct.accountType)) {
    throw new AppError(400, `This account can't be used for ${group.txn_type.replace(/_/g, ' ')} rows`, 'BATCH_CONTEXT_ACCOUNT_INVALID', { groupIndex });
  }
}

/**
 * Validates every row of every group (no writes). Group-level problems (a
 * missing or wrong context account) are a 400 naming the group; row
 * problems are listed per row.
 */
async function planGroups(
  ex: DbOrTx, tenantId: string, companyId: string, groups: BatchGroup[],
): Promise<{ validation: GroupValidation; planned: PlannedGroup[] }> {
  const resolver = new Resolver(ex, tenantId, companyId);
  const { lockDate, passwordSet } = await readClosingDate(ex, tenantId, companyId);
  const planned: PlannedGroup[] = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;
    await validateContextAccount(resolver, group, gi);
    const type = group.txn_type;
    const pg: PlannedGroup = { group, groupIndex: gi, rows: [] };

    for (const row of group.rows) {
      const errors: RowError[] = [];
      const result: GroupRowResult = {
        rowNumber: row.rowNumber, groupIndex: gi, txnType: type, status: 'valid',
        resolvedContactId: null, resolvedAccountId: null, errors, closedPeriod: false,
      };

      // Date
      if (!row.date) errors.push({ field: 'date', message: 'Date is required' });
      else if (!isValidDate(row.date)) errors.push({ field: 'date', message: 'Date must be a valid YYYY-MM-DD date' });
      else if (lockDate && row.date <= lockDate) result.closedPeriod = true;

      // Amounts
      let amount: DecimalValue | null = null;
      let debit: DecimalValue | null = null;
      let credit: DecimalValue | null = null;
      if (type === 'journal_entry') {
        if (row.amount !== undefined) errors.push({ field: 'amount', message: 'Journal entry rows take a debit or a credit, not an amount' });
        debit = parseMoney(row.debit, 'debit', errors);
        credit = parseMoney(row.credit, 'credit', errors);
        const d = debit && !debit.isZero();
        const c = credit && !credit.isZero();
        if (!d && !c && !errors.some((e) => e.field === 'debit' || e.field === 'credit')) {
          errors.push({ field: 'debit', message: 'Debit or credit is required' });
        }
        if (d && c) errors.push({ field: 'debit', message: 'Cannot have both debit and credit' });
      } else {
        if (row.debit !== undefined || row.credit !== undefined) {
          errors.push({ field: 'debit', message: 'Only journal entry rows take a debit or a credit; use amount' });
        }
        if (row.amount === undefined) errors.push({ field: 'amount', message: 'Amount is required' });
        amount = parseMoney(row.amount, 'amount', errors);
        if (amount && !amount.greaterThan(0)) errors.push({ field: 'amount', message: 'Amount must be greater than 0' });
      }

      // Reference / check number
      const ref = row.refNo?.trim() ?? '';
      let checkNumber: number | null = null;
      if (type === 'check') {
        if (row.printLater && ref) {
          errors.push({ field: 'ref_no', message: 'A check to print later gets its number when it prints; leave the number empty' });
        } else if (ref) {
          if (!CHECK_NUMBER_RE.test(ref) || Number(ref) < 1) {
            errors.push({ field: 'ref_no', message: 'The check number must be a whole number of 1 or more' });
          } else {
            checkNumber = Number(ref);
          }
        }
      } else {
        if (row.printLater !== undefined) errors.push({ field: 'print_later', message: 'Only check rows can be printed later' });
        if (ref.length > REF_MAX[type]) errors.push({ field: 'ref_no', message: `The reference number can be at most ${REF_MAX[type]} characters` });
      }
      if (type !== 'journal_entry' && row.entry !== undefined) {
        errors.push({ field: 'entry', message: 'Only journal entry rows take an entry key' });
      }

      // Account
      if (row.accountId) {
        const acct = await resolver.accountById(row.accountId);
        if (acct) result.resolvedAccountId = acct.id;
        else errors.push({ field: 'account_name', message: 'Selected account was not found in this company' });
      } else if (row.accountName?.trim()) {
        const acct = await resolver.accountByName(row.accountName);
        if (acct) result.resolvedAccountId = acct.id;
        else errors.push({ field: 'account_name', message: `Account '${row.accountName.trim()}' not found` });
      } else {
        errors.push({ field: 'account_name', message: 'Account is required' });
      }
      if (result.resolvedAccountId && result.resolvedAccountId === group.context_account_id) {
        errors.push({ field: 'account_name', message: 'The account must differ from the bank or card account of the group' });
      }

      // Contact
      let contactName: string | null = null;
      const preferred = CONTACT_TYPE[type];
      if (row.contactId) {
        const c = await resolver.contactById(row.contactId);
        if (c) { result.resolvedContactId = c.id; contactName = c.displayName; }
        else errors.push({ field: 'contact_name', message: 'Selected name was not found in this company' });
      } else if (row.contactName?.trim()) {
        const c = await resolver.contactByName(row.contactName, preferred);
        if (c) { result.resolvedContactId = c.id; contactName = c.displayName; }
        else if (preferred) {
          contactName = row.contactName.trim();
          result.newContact = { displayName: contactName, contactType: preferred };
        } else {
          errors.push({ field: 'contact_name', message: `Name '${row.contactName.trim()}' not found` });
        }
      }
      if (type === 'check' && row.printLater && !contactName) {
        errors.push({ field: 'contact_name', message: 'A check to print later needs a payee' });
      }

      // Tag
      if (row.tagId && !(await resolver.tagInScope(row.tagId))) {
        errors.push({ field: 'tag', message: 'Tag not found in this company' });
      }

      if (type === 'journal_entry') result.entryKey = jeEntryKey(row);
      pg.rows.push({ row, result, amount, debit, credit, contactName, checkNumber });
    }
    planned.push(pg);
  }

  await checkCheckNumbers(ex, tenantId, planned);
  await checkJournalEntries(ex, tenantId, companyId, planned);

  const rows: GroupRowResult[] = [];
  let validCount = 0;
  let invalidCount = 0;
  for (const pg of planned) {
    for (const pr of pg.rows) {
      const r = pr.result;
      r.status = r.errors.length > 0 ? 'invalid' : r.newContact ? 'warning' : 'valid';
      if (r.status === 'invalid') invalidCount++; else validCount++;
      rows.push(r);
    }
  }
  const closedPeriodRowNumbers = rows.filter((r) => r.closedPeriod).map((r) => r.rowNumber);
  return {
    validation: { validCount, invalidCount, closingDate: lockDate, closingPasswordRequired: passwordSet, closedPeriodRowNumbers, rows },
    planned,
  };
}

/** Check numbers: unique per bank account, in the batch and in the books. */
async function checkCheckNumbers(ex: DbOrTx, tenantId: string, planned: PlannedGroup[]) {
  const byBank = new Map<string, PlannedRow[]>();
  for (const pg of planned) {
    if (pg.group.txn_type !== 'check') continue;
    const bank = pg.group.context_account_id!;
    const list = byBank.get(bank) ?? [];
    list.push(...pg.rows.filter((r) => r.checkNumber !== null));
    byBank.set(bank, list);
  }
  for (const [bank, rows] of byBank) {
    if (rows.length === 0) continue;
    const seen = new Map<number, number>();
    for (const r of rows) {
      const first = seen.get(r.checkNumber!);
      if (first !== undefined) {
        r.result.errors.push({ field: 'ref_no', message: `Check #${r.checkNumber} is also on row ${first}`, code: 'CHECK_NUMBER_DUPLICATE' });
      } else {
        seen.set(r.checkNumber!, r.row.rowNumber);
      }
    }
    const numbers = [...seen.keys()];
    const taken = new Set<number>();
    for (let i = 0; i < numbers.length; i += 1000) {
      const chunk = numbers.slice(i, i + 1000);
      const res = await ex.execute(sql`
        SELECT DISTINCT t.check_number FROM transactions t
        JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.account_id = ${bank}
        WHERE t.tenant_id = ${tenantId}
          AND t.check_number IN (${sql.join(chunk.map((n) => sql`${n}`), sql`, `)})
          AND t.status NOT IN ('void', 'deleted')
      `);
      for (const row of res.rows as Array<{ check_number: number }>) taken.add(Number(row.check_number));
    }
    for (const r of rows) {
      if (taken.has(r.checkNumber!)) {
        r.result.errors.push({ field: 'ref_no', message: `Check #${r.checkNumber} already exists on this bank account`, code: 'CHECK_NUMBER_DUPLICATE' });
      }
    }
  }
}

/** Journal entries: same date per entry, at least two rows, exact balance, A/R-A/P names. */
async function checkJournalEntries(ex: DbOrTx, tenantId: string, companyId: string, planned: PlannedGroup[]) {
  for (const pg of planned) {
    if (pg.group.txn_type !== 'journal_entry') continue;
    for (const entry of jeEntries(pg).values()) {
      const fail = (message: string, code?: string) => {
        for (const r of entry) r.result.errors.push({ field: 'debit', message, ...(code ? { code } : {}) });
      };
      const dates = new Set(entry.map((r) => r.row.date));
      if (dates.size > 1) { fail('Every row of a journal entry must have the same date'); continue; }
      if (entry.length < 2) { fail('A journal entry needs at least two rows (give them the same entry key or ref no.)'); continue; }
      const refs = new Set(entry.map((r) => r.row.refNo?.trim() ?? ''));
      if (refs.size > 1) { fail('Every row of a journal entry must have the same ref no.'); continue; }
      // Exact balance only when every amount parsed.
      if (entry.some((r) => r.result.errors.some((e) => e.field === 'debit' || e.field === 'credit'))) continue;
      const debits = entry.reduce((s, r) => s.plus(r.debit ?? 0), new Decimal(0));
      const credits = entry.reduce((s, r) => s.plus(r.credit ?? 0), new Decimal(0));
      if (!debits.equals(credits)) {
        fail(`Journal entry does not balance: debits ${debits.toFixed(2)} != credits ${credits.toFixed(2)}`, 'TXN_UNBALANCED');
        continue;
      }
      if (entry.some((r) => !r.result.resolvedAccountId)) continue;
      try {
        await journalEntryService.assertJournalEntryNames(ex, tenantId, companyId, entry.map((r) => ({
          accountId: r.result.resolvedAccountId!, contactId: r.result.resolvedContactId,
        })));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        fail(err.message.replace(/^Line \d+ /, 'A row '), err.code);
      }
    }
  }
}

function jeEntries(pg: PlannedGroup): Map<string, PlannedRow[]> {
  const entries = new Map<string, PlannedRow[]>();
  for (const pr of pg.rows) {
    const key = pr.result.entryKey!;
    const list = entries.get(key) ?? [];
    list.push(pr);
    entries.set(key, list);
  }
  return entries;
}

/** POST /batch/validate (grouped shape): read-only. */
export async function validateBatchGroups(tenantId: string, companyId: string, groups: BatchGroup[]): Promise<GroupValidation> {
  return (await planGroups(db, tenantId, companyId, groups)).validation;
}

// ─── Save ────────────────────────────────────────────────────────

export interface SavedTxn {
  rowNumber: number;
  id: string;
  txnType: BatchGroupTxnType;
  txnNumber: string | null;
  checkNumber?: number | null;
}

export interface BatchSaveResult {
  batchId: string;
  savedCount: number;
  createdContacts: Array<{ displayName: string; id: string; contactType: string }>;
  transactions: SavedTxn[];
}

/** Re-throws a posting failure with the row numbers it belongs to. */
function rowFailure(err: unknown, rowNumbers: number[]): unknown {
  if (!(err instanceof AppError)) return err;
  const errors = [{ field: 'row', message: err.message, ...(err.code ? { code: err.code } : {}) }];
  return new AppError(err.statusCode, `Row ${rowNumbers.join(', ')}: ${err.message}`, err.code ?? 'BATCH_ROW_FAILED', {
    ...(err.details ?? {}),
    rowNumbers,
    rows: rowNumbers.map((rowNumber) => ({ rowNumber, errors })),
  });
}

async function postGroups(
  tx: Tx, tenantId: string, companyId: string, planned: PlannedGroup[], batchId: string,
  autoCreateContacts: boolean, userId?: string,
): Promise<BatchSaveResult> {
  const saved: SavedTxn[] = [];
  const createdContacts: BatchSaveResult['createdContacts'] = [];
  const created = new Map<string, string>();

  const contactFor = async (pr: PlannedRow): Promise<string | null> => {
    if (pr.result.resolvedContactId) return pr.result.resolvedContactId;
    const nc = pr.result.newContact;
    if (!nc || !autoCreateContacts) return null;
    const key = `${nc.contactType}|${nc.displayName.toLowerCase()}`;
    const known = created.get(key);
    if (known) return known;
    // Tenant-wide (company_id NULL), as POST /contacts creates them.
    const [row] = await tx.insert(contacts).values({
      tenantId, contactType: nc.contactType, displayName: nc.displayName,
    }).returning({ id: contacts.id, displayName: contacts.displayName });
    if (!row) throw AppError.internal('Failed to create contact');
    await auditLog(tenantId, 'create', 'contact', row.id, null, {
      displayName: row.displayName, contactType: nc.contactType, source: 'batch', batchId,
    }, userId, tx);
    created.set(key, row.id);
    createdContacts.push({ displayName: row.displayName, id: row.id, contactType: nc.contactType });
    return row.id;
  };

  for (const pg of planned) {
    const type = pg.group.txn_type;
    const ctxAccount = pg.group.context_account_id ?? '';

    if (type === 'journal_entry') {
      for (const entry of jeEntries(pg).values()) {
        const rowNumbers = entry.map((r) => r.row.rowNumber);
        try {
          const first = entry[0]!.row;
          const lines = [];
          for (const pr of entry) {
            lines.push({
              accountId: pr.result.resolvedAccountId!,
              debit: (pr.debit ?? new Decimal(0)).toFixed(4),
              credit: (pr.credit ?? new Decimal(0)).toFixed(4),
              description: pr.row.description ?? pr.row.memo,
              tagId: pr.row.tagId ?? null,
              contactId: await contactFor(pr),
            });
          }
          const input = {
            txnDate: first.date!,
            ...(first.refNo?.trim() ? { txnNumber: first.refNo.trim() } : {}),
            memo: first.memo,
            basis: 'both',
            lines,
          } as CreateJournalEntryInput;
          const txn = await journalEntryService.createJournalEntry(tenantId, input, userId, companyId, {}, tx);
          for (const n of rowNumbers) saved.push({ rowNumber: n, id: txn.id, txnType: type, txnNumber: txn.txnNumber ?? null });
        } catch (err) {
          throw rowFailure(err, rowNumbers);
        }
      }
      continue;
    }

    for (const pr of pg.rows) {
      const row = pr.row;
      try {
        const contactId = await contactFor(pr);
        const amount = pr.amount!.toFixed(4);
        const accountId = pr.result.resolvedAccountId!;
        const ref = row.refNo?.trim() || undefined;
        let posted: SavedTxn;
        switch (type) {
          case 'check': {
            const input = {
              bankAccountId: ctxAccount,
              contactId: contactId ?? undefined,
              ...(pr.contactName ? { payeeNameOnCheck: pr.contactName } : {}),
              txnDate: row.date!,
              amount,
              memo: row.memo,
              printLater: row.printLater === true,
              checkNumber: pr.checkNumber ?? undefined,
              lines: [{ accountId, amount, description: row.description ?? row.memo, tagId: row.tagId ?? null }],
            } as WriteCheckInput;
            const t = await checkService.createCheck(tenantId, input, userId, companyId, tx);
            posted = { rowNumber: row.rowNumber, id: t.id, txnType: type, txnNumber: t.txnNumber ?? null, checkNumber: t.checkNumber };
            break;
          }
          case 'expense':
          case 'credit_card_charge': {
            const t = await expenseService.createExpense(tenantId, {
              txnDate: row.date!,
              txnNumber: ref,
              contactId: contactId ?? undefined,
              payFromAccountId: ctxAccount,
              lines: [{ expenseAccountId: accountId, amount, description: row.description ?? row.memo, tagId: row.tagId ?? null }],
              memo: row.memo,
            }, userId, companyId, tx);
            posted = { rowNumber: row.rowNumber, id: t.id, txnType: type, txnNumber: t.txnNumber ?? null };
            break;
          }
          case 'deposit':
          case 'credit_card_credit': {
            // A card credit is a deposit into the card account: DR card, CR
            // the category (the same posting as Record Card Credit).
            const { transaction: t } = await depositService.createDepositWithWarnings(tenantId, {
              txnDate: row.date!,
              depositToAccountId: ctxAccount,
              lines: [{ accountId, amount, description: row.description ?? row.memo, tagId: row.tagId ?? null, contactId }],
              memo: row.memo,
              strictAmounts: true,
            }, userId, companyId, tx);
            if (ref) {
              await tx.update(transactions).set({ txnNumber: ref })
                .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, t.id)));
            }
            posted = { rowNumber: row.rowNumber, id: t.id, txnType: type, txnNumber: ref ?? t.txnNumber ?? null };
            break;
          }
        }
        saved.push(posted);
      } catch (err) {
        throw rowFailure(err, [row.rowNumber]);
      }
    }
  }

  // Provenance: every transaction of the batch is source 'batch' + batchId.
  const ids = [...new Set(saved.map((s) => s.id))];
  for (let i = 0; i < ids.length; i += 1000) {
    await tx.update(transactions).set({ source: 'batch', sourceId: batchId })
      .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, ids.slice(i, i + 1000))));
  }

  await auditLog(tenantId, 'create', 'batch', batchId, null, {
    groups: planned.map((pg) => ({ txnType: pg.group.txn_type, rows: pg.rows.length })),
    savedCount: ids.length,
    createdContacts: createdContacts.length,
  }, userId, tx);

  return { batchId, savedCount: ids.length, createdContacts, transactions: saved };
}

// ─── Idempotency-Key ─────────────────────────────────────────────

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
/** Replay records older than this are pruned when the company saves a batch. */
const IDEMPOTENCY_RETENTION_DAYS = 30;

export function assertIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw AppError.badRequest('Idempotency-Key must be 1 to 255 visible ASCII characters', 'IDEMPOTENCY_KEY_INVALID');
  }
}

export interface SaveOutcome { status: number; body: unknown; replayed: boolean }

/**
 * POST /batch/save (grouped shape). One database transaction: validation,
 * the closing-date check, every posting, the provenance marks, the audit
 * rows and the Idempotency-Key record commit together or not at all.
 */
export async function saveBatchGroups(
  tenantId: string,
  companyId: string,
  body: { groups: BatchGroup[]; auto_create_contacts?: boolean; overrideConfirmed?: boolean },
  opts: { userId?: string; idempotencyKey?: string } = {},
): Promise<SaveOutcome> {
  const key = opts.idempotencyKey;
  if (key !== undefined) assertIdempotencyKey(key);
  const requestSha256 = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

  return db.transaction(async (tx) => {
    if (key !== undefined) {
      // Same key at the same time: the second waits for the first, then
      // replays its committed result.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`batch-save:${tenantId}:${companyId}:${key}`}, 0))`);
      const [prev] = await tx.select().from(batchSaveRequests).where(and(
        eq(batchSaveRequests.tenantId, tenantId),
        eq(batchSaveRequests.companyId, companyId),
        eq(batchSaveRequests.idempotencyKey, key),
      )).limit(1);
      if (prev) {
        if (prev.requestSha256 !== requestSha256) {
          throw AppError.conflict('This Idempotency-Key was already used for a different batch', 'IDEMPOTENCY_KEY_REUSED', { batchId: prev.batchId });
        }
        return { status: prev.responseStatus, body: prev.responseBody, replayed: true };
      }
    }

    const { validation, planned } = await planGroups(tx, tenantId, companyId, body.groups);
    if (validation.invalidCount > 0) {
      const bad = validation.rows.filter((r) => r.status === 'invalid');
      throw new AppError(400, `Batch has ${bad.length} invalid row(s); nothing was saved.`, 'BATCH_INVALID', {
        rowNumbers: bad.map((r) => r.rowNumber),
        rows: bad.map((r) => ({ rowNumber: r.rowNumber, errors: r.errors })),
      });
    }
    if (!body.auto_create_contacts) {
      const unknown = validation.rows.filter((r) => r.newContact);
      if (unknown.length > 0) {
        throw new AppError(400, `${unknown.length} row(s) name a payee that does not exist; nothing was saved.`, 'BATCH_CONTACT_NOT_FOUND', {
          rowNumbers: unknown.map((r) => r.rowNumber),
          rows: unknown.map((r) => ({
            rowNumber: r.rowNumber,
            errors: [{ field: 'contact_name', message: `Name '${r.newContact!.displayName}' not found` }],
          })),
        });
      }
    }

    // Closed period: one check up front so the refusal lists every row
    // dated on or before the closing date. The postings check again (and
    // audit each permitted override); the password is compared once.
    const locked = validation.closedPeriodRowNumbers;
    if (locked.length > 0) {
      const firstDate = validation.rows.find((r) => r.closedPeriod)!;
      const date = planned.flatMap((p) => p.rows).find((p) => p.row.rowNumber === firstDate.rowNumber)!.row.date!;
      try {
        await ledger.checkLockDate(tx, tenantId, date, companyId, undefined, { deferAudit: true });
      } catch (err) {
        if (err instanceof AppError) {
          throw new AppError(err.statusCode, err.message, err.code, { ...(err.details ?? {}), rowNumbers: locked });
        }
        throw err;
      }
    }

    const batchId = crypto.randomUUID();
    const result = await postGroups(tx, tenantId, companyId, planned, batchId, body.auto_create_contacts === true, opts.userId);

    if (key !== undefined) {
      await tx.insert(batchSaveRequests).values({
        tenantId, companyId, idempotencyKey: key, requestSha256, batchId,
        responseStatus: 201, responseBody: result, userId: opts.userId ?? null,
      });
      await tx.delete(batchSaveRequests).where(and(
        eq(batchSaveRequests.tenantId, tenantId),
        lt(batchSaveRequests.createdAt, sql`now() - make_interval(days => ${IDEMPOTENCY_RETENTION_DAYS})`),
      ));
    }
    return { status: 201, body: result, replayed: false };
  });
}
