// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Average-cost walk of one item's stock ledger (U-157, U-158;
 * inventory-costing-v1). Pure: no database. The costing service feeds it the
 * item's movements in position order from the first affected position, with
 * the state stored just before; it returns every row's written and true
 * figures and the running state after each row.
 *
 * Position: (date, sortRank, transaction created_at, transaction id).
 * State: Q on hand; P posted value (what the GL holds); T true value; L the
 * true average round6(T/Q) after the latest row that left Q > 0 and T > 0.
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

export type MovementKind = 'receipt' | 'sale' | 'customer_return' | 'vendor_return' | 'adjust_qty' | 'adjust_value' | 'restatement';

export interface WalkState {
  /** On hand. */
  q: Dec;
  /** Posted value: what the asset account holds for the item. */
  p: Dec;
  /** True value: the value if no closed period had frozen anything. */
  t: Dec;
  /** True last positive average (0 = none yet). */
  l: Dec;
}

export const ZERO_STATE: WalkState = { q: ZERO, p: ZERO, t: ZERO, l: ZERO };

export interface WalkRow {
  id: string;
  date: string;
  kind: MovementKind;
  /** Signed quantity (in > 0, out < 0; 0 for value-only and restatements). */
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
  /** Dated on or before the closing date and not the overridden trigger's own row: keeps its stored figures. */
  frozen: boolean;
  /** Stored written figures (asset effects), used for frozen rows. */
  stored: { value: Dec; correction: Dec; residual: Dec };
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
  /** What the row writes (stored figures when frozen; for restatements T - P). */
  written: RowFigures;
  /** What the row is worth on the true ledger. */
  truth: RowFigures;
  /** State after the row (running_qty, running_value = P, true_value = T, last_cost = L). */
  after: WalkState;
  /** A restatement re-valued to 0: void it. */
  voidRestatement?: boolean;
}

export interface NegativeStock { rowId: string; date: string; onHand: Dec }

export interface WalkResult {
  rows: RowResult[];
  /**
   * Set when the walk crossed the closing date with P != T and no open
   * restatement at closing + 1: the caller inserts one there with this
   * value (asset effect), then P = T. `afterRowId` is the last closed row
   * walked (null when the seed itself was the last closed row).
   */
  restatement: { value: Dec; state: WalkState } | null;
  /** The first row whose running quantity newly went below 0. */
  negative: NegativeStock | null;
  final: WalkState;
}

export interface WalkOptions {
  /** The company's closing date (YYYY-MM-DD) or null. */
  closingDate: string | null;
  /**
   * The walk starts at or before the closing date (its first affected
   * position is dated on or before it): the boundary check runs once.
   */
  startsInClosedPeriod: boolean;
}

/** Relief of q > 0 units at cost from state s (Q-P24c, Q-P24d). */
export function reliefAtCost(s: WalkState, q: Dec, fallbackCost: Dec | null): Dec {
  if (s.q.greaterThan(0) && q.lessThanOrEqualTo(s.q)) return round2(s.t.times(q).dividedBy(s.q));
  const excess = q.minus(Decimal.max(s.q, ZERO));
  const c = s.l.greaterThan(0) ? s.l : (fallbackCost ?? ZERO);
  return (s.q.greaterThan(0) ? s.t : ZERO).plus(round2(excess.times(c)));
}

/** Value of r > 0 units coming back in at cost (customer return, adjust up without a value). */
export function inflowAtCost(s: WalkState, r: Dec, fallbackCost: Dec | null): Dec {
  if (s.q.greaterThan(0)) return round2(s.t.times(r).dividedBy(s.q));
  const c = s.l.greaterThan(0) ? s.l : (fallbackCost ?? ZERO);
  return round2(r.times(c));
}

/**
 * The true figures of one row from state s (on T), and the state after it.
 * Restatements are not handled here.
 */
export function trueRow(s: WalkState, row: WalkRow): { fig: RowFigures; q: Dec; t: Dec } {
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
    const c = round2(value.times(k).dividedBy(qty)).minus(round2(s.t.negated().times(k).dividedBy(s.q.negated())));
    correction = c.negated();
  }
  const q = s.q.plus(qty);
  let t = s.t.plus(value).plus(correction);
  // Residual: a row leaving Q = 0 with value left moves it to COGS.
  let residual = ZERO;
  if (q.isZero() && !t.isZero()) {
    residual = t.negated();
    t = ZERO;
  }
  return { fig: { value, correction, residual }, q, t };
}

const sum = (f: RowFigures) => f.value.plus(f.correction).plus(f.residual);

/** The day after a YYYY-MM-DD date. */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Walks the rows (already in position order, voided rows left out) from
 * `seed`. Rules (P24 plan §2.2): frozen rows keep their stored figures (P
 * advances by them, T by the true ones); an open restatement takes T - P;
 * any other open row is recomputed from T and written; after the last row
 * on or before the closing date, if P != T and no open restatement follows
 * at closing + 1, one is asked for.
 */
export function walk(seed: WalkState, rows: readonly WalkRow[], opts: WalkOptions): WalkResult {
  let s: WalkState = { ...seed };
  const out: RowResult[] = [];
  let restatement: WalkResult['restatement'] = null;
  let negative: NegativeStock | null = null;
  const closing = opts.closingDate;
  let boundaryDone = !closing || !opts.startsInClosedPeriod;

  const boundary = (next: WalkRow | undefined) => {
    if (boundaryDone) return;
    boundaryDone = true;
    if (s.p.equals(s.t)) return;
    // An open restatement at closing + 1 re-values itself (rule 2).
    if (next && next.kind === 'restatement' && next.date === nextDay(closing!)) return;
    restatement = { value: s.t.minus(s.p), state: { ...s, p: s.t } };
    s = { ...s, p: s.t };
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (closing && row.date > closing) boundary(row);
    const before = s;
    if (row.kind === 'restatement') {
      if (row.frozen) {
        const w = row.stored;
        s = { ...s, p: s.p.plus(sum(w)) };
        out.push({ id: row.id, written: w, truth: { value: ZERO, correction: ZERO, residual: ZERO }, after: { ...s } });
      } else {
        const value = s.t.minus(s.p);
        s = { ...s, p: s.t };
        out.push({
          id: row.id, written: { value, correction: ZERO, residual: ZERO }, truth: { value: ZERO, correction: ZERO, residual: ZERO },
          after: { ...s }, ...(value.isZero() ? { voidRestatement: true } : {}),
        });
      }
      continue;
    }
    const { fig, q, t } = trueRow(s, row);
    const written = row.frozen ? row.stored : fig;
    const p = s.p.plus(sum(written));
    const l = q.greaterThan(0) && t.greaterThan(0) ? round6(t.dividedBy(q)) : s.l;
    s = { q, p, t, l };
    if (!negative && before.q.greaterThanOrEqualTo(0) && q.lessThan(0)) negative = { rowId: row.id, date: row.date, onHand: q };
    out.push({ id: row.id, written, truth: fig, after: { ...s } });
  }
  boundary(undefined);
  return { rows: out, restatement, negative, final: s };
}

/** Average cost as GET /items shows it: T/Q to 6 places while Q > 0, else the last positive average. */
export function averageCost(s: WalkState): Dec {
  return s.q.greaterThan(0) ? round6(s.t.dividedBy(s.q)) : s.l;
}
