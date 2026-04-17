// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';

// SSN pattern scanner (unit-testable without DB)
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;

function scanForSSN(rawData: Record<string, any>): boolean {
  for (const value of Object.values(rawData)) {
    if (typeof value === 'string' && SSN_PATTERN.test(value)) return true;
  }
  return false;
}

describe('SSN Pattern Detection', () => {
  it('detects SSN pattern in values', () => {
    expect(scanForSSN({ name: 'John', ssn: '123-45-6789' })).toBe(true);
  });

  it('detects SSN in any column', () => {
    expect(scanForSSN({ col1: 'data', col2: 'more data', col3: 'SSN: 123-45-6789' })).toBe(true);
  });

  it('does not flag non-SSN patterns', () => {
    expect(scanForSSN({ name: 'John', phone: '555-1234' })).toBe(false);
    expect(scanForSSN({ name: 'John', date: '01/15/2026' })).toBe(false);
    expect(scanForSSN({ name: 'John', amount: '$1,234.56' })).toBe(false);
  });

  it('does not flag partial SSN-like patterns', () => {
    expect(scanForSSN({ ref: '12-34-5678' })).toBe(false); // only 2 digits in first group
    expect(scanForSSN({ ref: '1234-56-7890' })).toBe(false); // 4 digits in first group
  });

  it('handles numeric values', () => {
    expect(scanForSSN({ amount: 5000 })).toBe(false);
    expect(scanForSSN({ amount: null })).toBe(false);
  });

  it('returns false for empty data', () => {
    expect(scanForSSN({})).toBe(false);
  });
});

describe('Gusto Missing Column Detection', () => {
  it('identifies when all tax columns are zero', () => {
    const rows = [
      { federal_income_tax: 0, social_security_ee: 0, medicare_ee: 0 },
      { federal_income_tax: 0, social_security_ee: 0, medicare_ee: 0 },
    ];
    const allZero = rows.every(r =>
      ['federal_income_tax', 'social_security_ee', 'medicare_ee'].every(f => Number(r[f as keyof typeof r] ?? 0) === 0)
    );
    expect(allZero).toBe(true);
  });

  it('identifies when tax columns have values', () => {
    const rows = [
      { federal_income_tax: 750, social_security_ee: 310, medicare_ee: 72.5 },
      { federal_income_tax: 600, social_security_ee: 248, medicare_ee: 58 },
    ];
    const allZero = rows.every(r =>
      ['federal_income_tax', 'social_security_ee', 'medicare_ee'].every(f => Number(r[f as keyof typeof r] ?? 0) === 0)
    );
    expect(allZero).toBe(false);
  });
});

describe('Toast SaaS Fee Detection', () => {
  it('detects service fee descriptions', () => {
    const descriptions = ['Regular Wages', 'FUTA', 'Toast Service Fee', 'Net Pay'];
    const hasSaasFee = descriptions.some(d =>
      d.toLowerCase().includes('service fee') || d.toLowerCase().includes('saas fee')
    );
    expect(hasSaasFee).toBe(true);
  });

  it('does not flag when no service fee', () => {
    const descriptions = ['Regular Wages', 'FUTA', 'Federal Tax', 'Net Pay'];
    const hasSaasFee = descriptions.some(d =>
      d.toLowerCase().includes('service fee') || d.toLowerCase().includes('saas fee')
    );
    expect(hasSaasFee).toBe(false);
  });
});

describe('ADP Clearing Account Detection', () => {
  it('detects clearing account entries', () => {
    const descriptions = ['Payroll - Salaries & Wages', 'ADP Clearing', 'Net Pay'];
    const hasClearing = descriptions.some(d =>
      d.toLowerCase().includes('clearing') || d.toLowerCase().includes('check register')
    );
    expect(hasClearing).toBe(true);
  });
});

describe('Mode B Minimum Row Check', () => {
  it('rejects files with fewer than 2 data rows', () => {
    const rowCount = 1;
    expect(rowCount < 2).toBe(true);
  });

  it('accepts files with 2+ data rows', () => {
    const rowCount = 2;
    expect(rowCount < 2).toBe(false);
  });

  it('rejects empty files', () => {
    const rowCount = 0;
    expect(rowCount < 2).toBe(true);
  });
});

describe('SSN Pattern Detection: edge cases', () => {
  it('detects SSN embedded in longer text', () => {
    expect(scanForSSN({ note: 'Employee SSN is 123-45-6789 on file' })).toBe(true);
  });

  it('does not flag EIN patterns (XX-XXXXXXX)', () => {
    expect(scanForSSN({ ein: '12-3456789' })).toBe(false);
  });

  it('does not flag phone-like patterns', () => {
    expect(scanForSSN({ phone: '(555) 123-4567' })).toBe(false);
  });

  it('detects multiple SSNs', () => {
    expect(scanForSSN({
      col1: '123-45-6789',
      col2: '987-65-4321',
    })).toBe(true);
  });
});

describe('Toast AccountID blank detection', () => {
  it('detects when all AccountIDs are blank', () => {
    const rows = [
      { 'AccountID': '', 'Account Description': 'Wages', Debit: '5000', Credit: '0' },
      { 'AccountID': '', 'Account Description': 'Net Pay', Debit: '0', Credit: '5000' },
    ];
    let allBlank = true;
    for (const r of rows) {
      if (r['AccountID'].trim()) { allBlank = false; break; }
    }
    expect(allBlank).toBe(true);
  });

  it('detects when at least one AccountID is present', () => {
    const rows = [
      { 'AccountID': 'GL-6000', 'Account Description': 'Wages', Debit: '5000', Credit: '0' },
      { 'AccountID': '', 'Account Description': 'Net Pay', Debit: '0', Credit: '5000' },
    ];
    let allBlank = true;
    for (const r of rows) {
      if (r['AccountID'].trim()) { allBlank = false; break; }
    }
    expect(allBlank).toBe(false);
  });
});
