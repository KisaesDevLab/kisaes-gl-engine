// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// QuickBooks Online XLSX adapters. QBO exports always have a small
// preamble (entity name + report title + report date + blank row)
// before the actual header, plus a leading "indent" column that's
// blank in the header but used by QBO's UI for row grouping. The
// helpers below scan for the header row by signature and tolerate
// either preamble length and the leading-blank-column convention.

import ExcelJS from 'exceljs';
import {
  QBO_TYPE_TEXT_MAP,
  QBO_TXN_TYPE_LABELS,
  type CanonicalCoaRow,
  type CanonicalContactRow,
  type CanonicalGlEntry,
  type CanonicalGlLine,
  type CanonicalTrialBalanceRow,
  type ContactKind,
  type ImportValidationError,
} from '@kis-books/shared';

// ── Shared helpers ────────────────────────────────────────────────

interface SheetGrid {
  rows: (string | number | Date | null | undefined)[][];
}

/** Load the first worksheet (or by name) into a normalized grid. */
async function loadSheet(buf: Buffer, sheetName?: string): Promise<SheetGrid | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) return null;
  const rows: SheetGrid['rows'] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const v = row.values as unknown[];
    // exceljs row.values is 1-indexed; drop the leading sentinel.
    const slice = v.slice(1).map((cell) => {
      if (cell == null) return null;
      if (typeof cell === 'object' && 'result' in (cell as object)) {
        // Formula cell — use its computed result.
        return (cell as { result?: unknown }).result as string | number | Date | null;
      }
      if (typeof cell === 'object' && cell instanceof Date) return cell;
      if (typeof cell === 'string' || typeof cell === 'number') return cell;
      // Hyperlink / rich-text cells fall through to string-of-text.
      const asText = (cell as { text?: string }).text;
      return typeof asText === 'string' ? asText : String(cell);
    });
    rows.push(slice as SheetGrid['rows'][number]);
  });
  return { rows };
}

/**
 * Find the row index whose stringified cells contain every required
 * label (case-insensitive substring). Returns -1 when no row matches —
 * the caller should surface that as IMPORT_HEADER_NOT_FOUND.
 *
 * NOTE: this uses substring match because QBO header rows often have
 * the exact label as the cell value but with leading whitespace or a
 * "*" annotation. For *column lookup* (after the header row is found)
 * use `colIdx()` below which is exact-match — substring matching at
 * lookup time risks "type" picking "detail type".
 */
function findHeaderRow(rows: SheetGrid['rows'], required: readonly string[]): number {
  const lowered = required.map((s) => s.toLowerCase());
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) => (c == null ? '' : String(c).toLowerCase()));
    if (lowered.every((needle) => cells.some((c) => c.includes(needle)))) return i;
  }
  return -1;
}

/**
 * Exact-equals (whitespace- and case-tolerant) column index lookup for
 * use *after* findHeaderRow has located the header. Returns -1 if not
 * found. Use this for any column whose semantics matter — Date, Type,
 * Account, Debit, Credit — to avoid the "type matches detail type"
 * substring collision.
 */
function colIdx(header: string[], label: string): number {
  const target = label.trim().toLowerCase();
  return header.findIndex((h) => (h ?? '').trim().toLowerCase() === target);
}

/** Substring fallback — for fuzzy-matched optional columns (Email, Phone, …)
 *  where no two QBO column labels collide on the substring. */
function colIdxFuzzy(header: string[], label: string): number {
  const target = label.trim().toLowerCase();
  return header.findIndex((h) => (h ?? '').trim().toLowerCase().includes(target));
}

function cellToString(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'number') return String(c);
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c);
}

function cellToDecimal(c: unknown): string | undefined {
  if (c == null || c === '') return undefined;
  if (typeof c === 'number') return String(c);
  const s = String(c).replace(/,/g, '').trim();
  if (!s) return undefined;
  const n = parseFloat(s);
  if (Number.isNaN(n)) return undefined;
  return s;
}

function cellToIsoDate(c: unknown): string | null {
  if (c == null || c === '') return null;
  if (c instanceof Date) {
    return `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(c).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [, mm, dd, yy] = m;
    const y = yy!.length === 2 ? `20${yy}` : yy;
    return `${y}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
  }
  return null;
}

// ── Chart of Accounts ─────────────────────────────────────────────

const QBO_COA_HEADER = ['Full name', 'Type', 'Detail type'] as const;

