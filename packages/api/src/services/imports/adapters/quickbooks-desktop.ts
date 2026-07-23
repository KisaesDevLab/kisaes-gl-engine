// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// QuickBooks Desktop CSV adapters. QB Desktop's list/report CSV exports
// differ from QuickBooks Online in three ways this adapter handles:
//
//   1. Encoding is ISO-8859-1 (Latin-1), NOT UTF-8. The account cell's
//      number/name separator is a MIDDLE DOT (byte 0xB7 → U+00B7 "·").
//      Decoding as UTF-8 corrupts it to the replacement char; we decode
//      as latin1 so the separator (and any accented vendor names) survive.
//   2. Accounts are written "<number> · <name>" in one cell (the Journal
//      and Trial Balance); the Account List additionally has a clean
//      "Accnt. #" column. splitQbdAccount() peels the number off the name.
//   3. The Journal groups a transaction across several rows keyed by a
//      "Trans #" column: a header/first-leg row (carries Type/Date/Num),
//      continuation leg rows (leading columns blank), then a per-txn
//      subtotal row (blank Account, equal Debit+Credit) that closes it —
//      plus a trailing grand "TOTAL" row. parseGl() is the state machine.
//
// Each parser emits the same canonical row shapes as the QBO / Accounting
// Power adapters so the shared validate/commit pipeline is unchanged.

import {
  QBD_TYPE_TEXT_MAP,
  QBD_TXN_TYPE_LABELS,
  QBD_COA_HEADER_REQUIRED,
  QBD_GL_HEADER_REQUIRED,
  type CanonicalCoaRow,
  type CanonicalContactRow,
  type CanonicalGlEntry,
  type CanonicalGlLine,
  type CanonicalTrialBalanceRow,
  type ContactKind,
  type ImportValidationError,
} from '@kis-books/shared';
import { parseCsvText } from '../../payroll-parse.service.js';

// ── Shared helpers ────────────────────────────────────────────────

/**
 * Decode the upload buffer as Latin-1 (ISO-8859-1), which is how QB
 * Desktop writes its CSV exports. This is lossless for the 0xB7 middle-dot
 * account separator and for Windows-1252/Latin-1 accented names, both of
 * which a UTF-8 decode would mangle into replacement characters. Strips a
 * BOM if one is present.
 */
function bufferToText(buf: Buffer): string {
  return buf.toString('latin1').replace(/^﻿/, '');
}

/** Exact-equals (case- and whitespace-insensitive) column lookup. */
function colOf(header: string[], label: string): number {
  const target = label.trim().toLowerCase();
  return header.findIndex((c) => (c ?? '').trim().toLowerCase() === target);
}

/**
 * Find the first row whose cells contain every required label (exact,
 * case-insensitive). QB Desktop reports carry a preamble (report title,
 * "As of" date, blank rows) above the real header, so we scan for it
 * rather than assuming row 0. Returns -1 when no row matches.
 */
function findHeaderRow(grid: string[][], required: readonly string[]): number {
  const lowered = required.map((s) => s.toLowerCase());
  for (let i = 0; i < grid.length; i++) {
    const cells = (grid[i] ?? []).map((c) => (c ?? '').trim().toLowerCase());
    if (lowered.every((needle) => cells.includes(needle))) return i;
  }
  return -1;
}

