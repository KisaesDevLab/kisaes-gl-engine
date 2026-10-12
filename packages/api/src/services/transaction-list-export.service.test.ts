// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Transactions list export — the pure parts: Debit/Credit derivation, CSV
// quoting + formula guard, the PDF's HTML (header, filters, GL columns,
// totals, truncation note) and the stamped footer (printed time + page
// numbers). Chromium is mocked: a real render is covered by the route test
// wherever a browser exists.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { Decimal } from 'decimal.js';

const toPdfCalls: Array<{ html: string; orientation?: string }> = [];
vi.mock('./report-export.service.js', async (orig) => {
  const real = await orig<typeof import('./report-export.service.js')>();
  return {
    ...real,
    toPdf: async (html: string, opts: { orientation?: 'portrait' | 'landscape' } = {}) => {
      toPdfCalls.push({ html, orientation: opts.orientation });
      const d = await PDFDocument.create();
      d.addPage([792, 612]);
      d.addPage([792, 612]);
      return Buffer.from(await d.save());
    },
  };
});

const svc = await import('./transaction-list-export.service.js');
const { extractTextLayer } = await import('./extraction/pdf-detect.service.js');

type Exp = Parameters<typeof svc.toTransactionListCsv>[0];

function sample(overrides: Partial<Exp> = {}): Exp {
  return {
    rows: [
      { date: '2026-01-05', type: 'Expense', ref: '101', name: '=HYPERLINK("http://evil",A1)', description: 'Paper, "A4"', category: 'Office <b>Supplies</b>', debit: new Decimal('1234.5'), credit: null, tag: 'East; West', status: 'posted' },
      { date: '2026-02-10', type: 'Deposit', ref: '', name: '+1-555', description: '@mention', category: 'Split', debit: null, credit: new Decimal('250'), tag: '', status: 'posted' },
      { date: '2026-03-01', type: 'Expense', ref: '', name: '\tTabbed', description: '-10', category: '', debit: new Decimal(0), credit: new Decimal(0), tag: '', status: 'void' },
    ],
    totals: { debit: new Decimal('1234.5'), credit: new Decimal('250') },
    matched: 3,
    truncated: false,
    cap: 50_000,
    companyName: 'Acme & Sons',
    dateLabel: '01/01/2026 to 12/31/2026',
    filterLines: ['Account: 1000 Checking', 'Search: "paper"', 'Sorted by: Date (newest first)'],
    ...overrides,
  };
}

beforeEach(() => { toPdfCalls.length = 0; });

describe('deriveDebitCredit', () => {
  const base = { status: 'posted', accountDebit: null, accountCredit: null, categoryDebit: null, categoryCredit: null, lineCategories: null, displayTotal: null, total: null } as const;
  const dc = (row: Partial<Parameters<typeof svc.deriveDebitCredit>[0]>, acct = false) => {
    const r = svc.deriveDebitCredit({ ...base, ...row } as Parameters<typeof svc.deriveDebitCredit>[0], acct);
    return [r.debit.toFixed(2), r.credit.toFixed(2)];
  };
  it('void → zero both sides, whatever the lines say', () => {
    expect(dc({ status: 'void', accountDebit: '5', categoryDebit: '5', lineCategories: ['X'], displayTotal: '5' }, true)).toEqual(['0.00', '0.00']);
    expect(dc({ status: 'void', categoryDebit: '5', lineCategories: ['X'], displayTotal: '5' })).toEqual(['0.00', '0.00']);
  });
  it('account filter → that account’s own legs (register view)', () => {
    expect(dc({ accountDebit: '250.0000', accountCredit: null, categoryDebit: '9', lineCategories: ['X'] }, true)).toEqual(['250.00', '0.00']);
  });
  it('no account filter → the category side’s legs', () => {
    expect(dc({ categoryDebit: '100', categoryCredit: null, lineCategories: ['Office'], displayTotal: '100' })).toEqual(['100.00', '0.00']);
    expect(dc({ categoryDebit: null, categoryCredit: '250', lineCategories: ['Sales'], displayTotal: '250' })).toEqual(['0.00', '250.00']);
  });
  it('no category side → the list’s amount on both sides', () => {
    expect(dc({ lineCategories: null, displayTotal: '75.0000' })).toEqual(['75.00', '75.00']);
    expect(dc({ lineCategories: [], displayTotal: null, total: '12' })).toEqual(['12.00', '12.00']);
  });
});

