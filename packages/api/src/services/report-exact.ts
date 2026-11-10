// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Exact report amounts (U-14, reports-exact-v1).
//
// With ?exact=1 every money field `x` of a report gains an additive
// sibling `xExact`: the unrounded decimal string at the stored scale (at
// least 4 places, more when a cash-basis allocation carries them). Every
// total, subtotal and grand total is summed in Decimal from the same
// values the rows show, so a total always equals the Decimal sum of its
// rows. `x` and `xExact` always carry the same sign. The legacy number
// fields stay for existing clients (MyBooks Online, api-v2, MCP).
//
// Everything money in this module is Decimal; nothing here parses money
// into a JS number.

import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;

export type Dec = InstanceType<typeof Decimal>;
export type MoneyIn = Dec | string | number | null | undefined;

export const REPORTS_EXACT_CAPABILITY = 'reports-exact-v1';

/** Stored scale of journal amounts (numeric(19,4)). */
export const STORED_SCALE = 4;

/** A Decimal from a pg numeric string, a Decimal, or (legacy) a number. */
export function dec(x: MoneyIn): Dec {
  if (x === null || x === undefined || x === '') return new Decimal(0);
  if (x instanceof Decimal) return x as Dec;
  return new Decimal(typeof x === 'number' ? String(x) : x);
}

/**
 * The exact wire form: unrounded, at least the stored scale, never "-0".
 * A value with more places (a cash-basis share) keeps all of them.
 */
export function exactStr(x: MoneyIn): string {
  const d = dec(x);
  if (d.isZero()) return (0).toFixed(STORED_SCALE);
  return d.toFixed(Math.max(STORED_SCALE, d.decimalPlaces()));
}

/** Decimal sum. */
export function dsum(values: Iterable<MoneyIn>): Dec {
  let acc = new Decimal(0);
  for (const v of values) acc = acc.plus(dec(v));
  return acc;
}

/** The legacy number field derived from the exact value (4 places, as num() did). */
export function legacyNum(x: MoneyIn): number {
  return Number(dec(x).toFixed(STORED_SCALE));
}

/** Percent of `base` at 1 place, half away from zero; null on a zero base. */
export function percent1(part: MoneyIn, base: MoneyIn): string | null {
  const b = dec(base);
  if (b.isZero()) return null;
  const p = dec(part).div(b).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
  return p.isZero() ? '0.0' : p.toFixed(1);
}

/**
 * Adds `${field}Exact` to each row for every listed money field (the raw
 * value, which for pg numeric columns is already the exact string) and
 * returns the Decimal totals per field. Missing / null values count as 0
 * and get a null `xExact` so the row still says "no amount".
 */
export function exactRows<T extends Record<string, unknown>>(
  rows: T[],
  fields: readonly string[],
): { rows: Array<T & Record<string, string | null>>; totals: Record<string, string> } {
  const sums = new Map<string, Dec>(fields.map((f) => [f, new Decimal(0)]));
  const out = rows.map((row) => {
    const extra: Record<string, string | null> = {};
    for (const f of fields) {
      const v = row[f] as MoneyIn;
      if (v === null || v === undefined || v === '') { extra[`${f}Exact`] = null; continue; }
      const d = dec(v);
      sums.set(f, sums.get(f)!.plus(d));
      extra[`${f}Exact`] = exactStr(d);
    }
    return { ...row, ...extra } as T & Record<string, string | null>;
  });
  const totals: Record<string, string> = {};
  for (const f of fields) totals[f] = exactStr(sums.get(f)!);
  return { rows: out, totals };
}

// ─── Dates ───────────────────────────────────────────────────────

/**
 * A pg `date` column read without a type parser arrives as a JS Date at
 * the engine's local midnight. Reading it back with local getters gives
 * the calendar day exactly (toISOString() is a day off east of UTC).
 */
export function toCalendarDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Keys that hold a calendar date (not an instant): `date`, `*Date`, `*_date`. */
export function isDateKey(key: string): boolean {
  return key === 'date' || key.endsWith('Date') || key.endsWith('_date');
}

/**
 * Exact mode: every calendar-date field becomes `YYYY-MM-DD`. Real
 * timestamps (`createdAt`, `*_at`) are left as instants.
 */
export function normalizeReportDates<T>(value: T): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (v instanceof Date) return key !== null && isDateKey(key) ? toCalendarDate(v) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object' && !(v instanceof Decimal)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, k);
      return o;
    }
    return v;
  };
  return walk(value, null) as T;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form. */
export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ─── Meta ────────────────────────────────────────────────────────

/**
 * The cash-basis rules (Q-P23z) as one plain sentence, so a client can
 * show it beside any cash-basis report.
 */
export const CASH_BASIS_RULES_NOTE =
  'Cash basis: income counts when payment is received and expenses when they are paid. '
  + 'Customer payments not yet applied to an invoice count as unapplied receipts, write-offs are not income or expense, '
  + 'and bill discounts reduce the expense when the bill is paid. These rules apply to every period.';