export async function parseCoa(
  buf: Buffer,
): Promise<{ rows: CanonicalCoaRow[]; errors: ImportValidationError[] }> {
  const rows: CanonicalCoaRow[] = [];
  const errors: ImportValidationError[] = [];
  const sheet = await loadSheet(buf);
  if (!sheet) {
    errors.push({ rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND', message: 'No worksheets in file.' });
    return { rows, errors };
  }
  const headerRowIdx = findHeaderRow(sheet.rows, QBO_COA_HEADER);
  if (headerRowIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Could not locate the header row. Expected columns: Full name, Type, Detail type.',
    });
    return { rows, errors };
  }
  const header = (sheet.rows[headerRowIdx] ?? []).map((c) => cellToString(c));
  const iName = colIdx(header, 'full name');
  // Exact match — 'detail type' contains 'type' so the looser fallback
  // would resolve iType to iDetail and silently mis-bucket every account.
  const iType = colIdx(header, 'type');
  const iDetail = colIdx(header, 'detail type');
  const iDesc = colIdx(header, 'description');

  for (let i = headerRowIdx + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    const rowNumber = i + 1;
    const fullName = cellToString(r[iName]).trim();
    const typeText = cellToString(r[iType]).trim();
    if (!fullName || !typeText) continue;

    const accountType = QBO_TYPE_TEXT_MAP[typeText.toLowerCase()];
    if (!accountType) {
      errors.push({
        rowNumber,
        field: 'Type',
        code: 'IMPORT_UNKNOWN_TYPE',
        message: `Unknown QuickBooks Type "${typeText}". Map this manually or extend QBO_TYPE_TEXT_MAP.`,
      });
      continue;
    }

    // QBO's Parent:Child convention. Split on the LAST ":" so multi-
    // colon names like "Income:Sales:Online" produce parentName
    // "Income:Sales" (which itself must exist in the file).
    let name = fullName;
    let parentName: string | undefined;
    const colon = fullName.lastIndexOf(':');
    if (colon !== -1) {
      parentName = fullName.slice(0, colon).trim();
      name = fullName.slice(colon + 1).trim();
    }

    const detailType = iDetail !== -1 ? cellToString(r[iDetail]).trim() || undefined : undefined;
    const description = iDesc !== -1 ? cellToString(r[iDesc]).trim() || undefined : undefined;

    rows.push({
      rowNumber,
      name,
      accountType,
      detailType,
      description,
      parentName,
    });
  }
  return { rows, errors };
}

// ── Contacts (Customers / Vendors) ────────────────────────────────

export async function parseContacts(
  buf: Buffer,
  kind: ContactKind,
): Promise<{ rows: CanonicalContactRow[]; errors: ImportValidationError[] }> {
  const rows: CanonicalContactRow[] = [];
  const errors: ImportValidationError[] = [];
  const sheet = await loadSheet(buf);
  if (!sheet) {
    errors.push({ rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND', message: 'No worksheets in file.' });
    return { rows, errors };
  }
  // QBO labels the name column "Customer" or "Vendor" depending on the
  // export. Look for either; the kind argument tells us which file the
  // operator said they were uploading.
  //
  // The contacts XLSX has a "Customer Contact List" / "Vendor Contact
  // List" title row before the real header. A naive findHeaderRow search
  // for just 'customer' would match the title row first (since it
  // contains the substring), then we'd treat its sole cell as the header
  // and extract zero rows. Anchor on a multi-token signature that only
  // appears together on the real header to skip past the title.
  const nameLabel = kind === 'customer' ? 'customer' : 'vendor';
  const headerRowIdx = findHeaderRow(sheet.rows, [nameLabel, 'phone', 'email']);
  if (headerRowIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: `Could not find a "${nameLabel}" header row with the expected columns. Did you upload the right file?`,
    });
    return { rows, errors };
  }
  const header = (sheet.rows[headerRowIdx] ?? []).map((c) => cellToString(c));
  // Exact match for the name column — falls back to fuzzy ("Customer
  // Name") only if QBO's exact label isn't there. Other columns are
  // unique enough on the substring that fuzzy is safe.
  const iName = colIdx(header, nameLabel) !== -1 ? colIdx(header, nameLabel) : colIdxFuzzy(header, nameLabel);
  const iEmail = colIdxFuzzy(header, 'email');
  const iPhone = colIdxFuzzy(header, 'phone');
  const iFull = colIdxFuzzy(header, 'full name');
  const iBilling = colIdxFuzzy(header, 'billing');
  const iShipping = colIdxFuzzy(header, 'shipping');
  const iAddress = iBilling === -1 ? colIdxFuzzy(header, 'address') : -1;

  for (let i = headerRowIdx + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    const rowNumber = i + 1;
    const displayName = cellToString(r[iName]).trim();
    if (!displayName) continue;
    rows.push({
      rowNumber,
      displayName,
      contactType: kind,
      email: iEmail !== -1 ? cellToString(r[iEmail]).trim() || undefined : undefined,
      phone: iPhone !== -1 ? cellToString(r[iPhone]).trim() || undefined : undefined,
      fullName: iFull !== -1 ? cellToString(r[iFull]).trim() || undefined : undefined,
      billingAddress:
        iBilling !== -1
          ? cellToString(r[iBilling]).trim() || undefined
          : iAddress !== -1
            ? cellToString(r[iAddress]).trim() || undefined
            : undefined,
      shippingAddress: iShipping !== -1 ? cellToString(r[iShipping]).trim() || undefined : undefined,
    });
  }
  return { rows, errors };
}

