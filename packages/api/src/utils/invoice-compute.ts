// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Invoice pricing (U-129, invoice-pricing-v1): every figure of an invoice
 * from what the owner typed, with item kinds (U-39a) and price levels
 * (U-40). Pure: the service resolves the items and the client's price level
 * and passes them in, so POST /invoices/preview and POST / PUT /invoices run
 * exactly this. Golden cases: packages/shared/fixtures/invoice-golden.json
 * (pricingRules, pricingCases, pricingErrors).
 *
 *   unit price  (service, non_inventory, other_charge, or no item) the line's
 *               unitPrice when sent ('input'); else the level's fixed price
 *               for the item ('price_level'); else round2(item price x
 *               (1 + level percent / 100)), half away from zero
 *               ('price_level_percent'); else the item's price ('item');
 *               else 400 VALIDATION_ERROR. quantity omitted is 1.
 *   discount    applies to the group: the signed sum of the line amounts
 *               since the last subtotal line (earlier discounts included);
 *               a discount right under a subtotal takes that subtotal's
 *               amount, and each discount right under that one the subtotal
 *               less the discounts between (stacked discounts compound);
 *               nothing above it is a group of 0.00. Percent (the
 *               line's discountPercent, else the item's, 0 < p <= 100):
 *               amount = -round2(group x p / 100), half away from zero;
 *               0.00 when the group is 0.00 or less (a discount never adds).
 *               Amount (the line's unitPrice, else the item's price):
 *               amount = -|round2(price)|; quantity is not used. Sending
 *               both discountPercent and unitPrice is 400. Taxable unless
 *               marked otherwise (item default true): a taxable discount is
 *               a negative taxable line, so it reduces the taxable base
 *               (Q-P20t); a non-taxable one leaves the base whole.
 *   subtotal    amount = the signed sum of the line amounts since the
 *               previous subtotal; shown only: it is not part of the
 *               document subtotal, the taxable base or the total, and is
 *               never taxed. quantity / unitPrice are ignored.
 *   tax, total  the U-122 rule (sales-compute.ts computeSalesTotals); a
 *               rate's taxable base below 0.00 taxes 0.00 when the document
 *               subtotal is above 0.00 (Q-P20ag); a wholly negative document
 *               reverses its tax (Q-P20aj).
 */

import DecimalLib from 'decimal.js';
import { AppError } from './errors.js';
import {
  computeSalesTotals, parseSalesQuantity, parseSalesUnitPrice, salesLineAmount, type SalesDocumentResult,
} from './sales-compute.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;

export type SalesItemType = 'service' | 'non_inventory' | 'other_charge' | 'discount' | 'subtotal';
export type UnitPriceSource = 'input' | 'item' | 'price_level' | 'price_level_percent' | 'none' | 'billable_cost';

/**
 * A billable cost's figures on an invoice (U-128, billable-costs-v1; golden
 * billableCases). Half away from zero, sign kept:
 *   costAmount   = round2(source cost), the source line's debit - credit
 *   markupAmount = round2(costAmount x markupPercent / 100); a negative cost
 *                  takes no markup and passes through at cost (Q-P20z), so
 *                  its effective markupPercent is 0
 *   amount       = costAmount + markupAmount (one visible line, Q-P20w)
 *   quantity     = the source quantity, else 1
 *   displayRate  = amount / quantity, 4 places (exact when quantity is 1)
 */
export interface BillableFigures {
  costAmount: string;
  markupPercent: string;
  markupAmount: string;
  amount: string;
  quantity: string;
  displayRate: string;
}

const MARKUP_RE = /^\d{1,4}(\.\d{1,4})?$/;

/** A markup percent: "0" to "1000", at most 4 places (10 = 10 %). */
export function parseMarkupPercent(value: unknown, field: string): DecimalValue {
  const s = value === undefined || value === null || value === '' ? '0' : asString(value);
  if (!MARKUP_RE.test(s)) throw invalid(`${field} must be a percent from 0 to 1000 with at most 4 decimal places, such as 10 for 10 %`);
  const p = new Decimal(s);
  if (p.greaterThan(1000)) throw invalid(`${field} must be from 0 to 1000`);
  return p;
}

export function billableFigures(sourceCost: unknown, sourceQuantity: unknown, markupPercent: unknown, field = 'line'): BillableFigures {
  const cost = new Decimal(asString(sourceCost) || '0').toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const sent = parseMarkupPercent(markupPercent, `${field}.markupPercent`);
  const pct = cost.isNegative() ? new Decimal(0) : sent;
  let markup = cost.times(pct).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (markup.isZero()) markup = new Decimal(0);
  const amount = cost.plus(markup);
  const q = present(sourceQuantity) ? new Decimal(asString(sourceQuantity)) : new Decimal(1);
  const quantity = q.isZero() ? new Decimal(1) : q;
  return {
    costAmount: (cost.isZero() ? new Decimal(0) : cost).toFixed(2),
    markupPercent: pct.toFixed(4),
    markupAmount: markup.toFixed(2),
    amount: (amount.isZero() ? new Decimal(0) : amount).toFixed(2),
    quantity: quantity.toFixed(4).replace(/\.?0+$/, '') || '0',
    displayRate: amount.dividedBy(quantity).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
  };
}

