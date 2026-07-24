// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Generic Excel/CSV import adapter. Unlike the vendor adapters (which decode a
// specific product's export quirks), this one reads OUR documented templates
// (see generic-columns.ts) — fixed, human-friendly headers in the first row.
// It emits the same canonical row shapes as the other adapters so the shared
// validate/commit pipeline is unchanged.
//
// The transaction template is single-row / signed-amount: each row is ONE
// transaction with an Account, an Offset Account, and a signed Amount. A
// positive Amount debits the Account and credits the Offset; a negative Amount
// credits the Account (as its absolute value) and debits the Offset. Each row
// becomes a balanced two-line journal entry. A per-row Tag is carried on both
// lines and auto-created at commit time.

import {
  type AccountType,
  type CanonicalCoaRow,
  type CanonicalContactRow,
  type CanonicalGlEntry,
  type CanonicalGlLine,
  type CanonicalTrialBalanceRow,
  type ContactKind,
  type ImportValidationError,
} from '@kis-books/shared';
import { parseCsvText, parseXlsxBuffer } from '../../payroll-parse.service.js';
import { ACCOUNT_TYPE_VALUES } from './generic-columns.js';

// ── Shared helpers ────────────────────────────────────────────────

/** Read the upload as a string grid — .xlsx by magic bytes, else CSV (UTF-8). */
async function readGrid(buf: Buffer): Promise<string[][]> {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return parseXlsxBuffer(buf);
  return parseCsvText(buf.toString('utf8').replace(/^﻿/, ''));
}

/** Exact-equals (case- and whitespace-insensitive) column lookup. */
function colOf(header: string[], label: string): number {
  const target = label.trim().toLowerCase();
  return header.findIndex((c) => (c ?? '').trim().toLowerCase() === target);
}

/** Find the first row that contains every required header label. */
function findHeaderRow(grid: string[][], required: readonly string[]): number {
  const lowered = required.map((s) => s.toLowerCase());
  for (let i = 0; i < grid.length; i++) {
    const cells = (grid[i] ?? []).map((c) => (c ?? '').trim().toLowerCase());
    if (lowered.every((needle) => cells.includes(needle))) return i;
  }
  return -1;
}

function headerNotFound(cols: string): ImportValidationError {
  return {
    rowNumber: 0,
    code: 'IMPORT_HEADER_NOT_FOUND',
    message: `Could not find the expected header row (need columns: ${cols}). Download the sample template and keep the header row intact.`,
  };
}

