// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Accounting Power CSV adapters. Each parser takes the raw upload
// buffer and emits canonical rows ready for the validate/commit
// pipeline. Header validation runs at parse time so a wrong-file
// upload fails fast with IMPORT_HEADER_NOT_FOUND rather than
// surfacing dozens of unrelated row errors downstream.

import {
  AP_TYPE_LETTER_MAP,
  AP_JOURNAL_LABELS,
  AP_COA_HEADER_REQUIRED,
  AP_GL_HEADER_REQUIRED,
  AP_TB_HEADER_REQUIRED,
  type CanonicalCoaRow,
  type CanonicalGlEntry,
  type CanonicalGlLine,
  type CanonicalTrialBalanceRow,
  type ImportValidationError,
  type TbColumnChoice,
} from '@kis-books/shared';
import { parseCsvText } from '../../payroll-parse.service.js';

// ── Shared helpers ────────────────────────────────────────────────

/** Decode upload buffer as UTF-8. Strips BOM if present. */
function bufferToText(buf: Buffer): string {
  return buf.toString('utf8');
}

/** Convert MM/DD/YYYY (or M/D/YY) → ISO YYYY-MM-DD. Returns null on failure. */
function toIsoDate(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mm, dd, yy] = m;
  const y = yy!.length === 2 ? `20${yy}` : yy;
  return `${y}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
}

/** Parse an AP amount string ("123,415.81", "-2,021.92", "0.00") → decimal string. */
function toDecimal(raw: string | undefined): string {
  if (!raw) return '0';
  const cleaned = raw.replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return '0';
  return cleaned;
}

/** Header rows are required to start with these column names in this order. */
function requireHeader(actual: string[], expected: readonly string[]): ImportValidationError | null {
  for (const col of expected) {
    if (!actual.some((c) => c.trim().toLowerCase() === col.toLowerCase())) {
      return {
        rowNumber: 1,
        code: 'IMPORT_HEADER_NOT_FOUND',
        message: `Required column "${col}" not found in header. This does not look like an Accounting Power export.`,
      };
    }
  }
  return null;
}

// ── Chart of Accounts ─────────────────────────────────────────────

export function parseCoa(buf: Buffer): { rows: CanonicalCoaRow[]; errors: ImportValidationError[] } {
  const rows: CanonicalCoaRow[] = [];
  const errors: ImportValidationError[] = [];
  const grid = parseCsvText(bufferToText(buf));
  if (grid.length === 0) {
    errors.push({ rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND', message: 'Empty file.' });
    return { rows, errors };
  }
  const header = grid[0]!;
  const headerErr = requireHeader(header, AP_COA_HEADER_REQUIRED);
  if (headerErr) {
    errors.push(headerErr);
    return { rows, errors };
  }

  // Resolve every column by name rather than position so a future AP
  // export-format change (added column, reordering) doesn't silently
  // shift Type into the wrong slot. Exact-equals match (case- and
  // whitespace-insensitive) avoids substring collisions like 'Type'
  // matching 'Detail type' which `.includes()` would do.
  const colIdx = (label: string) =>
    header.findIndex((c) => c.trim().toLowerCase() === label.toLowerCase());
  const iAcct = colIdx('Account');
  const iDesc = colIdx('Description');
  const iType = colIdx('Type');
  const iClass = colIdx('Class');
  const iCategory = colIdx('Category');
  const iSubAcct = colIdx('SubAccount Of');

  // requireHeader above already verified the columns are present by
  // name, but a defensive double-check on the resolved indices avoids
  // silent zero-row imports if the header validation logic changes
  // out from under us. The required-presence check is exact-match here
  // (vs. requireHeader's substring), so it's the more authoritative
  // signal.
  if (iAcct === -1 || iDesc === -1 || iType === -1) {
    errors.push({
      rowNumber: 1,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Required CoA columns missing: Account, Description, Type.',
    });
    return { rows, errors };
  }

  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]!;
    const rowNumber = i + 1; // 1-indexed source row
    const accountNumber = (r[iAcct] ?? '').trim();
    const name = (r[iDesc] ?? '').trim();
    const typeLetter = (r[iType] ?? '').trim().toUpperCase();
    const cls = iClass !== -1 ? (r[iClass] ?? '').trim() : '';
    const category = iCategory !== -1 ? (r[iCategory] ?? '').trim() : '';
    const parentNumber = iSubAcct !== -1 ? (r[iSubAcct] ?? '').trim() : '';

    if (!accountNumber || !name) continue; // skip blank rows
    const accountType = AP_TYPE_LETTER_MAP[typeLetter];
    if (!accountType) {
      errors.push({
        rowNumber,
        field: 'Type',
        code: 'IMPORT_UNKNOWN_TYPE',
        message: `Unknown Accounting Power Type letter "${typeLetter}". Expected one of ${Object.keys(AP_TYPE_LETTER_MAP).join(', ')}.`,
      });
      continue;
    }
    // AP's Class is the coarse grouping ("CA - Current assets"); Category is finer.
    // Concatenate when both exist so the operator can still see the source data
    // post-import. detailType is free-text in MyBooks.
    const detailType = [cls, category].filter(Boolean).join(' / ') || undefined;

    rows.push({
      rowNumber,
      accountNumber,
      name,
      accountType,
      detailType,
      parentNumber: parentNumber || undefined,
    });
  }
  return { rows, errors };
}

// ── Trial Balance ─────────────────────────────────────────────────

export function parseTrialBalance(
  buf: Buffer,
  opts: { column: TbColumnChoice },
): { rows: CanonicalTrialBalanceRow[]; errors: ImportValidationError[] } {
  const rows: CanonicalTrialBalanceRow[] = [];
  const errors: ImportValidationError[] = [];
  const grid = parseCsvText(bufferToText(buf));
  if (grid.length === 0) {
    errors.push({ rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND', message: 'Empty file.' });
    return { rows, errors };
  }

  const header = grid[0]!;
  const headerErr = requireHeader(header, AP_TB_HEADER_REQUIRED);
  if (headerErr) {
    errors.push(headerErr);
    return { rows, errors };
  }

  // Resolve the chosen column's index by name so we don't break if AP
  // adds or reorders columns in a future export.
  const targetCol = opts.column === 'beginning' ? 'Beginning Balance' : 'Adjusted Balance';
  const balanceIdx = header.findIndex((c) => c.trim().toLowerCase() === targetCol.toLowerCase());
  const codeIdx = header.findIndex((c) => c.trim().toLowerCase() === 'account code');
  const descIdx = header.findIndex((c) => c.trim().toLowerCase() === 'description');
  if (balanceIdx === -1 || codeIdx === -1 || descIdx === -1) {
    errors.push({
      rowNumber: 1,
      code: 'IMPORT_HEADER_NOT_FOUND',
      message: `Trial balance header missing required columns. Need "Account Code", "Description", "${targetCol}".`,
    });
    return { rows, errors };
  }

  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]!;
    const rowNumber = i + 1;
    const accountNumber = (r[codeIdx] ?? '').trim();
    const accountName = (r[descIdx] ?? '').trim();
    if (!accountNumber) continue;

    const raw = (r[balanceIdx] ?? '').trim();
    const cleaned = raw.replace(/,/g, '');
    const value = parseFloat(cleaned);
    if (Number.isNaN(value)) {
      errors.push({
        rowNumber,
        field: targetCol,
        code: 'IMPORT_BAD_AMOUNT',
        message: `Could not parse "${raw}" as a number for "${accountNumber}".`,
      });
      continue;
    }
    if (value === 0) continue; // zero-balance accounts contribute nothing.

    if (value > 0) {
      rows.push({ rowNumber, accountNumber, accountName, debit: cleaned });
    } else {
      // Strip the leading minus; the magnitude lives in `credit`.
      rows.push({ rowNumber, accountNumber, accountName, credit: Math.abs(value).toFixed(4) });
    }
  }

  return { rows, errors };
}

// ── GL Transactions ───────────────────────────────────────────────

interface RawGlLine {
  rowNumber: number;
  journal: string;
  date: string;
  reference: string;
  description: string;
  accountNumber: string;
  accountName: string;
  debit: string;
  credit: string;
  memo: string;
}

// Anchored, exact-token match for AP's inline-void marker. Matches the
// canonical "Check Voided" / "Voided" / "Void" memos AP generates
// without falsely splitting unrelated lines whose memo happens to
// contain "void" (e.g. "Voided invoice cleared in 2023" — that's a
// description of past activity, NOT a reversal). The earlier loose
// `/\bvoid(ed)?\b/i` flagged those false positives and would have
// reordered debit/credit on legitimate JEs.
const VOID_MEMO_RE = /^\s*(check\s+)?(voided?)\s*$/i;

/**
 * Group AP GL lines into journal entries. Lines that share
 * (Journal, Date, Reference) form one balanced group; if a group
 * contains any line whose memo matches /void(ed)?/i we split into
 * two entries — the original lines (without void memos) plus a
 * separate reversing entry for the void lines, marked
 * isVoidReversal=true. This matches MyBooks' own voidTransaction
 * semantics where a void is its own JE that net-zeros the original.
 */
export function parseGl(buf: Buffer): { entries: CanonicalGlEntry[]; errors: ImportValidationError[] } {
  const entries: CanonicalGlEntry[] = [];
  const errors: ImportValidationError[] = [];
  const grid = parseCsvText(bufferToText(buf));
  if (grid.length === 0) {
    errors.push({ rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND', message: 'Empty file.' });
    return { entries, errors };
  }
  const header = grid[0]!;
  const headerErr = requireHeader(header, AP_GL_HEADER_REQUIRED);
  if (headerErr) {
    errors.push(headerErr);
    return { entries, errors };
  }

  const idx = (col: string) => header.findIndex((c) => c.trim().toLowerCase() === col.toLowerCase());
  const iJournal = idx('Journal');
  const iDate = idx('Date');
  const iRef = idx('Reference');
  const iDesc = idx('Description');
  const iAcct = idx('Account');
  const iName = idx('Account Name');
  const iDeb = idx('Debit Amount');
  const iCred = idx('Credit Amount');
  const iMemo = idx('Memo');

  // Bucket all lines by (journal, date, reference)
  const buckets = new Map<string, RawGlLine[]>();
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]!;
    const journal = (r[iJournal] ?? '').trim();
    const date = (r[iDate] ?? '').trim();
    const reference = (r[iRef] ?? '').trim();
    const accountNumber = (r[iAcct] ?? '').trim();
    if (!journal || !date || !accountNumber) continue;
    const key = `${journal} ${date} ${reference}`;
    const line: RawGlLine = {
      rowNumber: i + 1,
      journal,
      date,
      reference,
      description: (r[iDesc] ?? '').trim(),
      accountNumber,
      accountName: (r[iName] ?? '').trim(),
      debit: toDecimal(r[iDeb]),
      credit: toDecimal(r[iCred]),
      memo: (r[iMemo] ?? '').trim(),
    };
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(line);
  }

  // Emit one or two entries per bucket. A bucket whose lines split into
  // void-memoed and non-void-memoed halves yields two entries — the
  // original (non-void lines) and the reversing entry (void lines).
  for (const lines of buckets.values()) {
    const voidLines = lines.filter((l) => VOID_MEMO_RE.test(l.memo));
    const originalLines = lines.filter((l) => !VOID_MEMO_RE.test(l.memo));

    const buildEntry = (group: RawGlLine[], isVoidReversal: boolean): CanonicalGlEntry | null => {
      if (group.length === 0) return null;
      const first = group[0]!;
      const iso = toIsoDate(first.date);
      if (!iso) {
        errors.push({
          rowNumber: first.rowNumber,
          field: 'Date',
          code: 'IMPORT_BAD_DATE',
          message: `Could not parse date "${first.date}".`,
        });
        return null;
      }
      const sourceCode = AP_JOURNAL_LABELS[first.journal] ?? `AP:${first.journal}`;
      const lines: CanonicalGlLine[] = group.map((l) => ({
        accountNumber: l.accountNumber,
        accountName: l.accountName || undefined,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo || undefined,
      }));
      // Roll up a representative memo from the first non-blank line
      // (lines in the same JE typically share or repeat the memo).
      const memo = group.find((l) => l.memo)?.memo;
      return {
        rowNumber: first.rowNumber,
        date: iso,
        reference: first.reference || undefined,
        transactionType: first.journal,
        sourceCode,
        name: first.description || undefined,
        memo: memo || undefined,
        lines,
        isVoidReversal,
      };
    };

    if (voidLines.length > 0 && originalLines.length > 0) {
      const orig = buildEntry(originalLines, false);
      const reversal = buildEntry(voidLines, true);
      if (orig) entries.push(orig);
      if (reversal) entries.push(reversal);
    } else {
      const all = buildEntry(lines, voidLines.length > 0);
      if (all) entries.push(all);
    }
  }

  return { entries, errors };
}
