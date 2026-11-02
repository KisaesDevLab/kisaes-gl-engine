// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Sales-form money to the cent (U-122, sales-cents-v1): invoices and cash
 * sales (sales receipts) use computeSalesDocument; credit memos use
 * salesLineAmount for their lines. Golden cases shared with ClientLedger:
 * packages/shared/fixtures/invoice-golden.json.
 *
 *   line amount = round2(quantity x unitPrice), half away from zero.
 *   tax         = round2(taxable base x rate), half away from zero, ONCE per
 *                 document and rate (the taxable base is the signed sum of
 *                 the taxable line amounts at that rate; a taxable negative
 *                 line, such as a discount, reduces it).
 *   line tax    = the document tax allocated to the taxable lines at that
 *                 rate by largest remainder: each line's exact share
 *                 (amount x rate) in cents is floored (toward minus
 *                 infinity), and the cents left over go one each to the
 *                 lines with the largest remainder, the earlier line first
 *                 on a tie. The line taxes sum to the document tax exactly,
 *                 whatever the signs.
 *   total       = subtotal + tax.
 *
 * Decimal at 40 significant digits, so nothing is rounded before the step
 * that says so.
 */

import DecimalLib from 'decimal.js';
import { AppError } from './errors.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;

// journal_lines.quantity is numeric(12,4); unit_price numeric(19,4). Sales
// lines may be negative (a returned item, a discount typed as a line).
const QUANTITY_RE = /^-?\d{1,8}(\.\d{1,4})?$/;
const UNIT_PRICE_RE = /^-?\d{1,15}(\.\d{1,4})?$/;
// A plain decimal rate (fraction, "0.0825" = 8.25 %).
const RATE_RE = /^\d{1,4}(\.\d+)?$/;
const MONEY_LIMIT = new Decimal('1e15');

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return AppError.badRequest(message, 'VALIDATION_ERROR', details);
}

export function parseSalesQuantity(value: unknown, field: string): DecimalValue {
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!QUANTITY_RE.test(s)) {
    throw invalid(`${field} must be a quantity below 100,000,000 with at most 4 decimal places`);
  }
  return new Decimal(s);
}

export function parseSalesUnitPrice(value: unknown, field: string): DecimalValue {
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!UNIT_PRICE_RE.test(s)) {
    throw invalid(`${field} must be a price with at most 4 decimal places`);
  }
  return new Decimal(s);
}

/** Places a sales tax rate (a fraction) keeps: 8.875 % is 0.088750 (U-148). */
export const TAX_RATE_PLACES = 6;

/**
 * A document line's tax rate as a fraction, rounded half away from zero to
 * the 6 places journal_lines.tax_rate stores (U-148), so the rate used is
 * the rate stored. Lenient on purpose (review B3): a browser that divides a
 * percent by 100 sends the JSON number 0.011000000000000001 for 1.1 %; that
 * is 0.011000 here, never a 400. Below 0 or 1 (100 %) and up: 400
 * VALIDATION_ERROR.
 */
export function parseSalesTaxRate(value: unknown, field: string): DecimalValue {
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!RATE_RE.test(s)) throw invalid(`${field} must be a tax rate written as a fraction, such as 0.0825`);
  const rate = new Decimal(s).toDecimalPlaces(TAX_RATE_PLACES, Decimal.ROUND_HALF_UP);
  if (rate.greaterThanOrEqualTo(1)) throw invalid(`${field} must be below 1 (100 %)`);
  return rate;
}

const SETUP_RATE_RE = /^0?\.\d{1,6}$|^0$/;

/**
 * A sales tax item's rate (setup routes, U-148): a decimal string fraction
 * with at most 6 places, 0 <= rate < 1. Strict: no numbers, no rounding.
 */
export function parseSetupTaxRate(value: unknown, field: string): DecimalValue {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!SETUP_RATE_RE.test(s)) {
    throw invalid(`${field} must be a fraction written as a string with at most 6 decimal places, such as "0.088750" for 8.875 %`, { field });
  }
  return new Decimal(s);
}

