// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  parseCsvText,
  detectHeaderRow,
  detectProvider,
  detectImportMode,
  detectFileType,
  parseCurrency,
  parseDate,
  applyColumnMapping,
  hashBuffer,
  toPayrollImportRow,
  pivotLongFormat,
} from './payroll-parse.service.js';

describe('CSV Parser', () => {
  it('parses simple CSV', () => {
    const rows = parseCsvText('Name,Age\nAlice,30\nBob,25');
    expect(rows).toEqual([['Name', 'Age'], ['Alice', '30'], ['Bob', '25']]);
  });

  it('handles quoted fields with commas', () => {
    const rows = parseCsvText('"Last, First",Pay\n"Doe, John",5000');
    expect(rows[0]).toEqual(['Last, First', 'Pay']);
    expect(rows[1]).toEqual(['Doe, John', '5000']);
  });

  it('handles escaped quotes', () => {
    const rows = parseCsvText('Name,Note\nAlice,"She said ""hello"""\n');
    expect(rows[1]).toEqual(['Alice', 'She said "hello"']);
  });

  it('strips BOM', () => {
    const rows = parseCsvText('\uFEFFName,Age\nAlice,30');
    expect(rows[0]).toEqual(['Name', 'Age']);
  });

  it('handles CRLF line endings', () => {
    const rows = parseCsvText('A,B\r\n1,2\r\n3,4');
    expect(rows.length).toBe(3);
  });

  it('handles TSV delimiter', () => {
    const rows = parseCsvText('Name\tAge\nAlice\t30', '\t');
    expect(rows[0]).toEqual(['Name', 'Age']);
    expect(rows[1]).toEqual(['Alice', '30']);
  });

  it('skips blank rows', () => {
    const rows = parseCsvText('A,B\n1,2\n\n3,4\n');
    expect(rows.length).toBe(3);
  });
});

describe('Header Row Detection', () => {
  it('detects row 0 for typical CSV', () => {
    const rows = [
      ['Employee Name', 'Check Date', 'Gross Pay', 'Net Pay'],
      ['John Doe', '01/15/2026', '$5,000.00', '$3,500.00'],
    ];
    expect(detectHeaderRow(rows)).toBe(0);
  });

  it('detects header row with leading data rows', () => {
    const rows = [
      ['Company: ABC Inc.', '', '', ''],
      ['Report: Payroll Detail', '', '', ''],
      ['', '', '', ''],
      ['Employee Name', 'Check Date', 'Gross Pay', 'Net Pay'],
      ['John Doe', '01/15/2026', '5000', '3500'],
    ];
    const headerRow = detectHeaderRow(rows);
    expect(headerRow).toBe(3);
  });
});

