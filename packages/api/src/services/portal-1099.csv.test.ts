// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { CSV_HEADER, buildCsvLine, csvEscape, maskTin } from './portal-1099.csv.js';

describe('csvEscape', () => {
  it('wraps the value in quotes and doubles embedded quotes', () => {
    expect(csvEscape('plain')).toBe('"plain"');
    expect(csvEscape('a "quoted" b')).toBe('"a ""quoted"" b"');
    expect(csvEscape('comma, separated')).toBe('"comma, separated"');
  });
});

describe('CSV_HEADER', () => {
  it('declares the canonical 9-column shape including box and correction_type', () => {
    const cols = CSV_HEADER.split(',');
    expect(cols).toEqual([
      'recipient_name',
      'recipient_tin',
      'tin_type',
      'amount',
      'form_type',
      'box',
      'tax_year',
      'backup_withholding',
      'correction_type',
    ]);
  });
});

describe('buildCsvLine', () => {
  const base = {
    recipientName: 'Acme LLC',
    tin: '123456789',
    tinType: 'EIN',
    amount: 1234.5,
    formType: '1099-NEC',
    box: '1',
    taxYear: 2026,
    backupWithholding: false,
    correctionType: '' as const,
  };

  it('formats an original (non-correction) row with blank correction_type', () => {
    expect(buildCsvLine(base)).toBe('"Acme LLC",123456789,EIN,1234.50,1099-NEC,1,2026,N,');
  });

  it('writes the box number between form_type and tax_year', () => {
    const line = buildCsvLine({ ...base, formType: '1099-MISC', box: '10' });
    expect(line).toContain(',1099-MISC,10,2026,');
  });

  it('emits an empty box on legacy / pre-rewrite filings', () => {
    const line = buildCsvLine({ ...base, box: '' });
    expect(line).toContain(',1099-NEC,,2026,');
  });

  it('writes Y for backup withholding', () => {
    expect(buildCsvLine({ ...base, backupWithholding: true })).toContain(',Y,');
  });

  it('emits "C" for amend corrections and the new amount', () => {
    const line = buildCsvLine({ ...base, amount: 980, correctionType: 'C' });
    expect(line.endsWith(',C')).toBe(true);
    expect(line).toContain(',980.00,');
  });

  it('emits "G" for void corrections at $0.00', () => {
    const line = buildCsvLine({ ...base, amount: 0, correctionType: 'G' });
    expect(line.endsWith(',G')).toBe(true);
    expect(line).toContain(',0.00,');
  });

  it('escapes embedded commas and quotes in vendor names', () => {
    const line = buildCsvLine({
      ...base,
      recipientName: 'Smith, "Bob" & Co',
    });
    expect(line.startsWith('"Smith, ""Bob"" & Co",')).toBe(true);
  });

  it('renders amount to 2 decimals even for whole numbers', () => {
    expect(buildCsvLine({ ...base, amount: 600 })).toContain(',600.00,');
  });
});

describe('maskTin', () => {
  it('masks all but the last 4 digits in SSN format', () => {
    expect(maskTin('123456789')).toBe('***-**-6789');
  });

  it('strips non-digits before masking', () => {
    expect(maskTin('123-45-6789')).toBe('***-**-6789');
    expect(maskTin('12-3456789')).toBe('***-**-6789');
  });

  it('falls back to a fully-masked placeholder for malformed input', () => {
    expect(maskTin('abc')).toBe('***-**-****');
    expect(maskTin('')).toBe('***-**-****');
    expect(maskTin('123')).toBe('***-**-****');
  });
});
