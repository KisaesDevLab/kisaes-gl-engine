// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Average-cost walk of one item's stock ledger (U-157, U-158;
 * inventory-costing-v1). Pure: no database. The costing service feeds it the
 * item's movements in position order from the first affected position, with
 * the state stored just before; it returns every row's figures and the
 * running state after each row.
 *
 * Position: (date, transaction created_at, transaction id). State: Q on
 * hand; V value (what the inventory asset account holds for the item); L
 * the last positive average round6(V/Q) after the latest row that left
 * Q > 0 and V > 0.
 *
 * Closed periods are never re-walked: a document with inventory lines dated
 * on or before the closing date can't be added, edited, voided or deleted
 * (409 INVENTORY_PERIOD_CLOSED, owner decision 2026-11-06), so every walk
 * starts after the closing date and nothing on or before it changes.
 *
 * Money is decimal at 40 digits, rounded half away from zero ("round2",
 * "round6"), negatives included. Golden cases:
 * packages/shared/fixtures/inventory-golden.json.
 */

import DecimalLib from 'decimal.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
export const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Decimal>;

export const round2 = (v: Dec): Dec => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const round6 = (v: Dec): Dec => v.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
const ZERO = new Decimal(0);

export type MovementKind = 'receipt' | 'sale' | 'customer_return' | 'vendor_return' | 'adjust_qty' | 'adjust_value';

export interface WalkState {
  /** On hand. */
  q: Dec;
  /** Value: what the inventory asset account holds for the item. */
  v: Dec;
  /** Last positive average (0 = none yet). */
  l: Dec;
}

export const ZERO_STATE: WalkState = { q: ZERO, v: ZERO, l: ZERO };

export interface WalkRow {
  id: string;
  date: string;
  kind: MovementKind;
  /** Signed quantity (in > 0, out < 0; 0 for value-only adjustments). */
  quantity: Dec;
  /**
   * given: the document carries the value (receipts, vendor returns,
   * adjustments with a value) in `given`, signed as its effect on the asset.
   * derived: valued at cost from the state (sales, customer returns,
   * quantity-only adjustments).
   */
  valueMode: 'given' | 'derived';
  given: Dec | null;
  /** The item's purchase cost when the line was posted or last edited (Q-P24d). */
  fallbackCost: Dec | null;
}

export interface RowFigures {
  /** Asset effect of the row itself (relief is negative). */
  value: Dec;
  /** Asset effect of the negative-stock correction (C > 0 is -C here). */
  correction: Dec;
  /** Asset effect of the zero-quantity residual. */
  residual: Dec;
}

export interface RowResult {
  id: string;
  fig: RowFigures;
  /** State after the row (running_qty, running_value, last_cost). */
  after: WalkState;
}

export interface NegativeStock { rowId: string; date: string; onHand: Dec }

export interface WalkResult {
  rows: RowResult[];
  /** The first row whose running quantity newly went below 0. */
  negative: NegativeStock | null;
  final: WalkState;
}

/** Relief of q > 0 units at cost from state s (Q-P24c, Q-P24d). */
export function reliefAtCost(s: WalkState, q: Dec, fallbackCost: Dec | null): Dec {
  if (s.q.greaterThan(0) && q.lessThanOrEqualTo(s.q)) return round2(s.v.times(q).dividedBy(s.q));
  const excess = q.minus(Decimal.max(s.q, ZERO));
  const c = s.l.greaterThan(0) ? s.l : (fallbackCost ?? ZERO);
  return (s.q.greaterThan(0) ? s.v : ZERO).plus(round2(excess.times(c)));
}

/** Value of r > 0 units coming back in at cost (customer return, adjust up without a value). */
export function inflowAtCost(s: WalkState, r: Dec, fallbackCost: Dec | null): Dec {
  if (s.q.greaterThan(0)) return round2(s.v.times(r).dividedBy(s.q));
  const c = s.l.greaterThan(0) ? s.l : (fallbackCost ?? ZERO);
  return round2(r.times(c));
}

/** The figures of one row from state s, and the state after it. */
export function stepRow(s: WalkState, row: WalkRow): { fig: RowFigures; after: WalkState } {
  const qty = row.quantity;
  let value: Dec;
  if (row.valueMode === 'given') {
    value = row.given ?? ZERO;
  } else if (qty.lessThan(0)) {
    value = reliefAtCost(s, qty.negated(), row.fallbackCost).negated();
  } else if (qty.greaterThan(0)) {
    value = inflowAtCost(s, qty, row.fallbackCost);
  } else {
    value = ZERO;
  }
  // Correction: an inflow of r units while Q < 0 re-prices the k units sold short.
  let correction = ZERO;
  if (qty.greaterThan(0) && s.q.lessThan(0)) {
    const k = Decimal.min(qty, s.q.negated());
    const c = round2(value.times(k).dividedBy(qty)).minus(round2(s.v.negated().times(k).dividedBy(s.q.negated())));
    correction = c.negated();
  }
  const q = s.q.plus(qty);
  let v = s.v.plus(value).plus(correction);
  // Residual: a row leaving Q = 0 with value left moves it to COGS.
  let residual = ZERO;
  if (q.isZero() && !v.isZero()) {
    residual = v.negated();
    v = ZERO;
  }
  const l = q.greaterThan(0) && v.greaterThan(0) ? round6(v.dividedBy(q)) : s.l;
  return { fig: { value, correction, residual }, after: { q, v, l } };
}

/** Walks the rows (in position order, voided rows left out) from `seed`. */
export function walk(seed: WalkState, rows: readonly WalkRow[]): WalkResult {
  let s: WalkState = { ...seed };
  const out: RowResult[] = [];
  let negative: NegativeStock | null = null;
  for (const row of rows) {
    const before = s;
    const { fig, after } = stepRow(s, row);
    s = after;
    if (!negative && before.q.greaterThanOrEqualTo(0) && s.q.lessThan(0)) negative = { rowId: row.id, date: row.date, onHand: s.q };
    out.push({ id: row.id, fig, after: { ...s } });
  }
  return { rows: out, negative, final: s };
}

/** Average cost as GET /items shows it: V/Q to 6 places while Q > 0, else the last positive average. */
export function averageCost(s: WalkState): Dec {
  return s.q.greaterThan(0) ? round6(s.v.dividedBy(s.q)) : s.l;
}