// ── Trial Balance ─────────────────────────────────────────────────

const QBO_TB_HEADER = ['debit', 'credit'] as const;
const AS_OF_RE = /as of\s+(.+)/i;

export async function parseTrialBalance(
  buf: Buffer,
): Promise<{
  rows: CanonicalTrialBalanceRow[];
  errors: ImportValidationError[];
  reportDate: string | null;
}> {
  const rows: CanonicalTrialBalanceRow[] = [];
  const errors: ImportValidationError[] = [];
  const sheet = await loadSheet(buf);
  if (!sheet) {
    errors.push({ rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND', message: 'No worksheets in file.' });
    return { rows, errors, reportDate: null };
  }
  // Pull the "As of <DATE>" line from anywhere in the preamble.
  let reportDate: string | null = null;
  for (let i = 0; i < Math.min(sheet.rows.length, 10); i++) {
    for (const cell of sheet.rows[i] ?? []) {
      const m = cellToString(cell).match(AS_OF_RE);
      if (m) {
        const parsed = cellToIsoDate(m[1]) ?? cellToIsoDate(new Date(m[1]!));
        if (parsed) {
          reportDate = parsed;
          break;
        }
      }
    }
    if (reportDate) break;
  }

  const headerRowIdx = findHeaderRow(sheet.rows, QBO_TB_HEADER);
  if (headerRowIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Could not find Debit/Credit columns. Did you upload the right file?',
    });
    return { rows, errors, reportDate };
  }
  const header = (sheet.rows[headerRowIdx] ?? []).map((c) => cellToString(c));
  const iDeb = colIdx(header, 'debit');
  const iCred = colIdx(header, 'credit');
  // Account-name column is usually the FIRST non-blank column to the
  // left of Debit. Walk back until we hit something with a header value.
  let iAcct = -1;
  for (let c = iDeb - 1; c >= 0; c--) {
    const cell = (header[c] ?? '').trim();
    if (cell !== '') {
      iAcct = c;
      break;
    }
  }
  if (iAcct === -1) iAcct = 0;

  for (let i = headerRowIdx + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    const rowNumber = i + 1;
    const accountName = cellToString(r[iAcct]).trim();
    if (!accountName) continue;
    // QBO totals rows often have empty name + populated debit/credit.
    // Also TOTAL rows say "TOTAL" — skip those too.
    if (/^total/i.test(accountName)) continue;
    const debit = cellToDecimal(r[iDeb]);
    const credit = cellToDecimal(r[iCred]);
    if (!debit && !credit) continue;
    rows.push({
      rowNumber,
      accountName,
      debit,
      credit,
    });
  }
  return { rows, errors, reportDate };
}

// ── GL Transactions ───────────────────────────────────────────────

const QBO_GL_HEADER = ['date', 'transaction type', 'account'] as const;

interface QboLineRaw {
  rowNumber: number;
  date: unknown;
  txnType: string;
  num: string;
  name: string;
  memo: string;
  account: string;
  debit: unknown;
  credit: unknown;
}

