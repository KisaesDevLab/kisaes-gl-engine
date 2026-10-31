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
import { computeInvoice, priceLevelPrice, billableFigures, type InvoiceComputeLineInput, type PricingLevel } from './invoice-compute.js';
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
  pricingRules: Record<string, string>;
  pricingCases: Array<{
    name: string; defaultTaxRate: string; priceLevel?: PricingLevel; lines: InvoiceComputeLineInput[];
    expect: {
      lines: Array<Record<string, string | null>>;
      subtotal: string; taxableBase: string; taxTotal: string; total: string;
    };
  }>;
  pricingErrors: Array<{ name: string; lines: InvoiceComputeLineInput[]; error: string }>;
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

describe('invoice pricing golden cases (item-kinds-sales-v1, price-levels-v1, invoice-pricing-v1)', () => {
  it('states every pricing rule', () => {
    expect(Object.keys(golden.pricingRules).sort()).toEqual(['discount', 'preview', 'priceLevel', 'subtotal', 'unitPrice']);
  });

  it.each(golden.pricingCases)('$name', (c) => {
    const r = computeInvoice(c.lines, { defaultTaxRate: c.defaultTaxRate, priceLevel: c.priceLevel ?? null });
    expect(r.lines.map((l) => ({
      itemType: l.itemType, quantity: l.quantity, unitPrice: l.unitPrice, unitPriceSource: l.unitPriceSource,
      discountPercent: l.discountPercent, amount: l.amount, taxRate: l.taxRate, taxAmount: l.taxAmount,
    }))).toEqual(c.expect.lines);
    expect(r.subtotal).toBe(c.expect.subtotal);
    expect(r.taxableBase).toBe(c.expect.taxableBase);
    expect(r.taxTotal).toBe(c.expect.taxTotal);
    expect(r.total).toBe(c.expect.total);
    const lineTax = r.lines.reduce((s, l) => s.plus(l.taxAmount), new Decimal(0));
    expect(lineTax.toFixed(2)).toBe(r.taxTotal);
    // The document subtotal leaves the subtotal lines out.
    const money = r.lines.filter((l) => l.itemType !== 'subtotal').reduce((s, l) => s.plus(l.amount), new Decimal(0));
    expect(money.toFixed(2)).toBe(r.subtotal);
    expect(new Decimal(r.subtotal).plus(r.taxTotal).toFixed(2)).toBe(r.total);
  });

  it.each(golden.pricingErrors)('refuses: $name', (c) => {
    let err: unknown;
    try { computeInvoice(c.lines, { defaultTaxRate: '0' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(c.error);
  });

  it('the E1 cases give the same figures through computeInvoice', () => {
    for (const c of golden.cases) {
      const r = computeInvoice(c.lines, { defaultTaxRate: c.defaultTaxRate });
      expect(r.lines.map((l) => ({ amount: l.amount, taxRate: l.taxRate, taxAmount: l.taxAmount }))).toEqual(c.expect.lines);
      expect([r.subtotal, r.taxableBase, r.taxTotal, r.total]).toEqual([c.expect.subtotal, c.expect.taxableBase, c.expect.taxTotal, c.expect.total]);
    }
  });

  it('priceLevelPrice: -7.5 % of 32.50 is 30.06; +5 % of 0.30 is 0.32; -100 % is 0.00', () => {
    expect(priceLevelPrice('32.50', '-7.5')).toBe('30.06');
    expect(priceLevelPrice('0.30', '5')).toBe('0.32');
    expect(priceLevelPrice('19.99', '-100')).toBe('0.00');
    expect(() => priceLevelPrice('1', '-100.5')).toThrow(AppError);
  });
});

interface BillableIn { sourceCost: string; sourceQuantity: string | null; markupPercent: string }
const billableGolden = golden as unknown as {
  billableRules: Record<string, string>;
  billableCases: Array<{
    name: string; defaultTaxRate: string; priceLevel?: PricingLevel;
    lines: Array<Omit<InvoiceComputeLineInput, 'billable'> & { billable?: BillableIn }>;
    expect: { lines: Array<Record<string, string | null>>; subtotal: string; taxableBase: string; taxTotal: string; total: string };
  }>;
  billableErrors: Array<{ name: string; billable: BillableIn; error: string }>;
};

describe('billable cost golden cases (billable-costs-v1, U-128)', () => {
  it('states every billable rule', () => {
    expect(Object.keys(billableGolden.billableRules).sort()).toEqual(['cost', 'journal', 'line', 'markup']);
  });

  it.each(billableGolden.billableCases)('$name', (c) => {
    const figures = c.lines.map((l) => (l.billable
      ? billableFigures(l.billable.sourceCost, l.billable.sourceQuantity, l.billable.markupPercent) : null));
    const r = computeInvoice(c.lines.map((l, i) => ({ ...l, billable: figures[i] })), {
      defaultTaxRate: c.defaultTaxRate, priceLevel: c.priceLevel ?? null,
    });
    expect(r.lines.map((l, i) => ({
      costAmount: figures[i]?.costAmount ?? null,
      markupPercent: figures[i]?.markupPercent ?? null,
      markupAmount: figures[i]?.markupAmount ?? null,
      amount: l.amount, quantity: l.quantity, unitPrice: l.unitPrice, taxAmount: l.taxAmount,
    }))).toEqual(c.expect.lines);
    expect([r.subtotal, r.taxableBase, r.taxTotal, r.total])
      .toEqual([c.expect.subtotal, c.expect.taxableBase, c.expect.taxTotal, c.expect.total]);
    r.lines.forEach((l, i) => {
      const f = figures[i];
      if (!f) return;
      expect(l.unitPriceSource).toBe('billable_cost');
      // amount = cost + markup; markup = round2(cost x pct / 100).
      expect(new Decimal(f.costAmount).plus(f.markupAmount).toFixed(2)).toBe(l.amount);
      expect(new Decimal(f.costAmount).times(f.markupPercent).dividedBy(100)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)).toBe(f.markupAmount === '0.00' ? '0.00' : f.markupAmount);
    });
  });

  it.each(billableGolden.billableErrors)('refuses: $name', (c) => {
    let err: unknown;
    try { billableFigures(c.billable.sourceCost, c.billable.sourceQuantity, c.billable.markupPercent); } catch (e) { err = e; }
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
