// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import DecimalLib from 'decimal.js';
import { computeEntry } from './daily-sales.service.js';

const Decimal = DecimalLib.default || DecimalLib;

type Line = { id: string; section: string; label: string; accountId: string | null; normalSide: string; isActive: boolean };

// A minimal generic template: sales+tax (credits) and cash+card tenders (debits).
const lines: Line[] = [
  { id: 'food', section: 'sales', label: 'Food Sales', accountId: 'acc-rev', normalSide: 'credit', isActive: true },
  { id: 'tax', section: 'tax', label: 'Sales Tax', accountId: 'acc-tax', normalSide: 'credit', isActive: true },
  { id: 'cash', section: 'payment', label: 'Cash', accountId: 'acc-clear', normalSide: 'debit', isActive: true },
  { id: 'card', section: 'payment', label: 'Card', accountId: 'acc-clear', normalSide: 'debit', isActive: true },
];

const val = (id: string, amount: string) => ({ templateLineId: id, amount, tagId: null });

// Replicate the service's over/short balancing line and assert debits == credits.
function totalsWithOverShort(c: ReturnType<typeof computeEntry>) {
  let d = new Decimal(c.totalDebits);
  let cr = new Decimal(c.totalCredits);
  const delta = new Decimal(c.overShort);
  if (delta.greaterThan(0)) cr = cr.plus(delta);
  else if (delta.lessThan(0)) d = d.plus(delta.abs());
  return { d: d.toFixed(4), cr: cr.toFixed(4) };
}

describe('daily-sales computeEntry', () => {
  it('balances exactly when tenders equal sales + tax (over/short 0)', () => {
    const c = computeEntry(lines, [val('food', '1000'), val('tax', '80'), val('cash', '500'), val('card', '580')], null, null);
    expect(c.totalCredits).toBe('1080.0000');
    expect(c.totalDebits).toBe('1080.0000');
    expect(c.overShort).toBe('0.0000');
    const t = totalsWithOverShort(c);
    expect(t.d).toBe(t.cr);
  });

  it('overage: tenders exceed sales+tax → positive over/short, still balances', () => {
    const c = computeEntry(lines, [val('food', '1000'), val('tax', '80'), val('cash', '520'), val('card', '580')], null, null);
    expect(c.overShort).toBe('20.0000'); // debits 1100 - credits 1080
    const t = totalsWithOverShort(c);
    expect(t.d).toBe(t.cr); // a credit to Cash Over/Short closes it
  });

  it('shortage: tenders short of sales+tax → negative over/short, still balances', () => {
    const c = computeEntry(lines, [val('food', '1000'), val('tax', '80'), val('cash', '500'), val('card', '565')], null, null);
    expect(c.overShort).toBe('-15.0000'); // debits 1065 - credits 1080
    const t = totalsWithOverShort(c);
    expect(t.d).toBe(t.cr); // a debit to Cash Over/Short closes it
  });

  it('flags lines with an amount but no mapped account', () => {
    const unmapped: Line[] = [{ id: 'misc', section: 'other', label: 'Unmapped', accountId: null, normalSide: 'credit', isActive: true }];
    const c = computeEntry([...lines, ...unmapped], [val('food', '100'), val('cash', '100'), val('misc', '5')], null, null);
    expect(c.unmappedLabels).toContain('Unmapped');
  });

  it('skips zero and inactive lines; tracks section totals', () => {
    const withInactive: Line[] = [...lines, { id: 'old', section: 'sales', label: 'Retired', accountId: 'acc-rev', normalSide: 'credit', isActive: false }];
    const c = computeEntry(withInactive, [val('food', '1000'), val('tax', '0'), val('cash', '1000'), val('old', '999')], null, null);
    expect(c.totalSales).toBe('1000.0000'); // tax 0 skipped, inactive 'old' skipped
    expect(c.totalTax).toBe('0.0000');
    expect(c.totalPayments).toBe('1000.0000');
    expect(c.journalLines).toHaveLength(2); // food + cash only
  });

  it('applies tag precedence: line tag > entry tag > template default', () => {
    const withVal = [{ templateLineId: 'food', amount: '100', tagId: 'line-tag' }, { templateLineId: 'cash', amount: '100', tagId: null }];
    const c = computeEntry(lines, withVal, 'entry-tag', 'tpl-tag');
    const food = c.journalLines.find((l) => l.description === 'Food Sales');
    const cash = c.journalLines.find((l) => l.description === 'Cash');
    expect(food?.tagId).toBe('line-tag');
    expect(cash?.tagId).toBe('entry-tag');
  });
});