export async function parseGl(
  buf: Buffer,
): Promise<{ entries: CanonicalGlEntry[]; errors: ImportValidationError[] }> {
  const entries: CanonicalGlEntry[] = [];
  const errors: ImportValidationError[] = [];
  const sheet = await loadSheet(buf);
  if (!sheet) {
    errors.push({ rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND', message: 'No worksheets in file.' });
    return { entries, errors };
  }
  const headerRowIdx = findHeaderRow(sheet.rows, QBO_GL_HEADER);
  if (headerRowIdx === -1) {
    errors.push({
      rowNumber: 0,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Could not find a Journal-shaped header (Date / Transaction Type / Account).',
    });
    return { entries, errors };
  }
  const header = (sheet.rows[headerRowIdx] ?? []).map((c) => cellToString(c));
  // Use exact-match (colIdx) for everything — substring match would
  // pick "Account" inside "Transaction Type" and re-bucket cells.
  const iDate = colIdx(header, 'date');
  const iType = colIdx(header, 'transaction type');
  const iNum = colIdx(header, 'num');
  const iName = colIdx(header, 'name');
  // Memo column in QBO exports is "Memo/Description". Accept either.
  const iMemo = colIdx(header, 'memo/description') !== -1
    ? colIdx(header, 'memo/description')
    : colIdx(header, 'memo');
  const iAcct = colIdx(header, 'account');
  const iDeb = colIdx(header, 'debit');
  const iCred = colIdx(header, 'credit');

  // State-machine: walk rows after header. Buffer the current JE in
  // `current`. A row with both Date and Type starts a new JE (closing
  // the previous one). A row whose debit==credit and both>0 is the
  // QBO totals row — close+skip. A blank row (no account, no amounts)
  // also closes.
  let current: QboLineRaw[] | null = null;

  const closeCurrent = () => {
    if (!current || current.length === 0) {
      current = null;
      return;
    }
    const first = current[0]!;
    const iso = cellToIsoDate(first.date);
    if (!iso) {
      errors.push({
        rowNumber: first.rowNumber,
        field: 'Date',
        code: 'IMPORT_BAD_DATE',
        message: `Could not parse date "${cellToString(first.date)}".`,
      });
      current = null;
      return;
    }
    const sourceCode =
      QBO_TXN_TYPE_LABELS[first.txnType.toLowerCase()] ?? `QBO:${first.txnType}`;
    const lines: CanonicalGlLine[] = current.map((l) => ({
      accountName: l.account || undefined,
      debit: cellToDecimal(l.debit) ?? '0',
      credit: cellToDecimal(l.credit) ?? '0',
      memo: l.memo || undefined,
    }));
    entries.push({
      rowNumber: first.rowNumber,
      date: iso,
      reference: first.num || undefined,
      transactionType: first.txnType,
      sourceCode,
      name: first.name || undefined,
      memo: current.find((l) => l.memo)?.memo || undefined,
      lines,
    });
    current = null;
  };

  for (let i = headerRowIdx + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    const rowNumber = i + 1;
    const account = cellToString(r[iAcct]).trim();
    const debit = cellToDecimal(r[iDeb]);
    const credit = cellToDecimal(r[iCred]);
    const date = r[iDate];
    const txnType = cellToString(r[iType]).trim();

    // QBO totals row: equal debit + credit, both > 0, no account label.
    // It's the marker that the JE just ended; don't include it in the
    // group, but do close the current group (if any).
    if (!account && debit && credit && debit === credit) {
      closeCurrent();
      continue;
    }

    // Fully blank row → close the current group.
    if (!account && !debit && !credit && !date && !txnType) {
      closeCurrent();
      continue;
    }

    // Header of a new JE.
    if (date && txnType) {
      closeCurrent();
      current = [];
    }

    // If we don't have a current group yet but this looks like a JE
    // continuation (no date but has account), the file is malformed
    // for our state machine — record an error and move on.
    if (!current) {
      if (account) {
        errors.push({
          rowNumber,
          code: 'IMPORT_HEADER_NOT_FOUND',
          message: 'Detail row encountered before a JE header — unexpected QBO structure.',
        });
      }
      continue;
    }

    current.push({
      rowNumber,
      date,
      txnType: txnType || (current[0]?.txnType ?? ''),
      num: cellToString(r[iNum]).trim(),
      name: cellToString(r[iName]).trim(),
      memo: cellToString(r[iMemo]).trim(),
      account,
      debit: r[iDeb],
      credit: r[iCred],
    });
  }
  // EOF: flush whatever's open.
  closeCurrent();

  return { entries, errors };
}