/** A stored rate (any scale) as the 6-place wire string. */
export function formatTaxRate(value: unknown): string {
  return new Decimal(value === null || value === undefined || value === '' ? '0' : String(value)).toFixed(TAX_RATE_PLACES);
}

/** round2(quantity x unitPrice), half away from zero, as a 2-place string. */
export function salesLineAmount(quantity: unknown, unitPrice: unknown, field = 'line'): string {
  const amount = parseSalesQuantity(quantity, `${field}.quantity`)
    .times(parseSalesUnitPrice(unitPrice, `${field}.unitPrice`))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (amount.abs().greaterThanOrEqualTo(MONEY_LIMIT)) throw invalid(`${field}: quantity x unitPrice is too large`);
  return amount.toFixed(2);
}

export interface SalesLineInput {
  quantity: unknown;
  unitPrice: unknown;
  /** Resolved taxable flag (the request's, else the item's, else false). */
  isTaxable: boolean;
  /** The line's own rate when sent (fraction); absent uses the document default. */
  taxRate?: unknown;
}

export interface SalesLineResult {
  /** 2-place amount. */
  amount: string;
  /** The rate applied, 6 places ("0.000000" when not taxable; U-148). */
  taxRate: string;
  /** 2-place share of the document tax ("0.00" when not taxable). */
  taxAmount: string;
  isTaxable: boolean;
}

export interface SalesDocumentResult {
  lines: SalesLineResult[];
  subtotal: string;
  /** Sum of each rate's taxable base (the signed sum of its taxable lines), a negative base counted as 0.00 when the document subtotal is above 0.00 (Q-P20ag, Q-P20aj). */
  taxableBase: string;
  taxTotal: string;
  total: string;
  /** One entry per distinct rate with taxable lines, in first-seen order; a negative base shows as 0.00 with tax 0.00. */
  taxGroups: Array<{ rate: string; base: string; tax: string }>;
  /**
   * With a sales tax (U-147): one entry per item (a group's members in
   * order), the document tax allocated by base x item rate. Absent on the
   * legacy per-rate path.
   */
  salesTaxMembers?: Array<{ itemId: string; rate: string; base: string; tax: string }>;
}

/** A document's one sales tax (Q-P23d): an item, or a group whose members are charged together. */
export interface SalesTaxUnit {
  id: string;
  /** Each item with its rate (a 6-place fraction string); one entry for an item, 1-10 for a group. */
  members: ReadonlyArray<{ itemId: string; rate: string }>;
}

/**
 * The document tax with one sales tax (Q-P23d, U-147): unit rate = the sum
 * of the members' rates; base = the signed sum of the taxable lines (floored
 * at 0.00 on a document with a positive subtotal, Q-P20ag); tax =
 * round2(base x unit rate) once; lines get allocateCents(line x unit rate)
 * and members allocateCents(base x member rate). A floored base gives every
 * line and member 0.00 without allocating (S3).
 */
