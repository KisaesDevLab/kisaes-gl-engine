// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 15.7 + 15.8 — pure CSV
// helpers for 1099 exports and corrections. Lifted out of the
// service module so they're unit-testable without a Postgres
// connection.

export const CSV_HEADER = [
  'recipient_name',
  'recipient_tin',
  'tin_type',
  'amount',
  'form_type',
  // Per-box exporter — the box is the IRS form-box number ('1', '2',
  // '10', etc.). Blank on filings created before the per-box rewrite
  // so legacy spreadsheets still parse.
  'box',
  'tax_year',
  'backup_withholding',
  // 15.8 — IRS Pub 1220 §M: 'C' = corrected amount, 'G' = void
  // (vendor shouldn't have been issued a 1099). Blank on originals
  // so spreadsheet diffs against pre-15.8 exports stay clean.
  'correction_type',
].join(',');

export function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export interface CsvLineArgs {
  recipientName: string;
  tin: string;
  tinType: string;
  amount: number;
  formType: string;
  /** IRS box number ('1', '2', '10', …). Empty string on legacy /
   *  pre-rewrite filings where the box wasn't tracked. */
  box: string;
  taxYear: number;
  backupWithholding: boolean;
  correctionType: '' | 'C' | 'G';
}

export function buildCsvLine(args: CsvLineArgs): string {
  return [
    csvEscape(args.recipientName),
    args.tin,
    args.tinType,
    args.amount.toFixed(2),
    args.formType,
    args.box,
    args.taxYear,
    args.backupWithholding ? 'Y' : 'N',
    args.correctionType,
  ].join(',');
}

export function maskTin(plain: string): string {
  const digits = plain.replace(/\D/g, '');
  if (digits.length < 4) return '***-**-****';
  return `***-**-${digits.slice(-4)}`;
}