/** Convert MM/DD/YYYY (or M/D/YY) → ISO YYYY-MM-DD. Returns null on failure. */
function toIsoDate(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [, mm, dd, yy] = m;
    const y = yy!.length === 2 ? `20${yy}` : yy;
    return `${y}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
  }
  // QB Desktop report headers phrase dates as "Dec 31, 25" / "December 31, 2025".
  const named = trimmed.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (named) {
    const mon = MONTHS[named[1]!.slice(0, 3).toLowerCase()];
    if (mon) {
      const y = named[3]!.length === 2 ? `20${named[3]}` : named[3];
      return `${y}-${mon}-${named[2]!.padStart(2, '0')}`;
    }
  }
  return null;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Parse a QB amount ("1,051.07", "0.00", "-2,500.00", "") → decimal string. */
function toDecimal(raw: string | undefined): string {
  if (!raw) return '0';
  const cleaned = raw.replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return '0';
  return cleaned;
}

/**
 * Split a QB Desktop account cell "<number> · <name>" into its parts.
 * The separator is a middle-dot (U+00B7); we also tolerate the UTF-8
 * replacement char (in case a caller decoded as UTF-8) and a colon.
 * A cell that is only a name yields just the name; a cell that is only a
 * number yields just the number. Resolution downstream prefers the number,
 * falling back to the name, so either alone still matches the chart.
 */
export function splitQbdAccount(raw: string): { accountNumber?: string; accountName?: string } {
  const s = (raw ?? '').trim();
  if (!s) return {};
  const m = s.match(/^#?(\d[\d.]*)\s*[··�:]\s*(.+)$/);
  if (m) return { accountNumber: m[1], accountName: m[2]!.trim() };
  const numOnly = s.match(/^#?(\d[\d.]*)$/);
  if (numOnly) return { accountNumber: numOnly[1] };
  return { accountName: s };
}

/** A header-signature check that fails fast on a wrong-file upload. */
function requireHeader(actual: string[], expected: readonly string[]): ImportValidationError | null {
  for (const col of expected) {
    if (!actual.some((c) => (c ?? '').trim().toLowerCase() === col.toLowerCase())) {
      return {
        rowNumber: 1,
        code: 'IMPORT_HEADER_NOT_FOUND',
        message: `Required column "${col}" not found. This does not look like a QuickBooks Desktop export.`,
      };
    }
  }
  return null;
}

// ── Chart of Accounts (Account List export) ───────────────────────
//
// QB Desktop "Account Listing" CSV: a leading blank (indent) column then
//   Account | Type | Balance Total | Description | Accnt. # | Tax Line
// where Account is "<number> · <name>" and "Accnt. #" is the bare number.

export function parseCoa(buf: Buffer): { rows: CanonicalCoaRow[]; errors: ImportValidationError[] } {
  const rows: CanonicalCoaRow[] = [];
  const errors: ImportValidationError[] = [];
  const grid = parseCsvText(bufferToText(buf));
  const headerRowIdx = findHeaderRow(grid, QBD_COA_HEADER_REQUIRED);
  if (headerRowIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Could not locate the Account List header (expected columns: Account, Type).',
    });
    return { rows, errors };
  }
  const header = grid[headerRowIdx]!;
  const headerErr = requireHeader(header, QBD_COA_HEADER_REQUIRED);
  if (headerErr) {
    errors.push(headerErr);
    return { rows, errors };
  }
  const iAcct = colOf(header, 'Account');
  const iType = colOf(header, 'Type');
  const iNum = colOf(header, 'Accnt. #');
  const iDesc = colOf(header, 'Description');

  for (let i = headerRowIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const acctCell = (r[iAcct] ?? '').trim();
    const typeText = (r[iType] ?? '').trim();
    if (!acctCell || /^total\b/i.test(acctCell)) continue; // subtotal/footer

    const split = splitQbdAccount(acctCell);
    // Prefer the explicit "Accnt. #" column; fall back to the number
    // peeled off the Account cell.
    const accountNumber = (iNum !== -1 ? (r[iNum] ?? '').trim() : '') || split.accountNumber || undefined;
    const name = split.accountName || acctCell;
    if (!typeText) continue; // header/section rows carry no type

    const accountType = QBD_TYPE_TEXT_MAP[typeText.toLowerCase()];
    if (!accountType) {
      errors.push({
        rowNumber,
        field: 'Type',
        code: 'IMPORT_UNKNOWN_TYPE',
        message: `Unknown QuickBooks Desktop account Type "${typeText}". Map it manually or extend QBD_TYPE_TEXT_MAP.`,
      });
      continue;
    }
    const description = iDesc !== -1 ? (r[iDesc] ?? '').trim() || undefined : undefined;
    rows.push({
      rowNumber,
      name,
      accountType,
      description,
      ...(accountNumber ? { accountNumber } : {}),
    });
  }
  if (rows.length === 0 && errors.length === 0 && grid.length > headerRowIdx + 1) {
    errors.push({
      rowNumber: headerRowIdx + 1,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'No account rows were recognized in the Account List.',
    });
  }
  return { rows, errors };
}

// ── Contacts (Vendor List / Customer List export) ─────────────────
//
// QB Desktop "Vendor Contact List" CSV: a leading blank column then
//   Active Status | Vendor | Balance | Balance Total | Company | ... |
//   First Name | ... | Last Name | Bill from 1..5 | ... | Main Phone | ...
// The name column is "Vendor" (or "Customer" on the customer list).

export function parseContacts(
  buf: Buffer,
  kind: ContactKind,
): { rows: CanonicalContactRow[]; errors: ImportValidationError[] } {
  const rows: CanonicalContactRow[] = [];
  const errors: ImportValidationError[] = [];
  const grid = parseCsvText(bufferToText(buf));
  const nameLabel = kind === 'customer' ? 'Customer' : 'Vendor';
  const headerRowIdx = findHeaderRow(grid, [nameLabel]);
  if (headerRowIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: `Could not find a "${nameLabel}" column. Did you upload the right QuickBooks Desktop list?`,
    });
    return { rows, errors };
  }
  const header = grid[headerRowIdx]!;
  const iName = colOf(header, nameLabel);
  const iCompany = colOf(header, 'Company');
  const iPhone = colOf(header, 'Main Phone') !== -1 ? colOf(header, 'Main Phone') : colOf(header, 'Phone');
  const iEmail = colOf(header, 'Main Email') !== -1 ? colOf(header, 'Main Email') : colOf(header, 'Email');
  const iBill1 = colOf(header, 'Bill from 1');
  const iActive = colOf(header, 'Active Status');

  for (let i = headerRowIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const displayName = (r[iName] ?? '').trim();
    if (!displayName || /^total\b/i.test(displayName)) continue;
    // QB Desktop lists can include inactive rows; skip explicit inactives.
    if (iActive !== -1 && /^inactive$/i.test((r[iActive] ?? '').trim())) continue;
    rows.push({
      rowNumber,
      displayName,
      contactType: kind,
      fullName: iCompany !== -1 ? (r[iCompany] ?? '').trim() || undefined : undefined,
      phone: iPhone !== -1 ? (r[iPhone] ?? '').trim() || undefined : undefined,
      email: iEmail !== -1 ? (r[iEmail] ?? '').trim() || undefined : undefined,
      billingAddress: iBill1 !== -1 ? (r[iBill1] ?? '').trim() || undefined : undefined,
    });
  }
  return { rows, errors };
}

// ── Trial Balance export ──────────────────────────────────────────
//
// QB Desktop "Trial Balance" CSV: preamble rows (report title, "As of"
// date such as "Dec 31, 25"), then a Debit/Credit header, then account
// rows "<number> · <name>" with a Debit or Credit amount, closing with a
// TOTAL row.

const AS_OF_DATE_RE = /([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4})/;

export function parseTrialBalance(buf: Buffer): {
  rows: CanonicalTrialBalanceRow[];
  errors: ImportValidationError[];
  reportDate: string | null;
} {
  const rows: CanonicalTrialBalanceRow[] = [];
  const errors: ImportValidationError[] = [];
  const grid = parseCsvText(bufferToText(buf));

  const headerRowIdx = findHeaderRow(grid, ['Debit', 'Credit']);
  if (headerRowIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Could not find Debit/Credit columns. Did you upload the right file?',
    });
    return { rows, errors, reportDate: null };
  }

  // Scrape the "as of" date from the preamble above the header.
  let reportDate: string | null = null;
  for (let i = 0; i < headerRowIdx; i++) {
    for (const cell of grid[i] ?? []) {
      const m = (cell ?? '').match(AS_OF_DATE_RE);
      if (m) {
        const iso = toIsoDate(m[1]!);
        if (iso) {
          reportDate = iso;
          break;
        }
      }
    }
    if (reportDate) break;
  }

  const header = grid[headerRowIdx]!;
  const iDeb = colOf(header, 'Debit');
  const iCred = colOf(header, 'Credit');
  // The account column is the first non-blank header cell left of Debit;
  // in QB Desktop's TB that's the leading column (index 0).
  let iAcct = -1;
  for (let c = iDeb - 1; c >= 0; c--) {
    if ((header[c] ?? '').trim() !== '') {
      iAcct = c;
      break;
    }
  }
  if (iAcct === -1) iAcct = 0;

  for (let i = headerRowIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const acctCell = (r[iAcct] ?? '').trim();
    if (!acctCell || /^total\b/i.test(acctCell)) continue;
    const debit = toDecimal(r[iDeb]);
    const credit = toDecimal(r[iCred]);
    if (Number(debit) === 0 && Number(credit) === 0) continue; // zero balances contribute nothing
    const split = splitQbdAccount(acctCell);
    rows.push({
      rowNumber,
      accountNumber: split.accountNumber,
      accountName: split.accountName || acctCell,
      ...(Number(debit) !== 0 ? { debit } : {}),
      ...(Number(credit) !== 0 ? { credit } : {}),
    });
  }
  return { rows, errors, reportDate };
}

// ── GL Transactions (Journal export) ──────────────────────────────

interface QbdLegRaw {
  rowNumber: number;
  name: string;
  memo: string;
  account: string;
  debit: string;
  credit: string;
}

interface QbdGroup {
  rowNumber: number;
  type: string;
  date: string;
  num: string;
  name: string;
  legs: QbdLegRaw[];
}

export function parseGl(buf: Buffer): { entries: CanonicalGlEntry[]; errors: ImportValidationError[] } {
  const entries: CanonicalGlEntry[] = [];
  const errors: ImportValidationError[] = [];
  const grid = parseCsvText(bufferToText(buf));
  const headerRowIdx = findHeaderRow(grid, QBD_GL_HEADER_REQUIRED);
  if (headerRowIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Could not find a QuickBooks Desktop Journal header (Trans #, Type, Date, Account).',
    });
    return { entries, errors };
  }
  const header = grid[headerRowIdx]!;
  const iTrans = colOf(header, 'Trans #');
  const iType = colOf(header, 'Type');
  const iDate = colOf(header, 'Date');
  const iNum = colOf(header, 'Num');
  const iName = colOf(header, 'Name');
  const iMemo = colOf(header, 'Memo');
  const iAcct = colOf(header, 'Account');
  const iDeb = colOf(header, 'Debit');
  const iCred = colOf(header, 'Credit');

  let current: QbdGroup | null = null;

  const closeCurrent = () => {
    const g = current;
    current = null;
    if (!g || g.legs.length === 0) return;
    const iso = toIsoDate(g.date);
    if (!iso) {
      errors.push({
        rowNumber: g.rowNumber,
        field: 'Date',
        code: 'IMPORT_BAD_DATE',
        message: `Could not parse date "${g.date}".`,
      });
      return;
    }
    const sourceCode = QBD_TXN_TYPE_LABELS[g.type.toLowerCase()] ?? `QBD:${g.type || 'Journal'}`;
    const lines: CanonicalGlLine[] = g.legs.map((l) => {
      const acct = splitQbdAccount(l.account);
      return {
        accountName: acct.accountName,
        accountNumber: acct.accountNumber,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo || undefined,
      };
    });
    // Drop a wholly zero-amount entry (postTransaction rejects all-zero
    // transactions; dropping here keeps surviving-entry indices stable for
    // fileHash:index dedup on re-upload).
    if (!lines.some((l) => Number(l.debit) !== 0 || Number(l.credit) !== 0)) return;
    entries.push({
      rowNumber: g.rowNumber,
      date: iso,
      reference: g.num || undefined,
      transactionType: g.type || 'Journal',
      sourceCode,
      name: g.name || g.legs.find((l) => l.name)?.name || undefined,
      memo: g.legs.find((l) => l.memo)?.memo || undefined,
      lines,
    });
  };

  for (let i = headerRowIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const trans = (r[iTrans] ?? '').trim();
    const type = (r[iType] ?? '').trim();
    const account = (r[iAcct] ?? '').trim();

    // Grand "TOTAL" footer row — close whatever's open and stop grouping it.
    if (trans && /^total\b/i.test(trans)) {
      closeCurrent();
      continue;
    }

    // A non-empty Trans # begins a new transaction.
    if (trans) {
      closeCurrent();
      current = {
        rowNumber,
        type,
        date: (r[iDate] ?? '').trim(),
        num: iNum !== -1 ? (r[iNum] ?? '').trim() : '',
        name: iName !== -1 ? (r[iName] ?? '').trim() : '',
        legs: [],
      };
    }

    // A row with no Account is either the per-txn subtotal (blank account,
    // equal Debit+Credit) or a blank separator — both close the group.
    if (!account) {
      closeCurrent();
      continue;
    }

    if (!current) {
      // A detail leg before any header — malformed for our state machine.
      errors.push({
        rowNumber,
        code: 'IMPORT_HEADER_NOT_FOUND',
        message: 'Journal detail row encountered before a transaction header — unexpected structure.',
      });
      continue;
    }

    current.legs.push({
      rowNumber,
      name: iName !== -1 ? (r[iName] ?? '').trim() : '',
      memo: iMemo !== -1 ? (r[iMemo] ?? '').trim() : '',
      account,
      debit: toDecimal(r[iDeb]),
      credit: toDecimal(r[iCred]),
    });
  }
  closeCurrent();

  return { entries, errors };
}
