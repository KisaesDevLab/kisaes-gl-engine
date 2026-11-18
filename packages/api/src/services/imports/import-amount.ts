// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Exact import amounts (U-260, imports-amounts-v1). Every import adapter
 * (Generic, QuickBooks Online, QuickBooks Desktop, Accounting Power) reads
 * its money cells through parseImportAmount, so an amount is never a float
 * and never rounded: it is the Decimal of exactly what the file says, or
 * IMPORT_AMOUNT_INVALID.
 *
 * Accepted (after removing spaces, tabs, NBSP U+00A0, U+2007 and U+202F):
 *   - digits with an optional decimal point, `,` thousands separators in
 *     groups of three ("1,234.50"), a leading point (".5");
 *   - one `$`, before or after a leading minus ("$-5", "-$5");
 *   - a leading or a trailing `-` ("-5", "5-"); U+2212 MINUS SIGN is `-`;
 *   - `(x)` for a negative ("(1,234.00)", "($5)");
 *   - in a signed column (opts.signed), a trailing `CR` (negative) or `DR`
 *     (positive), any case;
 *   - blank, or a bare `-` (the accounting zero), is 0 by default
 *     (trial balance, chart of accounts, journal files); with
 *     opts.blank = 'invalid' (transaction files) it is IMPORT_AMOUNT_INVALID.
 * Rejected: exponents ("1e3"), more than 4 decimal places once trailing
 * zeros are dropped ("1.23456"), a sign with parentheses ("-(5)", "(-5)"),
 * two signs, comma decimals or misplaced separators ("1.234,56", "1,23"),
 * more than 15 integer digits (numeric(19,4)), and anything else.
 *
 * A spreadsheet number cell arrives as its raw IEEE value, never the
 * formatted text ("1,235" on screen, exponent form at 1e11 and above):
 * xlsxNumberText gives the shortest string that round-trips to that value,
 * in plain notation, which is then parsed like any other text. A value
 * carrying binary noise (0.30000000000000004) has more than 4 places and is
 * refused rather than silently rounded.
 */

import DecimalLib from 'decimal.js';

export const Decimal = DecimalLib.default || DecimalLib;
export type ImportDecimal = InstanceType<typeof Decimal>;

export const IMPORT_AMOUNT_INVALID = 'IMPORT_AMOUNT_INVALID' as const;
export type ImportAmountInvalid = typeof IMPORT_AMOUNT_INVALID;

export interface ImportAmountOptions {
  /** Blank (or a bare "-"): 'zero' (default; TB, CoA and journal files) or 'invalid' (transaction files). */
  blank?: 'zero' | 'invalid';
  /** A signed column (one amount, the sign gives the side): a trailing CR (negative) or DR (positive) is accepted. */
  signed?: boolean;
}

/** Most places an import amount may carry: the ledger's numeric(19,4) scale. */
export const MAX_IMPORT_PLACES = 4;
const MAX_INTEGER_DIGITS = 15;

// Whitespace inside a cell: ASCII spaces and tabs, NBSP, figure space, narrow NBSP.
const SPACES_RE = /[\s   ]/g;
// Digits with optional groups of three, optional fraction; or a bare fraction.
const BODY_RE = /^(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?|\.(\d+))$/;

/**
 * The shortest string that round-trips to `n`, in plain (not exponent)
 * notation: what a spreadsheet number cell really holds. Not finite: ''.
 */
export function xlsxNumberText(n: number): string {
  if (!Number.isFinite(n)) return '';
  const s = String(n);
  // String() is the shortest round-trip form; it switches to exponent
  // notation below 1e-6 and from 1e21. Decimal reads that exactly.
  return /e/i.test(s) ? new Decimal(s).toFixed() : s;
}

/**
 * The exact amount of an import cell (see the module comment), or
 * IMPORT_AMOUNT_INVALID. A number (a spreadsheet's raw cell value) is read
 * through xlsxNumberText.
 */