function computeWithSalesTax(lines: readonly SalesAmountInput[], unit: SalesTaxUnit): SalesDocumentResult {
  const memberRates = unit.members.map((m) => new Decimal(m.rate));
  const rate = memberRates.reduce<DecimalValue>((s, r) => s.plus(r), new Decimal(0));
  const amounts = lines.map((l) => new Decimal(l.amount));
  const subtotal = amounts.reduce<DecimalValue>((s, a) => s.plus(a), new Decimal(0));
  const taxableIdx = lines.flatMap((l, i) => (l.isTaxable ? [i] : []));
  const rawBase = taxableIdx.reduce<DecimalValue>((s, i) => s.plus(amounts[i]!), new Decimal(0));
  const floored = subtotal.greaterThan(0) && rawBase.isNegative();
  const base = floored ? new Decimal(0) : rawBase;
  const tax = base.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const taxes = lines.map(() => new Decimal(0));
  let memberTax = memberRates.map(() => new Decimal(0));
  if (!tax.isZero()) {
    const shares = allocateCents(taxableIdx.map((i) => amounts[i]!.times(rate)), tax);
    taxableIdx.forEach((i, k) => { taxes[i] = shares[k]!; });
    memberTax = allocateCents(memberRates.map((r) => base.times(r)), tax);
  }
  const total = subtotal.plus(tax);
  if (total.abs().greaterThanOrEqualTo(MONEY_LIMIT)) throw invalid('The total is too large');
  const rateText = rate.toFixed(TAX_RATE_PLACES);
  return {
    lines: lines.map((l, i) => ({
      amount: amounts[i]!.toFixed(2),
      taxRate: l.isTaxable ? rateText : new Decimal(0).toFixed(TAX_RATE_PLACES),
      taxAmount: taxes[i]!.toFixed(2),
      isTaxable: l.isTaxable,
    })),
    subtotal: subtotal.toFixed(2),
    taxableBase: base.toFixed(2),
    taxTotal: tax.toFixed(2),
    total: total.toFixed(2),
    taxGroups: taxableIdx.length === 0 || rate.isZero() ? [] : [{ rate: rateText, base: base.toFixed(2), tax: tax.toFixed(2) }],
    salesTaxMembers: unit.members.map((m, k) => ({
      itemId: m.itemId, rate: memberRates[k]!.toFixed(TAX_RATE_PLACES), base: base.toFixed(2), tax: memberTax[k]!.toFixed(2),
    })),
  };
}

/**
 * Allocates `total` (exact cents) over `shares` (exact, any sign) by largest
 * remainder: floor each share to the cent, then one cent each to the largest
 * remainders, the earlier index first on a tie. Exported for the tests.
 */
export function allocateCents(shares: readonly DecimalValue[], total: DecimalValue): DecimalValue[] {
  const hundred = new Decimal(100);
  const floors = shares.map((s) => s.times(hundred).floor());
  const remainders = shares.map((s, i) => s.times(hundred).minus(floors[i]!));
  const floorSum = floors.reduce<DecimalValue>((a, b) => a.plus(b), new Decimal(0));
  const left = total.times(hundred).minus(floorSum);
  // total = round2(sum of shares) and every remainder is in [0, 1), so the
  // cents left over are a whole number from 0 to the number of shares.
  if (!left.isInteger() || left.isNegative() || left.greaterThan(shares.length)) {
    throw AppError.internal('Sales tax allocation out of range');
  }
  const order = remainders.map((r, i) => ({ r, i })).sort((a, b) => b.r.comparedTo(a.r) || a.i - b.i);
  const cents = [...floors];
  for (let k = 0; k < left.toNumber(); k++) cents[order[k]!.i] = cents[order[k]!.i]!.plus(1);
  return cents.map((c) => c.dividedBy(hundred));
}

/**
 * Every figure of an invoice or sales receipt from what the owner typed.
 * `defaultTaxRate`: the request company's default rate (fraction), used by
 * taxable lines that send no rate of their own.
 */
export function computeSalesDocument(lines: readonly SalesLineInput[], defaultTaxRate: unknown): SalesDocumentResult {
  return computeSalesTotals(lines.map((l, i) => ({
    amount: salesLineAmount(l.quantity, l.unitPrice, `lines[${i}]`),
    isTaxable: l.isTaxable,
    taxRate: l.taxRate,
  })), defaultTaxRate);
}

export interface SalesAmountInput {
  /** The line's amount, already to the cent (2-place decimal string). */
  amount: string;
  isTaxable: boolean;
  taxRate?: unknown;
}

/**
 * The tax and totals of lines whose amounts are already computed to the
 * cent (U-122 tax rule; invoice-compute.ts uses it for discount and
 * subtotal lines, U-129). computeSalesDocument is this after the line rule.
 */