export interface ReportMeta {
  exact: true;
  basis: 'accrual' | 'cash' | null;
  cashBasisRules: string | null;
  from?: string;
  to?: string;
  asOf?: string;
  reportSchemaVersion: string;
}

export function reportMeta(opts: {
  basis: 'accrual' | 'cash' | null;
  from?: string | null;
  to?: string | null;
  asOf?: string | null;
  reportSchemaVersion: string;
}): ReportMeta {
  return {
    exact: true,
    basis: opts.basis,
    cashBasisRules: opts.basis === 'cash' ? CASH_BASIS_RULES_NOTE : null,
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.to ? { to: opts.to } : {}),
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
    reportSchemaVersion: opts.reportSchemaVersion,
  };
}

// ─── Account tree (parentAccountId, depth, rollupExact) ─────────

export interface AccountTreeNode {
  id: string;
  parentId: string | null;
  name: string;
  accountNumber: string | null;
  accountType: string;
}

/**
 * Exact mode: places a section's account rows in a tree. Each row gets
 * `parentAccountId` (the parent only when it is in the same section, i.e.
 * the same account type) and `depth`; a missing ancestor of a row with an
 * amount is added at zero (built by `makeAncestor`) so a child never points
 * at a row the report left out; rows with children carry `rollupExact`
 * (own amount + every descendant). Rows come back parent-first, children
 * in their original order. Section totals stay the sum of own amounts.
 */
export function applyAccountTree<E extends { accountId: string | null }>(
  entries: E[],
  tree: Map<string, AccountTreeNode>,
  amountOf: (e: E) => Dec,
  makeAncestor: (node: AccountTreeNode) => E,
): Array<E & { parentAccountId: string | null; depth: number; rollupExact?: string }> {
  type Out = E & { parentAccountId: string | null; depth: number; rollupExact?: string };
  const byId = new Map<string, E>();
  for (const e of entries) if (e.accountId) byId.set(e.accountId, e);
  const sameSectionParent = (id: string): string | null => {
    const n = tree.get(id);
    if (!n || !n.parentId || n.parentId === id) return null;
    const p = tree.get(n.parentId);
    return p && p.accountType === n.accountType ? p.id : null;
  };
  // Add missing ancestors (cycle-guarded).
  const added: E[] = [];
  for (const e of entries) {
    if (!e.accountId) continue;
    const seen = new Set<string>([e.accountId]);
    let pid = sameSectionParent(e.accountId);
    while (pid && !seen.has(pid)) {
      seen.add(pid);
      if (!byId.has(pid)) {
        const anc = makeAncestor(tree.get(pid)!);
        byId.set(pid, anc);
        added.push(anc);
      }
      pid = sameSectionParent(pid);
    }
  }
  const all = [...entries, ...added];
  const parentOf = new Map<string, string | null>();
  for (const e of all) {
    if (!e.accountId) continue;
    const p = sameSectionParent(e.accountId);
    parentOf.set(e.accountId, p && byId.has(p) ? p : null);
  }
  const children = new Map<string | null, E[]>();
  // Original order for children; added ancestors sort by number then name.
  const order = [...entries, ...added.sort((a, b) => {
    const na = tree.get(a.accountId!)!; const nb = tree.get(b.accountId!)!;
    return (na.accountNumber ?? '').localeCompare(nb.accountNumber ?? '', undefined, { numeric: true }) || na.name.localeCompare(nb.name);
  })];
  for (const e of order) {
    const p = e.accountId ? (parentOf.get(e.accountId) ?? null) : null;
    const arr = children.get(p) ?? [];
    arr.push(e);
    children.set(p, arr);
  }
  const out: Out[] = [];
  const visit = (e: E, depth: number, path: Set<string>): Dec => {
    const row = { ...e, parentAccountId: e.accountId ? (parentOf.get(e.accountId) ?? null) : null, depth } as Out;
    out.push(row);
    let rollup = amountOf(e);
    const kids = e.accountId && !path.has(e.accountId) ? (children.get(e.accountId) ?? []) : [];
    if (kids.length > 0) {
      const next = new Set(path); next.add(e.accountId!);
      for (const k of kids) rollup = rollup.plus(visit(k, depth + 1, next));
      row.rollupExact = exactStr(rollup);
    }
    return rollup;
  };
  // Roots: rows without a parent in the section (and rows without an id).
  for (const e of children.get(null) ?? []) visit(e, 0, new Set());
  // A parent cycle in the data leaves rows unreached; keep them as roots.
  if (out.length < all.length) {
    const placed = new Set(out.map((r) => r.accountId));
    for (const e of order) {
      if (!placed.has(e.accountId)) out.push({ ...e, parentAccountId: null, depth: 0 } as Out);
    }
  }
  return out;
}