export function parseImportAmount(raw: unknown, opts: ImportAmountOptions = {}): ImportDecimal | ImportAmountInvalid {
  let s: string;
  if (raw === null || raw === undefined) s = '';
  else if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return IMPORT_AMOUNT_INVALID;
    s = xlsxNumberText(raw);
  } else if (typeof raw === 'string') s = raw;
  else return IMPORT_AMOUNT_INVALID;

  s = s.replace(SPACES_RE, '').replace(/−/g, '-');
  const blank = () => (opts.blank === 'invalid' ? IMPORT_AMOUNT_INVALID : new Decimal(0));
  if (s === '' || s === '-' || s === '$' || s === '$-' || s === '-$') return blank();

  let negative = false;
  if (opts.signed) {
    const m = /^(.*?)(CR|DR)$/i.exec(s);
    if (m) {
      if (m[2]!.toUpperCase() === 'CR') negative = true;
      s = m[1]!;
      if (s === '') return IMPORT_AMOUNT_INVALID;
    }
  }

  let signs = negative ? 1 : 0;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    signs += 1;
    s = s.slice(1, -1);
    // No sign of any kind next to parentheses: "(-5)", "(5-)".
    if (s.includes('-') || s.includes('(') || s.includes(')')) return IMPORT_AMOUNT_INVALID;
  }
  // A sign before the parentheses ("-(5)") is left in front and caught below.
  if (s.includes('(') || s.includes(')')) return IMPORT_AMOUNT_INVALID;

  // One $ at the front, before or after a leading minus.
  if (s.startsWith('-$')) { s = s.slice(2); negative = true; signs += 1; }
  else if (s.startsWith('$-')) { s = s.slice(2); negative = true; signs += 1; }
  else {
    if (s.startsWith('$')) s = s.slice(1);
    if (s.startsWith('-')) { s = s.slice(1); negative = true; signs += 1; }
  }
  if (s.endsWith('-')) { s = s.slice(0, -1); negative = true; signs += 1; }
  if (signs > 1) return IMPORT_AMOUNT_INVALID;

  const m = BODY_RE.exec(s);
  if (!m) return IMPORT_AMOUNT_INVALID;
  const intPart = (m[1] ?? '').replace(/,/g, '');
  const fraction = (m[2] ?? m[3] ?? '').replace(/0+$/, '');
  if (fraction.length > MAX_IMPORT_PLACES) return IMPORT_AMOUNT_INVALID;
  if (intPart.replace(/^0+/, '').length > MAX_INTEGER_DIGITS) return IMPORT_AMOUNT_INVALID;
  const value = new Decimal(`${intPart || '0'}${fraction ? `.${fraction}` : ''}`);
  // -0 is 0.
  return negative && !value.isZero() ? value.negated() : value;
}

/** True for a parsed amount (narrows away IMPORT_AMOUNT_INVALID). */
export function isImportAmount(v: ImportDecimal | ImportAmountInvalid): v is ImportDecimal {
  return v !== IMPORT_AMOUNT_INVALID;
}

/**
 * The canonical text of an import amount: plain notation, at least 2 places,
 * never rounded ("1234.50", "-0.1235", "5000.00").
 */
export function importAmountText(d: ImportDecimal): string {
  return d.toFixed(Math.max(2, d.decimalPlaces()));
}

/** The row error for a cell that is not an exact amount. */
export function importAmountError(rowNumber: number, field: string, raw: unknown) {
  const shown = typeof raw === 'number' ? xlsxNumberText(raw) || String(raw) : String(raw ?? '').trim();
  return {
    rowNumber,
    field,
    code: IMPORT_AMOUNT_INVALID,
    message: shown === ''
      ? `Row ${rowNumber}: ${field} is blank. Enter an amount.`
      : `Row ${rowNumber}: ${field} "${shown.slice(0, 40)}" is not an amount. Use digits with at most 4 decimal places, like 1,234.50 or (1,234.50).`,
  };
}
