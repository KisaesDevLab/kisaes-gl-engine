// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-260 (imports-amounts-v1): the one import amount parser. The table is the
// contract; ClientLedger's desktop CSV parser keeps an equal table.

import { describe, it, expect } from 'vitest';
import {
  IMPORT_AMOUNT_INVALID, importAmountError, importAmountText, isImportAmount, parseImportAmount, xlsxNumberText,
  type ImportAmountOptions,
} from './import-amount.js';
import { DESKTOP_CAPABILITIES } from '../../desktop/capabilities.js';

const BAD = IMPORT_AMOUNT_INVALID;
const parse = (raw: unknown, opts?: ImportAmountOptions) => {
  const d = parseImportAmount(raw, opts);
  return isImportAmount(d) ? d.toFixed() : d;
};

describe('parseImportAmount (U-260)', () => {
  it('advertises imports-amounts-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('imports-amounts-v1');
  });

  // [input, expected exact value or IMPORT_AMOUNT_INVALID]
  const accepted: Array<[string, string]> = [
    ['0', '0'], ['5', '5'], ['1234.5', '1234.5'], ['1234.50', '1234.5'], ['.5', '0.5'], ['5.', '5'],
    ['1,234.56', '1234.56'], ['12,345,678.9', '12345678.9'], ['1,000', '1000'],
    ['$5', '5'], ['$1,234.00', '1234'], ['$ 1,234.00', '1234'],
    ['-5', '-5'], ['5-', '-5'], ['-1,234.56', '-1234.56'], ['1,234.56-', '-1234.56'],
    ['$-5', '-5'], ['-$5', '-5'], ['$5-', '-5'],
    ['(5)', '-5'], ['(1,234.00)', '-1234'], ['($1,234.00)', '-1234'], ['( 12.34 )', '-12.34'],
    ['−5', '-5'], ['−1,234.56', '-1234.56'], // U+2212 MINUS SIGN
    ['1 234.56', '1234.56'], [' 5 ', '5'], ['1 234', '1234'], ['  42.10  ', '42.1'], ['\t7\t', '7'],
    ['0.0001', '0.0001'], ['1.12340', '1.1234'], ['100.000000', '100'], // trailing zeros past 4 places are fine
    ['-0', '0'], ['(0.00)', '0'],
    ['999999999999999.9999', '999999999999999.9999'], // 15 integer digits, numeric(19,4)
    ['000123.40', '123.4'],
  ];
  const rejected: string[] = [
    '1e3', '1E3', '1.5e-2', '-1e21', 'Infinity', 'NaN', '0x10',
    '1.23456', '0.00001', '-0.12345',
    '-(5)', '(-5)', '(5-)', '((5))', '(5', '5)', '--5', '-5-', '$-5-', '-$-5',
    '1.234,56', '1,23', '1,2345', ',123', '1,,234', '12,34.5', '1.234.567',
    '$$5', '5$', '$(5)', '+5', '5 CR', '5DR', // CR/DR only in signed columns
    'abc', '12abc', '.', '1 2 3.4.5', '€5',
    '1000000000000000', // 16 integer digits
  ];

  it.each(accepted)('accepts %j as %s', (input, expected) => {
    expect(parse(input)).toBe(expected);
  });

  it.each(rejected.map((r) => [r]))('rejects %j', (input) => {
    expect(parse(input)).toBe(BAD);
  });

  it('blank is 0 by default (TB, CoA, journal files) and invalid for transaction files', () => {
    for (const blank of ['', '   ', ' ', '-', '$', ' - ', undefined, null]) {
      expect(parse(blank)).toBe('0');
      expect(parse(blank, { blank: 'invalid' })).toBe(BAD);
    }
    expect(parse('5', { blank: 'invalid' })).toBe('5');
  });

  it('signed columns take a trailing CR (negative) or DR (positive), any case', () => {
    const s = { signed: true };
    expect(parse('1,234.56 CR', s)).toBe('-1234.56');
    expect(parse('1,234.56cr', s)).toBe('-1234.56');
    expect(parse('$50.00 DR', s)).toBe('50');
    expect(parse('50dr', s)).toBe('50');
    expect(parse('0.00 CR', s)).toBe('0');
    expect(parse('-5', s)).toBe('-5');
    // A CR with any other sign is two signs.
    for (const bad of ['-5 CR', '(5) CR', '5- CR', 'CR', 'DR', '5 CRDR', '1e3 CR']) expect(parse(bad, s)).toBe(BAD);
  });

  it('a spreadsheet number is read as the shortest round-trip string', () => {
    expect(xlsxNumberText(1234.5)).toBe('1234.5');
    expect(xlsxNumberText(0.1)).toBe('0.1');
    expect(xlsxNumberText(-1234.56)).toBe('-1234.56');
    expect(xlsxNumberText(123456789012.34)).toBe('123456789012.34'); // a formatted cell shows 1.23457E+11
    expect(xlsxNumberText(1e21)).toBe('1000000000000000000000'); // plain, not exponent
    expect(xlsxNumberText(1.5e-7)).toBe('0.00000015');
    expect(xlsxNumberText(Number.NaN)).toBe('');
    expect(parse(1234.5)).toBe('1234.5');
    expect(parse(-0.25)).toBe('-0.25');
    expect(parse(123456789012.34)).toBe('123456789012.34');
    expect(parse(0)).toBe('0');
    expect(parse(-0)).toBe('0');
    // Binary noise is refused, never rounded to 0.3.
    expect(parse(0.1 + 0.2)).toBe(BAD);
    expect(parse(1e21)).toBe(BAD); // 22 integer digits
    expect(parse(1.5e-7)).toBe(BAD); // 8 places
    expect(parse(Number.POSITIVE_INFINITY)).toBe(BAD);
    expect(parse(Number.NaN)).toBe(BAD);
    expect(parse({ text: '5' })).toBe(BAD);
  });

  it('canonical text keeps the exact digits with at least 2 places', () => {
    const t = (s: string) => {
      const d = parseImportAmount(s);
      if (!isImportAmount(d)) throw new Error('bad');
      return importAmountText(d);
    };
    expect(t('5000')).toBe('5000.00');
    expect(t('(1,234.5)')).toBe('-1234.50');
    expect(t('0.1235')).toBe('0.1235');
    expect(t('$-0.001')).toBe('-0.001');
    expect(t('')).toBe('0.00');
  });

  it('the row error names the field and the cell', () => {
    expect(importAmountError(7, 'Debit', '1.234,56')).toMatchObject({
      rowNumber: 7, field: 'Debit', code: 'IMPORT_AMOUNT_INVALID',
    });
    expect(importAmountError(7, 'Debit', '1.234,56').message).toContain('"1.234,56"');
    expect(importAmountError(3, 'Amount', '').message).toContain('blank');
    expect(importAmountError(3, 'Amount', 0.1 + 0.2).message).toContain('0.30000000000000004');
  });
});
