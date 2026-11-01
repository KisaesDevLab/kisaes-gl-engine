// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Receive Payment allocation golden cases (U-132, receive-payment-v1),
// canonical in packages/shared/fixtures/payment-golden.json; the ClientLedger
// client keeps a byte-identical copy (fixtures/payments/golden.json). Each
// case runs through computePayment, the function preview and posting share.
// Needs no database.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePayment, centBalance, MONEY_INPUT_RE, type ComputeInvoice, type ComputeRequest } from './payment-compute.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface GoldenCase {
  id: string;
  name: string;
  invoices: ComputeInvoice[];
  request: ComputeRequest;
  expect: {
    amount: string;
    amountSource: string;
    payments: Record<string, string>;
    remaining: Record<string, string>;
    totals: Record<string, string>;
    shortfalls: Array<{ invoiceId: string; amount: string }>;
    problems: Array<{ code: string; invoiceId?: string }>;
  };
}

const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/payment-golden.json'), 'utf8')) as {
  cases: GoldenCase[];
  errors: Array<{ name: string; body: { amount: string } }>;
};

describe('payment-golden.json', () => {
  for (const c of golden.cases) {
    it(`case ${c.id}: ${c.name}`, () => {
      const r = computePayment(c.invoices, c.request);
      expect(r.amount).toBe(c.expect.amount);
      expect(r.amountSource).toBe(c.expect.amountSource);
      expect(Object.fromEntries(r.invoices.map((i) => [i.invoiceId, i.payment]))).toEqual(c.expect.payments);
      expect(Object.fromEntries(r.invoices.map((i) => [i.invoiceId, i.remaining]))).toEqual(c.expect.remaining);
      expect(r.totals).toEqual(c.expect.totals);
      expect(r.shortfalls).toEqual(c.expect.shortfalls);
      expect(r.problems).toEqual(c.expect.problems);
      // The posted applications are exactly the rows with a payment, as strings.
      expect(r.applications.map((a) => [a.invoiceId, a.amount]))
        .toEqual(r.invoices.filter((i) => i.payment !== '0.00').map((i) => [i.invoiceId, i.payment]));
    });
  }

  for (const e of golden.errors) {
    it(`error: ${e.name}`, () => {
      expect(MONEY_INPUT_RE.test(e.body.amount)).toBe(false);
    });
  }
});

describe('computePayment', () => {
  const inv = (id: string, date: string, bal: string): ComputeInvoice =>
    ({ invoiceId: id, invoiceNumber: id, txnDate: date, dueDate: null, total: bal, balanceDueExact: bal });

  it('cent balance is half away from zero', () => {
    expect(centBalance('100.0049').toFixed(2)).toBe('100.00');
    expect(centBalance('100.0050').toFixed(2)).toBe('100.01');
    expect(centBalance('-0.0050').toFixed(2)).toBe('-0.01');
  });

  it('orders oldest first by date, then number, then id', () => {
    const r = computePayment([inv('b', '2026-01-02', '10.00'), inv('a', '2026-01-02', '10.00'), inv('c', '2026-01-01', '10.00')], { amount: '15.00' });
    expect(r.invoices.map((i) => [i.invoiceId, i.payment])).toEqual([['c', '10.00'], ['a', '5.00'], ['b', '0.00']]);
  });

  it('flags an invoice that is not open, duplicates and payments above the amount', () => {
    const r = computePayment([inv('a', '2026-01-01', '10.00')], {
      amount: '5.00',
      applications: [{ invoiceId: 'a', amount: '10.00' }, { invoiceId: 'a', amount: '1.00' }, { invoiceId: 'zz', amount: '1.00' }],
    });
    expect(r.problems).toEqual([
      { code: 'DUPLICATE_INVOICE', invoiceId: 'a' },
      { code: 'INVOICE_NOT_OPEN', invoiceId: 'zz' },
      { code: 'APPLICATIONS_EXCEED_AMOUNT' },
    ]);
  });

  it('nothing typed and nothing ticked is AMOUNT_REQUIRED', () => {
    expect(computePayment([inv('a', '2026-01-01', '10.00')], {}).problems).toEqual([{ code: 'AMOUNT_REQUIRED' }]);
  });

  it('money input accepts at most 2 places', () => {
    for (const ok of ['0', '1', '1.5', '1.50', '4000.00']) expect(MONEY_INPUT_RE.test(ok)).toBe(true);
    for (const bad of ['', '-1', '1.005', '1e3', '1,000.00', ' 1', '.5', 'NaN']) expect(MONEY_INPUT_RE.test(bad)).toBe(false);
  });
});
