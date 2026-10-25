// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Exact item-line and terms-discount arithmetic for A/P documents (U-85,
 * U-86). Decimal with 40 significant digits, so a product of a 12-digit
 * quantity and a 19-digit price is exact before it is rounded; decimal.js's
 * default precision (20) would round it first. Golden cases shared with
 * ClientLedger: packages/shared/fixtures/ap-amount-golden.json.
 */

import DecimalLib from 'decimal.js';
import { AppError } from './errors.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;

// journal_lines.quantity is numeric(12,4): positive, below 100,000,000.
const QUANTITY_RE = /^\d{1,8}(\.\d{1,4})?$/;
// journal_lines.unit_price is numeric(19,4): not negative.
const UNIT_PRICE_RE = /^\d{1,15}(\.\d{1,4})?$/;
// A money column holds at most 15 integer digits (numeric(19,4)).
const MONEY_LIMIT = new Decimal('1e15');

export function parseQuantity(value: unknown, field: string): DecimalValue {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!QUANTITY_RE.test(s) || !new Decimal(s).greaterThan(0)) {
    throw AppError.badRequest(
      `${field} must be a quantity greater than 0 and below 100,000,000 with at most 4 decimal places`,
      'VALIDATION_ERROR',
    );
  }
  return new Decimal(s);
}

export function parseUnitPrice(value: unknown, field: string): DecimalValue {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!UNIT_PRICE_RE.test(s)) {
    throw AppError.badRequest(`${field} must be a price of 0 or more with at most 4 decimal places`, 'VALIDATION_ERROR');
  }
  return new Decimal(s);
}

/** True when |amount| fits a numeric(19,4) money column. */
export function fitsMoneyColumn(amount: DecimalValue | string): boolean {
  return new Decimal(amount).abs().lessThan(MONEY_LIMIT);
}

/**
 * quantity x unitPrice rounded half away from zero to cents (D6, U-85), as
 * a 2-place string. Refuses (400 VALIDATION_ERROR) a quantity or price out
 * of bounds and a product that would not fit a money column.
 */
export function lineAmountFromQuantity(quantity: unknown, unitPrice: unknown, field = 'line'): string {
  const q = parseQuantity(quantity, `${field}.quantity`);
  const p = parseUnitPrice(unitPrice, `${field}.unitPrice`);
  const amount = q.times(p).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!fitsMoneyColumn(amount)) {
    throw AppError.badRequest(`${field}: quantity x unitPrice is too large`, 'VALIDATION_ERROR');
  }
  return amount.toFixed(2);
}

/**
 * Early-payment discount on an amount: amount x percent / 100, rounded half
 * away from zero to cents (U-86; P18 Pay Bills takes it). 218.44 at 2 % is
 * 4.3688, so 4.37.
 */
export function termsDiscountAmount(amount: string, percent: string): string {
  return new Decimal(amount).times(percent).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Two decimal strings equal as numbers ("1480" and "1480.00"). */
export function sameAmount(a: string, b: string): boolean {
  return new Decimal(a).equals(new Decimal(b));
}