describe('Provider Auto-Detection', () => {
  it('detects Gusto', () => {
    const headers = ['Employee Name', 'Check Date', 'Gross Pay', 'Net Pay', 'Federal Income Tax', 'Social Security (Employee)'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('gusto');
    expect(result!.confidence).toBeGreaterThanOrEqual(60);
  });

  it('detects Paychex Flex', () => {
    const headers = ['EE Name', 'Check Date', 'Gross', 'Fed W/H', 'State W/H', 'OASDI/EE', 'MED/EE', 'Net'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('paychex_flex');
  });

  it('detects Payroll Relief GL entries (Mode B)', () => {
    const headers = ['Date', 'Reference', 'Account', 'Description', 'Debit', 'Credit', 'Memo'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('payroll_relief_gl');
  });

  it('returns null for unknown headers', () => {
    const headers = ['Column A', 'Column B', 'Column C'];
    const result = detectProvider(headers);
    expect(result).toBeNull();
  });

  // New provider signatures
  it('detects ADP Run GLI (Mode B)', () => {
    const headers = ['Company Code', 'Check Date', 'GL Account Number', 'GL Account Description', 'Debit Amount', 'Credit Amount'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('adp_run_gli');
  });

  it('detects Paychex Flex GLS (Mode B)', () => {
    const headers = ['Check Date', 'GL Account', 'Description', 'Debit', 'Credit'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('paychex_flex_gls');
  });

  it('detects OnPay GL Summary (Mode B)', () => {
    const headers = ['Pay Date', 'Description', 'Category', 'Amount'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('onpay_gl_summary');
  });

  it('detects Toast JE Report (Mode B)', () => {
    const headers = ['AccountID', 'Account Description', 'Debit', 'Credit', 'Check Date', 'Pay Group'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('toast_je_report');
  });

  it('detects OnPay Listing (Mode A)', () => {
    const headers = ['Employee Name', 'Check Date', 'Gross Wages', 'Net Pay', 'Federal Tax', 'State Tax', 'FICA Employee'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('onpay_listing');
  });

  it('detects Toast Payroll Detail (Mode A)', () => {
    const headers = ['Employee Name', 'Check Date', 'Earning Name', 'Earning Amount', 'Tax Name', 'Tax Amount'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('toast_payroll_detail');
  });

  // Dual-mode discrimination: ADP employee CSV vs ADP GLI
  it('distinguishes ADP Run (Mode A) from ADP Run GLI (Mode B)', () => {
    const modeAHeaders = ['File #', 'Employee Name', 'Check Date', 'Earnings', 'Taxes', 'Net Pay', 'Deductions'];
    const modeBHeaders = ['Company Code', 'Check Date', 'GL Account Number', 'GL Account Description', 'Debit Amount', 'Credit Amount'];

    const resultA = detectProvider(modeAHeaders);
    const resultB = detectProvider(modeBHeaders);

    expect(resultA!.provider).toBe('adp_run');
    expect(resultB!.provider).toBe('adp_run_gli');
  });

  // Defensive header matching
  it('matches headers with extra spaces', () => {
    const headers = ['Employee  Name', ' Check Date ', 'Gross Pay', 'Net Pay', 'Federal Income Tax', 'Social Security (Employee)'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('gusto');
  });

  it('matches headers case-insensitively', () => {
    const headers = ['EMPLOYEE NAME', 'CHECK DATE', 'GROSS PAY', 'NET PAY', 'FEDERAL INCOME TAX', 'SOCIAL SECURITY (EMPLOYEE)'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('gusto');
  });

  it('matches headers with stripped parens/slashes', () => {
    const headers = ['Employee Name', 'Check Date', 'Gross Pay', 'Net Pay', 'Federal Income Tax', 'Social Security Employee'];
    const result = detectProvider(headers);
    expect(result).toBeTruthy();
    expect(result!.provider).toBe('gusto');
  });
});

describe('Import Mode Detection', () => {
  it('returns prebuilt_je for payroll_relief_gl', () => {
    expect(detectImportMode('payroll_relief_gl')).toBe('prebuilt_je');
  });

  it('returns prebuilt_je for all Mode B providers', () => {
    expect(detectImportMode('adp_run_gli')).toBe('prebuilt_je');
    expect(detectImportMode('paychex_flex_gls')).toBe('prebuilt_je');
    expect(detectImportMode('onpay_gl_summary')).toBe('prebuilt_je');
    expect(detectImportMode('toast_je_report')).toBe('prebuilt_je');
  });

  it('returns employee_level for gusto', () => {
    expect(detectImportMode('gusto')).toBe('employee_level');
  });

  it('returns employee_level for Mode A providers', () => {
    expect(detectImportMode('adp_run')).toBe('employee_level');
    expect(detectImportMode('paychex_flex')).toBe('employee_level');
    expect(detectImportMode('onpay_listing')).toBe('employee_level');
    expect(detectImportMode('toast_payroll_detail')).toBe('employee_level');
  });

  it('returns employee_level for null', () => {
    expect(detectImportMode(null)).toBe('employee_level');
  });
});

describe('Currency Parsing', () => {
  it('parses plain number', () => {
    expect(parseCurrency('1234.56')).toBe(1234.56);
  });

  it('strips $ and commas', () => {
    expect(parseCurrency('$1,234.56')).toBe(1234.56);
  });

  it('handles parenthetical negatives', () => {
    expect(parseCurrency('($500.00)')).toBe(-500);
  });

  it('handles numeric input', () => {
    expect(parseCurrency(42.5)).toBe(42.5);
  });

  it('returns 0 for empty/null', () => {
    expect(parseCurrency('')).toBe(0);
    expect(parseCurrency(null)).toBe(0);
    expect(parseCurrency(undefined)).toBe(0);
  });

  it('handles trailing minus', () => {
    expect(parseCurrency('500.00-')).toBe(-500);
    expect(parseCurrency('$1,234.56-')).toBe(-1234.56);
  });

  it('returns 0 for non-numeric', () => {
    expect(parseCurrency('abc')).toBe(0);
  });
});

describe('Date Parsing', () => {
  it('parses MM/DD/YYYY', () => {
    expect(parseDate('01/15/2026')).toBe('2026-01-15');
  });

  it('parses single-digit month/day', () => {
    expect(parseDate('1/5/2026')).toBe('2026-01-05');
  });

  it('passes through ISO dates', () => {
    expect(parseDate('2026-01-15')).toBe('2026-01-15');
  });

  it('parses MM-DD-YYYY', () => {
    expect(parseDate('01-15-2026')).toBe('2026-01-15');
  });

  it('returns null for empty', () => {
    expect(parseDate('')).toBeNull();
  });

  it('returns null for unparseable', () => {
    expect(parseDate('not a date')).toBeNull();
  });
});

describe('Column Mapping', () => {
  it('maps columns by source name', () => {
    const rows = [
      ['Employee Name', 'Check Date', 'Gross Pay', 'Net Pay'],
      ['John Doe', '01/15/2026', '5000', '3500'],
      ['Jane Smith', '01/15/2026', '4000', '2800'],
    ];
    const config = {
      header_row: 0,
      data_start_row: 1,
      mappings: {
        employee_name: { source: 'Employee Name' },
        check_date: { source: 'Check Date' },
        gross_pay: { source: 'Gross Pay' },
        net_pay: { source: 'Net Pay' },
      },
    };
    const { mappedRows, skippedCount, originalIndices } = applyColumnMapping(rows, rows[0]!, config);
    expect(mappedRows.length).toBe(2);
    expect(mappedRows[0]!['employee_name']).toBe('John Doe');
    expect(mappedRows[0]!['gross_pay']).toBe(5000);
    expect(skippedCount).toBe(0);
    expect(originalIndices).toEqual([0, 1]);
  });

  it('applies skip rules and returns correct originalIndices', () => {
    const rows = [
      ['Employee Name', 'Gross Pay'],
      ['John Doe', '5000'],
      ['Total', '5000'],
      ['', '0'],
    ];
    const config = {
      header_row: 0,
      data_start_row: 1,
      mappings: {
        employee_name: { source: 'Employee Name' },
        gross_pay: { source: 'Gross Pay' },
      },
      skip_rules: [
        { type: 'blank_field' as const, field: 'employee_name' },
        { type: 'value_match' as const, field: 'employee_name', values: ['Total'] },
      ],
    };
    const { mappedRows, skippedCount, originalIndices } = applyColumnMapping(rows, rows[0]!, config);
    expect(mappedRows.length).toBe(1);
    expect(skippedCount).toBe(2);
    // Only data row 0 (John Doe) survives; rows 1 and 2 are skipped
    expect(originalIndices).toEqual([0]);
  });

  it('normalizes currency values', () => {
    const rows = [
      ['Employee Name', 'Gross Pay'],
      ['John', '$5,000.00'],
    ];
    const config = {
      header_row: 0,
      data_start_row: 1,
      mappings: {
        employee_name: { source: 'Employee Name' },
        gross_pay: { source: 'Gross Pay' },
      },
    };
    const { mappedRows } = applyColumnMapping(rows, rows[0]!, config);
    expect(mappedRows[0]!['gross_pay']).toBe(5000);
  });
});

describe('File Hash', () => {
  it('generates consistent SHA-256 hash', () => {
    const buf = Buffer.from('test data');
    const hash1 = hashBuffer(buf);
    const hash2 = hashBuffer(buf);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });
});

describe('toPayrollImportRow', () => {
  it('converts mapped data to typed row', () => {
    const mapped = {
      employee_name: 'John Doe',
      check_date: '2026-01-15',
      gross_pay: 5000,
      net_pay: 3500,
      federal_income_tax: 750,
      is_contractor: false,
    };
    const row = toPayrollImportRow(mapped);
    expect(row.employee_name).toBe('John Doe');
    expect(row.check_date).toBe('2026-01-15');
    expect(row.gross_pay).toBe(5000);
    expect(row.net_pay).toBe(3500);
    expect(row.federal_income_tax).toBe(750);
    expect(row.is_contractor).toBe(false);
  });

  it('includes reimbursement_ee field', () => {
    const mapped = {
      employee_name: 'Jane Smith',
      check_date: '2026-01-15',
      gross_pay: 5000,
      net_pay: 3800,
      reimbursement_ee: 200,
    };
    const row = toPayrollImportRow(mapped);
    expect(row.reimbursement_ee).toBe(200);
  });
});

describe('File Type Detection', () => {
  it('detects .txt as csv or tsv based on content', () => {
    const csvContent = Buffer.from('Name,Age\nAlice,30');
    const result = detectFileType('payroll.txt', csvContent);
    expect(result).toBe('csv');
  });

  it('detects .txt with tabs as tsv', () => {
    const tsvContent = Buffer.from('Name\tAge\tPay\tTax\tNet\tOther\nAlice\t30\t5000\t500\t4500\t0');
    const result = detectFileType('payroll.txt', tsvContent);
    expect(result).toBe('tsv');
  });
});

describe('pivotLongFormat (Toast)', () => {
  it('pivots long-format rows to wide format', () => {
    const rows = [
      { 'Employee Name': 'John Doe', 'Check Date': '01/15/2026', 'Earning Name': 'Regular Wages', 'Earning Amount': '5000' },
      { 'Employee Name': 'John Doe', 'Check Date': '01/15/2026', 'Earning Name': 'Overtime', 'Earning Amount': '1000' },
      { 'Employee Name': 'Jane Smith', 'Check Date': '01/15/2026', 'Earning Name': 'Regular Wages', 'Earning Amount': '4000' },
    ];
    const result = pivotLongFormat(rows, {
      employeeField: 'Employee Name',
      nameField: 'Earning Name',
      amountField: 'Earning Amount',
      dateField: 'Check Date',
    });
    expect(result.length).toBe(2);
    const john = result.find(r => r['employee_name'] === 'John Doe');
    expect(john).toBeTruthy();
    expect(john!['regular_wages']).toBe(5000);
    expect(john!['overtime']).toBe(1000);
    const jane = result.find(r => r['employee_name'] === 'Jane Smith');
    expect(jane).toBeTruthy();
    expect(jane!['regular_wages']).toBe(4000);
  });

  it('aggregates amounts for same employee + earning', () => {
    const rows = [
      { 'Employee Name': 'John', 'Check Date': '01/15/2026', 'Earning Name': 'Tips', 'Earning Amount': '100' },
      { 'Employee Name': 'John', 'Check Date': '01/15/2026', 'Earning Name': 'Tips', 'Earning Amount': '50' },
    ];
    const result = pivotLongFormat(rows, {
      employeeField: 'Employee Name',
      nameField: 'Earning Name',
      amountField: 'Earning Amount',
      dateField: 'Check Date',
    });
    expect(result.length).toBe(1);
    expect(result[0]!['tips']).toBe(150);
  });

  it('skips rows with blank employee name', () => {
    const rows = [
      { 'Employee Name': '', 'Check Date': '01/15/2026', 'Earning Name': 'Wages', 'Earning Amount': '5000' },
    ];
    const result = pivotLongFormat(rows, {
      employeeField: 'Employee Name',
      nameField: 'Earning Name',
      amountField: 'Earning Amount',
      dateField: 'Check Date',
    });
    expect(result.length).toBe(0);
  });

  it('handles dollar-formatted amounts', () => {
    const rows = [
      { 'Employee Name': 'John', 'Check Date': '01/15/2026', 'Earning Name': 'Wages', 'Earning Amount': '$5,000.00' },
    ];
    const result = pivotLongFormat(rows, {
      employeeField: 'Employee Name',
      nameField: 'Earning Name',
      amountField: 'Earning Amount',
      dateField: 'Check Date',
    });
    expect(result.length).toBe(1);
    expect(result[0]!['wages']).toBe(5000);
  });

  it('keeps separate entries for different dates', () => {
    const rows = [
      { 'Employee Name': 'John', 'Check Date': '01/15/2026', 'Earning Name': 'Wages', 'Earning Amount': '5000' },
      { 'Employee Name': 'John', 'Check Date': '01/31/2026', 'Earning Name': 'Wages', 'Earning Amount': '5000' },
    ];
    const result = pivotLongFormat(rows, {
      employeeField: 'Employee Name',
      nameField: 'Earning Name',
      amountField: 'Earning Amount',
      dateField: 'Check Date',
    });
    expect(result.length).toBe(2);
  });
});

// ── Edge case tests from QA audit ──

describe('Provider Detection: edge cases', () => {
  it('handles completely empty headers', () => {
    const result = detectProvider([]);
    expect(result).toBeNull();
  });

  it('handles single-header files', () => {
    const result = detectProvider(['Amount']);
    expect(result).toBeNull();
  });

  it('does not false-positive on partially matching headers', () => {
    // Only 2 of 7 Payroll Relief headers — should NOT match at 60% threshold
    const result = detectProvider(['Date', 'Description']);
    expect(result).toBeNull();
  });
});

describe('Import Mode Detection: edge cases', () => {
  it('returns employee_level for unknown provider string', () => {
    expect(detectImportMode('some_unknown_provider')).toBe('employee_level');
  });

  it('returns employee_level for empty string', () => {
    expect(detectImportMode('')).toBe('employee_level');
  });
});

describe('parseCurrency: accounting notation edge cases', () => {
  it('handles parenthetical negative with dollar sign', () => {
    expect(parseCurrency('($1,234.56)')).toBe(-1234.56);
  });

  it('handles spaces around amount', () => {
    expect(parseCurrency('  $5,000.00  ')).toBe(5000);
  });

  it('handles just a dash', () => {
    expect(parseCurrency('-')).toBe(0);
  });

  it('handles zero in various formats', () => {
    expect(parseCurrency('$0.00')).toBe(0);
    expect(parseCurrency('0')).toBe(0);
    expect(parseCurrency('$-')).toBe(0);
  });
});

describe('detectFileType: edge cases', () => {
  it('defaults to csv for empty buffer', () => {
    const result = detectFileType('data.csv', Buffer.from(''));
    expect(result).toBe('csv');
  });

  it('detects xlsx from magic bytes even with wrong extension', () => {
    // PK magic bytes
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const result = detectFileType('data.xlsx', buf);
    expect(result).toBe('xlsx');
  });

  it('detects xls from magic bytes', () => {
    const buf = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
    const result = detectFileType('data.xls', buf);
    expect(result).toBe('xls');
  });
});
