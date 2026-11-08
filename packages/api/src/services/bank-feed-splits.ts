// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Exact Bank Feed split math (U-164, feed-exact-v1). Every amount is a
// decimal.js value; nothing here goes through a JavaScript number.
//
// Rules:
//   - The item amount is split by its absolute value. A split item amount
//     must be whole cents: more than 2 decimals is 400 AMOUNT_NOT_CENTS.
//   - Percentage splits (staged by a split_by_percentage rule) must total
//     exactly 100 as decimals, else 400 SPLITS_DONT_BALANCE {kind:
//     'percentage', percentTotal}. Each line gets floor(total x pct / 100) in
//     cents; the cents left over (fewer than the number of lines) go one each
//     to the lines with the largest remainders, and equal remainders are
//     settled by line order (earlier line first). 100.00 at 33.334 / 33.333
//     / 33.333% is 33.34 / 33.33 / 33.33; 0.03 at 50 / 50% is 0.02 / 0.01.
//     (Three equal thirds can't total exactly 100 as decimals.)
//   - Fixed splits (a split_by_fixed rule, or the owner's lines) are each
//     rounded to cents half away from zero and must then add up exactly to
//     |amount|, else 400 SPLITS_DONT_BALANCE {kind: 'fixed', difference}
//     where difference = |amount| - sum of the lines. A negative fixed line
//     (rules allow one) posts on the other side of the entry.
//   - Lines that come out at 0.00 are left off the entry.

import DecimalLib from 'decimal.js';
import { AppError } from '../utils/errors.js';

// 50 significant digits: a 12-digit amount in cents times a percentage that
// prints with up to 17 significant digits stays exact before the floor.
const Decimal = (DecimalLib.default || DecimalLib).clone({ precision: 50 });
type Dec = InstanceType<typeof Decimal>;

export type StagedSplitsConfig =
  | { kind: 'percentage'; splits: Array<{ accountId: string; percent: number | string; tagId?: string | null; memo?: string | null }> }
  | { kind: 'fixed'; splits: Array<{ accountId: string; amount: string; tagId?: string | null; memo?: string | null }> };

export interface SplitLineAmount {
  accountId: string;
  /** Signed amount in cents precision; negative = the other side of the entry. */
  amount: Dec;
  tagId: string | null;
  memo: string | null;
}

/** 400 AMOUNT_NOT_CENTS unless the item amount is whole cents. */
export function assertSplittableAmount(itemAmount: string): Dec {
  const abs = new Decimal(itemAmount).abs();
  if (abs.decimalPlaces() > 2) {
    throw AppError.badRequest(
      'This bank line has an amount with more than 2 decimals, so it can\'t be split. Record it to one account.',
      'AMOUNT_NOT_CENTS',
      { amount: abs.toFixed(4) },
    );
  }
  return abs;
}

/**
 * Largest remainder in cents. `percents` must total exactly 100 (checked by
 * the caller). Returns one cents amount per input line, in input order.
 */
export function allocatePercentCents(totalCents: Dec, percents: Dec[]): Dec[] {
  const shares = percents.map((p) => totalCents.times(p).dividedBy(100));
  const floors = shares.map((s) => s.floor());
  let left = totalCents.minus(floors.reduce((a, b) => a.plus(b), new Decimal(0)));
  const order = shares
    .map((s, i) => ({ i, frac: s.minus(floors[i]!) }))
    // Largest remainder first; equal remainders by line order.
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  const out = floors.slice();
  for (const { i } of order) {
    if (left.lte(0)) break;
    out[i] = out[i]!.plus(1);
    left = left.minus(1);
  }
  return out;
}

/**
 * The split lines for an item, exact to the cent, or a 400 with a code.
 * Only lines with a non-zero amount are returned.
 */
export function computeSplitLines(itemAmount: string, config: StagedSplitsConfig): SplitLineAmount[] {
  const total = assertSplittableAmount(itemAmount);
  let amounts: Dec[];
  if (config.kind === 'percentage') {
    const percents = config.splits.map((s) => new Decimal(String(s.percent)));
    const percentTotal = percents.reduce((a, b) => a.plus(b), new Decimal(0));
    if (!percentTotal.equals(100) || percents.some((p) => p.isNegative())) {
      throw AppError.badRequest(
        `The split percentages add up to ${percentTotal.toString()}%, not 100%.`,
        'SPLITS_DONT_BALANCE',
        { kind: 'percentage', percentTotal: percentTotal.toString() },
      );
    }
    amounts = allocatePercentCents(total.times(100), percents).map((c) => c.dividedBy(100));
  } else {
    amounts = config.splits.map((s) => new Decimal(s.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
    const sum = amounts.reduce((a, b) => a.plus(b), new Decimal(0));
    if (!sum.equals(total)) {
      const difference = total.minus(sum);
      throw AppError.badRequest(
        `The split lines add up to ${sum.toFixed(2)} but the bank line is ${total.toFixed(2)} `
          + `(difference ${difference.toFixed(2)}).`,
        'SPLITS_DONT_BALANCE',
        { kind: 'fixed', difference: difference.toFixed(2), splitTotal: sum.toFixed(2), amount: total.toFixed(2) },
      );
    }
  }
  const lines: SplitLineAmount[] = [];
  config.splits.forEach((s, i) => {
    const amount = amounts[i]!;
    if (amount.isZero()) return;
    lines.push({ accountId: s.accountId, amount, tagId: s.tagId ?? null, memo: s.memo ?? null });
  });
  return lines;
}
