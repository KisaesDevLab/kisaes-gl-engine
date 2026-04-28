// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  buildTinMatchFile,
  decodeMatchCode,
  parseTinMatchResult,
  sanitizeAccount,
  sanitizeName,
  tinTypeCode,
} from './portal-1099.tin-match.js';

describe('sanitizeName', () => {
  it('uppercases and strips characters outside the Pub 2108A whitelist', () => {
    expect(sanitizeName('Acme/Corp_Inc.')).toBe('ACME CORP INC.');
    expect(sanitizeName("O'Brien & Sons, LLC")).toBe("O'BRIEN & SONS, LLC");
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeName('  Acme   \t  Corp  ')).toBe('ACME CORP');
  });

  it('truncates at 40 characters per Pub 2108A §3', () => {
    const long = 'A'.repeat(60);
    expect(sanitizeName(long)).toHaveLength(40);
  });
});

describe('sanitizeAccount', () => {
  it('uppercases and strips disallowed characters', () => {
    expect(sanitizeAccount('abc-123_xyz')).toBe('ABC-123XYZ');
  });

  it('caps at 20 characters', () => {
    expect(sanitizeAccount('1'.repeat(40))).toHaveLength(20);
  });
});

describe('tinTypeCode', () => {
  it('maps EIN→1, SSN→2, null/unknown→3', () => {
    expect(tinTypeCode('EIN')).toBe('1');
    expect(tinTypeCode('SSN')).toBe('2');
    expect(tinTypeCode(null)).toBe('3');
    expect(tinTypeCode(undefined)).toBe('3');
  });
});

describe('decodeMatchCode', () => {
  it('treats 0/6/7/8 as matched', () => {
    expect(decodeMatchCode('0').status).toBe('matched');
    expect(decodeMatchCode('6').status).toBe('matched');
    expect(decodeMatchCode('7').status).toBe('matched');
    expect(decodeMatchCode('8').status).toBe('matched');
  });

  it('treats 2 and 3 as mismatched', () => {
    expect(decodeMatchCode('2').status).toBe('mismatched');
    expect(decodeMatchCode('3').status).toBe('mismatched');
  });

  it('treats 1, 4, 5 as error', () => {
    expect(decodeMatchCode('1').status).toBe('error');
    expect(decodeMatchCode('4').status).toBe('error');
    expect(decodeMatchCode('5').status).toBe('error');
  });
});

describe('buildTinMatchFile', () => {
  const goodRow = {
    tinType: 'EIN' as const,
    tin: '123456789',
    name: 'Acme Inc.',
    accountNumber: 'abc-123',
  };

  it('emits one pipe-delimited line per valid row, trailing newline', () => {
    const result = buildTinMatchFile([goodRow]);
    expect(result.recordCount).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.body).toBe('1|123456789|ACME INC.|ABC-123\n');
  });

  it('strips non-digits from the TIN before length-checking', () => {
    const result = buildTinMatchFile([{ ...goodRow, tin: '12-3456789' }]);
    expect(result.recordCount).toBe(1);
    expect(result.body).toContain('|123456789|');
  });

  it('skips rows with malformed TINs', () => {
    const result = buildTinMatchFile([
      goodRow,
      { ...goodRow, tin: 'short', accountNumber: 'X1' },
      { ...goodRow, tin: '', accountNumber: 'X2' },
    ]);
    expect(result.recordCount).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((s) => s.reason.includes('9 digits'))).toBe(true);
  });

  it('skips rows whose name is empty after sanitization', () => {
    const result = buildTinMatchFile([{ ...goodRow, name: '///' }]);
    expect(result.recordCount).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/empty/i);
  });

  it('produces an empty body without a trailing newline when no rows are valid', () => {
    expect(buildTinMatchFile([]).body).toBe('');
  });
});

describe('parseTinMatchResult', () => {
  it('parses a clean two-row result file', () => {
    const result = parseTinMatchResult(
      [
        '1|123456789|ACME INC.|VENDOR1|0',
        '2|987654321|JANE SMITH|VENDOR2|3',
      ].join('\n'),
    );
    expect(result.malformedLineNumbers).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ tinType: '1', matchCode: '0', accountNumber: 'VENDOR1' });
    expect(result.rows[1]).toMatchObject({ tinType: '2', matchCode: '3', accountNumber: 'VENDOR2' });
  });

  it('tolerates BOM, CRLF line endings, and trailing blank lines', () => {
    const text = '﻿1|123456789|ACME|V1|0\r\n2|987654321|SMITH|V2|3\r\n\r\n';
    const result = parseTinMatchResult(text);
    expect(result.rows).toHaveLength(2);
    expect(result.malformedLineNumbers).toEqual([]);
  });

  it('reports rows with the wrong number of fields as malformed', () => {
    const result = parseTinMatchResult('1|123456789|ACME|V1\n1|123456789|ACME|V2|0');
    expect(result.rows).toHaveLength(1);
    expect(result.malformedLineNumbers).toEqual([1]);
  });

  it('reports unknown tinType / matchCode as malformed (no silent drop)', () => {
    const result = parseTinMatchResult(
      ['9|123456789|ACME|V1|0', '1|123456789|ACME|V2|Z'].join('\n'),
    );
    expect(result.rows).toEqual([]);
    expect(result.malformedLineNumbers).toEqual([1, 2]);
  });
});
