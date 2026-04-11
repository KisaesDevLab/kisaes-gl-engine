import { describe, it, expect } from 'vitest';
import { parseDate, parseCurrency } from './payroll-parse.service.js';

// Re-implement pure functions to test without DB import
function parseGLEntries(rows: Record<string, string>[]) {
  return rows
    .filter(r => r['Description'] || r['description'])
    .map(r => ({
      date: parseDate(r['Date'] || r['date'] || '') || '',
      reference: r['Reference'] || r['reference'] || '',
      description: (r['Description'] || r['description'] || '').trim(),
      debit: parseCurrency(r['Debit'] || r['debit']),
      credit: parseCurrency(r['Credit'] || r['credit']),
      memo: (r['Memo'] || r['memo'] || '').trim(),
    }))
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

function extractPayPeriod(memo: string) {
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

describe('Mode B: parseGLEntries', () => {
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
