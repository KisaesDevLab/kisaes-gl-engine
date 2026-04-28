// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 15.5 — IRS Bulk TIN
// Matching, per Publication 2108A "Online Taxpayer Identification
// Number Matching Program". The format is plain text, pipe-
// delimited, one record per line, up to 100,000 records per file:
//
//   TINType|TIN|Name|AccountNumber
//
// where TINType is "1" (EIN), "2" (SSN), or "3" (unknown).
// Account number is optional — we always send it, populated with
// the contact_id, so the result file can be correlated back to
// the originating vendor row without any name/TIN guesswork on
// our side (TINs are encrypted at rest).
//
// The result file IRS returns ~24h later appends a single match
// code column to each input row:
//
//   TINType|TIN|Name|AccountNumber|MatchCode
//
// Match codes (Pub 2108A §3):
//   0 - TIN/Name combination matches IRS records
//   1 - Missing TIN, or TIN not 9-digit numeric
//   2 - TIN not currently issued
//   3 - TIN/Name combination does NOT match IRS records
//   4 - Invalid TIN matching request (e.g. format error)
//   5 - Duplicate TIN matching request in this file
//   6 - Matched on SSN (when input was type 3 = unknown)
//   7 - Matched on EIN (when input was type 3 = unknown)
//   8 - Matched on both SSN and EIN (type 3 ambiguous)
//
// Pub 2108A character set for Name: A-Z, 0-9, hyphen, ampersand,
// space, comma, period, apostrophe. Anything else must be stripped
// or replaced. Length limit: 40 characters per name field.

export type TinTypeCode = '1' | '2' | '3';
export type MatchCode = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';

export interface TinExportRow {
  tinType: 'SSN' | 'EIN' | null;
  tin: string;
  name: string;
  accountNumber: string;
}

export interface TinResultRow {
  tinType: TinTypeCode;
  tin: string;
  name: string;
  accountNumber: string;
  matchCode: MatchCode;
}

export interface TinResultParse {
  rows: TinResultRow[];
  malformedLineNumbers: number[];
}

const NAME_MAX = 40;
const ACCOUNT_MAX = 20; // Pub 2108A §3.04 — account number 1-20 chars

// Whitelist matches Pub 2108A §3.03 "Allowable Characters".
// Everything not in this set gets converted to a single space; runs of
// whitespace then collapse to one space. We do NOT lowercase — IRS
// matching is case-insensitive but the result file echoes our input.
const NAME_DISALLOWED = /[^A-Z0-9\-& ,.']/g;
const ACCOUNT_DISALLOWED = /[^A-Z0-9-]/g;

/** Sanitize a vendor name into the IRS-permitted character set + length. */
export function sanitizeName(raw: string): string {
  const upper = (raw ?? '').toUpperCase();
  const cleaned = upper.replace(NAME_DISALLOWED, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, NAME_MAX);
}

/** Sanitize an account number — uppercase alphanumeric + hyphen, ≤20 chars. */
export function sanitizeAccount(raw: string): string {
  const upper = (raw ?? '').toUpperCase().replace(ACCOUNT_DISALLOWED, '');
  return upper.slice(0, ACCOUNT_MAX);
}

export function tinTypeCode(tinType: 'SSN' | 'EIN' | null | undefined): TinTypeCode {
  if (tinType === 'EIN') return '1';
  if (tinType === 'SSN') return '2';
  return '3';
}

export function decodeMatchCode(code: MatchCode): {
  status: 'matched' | 'mismatched' | 'pending' | 'error';
  description: string;
} {
  switch (code) {
    case '0':
    case '6':
    case '7':
    case '8':
      return { status: 'matched', description: 'TIN/Name matches IRS records' };
    case '3':
      return { status: 'mismatched', description: 'TIN/Name does not match IRS records' };
    case '2':
      return { status: 'mismatched', description: 'TIN not currently issued' };
    case '1':
      return { status: 'error', description: 'Missing or invalid TIN' };
    case '4':
      return { status: 'error', description: 'Invalid request format' };
    case '5':
      return { status: 'error', description: 'Duplicate TIN matching request' };
    default:
      return { status: 'pending', description: 'Unknown response code' };
  }
}

/**
 * Build the request file body. Each input row is required to have a
 * 9-digit TIN; rows with missing or malformed TINs are dropped and
 * surfaced in `skipped` so the operator can fix the underlying
 * profile before re-running.
 */
export function buildTinMatchFile(rows: TinExportRow[]): {
  body: string;
  recordCount: number;
  skipped: Array<{ accountNumber: string; reason: string }>;
} {
  const skipped: Array<{ accountNumber: string; reason: string }> = [];
  const lines: string[] = [];
  let recordCount = 0;
  for (const row of rows) {
    const tinDigits = (row.tin ?? '').replace(/\D/g, '');
    const account = sanitizeAccount(row.accountNumber);
    if (tinDigits.length !== 9) {
      skipped.push({ accountNumber: account, reason: 'TIN is not 9 digits' });
      continue;
    }
    const name = sanitizeName(row.name);
    if (!name) {
      skipped.push({ accountNumber: account, reason: 'Name is empty after sanitization' });
      continue;
    }
    if (recordCount >= 100_000) {
      skipped.push({ accountNumber: account, reason: 'Exceeds 100,000-row file limit' });
      continue;
    }
    lines.push([tinTypeCode(row.tinType), tinDigits, name, account].join('|'));
    recordCount++;
  }
  return { body: lines.join('\n') + (lines.length ? '\n' : ''), recordCount, skipped };
}

/**
 * Parse a result file IRS returns. Tolerates trailing newlines, BOM,
 * Windows line endings, and unexpected leading/trailing whitespace
 * per row. Lines that don't have exactly 5 pipe-delimited fields or
 * carry an unrecognised match code are reported in
 * `malformedLineNumbers` so the operator can investigate without
 * silently dropping data.
 */
export function parseTinMatchResult(content: string): TinResultParse {
  const text = content.replace(/^﻿/, '');
  const rows: TinResultRow[] = [];
  const malformedLineNumbers: number[] = [];
  const lineArr = text.split(/\r?\n/);
  lineArr.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return;
    const parts = line.split('|');
    if (parts.length !== 5) {
      malformedLineNumbers.push(idx + 1);
      return;
    }
    const [tinTypeRaw, tin, name, accountNumber, matchCodeRaw] = parts.map((p) => p.trim());
    if (!['1', '2', '3'].includes(tinTypeRaw!)) {
      malformedLineNumbers.push(idx + 1);
      return;
    }
    if (!['0', '1', '2', '3', '4', '5', '6', '7', '8'].includes(matchCodeRaw!)) {
      malformedLineNumbers.push(idx + 1);
      return;
    }
    rows.push({
      tinType: tinTypeRaw as TinTypeCode,
      tin: tin ?? '',
      name: name ?? '',
      accountNumber: accountNumber ?? '',
      matchCode: matchCodeRaw as MatchCode,
    });
  });
  return { rows, malformedLineNumbers };
}
