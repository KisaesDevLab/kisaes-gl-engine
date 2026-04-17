// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { parseDate, parseCurrency } from './payroll-parse.service.js';
import type { ModeBColumnConfig } from '@kis-books/shared';
import { MODE_B_COLUMN_CONFIGS } from '@kis-books/shared';

// Re-implement pure functions to test without DB import (generalized version)
function col(row: Record<string, string>, colName: string): string {
  if (row[colName] !== undefined) return row[colName]!;
  const lower = colName.toLowerCase();
  for (const [key, val] of Object.entries(row)) {
    if (key.toLowerCase() === lower) return val;
  }
  return '';
}

const DEFAULT_CONFIG: ModeBColumnConfig = MODE_B_COLUMN_CONFIGS['payroll_relief_gl']!;

function parseGLEntries(rows: Record<string, string>[], config?: ModeBColumnConfig) {
  const c = config || DEFAULT_CONFIG;

  return rows
    .filter(r => col(r, c.descriptionColumn))
    .map(r => {
      const description = col(r, c.descriptionColumn).trim();
      const dateStr = col(r, c.dateColumn);
      const memo = c.memoColumn ? col(r, c.memoColumn).trim() : '';
      const reference = c.referenceColumn ? col(r, c.referenceColumn) : '';
      const accountCode = c.accountCodeColumn ? col(r, c.accountCodeColumn) : '';

      let debit = 0;
      let credit = 0;

      switch (c.amountConvention) {
        case 'separate_dr_cr': {
          debit = parseCurrency(col(r, c.debitColumn || 'Debit'));
          credit = parseCurrency(col(r, c.creditColumn || 'Credit'));
          break;
        }
        case 'signed_single': {
          const amount = parseCurrency(col(r, c.amountColumn || 'Amount'));
          if (amount >= 0) debit = amount;
          else credit = Math.abs(amount);
          break;
        }
        case 'category_derived': {
          const amount = Math.abs(parseCurrency(col(r, c.amountColumn || 'Amount')));
          const category = col(r, c.accountCategoryColumn || 'Category').toLowerCase().trim();
          if (category.startsWith('expense') || category.startsWith('cost')) {
            debit = amount;
          } else {
            credit = amount;
          }
          break;
        }
      }

      return { date: parseDate(dateStr) || '', reference, description, debit, credit, memo, accountCode };
    })
    .filter(r => r.description && (r.debit > 0 || r.credit > 0));
}

function groupByDate(entries: { date: string; [k: string]: any }[]) {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (!entry.date) continue;
    const existing = groups.get(entry.date) || [];
    existing.push(entry);
    groups.set(entry.date, existing);
  }
  return groups;
}