export function computeSalesTotals(lines: readonly SalesAmountInput[], defaultTaxRate: unknown, salesTax?: SalesTaxUnit | null): SalesDocumentResult {
  if (salesTax) return computeWithSalesTax(lines, salesTax);
  const fallbackRate = parseSalesTaxRate(defaultTaxRate ?? '0', 'defaultTaxRate');
  const amounts = lines.map((l) => new Decimal(l.amount));
  const rates = lines.map((l, i) => (
    !l.isTaxable ? new Decimal(0)
      : l.taxRate === undefined || l.taxRate === null || l.taxRate === '' ? fallbackRate
        : parseSalesTaxRate(l.taxRate, `lines[${i}].taxRate`)));

  // Group the taxable lines with a rate above zero by rate, first seen first.
  const groups = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (!l.isTaxable || rates[i]!.isZero()) return;
    const key = rates[i]!.toFixed(TAX_RATE_PLACES);
    const g = groups.get(key) ?? [];
    g.push(i);
    groups.set(key, g);
  });

  const taxes = lines.map(() => new Decimal(0));
  const taxGroups: SalesDocumentResult['taxGroups'] = [];
  let taxTotal = new Decimal(0);
  const subtotal = amounts.reduce<DecimalValue>((s, a) => s.plus(a), new Decimal(0));
  // The floor applies only to a document whose subtotal is above 0.00
  // (Q-P20ag, Q-P20aj): a wholly negative invoice or cash sale (a return)
  // reverses its tax.
  const floorBases = subtotal.greaterThan(0);
  for (const [key, idx] of groups) {
    const rate = new Decimal(key);
    const base = idx.reduce<DecimalValue>((s, i) => s.plus(amounts[i]!), new Decimal(0));
    // On a document with a positive subtotal a rate's taxable base never goes
    // below 0.00 (Q-P20ag): a negative base (a taxable discount bigger than
    // the taxable lines) taxes 0.00 and each line of the group gets 0.00; the
    // discount still lowers the total.
    if (floorBases && base.isNegative()) {
      taxGroups.push({ rate: key, base: '0.00', tax: '0.00' });
      continue;
    }
    const tax = base.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const shares = allocateCents(idx.map((i) => amounts[i]!.times(rate)), tax);
    idx.forEach((i, k) => { taxes[i] = shares[k]!; });
    taxGroups.push({ rate: key, base: base.toFixed(2), tax: tax.toFixed(2) });
    taxTotal = taxTotal.plus(tax);
  }

  // Each rate's taxable base, floored at 0.00 when the floor applies, summed;
  // the taxable lines at rate 0 count as one more rate. With no negative base
  // (or no floor) this is the signed sum of the taxable lines, as before.
  const baseByRate = new Map<string, DecimalValue>();
  lines.forEach((l, i) => {
    if (!l.isTaxable) return;
    const key = rates[i]!.toFixed(TAX_RATE_PLACES);
    baseByRate.set(key, (baseByRate.get(key) ?? new Decimal(0)).plus(amounts[i]!));
  });
  const taxableBase = [...baseByRate.values()].reduce<DecimalValue>((s, b) => (floorBases && b.isNegative() ? s : s.plus(b)), new Decimal(0));
  const total = subtotal.plus(taxTotal);
  if (total.abs().greaterThanOrEqualTo(MONEY_LIMIT)) throw invalid('The total is too large');

  return {
    lines: lines.map((l, i) => ({
      amount: amounts[i]!.toFixed(2),
      taxRate: rates[i]!.toFixed(TAX_RATE_PLACES),
      taxAmount: taxes[i]!.toFixed(2),
      isTaxable: l.isTaxable,
    })),
    subtotal: subtotal.toFixed(2),
    taxableBase: taxableBase.toFixed(2),
    taxTotal: taxTotal.toFixed(2),
    total: total.toFixed(2),
    taxGroups,
  };
}