/** The item a line names, as the service read it (prices are decimal strings). */
export interface PricingItem {
  id: string;
  type: SalesItemType;
  unitPrice: string | null;
  discountPercent: string | null;
}

/** The client's price level: a signed percent and fixed prices by item id. */
export interface PricingLevel {
  percent: string;
  itemPrices: Readonly<Record<string, string>>;
}

export interface InvoiceComputeLineInput {
  item?: PricingItem | null;
  quantity?: unknown;
  unitPrice?: unknown;
  discountPercent?: unknown;
  /** Resolved taxable flag (the request's, else the item's, else false). */
  isTaxable: boolean;
  taxRate?: unknown;
  /**
   * A billable cost (U-128): the line is this fixed amount, never priced
   * from the item or a price level; quantity and unitPrice (the display
   * rate) are the figures' own.
   */
  billable?: BillableFigures | null;
}

export interface InvoiceComputeLine {
  /** The item's kind; null for a line without an item. */
  itemType: SalesItemType | null;
  /** The quantity used (null on discount and subtotal lines). */
  quantity: string | null;
  /** The price used (a discount amount is negative; null on percent discounts and subtotals). */
  unitPrice: string | null;
  unitPriceSource: UnitPriceSource;
  /** The percent a percent discount used (4 places), else null. */
  discountPercent: string | null;
  /** 2 places. A subtotal line's amount is shown only. */
  amount: string;
  isTaxable: boolean;
  taxRate: string;
  taxAmount: string;
}

export interface InvoiceComputeResult extends Omit<SalesDocumentResult, 'lines'> {
  lines: InvoiceComputeLine[];
}

const PERCENT_RE = /^\d{1,3}(\.\d{1,4})?$/;
const LEVEL_PERCENT_RE = /^-?\d{1,4}(\.\d{1,4})?$/;

