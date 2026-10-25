// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// A/P amount and date arithmetic (U-85, U-86):
//   - item-line amount = round(quantity x unitPrice, 2, half away from zero)
//     and the terms discount, against the golden cases ClientLedger shares
//     (packages/shared/fixtures/ap-amount-golden.json);
//   - due dates are calendar arithmetic: under TZ=America/Chicago a 15-day
//     window from 2026-03-01 crosses the DST change and must still end on
//     2026-03-16, for bills and invoices alike (review missing test 5).

// Set before anything reads the clock: Node re-reads TZ on assignment.
process.env['TZ'] = 'America/Chicago';

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineAmountFromQuantity, termsDiscountAmount } from './line-amount.js';
import { addCalendarDays, isCalendarDate } from './calendar-date.js';
import { AppError } from './errors.js';
import { computeBillDueDate, resolveBillTerms } from '../services/bill.service.js';
import { computeDueDate } from '../services/invoice.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/ap-amount-golden.json'), 'utf8')) as {
  lineAmount: Array<{ quantity: string; unitPrice: string; amount?: string; error?: string }>;
  termsDiscount: Array<{ amount: string; percent: string; discount: string }>;
};

describe('line amount golden cases (shared with ClientLedger)', () => {
  it.each(golden.lineAmount)('$quantity x $unitPrice', (c) => {
    if (c.error) {
      let err: unknown;
      try { lineAmountFromQuantity(c.quantity, c.unitPrice); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(c.error);
    } else {
      expect(lineAmountFromQuantity(c.quantity, c.unitPrice)).toBe(c.amount);
    }
  });

  it.each(golden.termsDiscount)('discount $percent% of $amount', (c) => {
    expect(termsDiscountAmount(c.amount, c.percent)).toBe(c.discount);
  });
});

describe('calendar dates', () => {
  it('runs in a US zone that observes DST (the old arithmetic really fails here)', () => {
    const d = new Date('2026-03-01');
    d.setDate(d.getDate() + 15);
    expect(d.toISOString().split('T')[0]).toBe('2026-03-15');
  });

  it('adds days by the calendar', () => {
    expect(addCalendarDays('2026-03-01', 15)).toBe('2026-03-16');
    expect(addCalendarDays('2026-10-25', 15)).toBe('2026-11-09');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2026-03-16', -15)).toBe('2026-03-01');
    expect(() => addCalendarDays('2026-02-30', 1)).toThrow();
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-03-01T00:00:00Z')).toBe(false);
  });

  it('bill due dates across the March DST change', () => {
    expect(computeBillDueDate('2026-03-01', 'net_15', undefined)).toBe('2026-03-16');
    expect(computeBillDueDate('2026-02-20', 'net_30', undefined)).toBe('2026-03-22');
    expect(computeBillDueDate('2026-03-01', 'custom', 9)).toBe('2026-03-10');
    expect(computeBillDueDate('2026-03-01', 'due_on_receipt', undefined)).toBe('2026-03-01');
    expect(computeBillDueDate('2026-03-01', 'nonsense', undefined)).toBeUndefined();
  });

  it('invoice due dates across the March DST change', () => {
    expect(computeDueDate('2026-03-01', 'net_15')).toBe('2026-03-16');
    expect(computeDueDate('2026-02-20', 'net_30')).toBe('2026-03-22');
    expect(computeDueDate('2026-03-01', 'due_on_receipt')).toBe('2026-03-01');
  });
});

describe('resolveBillTerms', () => {
  const none = null;
  it('fixed discount terms take the table', () => {
    const t = resolveBillTerms({ txnDate: '2026-03-01', paymentTerms: '2_10_net_30' }, none);
    expect(t).toMatchObject({
      paymentTerms: '2_10_net_30', termsDays: 30, discountPercent: '2.0000', discountDays: 10,
      dueDate: '2026-03-31', discountDate: '2026-03-11', dueDateOverridden: false, discountDateOverridden: false, source: 'input',
    });
  });

  it('custom terms take days and an optional discount, both or neither', () => {
    expect(resolveBillTerms({ txnDate: '2026-03-01', paymentTerms: 'custom', termsDays: 45, discountPercent: '1.5', discountDays: 15 }, none))
      .toMatchObject({ termsDays: 45, discountPercent: '1.5000', discountDays: 15, dueDate: '2026-04-15', discountDate: '2026-03-16' });
    expect(() => resolveBillTerms({ txnDate: '2026-03-01', paymentTerms: 'custom', termsDays: 45, discountPercent: '1' }, none)).toThrow(/together/);
    expect(() => resolveBillTerms({ txnDate: '2026-03-01', paymentTerms: 'custom', termsDays: 10, discountPercent: '1', discountDays: 10 }, none)).toThrow(/fewer/);
    expect(() => resolveBillTerms({ txnDate: '2026-03-01', paymentTerms: 'custom', termsDays: 45, discountPercent: '0', discountDays: 5 }, none)).toThrow(/greater than 0/);
    expect(() => resolveBillTerms({ txnDate: '2026-03-01', paymentTerms: 'net_30', discountPercent: '1', discountDays: 5 }, none)).toThrow(/custom/);
  });

  it('vendor defaults apply when the bill names no terms; overrides are flagged', () => {
    const vendor = { defaultPaymentTerms: 'custom', defaultTermsDays: 20, defaultDiscountPercent: '2.5000', defaultDiscountDays: 5 };
    expect(resolveBillTerms({ txnDate: '2026-03-01' }, vendor))
      .toMatchObject({ source: 'vendor', paymentTerms: 'custom', termsDays: 20, discountPercent: '2.5000', dueDate: '2026-03-21', discountDate: '2026-03-06' });
    expect(resolveBillTerms({ txnDate: '2026-03-01', dueDate: '2026-05-01' }, vendor))
      .toMatchObject({ dueDate: '2026-05-01', dueDateOverridden: true });
    expect(resolveBillTerms({ txnDate: '2026-03-01' }, { defaultPaymentTerms: 'Net 30 EOM (legacy)' }))
      .toMatchObject({ paymentTerms: 'Net 30 EOM (legacy)', dueDate: null, source: 'vendor' });
    expect(resolveBillTerms({ txnDate: '2026-03-01' }, null)).toMatchObject({ paymentTerms: null, dueDate: null, source: 'none' });
    expect(() => resolveBillTerms({ txnDate: '2026-03-01', paymentTerms: 'net_30', discountDate: '2026-03-05' }, null)).toThrow(/discount/);
  });
});
