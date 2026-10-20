// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import DecimalLib from 'decimal.js';
import { AppError } from './errors.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

// A money amount as the API takes it: a decimal string, optionally signed,
// with at most four places (the scale of every money column). Anything else
// (exponents, thousands separators, currency signs, a fifth place the
// database would round away) is refused instead of being coerced.
const MONEY_RE = /^-?\d{1,15}(\.\d{1,4})?$/;

/**
 * Parse a money string exactly. Throws 400 VALIDATION_ERROR naming `field`
 * when the value is not a plain decimal with up to four places.
 */
export function exactAmount(value: unknown, field: string): DecimalValue {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!MONEY_RE.test(s)) {
    throw AppError.badRequest(`${field} must be a decimal amount with at most 4 decimal places`, 'VALIDATION_ERROR');
  }
  return new Decimal(s);
}

/** Exact sum of money strings (each validated by exactAmount). */
export function exactSum(values: Array<{ value: unknown; field: string }>): DecimalValue {
  return values.reduce<DecimalValue>((sum, v) => sum.plus(exactAmount(v.value, v.field)), new Decimal(0));
}