function invalid(message: string): AppError {
  return AppError.badRequest(message, 'VALIDATION_ERROR');
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '';
const asString = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** A discount percent: 0 < p <= 100, at most 4 places. */
export function parseDiscountPercent(value: unknown, field: string): DecimalValue {
  const s = asString(value);
  if (!PERCENT_RE.test(s)) throw invalid(`${field} must be a percent above 0 and at most 100, with at most 4 decimal places`);
  const p = new Decimal(s);
  if (p.lessThanOrEqualTo(0) || p.greaterThan(100)) throw invalid(`${field} must be a percent above 0 and at most 100`);
  return p;
}

/** A price level percent: -100 <= p <= 1000 (signed; -7.5 is 7.5 % down), at most 4 places. */
export function parseLevelPercent(value: unknown, field: string): DecimalValue {
  const s = asString(value);
  if (!LEVEL_PERCENT_RE.test(s)) throw invalid(`${field} must be a percent with at most 4 decimal places, such as -7.5 or 10`);
  const p = new Decimal(s);
  if (p.lessThan(-100) || p.greaterThan(1000)) throw invalid(`${field} must be from -100 to 1000`);
  return p;
}

/** round2(base x (1 + percent / 100)), half away from zero (U-40). */
export function priceLevelPrice(base: unknown, percent: unknown): string {
  const b = parseSalesUnitPrice(base, 'unitPrice');
  const p = parseLevelPercent(percent, 'percent');
  return b.times(new Decimal(1).plus(p.dividedBy(100))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** A fixed level price, rounded half away from zero to the cent; 0 and up. */
export function roundLevelItemPrice(value: unknown, field: string): string {
  const p = parseSalesUnitPrice(value, field);
  if (p.isNegative()) throw invalid(`${field} must be 0 or more`);
  return p.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function itemLinePrice(
  l: InvoiceComputeLineInput, level: PricingLevel | null | undefined, field: string,
): { unitPrice: string; source: UnitPriceSource } {
  if (present(l.unitPrice)) return { unitPrice: asString(l.unitPrice), source: 'input' };
  const item = l.item;
  if (item && level) {
    const fixed = level.itemPrices[item.id];
    if (fixed !== undefined) return { unitPrice: new Decimal(fixed).toFixed(2), source: 'price_level' };
    if (present(item.unitPrice)) return { unitPrice: priceLevelPrice(item.unitPrice, level.percent), source: 'price_level_percent' };
  }
  if (item && present(item.unitPrice)) return { unitPrice: item.unitPrice!, source: 'item' };
  throw invalid(item ? `${field}.unitPrice is required: the item has no price` : `${field}.unitPrice is required`);
}

/**
 * Every figure of an invoice (U-129). `defaultTaxRate`: the request
 * company's default rate; `priceLevel`: the client's level, if any.
 */
export function computeInvoice(
  lines: readonly InvoiceComputeLineInput[],
  opts: { defaultTaxRate: unknown; priceLevel?: PricingLevel | null },
): InvoiceComputeResult {
  const zero = new Decimal(0);
  const out: Array<Omit<InvoiceComputeLine, 'taxRate' | 'taxAmount'>> = [];
  let group = zero;
  let lastSubtotal: DecimalValue | null = null;

  lines.forEach((l, i) => {
    const field = `lines[${i}]`;
    const type = l.item?.type ?? null;

    // A billable cost: a fixed amount in the group like any money line, so a
    // discount after it covers it at its full amount, markup included.
    if (l.billable) {
      const b = l.billable;
      out.push({
        itemType: type, quantity: b.quantity, unitPrice: b.displayRate, unitPriceSource: 'billable_cost',
        discountPercent: null, amount: b.amount, isTaxable: l.isTaxable,
      });
      group = group.plus(b.amount);
      lastSubtotal = null;
      return;
    }

    if (type === 'subtotal') {
      out.push({
        itemType: type, quantity: null, unitPrice: null, unitPriceSource: 'none', discountPercent: null,
        amount: group.toFixed(2), isTaxable: false,
      });
      lastSubtotal = group;
      group = zero;
      return;
    }

    if (type === 'discount') {
      const item = l.item!;
      if (present(l.discountPercent) && present(l.unitPrice)) {
        throw invalid(`${field}: send discountPercent or unitPrice for a discount, not both`);
      }
      const base: DecimalValue = lastSubtotal ?? group;
      let amount: DecimalValue;
      let line: Omit<InvoiceComputeLine, 'taxRate' | 'taxAmount' | 'amount'>;
      const percentRaw = present(l.discountPercent) ? l.discountPercent
        : present(l.unitPrice) ? undefined : item.discountPercent;
      if (present(percentRaw)) {
        const p = parseDiscountPercent(percentRaw, `${field}.discountPercent`);
        // A percent of a base at or below 0.00 is 0.00: a discount never adds.
        amount = base.isPositive() && !base.isZero()
          ? base.times(p).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).negated()
          : zero;
        line = {
          itemType: type, quantity: null, unitPrice: null, discountPercent: p.toFixed(4),
          unitPriceSource: present(l.discountPercent) ? 'input' : 'item', isTaxable: l.isTaxable,
        };
      } else {
        const raw = present(l.unitPrice) ? l.unitPrice : item.unitPrice;
        if (!present(raw)) throw invalid(`${field}: the discount item has no percent or amount; send discountPercent or unitPrice`);
        amount = parseSalesUnitPrice(raw, `${field}.unitPrice`).abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP).negated();
        line = {
          itemType: type, quantity: null, unitPrice: amount.toFixed(2), discountPercent: null,
          unitPriceSource: present(l.unitPrice) ? 'input' : 'item', isTaxable: l.isTaxable,
        };
      }
      if (amount.isZero()) amount = zero; // no "-0.00"
      out.push({ ...line, amount: amount.toFixed(2) });
      group = group.plus(amount);
      // Stacked discounts under a subtotal compound: the next one takes the
      // subtotal less the discounts above it (100.00, Subtotal, 10 %, 5 % is
      // -10.00 then -4.50). The running group is unchanged, so a later
      // subtotal still shows the lines since the previous one.
      lastSubtotal = lastSubtotal === null ? null : lastSubtotal.plus(amount);
      return;
    }

    const quantity = present(l.quantity) ? asString(l.quantity) : '1';
    parseSalesQuantity(quantity, `${field}.quantity`);
    const { unitPrice, source } = itemLinePrice(l, opts.priceLevel, field);
    const amount = salesLineAmount(quantity, unitPrice, field);
    out.push({
      itemType: type, quantity, unitPrice, unitPriceSource: source, discountPercent: null,
      amount, isTaxable: l.isTaxable,
    });
    group = group.plus(amount);
    lastSubtotal = null;
  });

  const totals = computeSalesTotals(out.map((o, i) => (
    o.itemType === 'subtotal'
      ? { amount: '0.00', isTaxable: false }
      : { amount: o.amount, isTaxable: o.isTaxable, taxRate: lines[i]!.taxRate })), opts.defaultTaxRate);

  return {
    ...totals,
    lines: out.map((o, i) => ({ ...o, taxRate: totals.lines[i]!.taxRate, taxAmount: totals.lines[i]!.taxAmount })),
  };
}