/** MM/DD/YYYY, M/D/YY, or already-ISO → YYYY-MM-DD. Null on failure. */
function toIsoDate(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [, mm, dd, yy] = m;
    const y = yy!.length === 2 ? `20${yy}` : yy;
    return `${y}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
  }
  return null;
}

/** Parse a signed amount ("1,051.07", "-250.00", "(250.00)", "") → number. */
function parseAmount(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).replace(/[$,\s]/g, '').trim();
  if (s === '' || s === '-') return null;
  // Accounting-style parentheses = negative.
  if (/^\(.*\)$/.test(s)) s = `-${s.slice(1, -1)}`;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve an account cell to a canonical reference. The user may type EITHER
 * an account number or an account name in the same cell. A value that starts
 * with a digit is offered as both a number and a name (covers plain "1000" and
 * coded "1000-A"); a value that starts with a letter is a name only (keeps the
 * preview clean for the common case). commit tries the number first, then the
 * name, so either input resolves to the right account.
 */
function accountRef(cell: string): { accountNumber?: string; accountName?: string } {
  const s = (cell ?? '').trim();
  if (!s) return {};
  if (/^\d/.test(s)) return { accountNumber: s, accountName: s };
  return { accountName: s };
}

// ── Chart of Accounts ─────────────────────────────────────────────

export async function parseCoa(buf: Buffer): Promise<{ rows: CanonicalCoaRow[]; errors: ImportValidationError[] }> {
  const rows: CanonicalCoaRow[] = [];
  const errors: ImportValidationError[] = [];
  const grid = await readGrid(buf);
  const h = findHeaderRow(grid, ['Account Name', 'Account Type']);
  if (h === -1) return { rows, errors: [headerNotFound('Account Name, Account Type')] };

  const header = grid[h]!;
  const iNum = colOf(header, 'Account Number');
  const iName = colOf(header, 'Account Name');
  const iType = colOf(header, 'Account Type');
  const iDetail = colOf(header, 'Detail Type');
  const iDesc = colOf(header, 'Description');
  const iParent = colOf(header, 'Parent Account Number');

  const validTypes = new Set<string>(ACCOUNT_TYPE_VALUES);
  const synonyms: Record<string, AccountType> = {
    income: 'revenue',
    'other income': 'other_revenue',
    'cost of goods sold': 'cogs',
    'fixed asset': 'asset',
    'bank': 'asset',
    'accounts receivable': 'asset',
    'accounts payable': 'liability',
    'credit card': 'liability',
    'long term liability': 'liability',
    'other expense': 'other_expense',
  };

  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const name = (r[iName] ?? '').trim();
    if (!name) continue;
    const typeRaw = (r[iType] ?? '').trim().toLowerCase();
    if (!typeRaw) {
      errors.push({ rowNumber, field: 'Account Type', code: 'IMPORT_MISSING_FIELD', message: `Account "${name}" is missing an Account Type.` });
      continue;
    }
    const accountType = (validTypes.has(typeRaw) ? typeRaw : synonyms[typeRaw]) as AccountType | undefined;
    if (!accountType) {
      errors.push({
        rowNumber, field: 'Account Type', code: 'IMPORT_UNKNOWN_TYPE',
        message: `Unknown Account Type "${(r[iType] ?? '').trim()}". Use one of: ${ACCOUNT_TYPE_VALUES.join(', ')}.`,
      });
      continue;
    }
    const accountNumber = iNum !== -1 ? (r[iNum] ?? '').trim() : '';
    const detailType = iDetail !== -1 ? (r[iDetail] ?? '').trim() : '';
    const description = iDesc !== -1 ? (r[iDesc] ?? '').trim() : '';
    const parentNumber = iParent !== -1 ? (r[iParent] ?? '').trim() : '';
    rows.push({
      rowNumber,
      name,
      accountType,
      ...(accountNumber ? { accountNumber } : {}),
      ...(detailType ? { detailType } : {}),
      ...(description ? { description } : {}),
      ...(parentNumber ? { parentNumber } : {}),
    });
  }
  return { rows, errors };
}

// ── Contacts ──────────────────────────────────────────────────────

export async function parseContacts(
  buf: Buffer,
  fallbackKind?: ContactKind,
): Promise<{ rows: CanonicalContactRow[]; errors: ImportValidationError[] }> {
  const rows: CanonicalContactRow[] = [];
  const errors: ImportValidationError[] = [];
  const grid = await readGrid(buf);
  const h = findHeaderRow(grid, ['Display Name']);
  if (h === -1) return { rows, errors: [headerNotFound('Display Name')] };

  const header = grid[h]!;
  const iName = colOf(header, 'Display Name');
  const iType = colOf(header, 'Type');
  const iEmail = colOf(header, 'Email');
  const iPhone = colOf(header, 'Phone');
  const iCompany = colOf(header, 'Company Name');
  const iAddr = colOf(header, 'Billing Address');
  const iExpense = colOf(header, 'Default Expense Account');

  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const displayName = (r[iName] ?? '').trim();
    if (!displayName) continue;

    const typeRaw = (iType !== -1 ? (r[iType] ?? '').trim().toLowerCase() : '');
    let contactType: ContactKind | undefined;
    if (typeRaw === 'customer' || typeRaw === 'vendor') contactType = typeRaw;
    else if (typeRaw === 'both' || typeRaw === '') contactType = fallbackKind;
    if (!contactType) {
      errors.push({
        rowNumber, field: 'Type', code: 'IMPORT_MISSING_FIELD',
        message: `Contact "${displayName}" needs a Type of "customer" or "vendor".`,
      });
      continue;
    }
    rows.push({
      rowNumber,
      displayName,
      contactType,
      ...(iEmail !== -1 && (r[iEmail] ?? '').trim() ? { email: (r[iEmail] ?? '').trim() } : {}),
      ...(iPhone !== -1 && (r[iPhone] ?? '').trim() ? { phone: (r[iPhone] ?? '').trim() } : {}),
      ...(iCompany !== -1 && (r[iCompany] ?? '').trim() ? { fullName: (r[iCompany] ?? '').trim() } : {}),
      ...(iAddr !== -1 && (r[iAddr] ?? '').trim() ? { billingAddress: (r[iAddr] ?? '').trim() } : {}),
      ...(iExpense !== -1 && (r[iExpense] ?? '').trim() ? { defaultExpenseAccountRaw: (r[iExpense] ?? '').trim() } : {}),
    });
  }
  return { rows, errors };
}

// ── Trial Balance ─────────────────────────────────────────────────

export async function parseTrialBalance(buf: Buffer): Promise<{
  rows: CanonicalTrialBalanceRow[];
  errors: ImportValidationError[];
}> {
  const rows: CanonicalTrialBalanceRow[] = [];
  const errors: ImportValidationError[] = [];
  const grid = await readGrid(buf);
  // Either Account Number or Account Name must be present, plus Debit/Credit.
  const h = findHeaderRow(grid, ['Debit', 'Credit']);
  if (h === -1) return { rows, errors: [headerNotFound('Account Name (or Account Number), Debit, Credit')] };

  const header = grid[h]!;
  const iNum = colOf(header, 'Account Number');
  const iName = colOf(header, 'Account Name');
  const iDeb = colOf(header, 'Debit');
  const iCred = colOf(header, 'Credit');

  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const accountNumber = iNum !== -1 ? (r[iNum] ?? '').trim() : '';
    const accountName = iName !== -1 ? (r[iName] ?? '').trim() : '';
    if (!accountNumber && !accountName) continue;
    if (/^total\b/i.test(accountName) || /^total\b/i.test(accountNumber)) continue;
    const debit = parseAmount(r[iDeb]) ?? 0;
    const credit = parseAmount(r[iCred]) ?? 0;
    if (debit === 0 && credit === 0) continue;
    rows.push({
      rowNumber,
      ...(accountNumber ? { accountNumber } : {}),
      ...(accountName ? { accountName } : {}),
      ...(debit !== 0 ? { debit: String(debit) } : {}),
      ...(credit !== 0 ? { credit: String(credit) } : {}),
    });
  }
  return { rows, errors };
}

// ── Transactions (single-row, signed amount) ──────────────────────

export async function parseGl(buf: Buffer): Promise<{ entries: CanonicalGlEntry[]; errors: ImportValidationError[] }> {
  const entries: CanonicalGlEntry[] = [];
  const errors: ImportValidationError[] = [];
  const grid = await readGrid(buf);
  const h = findHeaderRow(grid, ['Date', 'Account', 'Amount', 'Offset Account']);
  if (h === -1) return { entries, errors: [headerNotFound('Date, Account, Amount, Offset Account')] };

  const header = grid[h]!;
  const iDate = colOf(header, 'Date');
  const iAccount = colOf(header, 'Account');
  const iAmount = colOf(header, 'Amount');
  const iOffset = colOf(header, 'Offset Account');
  const iDesc = colOf(header, 'Description');
  const iName = colOf(header, 'Name');
  const iRef = colOf(header, 'Reference');
  const iTag = colOf(header, 'Tag');

  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const accountCell = (r[iAccount] ?? '').trim();
    const offsetCell = (r[iOffset] ?? '').trim();
    const amountRaw = r[iAmount];
    const dateCell = (r[iDate] ?? '').trim();

    // Skip fully-blank rows silently.
    if (!accountCell && !offsetCell && !dateCell && (amountRaw ?? '') === '') continue;

    const date = toIsoDate(dateCell);
    if (!date) {
      errors.push({ rowNumber, field: 'Date', code: 'IMPORT_BAD_DATE', message: `Row ${rowNumber}: could not parse Date "${dateCell}".` });
      continue;
    }
    const amount = parseAmount(amountRaw);
    if (amount == null || amount === 0) {
      errors.push({ rowNumber, field: 'Amount', code: 'IMPORT_BAD_AMOUNT', message: `Row ${rowNumber}: Amount must be a non-zero number.` });
      continue;
    }
    if (!accountCell) {
      errors.push({ rowNumber, field: 'Account', code: 'IMPORT_MISSING_FIELD', message: `Row ${rowNumber}: Account is required.` });
      continue;
    }
    if (!offsetCell) {
      errors.push({ rowNumber, field: 'Offset Account', code: 'IMPORT_MISSING_FIELD', message: `Row ${rowNumber}: Offset Account is required.` });
      continue;
    }

    const abs = Math.abs(amount).toFixed(2);
    const account = accountRef(accountCell);
    const offset = accountRef(offsetCell);
    const tagName = iTag !== -1 ? (r[iTag] ?? '').trim() || undefined : undefined;

    // Positive → debit Account / credit Offset. Negative → credit Account / debit Offset.
    const accountLine: CanonicalGlLine =
      amount >= 0
        ? { ...account, debit: abs, credit: '0', ...(tagName ? { tagName } : {}) }
        : { ...account, debit: '0', credit: abs, ...(tagName ? { tagName } : {}) };
    const offsetLine: CanonicalGlLine =
      amount >= 0
        ? { ...offset, debit: '0', credit: abs, ...(tagName ? { tagName } : {}) }
        : { ...offset, debit: abs, credit: '0', ...(tagName ? { tagName } : {}) };

    const description = iDesc !== -1 ? (r[iDesc] ?? '').trim() : '';
    const name = iName !== -1 ? (r[iName] ?? '').trim() : '';
    const reference = iRef !== -1 ? (r[iRef] ?? '').trim() : '';

    entries.push({
      rowNumber,
      date,
      transactionType: 'Transaction',
      sourceCode: 'GEN',
      ...(reference ? { reference } : {}),
      ...(name ? { name } : {}),
      ...(description ? { memo: description } : {}),
      lines: [accountLine, offsetLine],
    });
  }
  return { entries, errors };
}