function extractPayPeriod(memo: string, periodRegex?: string) {
  if (periodRegex) {
    try {
      const customMatch = memo.match(new RegExp(periodRegex, 'i'));
      if (customMatch && customMatch[1] && customMatch[2]) {
        const start = parseDate(customMatch[1]);
        const end = parseDate(customMatch[2]);
        if (start && end) return { start, end };
      }
    } catch { /* fall through */ }
  }
  const match = memo.match(/Period:\s*(\d{2}\/\d{2}\/\d{4})\s*to\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (!match) return null;
  const start = parseDate(match[1]!);
  const end = parseDate(match[2]!);
  if (!start || !end) return null;
  return { start, end };
}

function checkBalance(entries: { debit: number; credit: number }[]) {
  let totalDebits = 0;
  let totalCredits = 0;
  for (const e of entries) {
    totalDebits += e.debit;
    totalCredits += e.credit;
  }
  return {
    totalDebits: Math.round(totalDebits * 100) / 100,
    totalCredits: Math.round(totalCredits * 100) / 100,
    balanced: Math.abs(totalDebits - totalCredits) < 0.01,
  };
}

describe('Mode B: parseGLEntries (Payroll Relief — backward compat)', () => {
  it('parses GL entry rows', () => {
    const rows = [
      { Date: '01/15/2026', Reference: '01/15/2026', Account: '', Description: 'Wages and Salary', Debit: '$5,000.00', Credit: '$0.00', Memo: 'Period: 01/01/2026 to 01/15/2026' },
      { Date: '01/15/2026', Reference: '01/15/2026', Account: '', Description: 'Net Payroll', Debit: '$0.00', Credit: '$3,500.00', Memo: 'Period: 01/01/2026 to 01/15/2026' },
    ];
    const entries = parseGLEntries(rows);
    expect(entries.length).toBe(2);
    expect(entries[0]!.description).toBe('Wages and Salary');
    expect(entries[0]!.debit).toBe(5000);
    expect(entries[1]!.credit).toBe(3500);
  });

  it('skips rows with no description', () => {
    const rows = [
      { Date: '01/15/2026', Description: '', Debit: '$100.00', Credit: '$0.00', Memo: '' },
    ];
    const entries = parseGLEntries(rows as any);
    expect(entries.length).toBe(0);
  });

  it('skips rows with zero amounts', () => {
    const rows = [
      { Date: '01/15/2026', Description: 'Something', Debit: '$0.00', Credit: '$0.00', Memo: '' },
    ];
    const entries = parseGLEntries(rows as any);
    expect(entries.length).toBe(0);
  });
});

describe('Mode B: parseGLEntries with separate_dr_cr (Paychex GLS)', () => {
  it('parses Paychex GLS format', () => {
    const config = MODE_B_COLUMN_CONFIGS['paychex_flex_gls']!;
    const rows = [
      { 'Check Date': '01/15/2026', 'GL Account': '6000', Description: 'Gross Wages', Debit: '5000.00', Credit: '0.00' },
      { 'Check Date': '01/15/2026', 'GL Account': '1010', Description: 'Net Check', Debit: '0.00', Credit: '3500.00' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(2);
    expect(entries[0]!.description).toBe('Gross Wages');
    expect(entries[0]!.debit).toBe(5000);
    expect(entries[0]!.accountCode).toBe('6000');
    expect(entries[1]!.credit).toBe(3500);
  });
});

describe('Mode B: parseGLEntries with separate_dr_cr (Toast JE)', () => {
  it('parses Toast JE Report format', () => {
    const config = MODE_B_COLUMN_CONFIGS['toast_je_report']!;
    const rows = [
      { 'Check Date': '01/15/2026', 'AccountID': 'GL-6000', 'Account Description': 'Regular Wages', Debit: '5000.00', Credit: '0.00', 'Pay Group': 'Biweekly' },
      { 'Check Date': '01/15/2026', 'AccountID': 'GL-2300', 'Account Description': 'Tips Owed', Debit: '0.00', Credit: '800.00', 'Pay Group': 'Biweekly' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(2);
    expect(entries[0]!.description).toBe('Regular Wages');
    expect(entries[0]!.accountCode).toBe('GL-6000');
    expect(entries[1]!.description).toBe('Tips Owed');
    expect(entries[1]!.credit).toBe(800);
  });
});

describe('Mode B: parseGLEntries with category_derived (OnPay GL Summary)', () => {
  it('derives debit/credit from category column', () => {
    const config = MODE_B_COLUMN_CONFIGS['onpay_gl_summary']!;
    const rows = [
      { 'Pay Date': '01/15/2026', Description: 'Wages Expense', Category: 'Expense', Amount: '5000.00' },
      { 'Pay Date': '01/15/2026', Description: 'Net Payroll', Category: 'Asset', Amount: '3500.00' },
      { 'Pay Date': '01/15/2026', Description: 'Federal Income Tax W/H', Category: 'Liability', Amount: '1500.00' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(3);
    // Expense → debit
    expect(entries[0]!.debit).toBe(5000);
    expect(entries[0]!.credit).toBe(0);
    // Asset → credit
    expect(entries[1]!.debit).toBe(0);
    expect(entries[1]!.credit).toBe(3500);
    // Liability → credit
    expect(entries[2]!.debit).toBe(0);
    expect(entries[2]!.credit).toBe(1500);
  });

  it('checks balance with category-derived entries', () => {
    const config = MODE_B_COLUMN_CONFIGS['onpay_gl_summary']!;
    const rows = [
      { 'Pay Date': '01/15/2026', Description: 'Wages', Category: 'Expense', Amount: '5000.00' },
      { 'Pay Date': '01/15/2026', Description: 'Net Pay', Category: 'Asset', Amount: '3500.00' },
      { 'Pay Date': '01/15/2026', Description: 'Taxes', Category: 'Liability', Amount: '1500.00' },
    ];
    const entries = parseGLEntries(rows, config);
    const balance = checkBalance(entries);
    expect(balance.balanced).toBe(true);
    expect(balance.totalDebits).toBe(5000);
    expect(balance.totalCredits).toBe(5000);
  });
});

describe('Mode B: parseGLEntries with ADP GLI separate_dr_cr', () => {
  it('parses ADP GLI format', () => {
    const config = MODE_B_COLUMN_CONFIGS['adp_run_gli']!;
    const rows = [
      { 'Company Code': 'ABC', 'Check Date': '01/15/2026', 'GL Account Number': '6000', 'GL Account Description': 'Payroll - Salaries & Wages', 'Debit Amount': '5000.00', 'Credit Amount': '0.00' },
      { 'Company Code': 'ABC', 'Check Date': '01/15/2026', 'GL Account Number': '1010', 'GL Account Description': 'Net Pay', 'Debit Amount': '0.00', 'Credit Amount': '3500.00' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(2);
    expect(entries[0]!.description).toBe('Payroll - Salaries & Wages');
    expect(entries[0]!.debit).toBe(5000);
    expect(entries[0]!.accountCode).toBe('6000');
    expect(entries[1]!.description).toBe('Net Pay');
    expect(entries[1]!.credit).toBe(3500);
  });
});

describe('Mode B: groupByDate', () => {
  it('groups entries by date', () => {
    const entries = [
      { date: '2026-01-15', reference: '', description: 'Wages', debit: 5000, credit: 0, memo: '' },
      { date: '2026-01-15', reference: '', description: 'Net Payroll', debit: 0, credit: 3500, memo: '' },
      { date: '2026-01-31', reference: '', description: 'Wages', debit: 5000, credit: 0, memo: '' },
    ];
    const groups = groupByDate(entries);
    expect(groups.size).toBe(2);
    expect(groups.get('2026-01-15')?.length).toBe(2);
    expect(groups.get('2026-01-31')?.length).toBe(1);
  });
});

describe('Mode B: extractPayPeriod', () => {
  it('extracts period from memo', () => {
    const result = extractPayPeriod('Period: 01/01/2026 to 01/15/2026');
    expect(result).toEqual({ start: '2026-01-01', end: '2026-01-15' });
  });

  it('returns null for no match', () => {
    expect(extractPayPeriod('Some other memo')).toBeNull();
  });

  it('returns null for empty memo', () => {
    expect(extractPayPeriod('')).toBeNull();
  });
});

describe('Mode B: checkBalance', () => {
  it('reports balanced entries', () => {
    const entries = [
      { date: '', reference: '', description: 'Wages', debit: 5000, credit: 0, memo: '' },
      { date: '', reference: '', description: 'SS Expense', debit: 310, credit: 0, memo: '' },
      { date: '', reference: '', description: 'Net Payroll', debit: 0, credit: 3500, memo: '' },
      { date: '', reference: '', description: 'FIT Payable', debit: 0, credit: 750, memo: '' },
      { date: '', reference: '', description: 'SS Payable', debit: 0, credit: 620, memo: '' },
      { date: '', reference: '', description: 'Medicare Payable', debit: 0, credit: 440, memo: '' },
    ];
    const result = checkBalance(entries);
    expect(result.totalDebits).toBe(5310);
    expect(result.totalCredits).toBe(5310);
    expect(result.balanced).toBe(true);
  });

  it('reports unbalanced entries', () => {
    const entries = [
      { date: '', reference: '', description: 'Wages', debit: 5000, credit: 0, memo: '' },
      { date: '', reference: '', description: 'Net Payroll', debit: 0, credit: 3000, memo: '' },
    ];
    const result = checkBalance(entries);
    expect(result.balanced).toBe(false);
  });

  it('handles floating point precision', () => {
    const entries = [
      { date: '', reference: '', description: 'A', debit: 100.01, credit: 0, memo: '' },
      { date: '', reference: '', description: 'B', debit: 0, credit: 100.01, memo: '' },
    ];
    const result = checkBalance(entries);
    expect(result.balanced).toBe(true);
  });
});

// ── Edge case tests from QA audit ──

describe('Mode B: parseGLEntries edge cases', () => {
  it('handles accounting-notation amounts like ($500.00)', () => {
    const config = MODE_B_COLUMN_CONFIGS['payroll_relief_gl']!;
    const rows = [
      { Date: '01/15/2026', Description: 'Adjustment', Debit: '($500.00)', Credit: '$0.00', Memo: '' },
    ];
    const entries = parseGLEntries(rows, config);
    // parseCurrency handles ($500.00) => -500. Since debit is negative, it maps to 0 debit
    // and credit should be 0 too since credit column is $0.00 — row should be filtered out
    // Actually: parseCurrency('($500.00)') = -500. debit = -500. Filter: debit > 0 || credit > 0 → false
    expect(entries.length).toBe(0);
  });

  it('handles trailing-minus amounts like 500.00-', () => {
    const config = MODE_B_COLUMN_CONFIGS['payroll_relief_gl']!;
    const rows = [
      { Date: '01/15/2026', Description: 'Reversal', Debit: '500.00-', Credit: '$0.00', Memo: '' },
    ];
    const entries = parseGLEntries(rows, config);
    // parseCurrency('500.00-') = -500. debit = -500. Filtered out since debit !> 0
    expect(entries.length).toBe(0);
  });

  it('handles empty description column gracefully', () => {
    const config = MODE_B_COLUMN_CONFIGS['onpay_gl_summary']!;
    const rows = [
      { 'Pay Date': '01/15/2026', Description: '', Category: 'Expense', Amount: '5000' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(0);
  });

  it('handles missing date column gracefully', () => {
    const config = MODE_B_COLUMN_CONFIGS['payroll_relief_gl']!;
    const rows = [
      { Description: 'Wages', Debit: '5000', Credit: '0' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(1);
    expect(entries[0]!.date).toBe(''); // parseDate returns null → ''
  });

  it('case-insensitive column lookup works', () => {
    const config = MODE_B_COLUMN_CONFIGS['payroll_relief_gl']!;
    const rows = [
      { date: '01/15/2026', description: 'Wages', debit: '5000.00', credit: '0.00' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(1);
    expect(entries[0]!.description).toBe('Wages');
    expect(entries[0]!.debit).toBe(5000);
  });

  it('signed_single convention: positive=debit, negative=credit', () => {
    const signedConfig: ModeBColumnConfig = {
      dateColumn: 'Date',
      descriptionColumn: 'Description',
      amountConvention: 'signed_single',
      amountColumn: 'Amount',
    };
    const rows = [
      { Date: '01/15/2026', Description: 'Wages Expense', Amount: '5000.00' },
      { Date: '01/15/2026', Description: 'Net Pay', Amount: '-3500.00' },
      { Date: '01/15/2026', Description: 'Tax Payable', Amount: '-1500.00' },
    ];
    const entries = parseGLEntries(rows, signedConfig);
    expect(entries.length).toBe(3);
    expect(entries[0]!.debit).toBe(5000);
    expect(entries[0]!.credit).toBe(0);
    expect(entries[1]!.debit).toBe(0);
    expect(entries[1]!.credit).toBe(3500);
    expect(entries[2]!.credit).toBe(1500);

    const balance = checkBalance(entries);
    expect(balance.balanced).toBe(true);
  });

  it('signed_single convention: zero amount filtered out', () => {
    const signedConfig: ModeBColumnConfig = {
      dateColumn: 'Date',
      descriptionColumn: 'Description',
      amountConvention: 'signed_single',
      amountColumn: 'Amount',
    };
    const rows = [
      { Date: '01/15/2026', Description: 'Zero Entry', Amount: '0.00' },
    ];
    const entries = parseGLEntries(rows, signedConfig);
    expect(entries.length).toBe(0);
  });

  it('category_derived: unknown category defaults to credit', () => {
    const config = MODE_B_COLUMN_CONFIGS['onpay_gl_summary']!;
    const rows = [
      { 'Pay Date': '01/15/2026', Description: 'Mystery', Category: 'Other', Amount: '100.00' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(1);
    // Unknown category → credit
    expect(entries[0]!.debit).toBe(0);
    expect(entries[0]!.credit).toBe(100);
  });

  it('category_derived: cost prefix treated as debit', () => {
    const config = MODE_B_COLUMN_CONFIGS['onpay_gl_summary']!;
    const rows = [
      { 'Pay Date': '01/15/2026', Description: 'COGS', Category: 'Cost of Goods', Amount: '200.00' },
    ];
    const entries = parseGLEntries(rows, config);
    expect(entries.length).toBe(1);
    expect(entries[0]!.debit).toBe(200);
    expect(entries[0]!.credit).toBe(0);
  });
});

describe('Mode B: extractPayPeriod with custom regex', () => {
  it('uses custom regex when provided', () => {
    const result = extractPayPeriod('Date Range: 2026-01-01 through 2026-01-15',
      'Date Range:\\s*(\\d{4}-\\d{2}-\\d{2})\\s*through\\s*(\\d{4}-\\d{2}-\\d{2})');
    expect(result).toEqual({ start: '2026-01-01', end: '2026-01-15' });
  });

  it('falls back to default when custom regex fails', () => {
    const result = extractPayPeriod('Period: 01/01/2026 to 01/15/2026', 'nonmatching_regex');
    expect(result).toEqual({ start: '2026-01-01', end: '2026-01-15' });
  });

  it('returns null when both custom and default regex fail', () => {
    const result = extractPayPeriod('Random memo text', 'nonmatching_regex');
    expect(result).toBeNull();
  });
});

describe('Mode B: groupByDate edge cases', () => {
  it('skips entries with empty date', () => {
    const entries = [
      { date: '', reference: '', description: 'No Date', debit: 100, credit: 0, memo: '' },
      { date: '2026-01-15', reference: '', description: 'Has Date', debit: 100, credit: 0, memo: '' },
    ];
    const groups = groupByDate(entries);
    expect(groups.size).toBe(1);
    expect(groups.has('')).toBe(false);
  });
});