describe('toTransactionListCsv', () => {
  it('writes RFC 4180 records with the formula guard and plain 2-decimal money', () => {
    const csv = svc.toTransactionListCsv(sample());
    expect(csv.startsWith('\uFEFF"Date"')).toBe(true); // UTF-8 BOM for Excel
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('"Date","Type","Ref #","Name","Description","Account / Category","Debit","Credit","Tag","Status"');
    expect(lines[1]).toBe(`"2026-01-05","Expense","101","'=HYPERLINK(""http://evil"",A1)","Paper, ""A4""","Office <b>Supplies</b>","1234.50","","East; West","posted"`);
    expect(lines[2]).toBe(`"2026-02-10","Deposit","","'+1-555","'@mention","Split","","250.00","","posted"`);
    // A leading tab is a trigger too; a genuine negative number is not.
    expect(lines[3]).toBe(`"2026-03-01","Expense","","'\tTabbed","-10","","0.00","0.00","","void"`);
    expect(lines[4]).toBe('"","","","","Total","","1234.50","250.00","",""');
    expect(lines[5]).toBe('');
    expect(lines).toHaveLength(6);
  });

  it('appends the truncation note after the totals', () => {
    const csv = svc.toTransactionListCsv(sample({ truncated: true, matched: 60_123 }));
    const lines = csv.trimEnd().split('\r\n');
    expect(lines.at(-1)).toMatch(/^"Export truncated: first 3 of 60,123 matching transactions\. Narrow the date range or filters to export the rest\."/);
  });
});

describe('toTransactionListHtml', () => {
  it('uses the report chrome with company, title, date range and filters, GL columns, totals', () => {
    const html = svc.toTransactionListHtml(sample());
    expect(html).toContain('<h1>Acme &amp; Sons</h1>');
    expect(html).toContain('>Transactions</div>');
    expect(html).toContain('01/01/2026 to 12/31/2026');
    expect(html).toContain('Account: 1000 Checking');
    expect(html).toContain('Search: &quot;paper&quot;');
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual(['Date', 'Type', 'Ref #', 'Name', 'Description', 'Account / Category', 'Tag', 'Debit', 'Credit']);
    // Escaped user text, GL money formatting, Split label.
    expect(html).toContain('Office &lt;b&gt;Supplies&lt;/b&gt;');
    expect(html).not.toContain('<b>Supplies');
    expect(html).toContain('1,234.50');
    expect(html).toContain('>Split<');
    expect(html).toMatch(/class="total-row"[^>]*>.*>Total<\/td><td><\/td><td class="amount">1,234.50<\/td><td class="amount">250.00<\/td><\/tr>/);
    // Tag column (same value as the CSV's), wrapping inside its width;
    // an untagged row's cell is empty. No Status column.
    expect(html).toMatch(/<td style="[^"]*overflow-wrap:anywhere[^"]*">East; West<\/td><td class="amount"[^>]*>1,234.50<\/td>/);
    expect(html).toMatch(/>Split<\/td><td style="[^"]*">\s*<\/td><td class="amount"/);
    expect(html).not.toContain('>Status<');
    expect(html).not.toContain('Truncated');
  });

  it('says so when nothing matches and when truncated', () => {
    expect(svc.toTransactionListHtml(sample({ rows: [], totals: { debit: new Decimal(0), credit: new Decimal(0) }, matched: 0 })))
      .toContain('No transactions match these filters.');
    expect(svc.toTransactionListHtml(sample({ truncated: true, matched: 20_000 })))
      .toContain('Export truncated: first 3 of 20,000 matching transactions.');
  });
});

describe('toTransactionListPdf', () => {
  it('renders landscape and stamps printed time + page numbers on every page', async () => {
    const pdf = await svc.toTransactionListPdf(sample(), { timeZone: 'America/Chicago', now: new Date('2026-10-12T20:05:00Z') });
    expect(toPdfCalls).toHaveLength(1);
    expect(toPdfCalls[0]!.orientation).toBe('landscape');
    const pages = await extractTextLayer(pdf);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.text).toContain('Page 1 of 2');
    expect(pages[1]!.text).toContain('Page 2 of 2');
    expect(pages[0]!.text).toContain('Printed 10/12/2026 3:05 PM CDT');
  });

  it('falls back to UTC for a bogus time zone', () => {
    expect(svc.printedLabel(new Date('2026-10-12T20:05:00Z'), 'Not/AZone')).toBe('Printed 10/12/2026 8:05 PM UTC');
  });
});
