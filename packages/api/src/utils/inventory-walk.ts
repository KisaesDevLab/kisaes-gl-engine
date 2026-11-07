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
  /** The row's document (a sale's id is what linked returns name). */
  transactionId?: string;
  date: string;
  kind: MovementKind;
  /** Signed quantity (in > 0, out < 0; 0 for value-only adjustments). */
  quantity: Dec;
  /**
   * given: the document carries the value (receipts, vendor returns,
   * adjustments with a value) in `given`, signed as its effect on the asset.
   * derived: valued at cost from the state (sales, customer returns,
   * quantity-only adjustments).
   * linked: a customer return linked to its sale (Q-P24e), valued from the
   * sale's relief by cumulative difference (see walk()).
   */
  valueMode: 'given' | 'derived' | 'linked';
  given: Dec | null;
  /** The linked sale (valueMode linked). */
  sourceId?: string | null;
  /** The item's purchase cost when the line was posted or last edited (Q-P24d). */
  fallbackCost: Dec | null;
  /**
   * A row before the walk start, replayed only to rebuild the short-units
   * queue and the sales its linked returns name (S5): its stored figures and
   * running state are taken as they are, never recomputed.
   */
  fixed?: { fig: RowFigures; after: WalkState };
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

/**
 * A sale as its linked returns see it: R its cost (relief plus the
 * negative-stock corrections attributed to the units it sold short, S5),
 * S units sold, N units already returned and B the value they brought back.
 */
export interface SaleLink { r: Dec; s: Dec; n: Dec; b: Dec }

export interface WalkResult {
  rows: RowResult[];
  /** The first row whose running quantity went below 0 from 0 or more in this walk (the costing service warns against the stored state instead, PR-4 S1). */
  negative: NegativeStock | null;
  final: WalkState;
  /**
   * Per sale walked here (its transaction id): the corrections attributed to
   * the units it sold short (S5), the sale row's correction_share.
   */
  shares: Map<string, Dec>;
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

/**
 * Walks the rows (in position order, voided rows left out) from `seed`.
 * `links`: for every sale a linked row names that is not itself in `rows`
 * (it sits before the walk start), its cost R (stored relief plus its stored
 * correction_share), quantity S, and the quantity N and value B its linked
 * returns before the start already took back. A sale in `rows` registers
 * itself (its returns always come after it). A linked return of q units:
 * value = round2(R x (N + q) / S) - B, so returning every unit gives back
 * exactly R (I7).
 *
 * Corrected sale cost (PR-4 S5, Q-P24e "the original sale cost"): units
 * sold below 0 join a first-short, first-cured queue; an inflow that cures k
 * of them with correction C (the extra cost, -fig.correction) splits C over
 * the units it takes from the queue by cumulative difference
 * (round2(C x K_i / k) - round2(C x K_(i-1) / k)), and each sale's share is
 * added to its R. So a return linked to a sale that was sold short and later
 * re-priced comes back at the corrected cost. The queue is empty whenever
 * on hand is 0 or more; a walk that starts below 0 is given the rows from
 * the start of that stretch as `fixed` rows (stored figures, not recomputed).
 */
export function walk(seed: WalkState, rows: readonly WalkRow[], links: ReadonlyMap<string, SaleLink> = new Map()): WalkResult {
  let s: WalkState = { ...seed };
  const out: RowResult[] = [];
  let negative: NegativeStock | null = null;
  const sales = new Map<string, SaleLink>([...links].map(([k, v]) => [k, { ...v }]));
  const shares = new Map<string, Dec>();
  // Units sold (or taken out) below 0, oldest first; saleId null for a non-sale outflow.
  const short: Array<{ saleId: string | null; units: Dec }> = seed.q.lessThan(0) ? [{ saleId: null, units: seed.q.negated() }] : [];
  for (const row of rows) {
    const before = s;
    let fig: RowFigures;
    let after: WalkState;
    if (row.fixed) {
      ({ fig, after } = row.fixed);
      if (row.valueMode === 'linked') {
        const sale = row.sourceId ? sales.get(row.sourceId) : undefined;
        if (sale) { sale.n = sale.n.plus(row.quantity); sale.b = sale.b.plus(fig.value); }
      }
    } else {
      let input = row;
      if (row.valueMode === 'linked') {
        const sale = row.sourceId ? sales.get(row.sourceId) : undefined;
        if (!sale) throw new Error('inventory walk: a linked return without its sale');
        const value = linkedValue(sale, row.quantity);
        input = { ...row, valueMode: 'given', given: value };
        sale.n = sale.n.plus(row.quantity);
        sale.b = sale.b.plus(value);
      }
      ({ fig, after } = stepRow(s, input));
    }
    s = { ...after };
    if (row.kind === 'sale' && row.transactionId && row.quantity.lessThan(0)) {
      sales.set(row.transactionId, { r: fig.value.negated(), s: row.quantity.negated(), n: ZERO, b: ZERO });
      shares.set(row.transactionId, ZERO);
    }
    trackShort(short, before, row, fig, (saleId, share) => {
      const sale = sales.get(saleId);
      if (sale) sale.r = sale.r.plus(share);
      if (shares.has(saleId)) shares.set(saleId, shares.get(saleId)!.plus(share));
    });
    if (!negative && before.q.greaterThanOrEqualTo(0) && s.q.lessThan(0)) negative = { rowId: row.id, date: row.date, onHand: s.q };
    out.push({ id: row.id, fig, after: { ...s } });
  }
  return { rows: out, negative, final: s, shares };
}

/** The short-units queue after one row (S5): an outflow below 0 joins it; an inflow while below 0 cures from its head. */
function trackShort(short: Array<{ saleId: string | null; units: Dec }>, before: WalkState, row: WalkRow, fig: RowFigures,
  attribute: (saleId: string, share: Dec) => void) {
  const qty = row.quantity;
  if (qty.lessThan(0)) {
    const excess = qty.negated().minus(Decimal.max(before.q, ZERO));
    if (excess.greaterThan(0)) short.push({ saleId: row.kind === 'sale' && row.transactionId ? row.transactionId : null, units: excess });
    return;
  }
  if (!qty.greaterThan(0) || !before.q.lessThan(0)) return;
  const k = Decimal.min(qty, before.q.negated());
  const c = fig.correction.negated();
  let taken = ZERO;
  let given = ZERO;
  while (taken.lessThan(k) && short.length > 0) {
    const head = short[0]!;
    const u = Decimal.min(head.units, k.minus(taken));
    taken = taken.plus(u);
    const upTo = round2(c.times(taken).dividedBy(k));
    const share = upTo.minus(given);
    given = upTo;
    if (head.saleId && !share.isZero()) attribute(head.saleId, share);
    head.units = head.units.minus(u);
    if (!head.units.greaterThan(0)) short.shift();
  }
}

/** The value of q more units returned against `sale` (cumulative difference, Q-P24e): round2(R x (N + q) / S) - B. */
export function linkedValue(sale: SaleLink, q: Dec): Dec {
  if (!sale.s.greaterThan(0)) return ZERO;
  return round2(sale.r.times(sale.n.plus(q)).dividedBy(sale.s)).minus(sale.b);
}

/** Average cost as GET /items shows it: V/Q to 6 places while Q > 0, else the last positive average. */
export function averageCost(s: WalkState): Dec {
  return s.q.greaterThan(0) ? round6(s.v.dividedBy(s.q)) : s.l;
}
