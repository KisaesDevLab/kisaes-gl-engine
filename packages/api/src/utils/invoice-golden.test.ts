// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The sales-form golden cases (U-122, sales-cents-v1), canonical here in
// packages/shared/fixtures/invoice-golden.json; the ClientLedger client keeps
// a byte-identical copy (fixtures/invoices/golden.json). Each case runs
// through computeSalesDocument, the function invoices and cash sales post
// with. Needs no database.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import DecimalLib from 'decimal.js';
import { computeSalesDocument, allocateCents, salesLineAmount } from './sales-compute.js';
import { AppError } from './errors.js';

const Decimal = DecimalLib.default || DecimalLib;
const here = path.dirname(fileURLToPath(import.meta.url));

interface GoldenLine { quantity: string; unitPrice: string; isTaxable: boolean; taxRate?: string }
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/invoice-golden.json'), 'utf8')) as {
  rules: Record<string, string>;
  cases: Array<{
    name: string; defaultTaxRate: string; lines: GoldenLine[];
    expect: {
      lines: Array<{ amount: string; taxRate: string; taxAmount: string }>;
      subtotal: string; taxableBase: string; taxTotal: string; total: string;
    };
  }>;
  errors: Array<{ name: string; lines: GoldenLine[]; error: string }>;
};

describe('invoice golden cases (sales-cents-v1)', () => {
  it('states every rule', () => {
    expect(Object.keys(golden.rules).sort()).toEqual(['allocation', 'lineAmount', 'tax', 'taxRate', 'total']);
  });

  it.each(golden.cases)('$name', (c) => {
    const r = computeSalesDocument(c.lines, c.defaultTaxRate);
    expect(r.lines.map((l) => ({ amount: l.amount, taxRate: l.taxRate, taxAmount: l.taxAmount }))).toEqual(c.expect.lines);
    expect(r.subtotal).toBe(c.expect.subtotal);
    expect(r.taxableBase).toBe(c.expect.taxableBase);
    expect(r.taxTotal).toBe(c.expect.taxTotal);
    expect(r.total).toBe(c.expect.total);
    // Line taxes sum to the document tax exactly; the total adds up.
    const lineTax = r.lines.reduce((s, l) => s.plus(l.taxAmount), new Decimal(0));
    expect(lineTax.toFixed(2)).toBe(r.taxTotal);
    expect(new Decimal(r.subtotal).plus(r.taxTotal).toFixed(2)).toBe(r.total);
    // Each line amount is the line rule.
    c.lines.forEach((l, i) => expect(salesLineAmount(l.quantity, l.unitPrice)).toBe(c.expect.lines[i]!.amount));
  });

  it.each(golden.errors)('refuses: $name', (c) => {
    let err: unknown;
    try { computeSalesDocument(c.lines, '0'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(c.error);
  });
});

describe('allocateCents', () => {
  it('always sums to the rounded total, for random mixed-sign shares', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let run = 0; run < 500; run++) {
      const n = 1 + Math.floor(rnd() * 8);
      const rate = new Decimal(Math.floor(rnd() * 1500)).dividedBy(10000);
      const amounts = Array.from({ length: n }, () => new Decimal(Math.floor(rnd() * 200000) - 50000).dividedBy(100));
      const shares = amounts.map((a) => a.times(rate));
      const total = amounts.reduce((s, a) => s.plus(a), new Decimal(0)).times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const cents = allocateCents(shares, total);
      expect(cents.reduce((s, c) => s.plus(c), new Decimal(0)).equals(total)).toBe(true);
      // No line moves more than a cent from its exact share.
      cents.forEach((c, i) => expect(c.minus(shares[i]!).abs().lessThan('0.01')).toBe(true));
    }
  });
});
