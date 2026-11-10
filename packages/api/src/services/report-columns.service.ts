// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Report columns and tag split (U-201, reports-columns-v1).
//
// Profit and Loss and Balance Sheet in a column layout: explicit period
// ranges (4-4-5 and custom), a YTD column, prior period / prior year with
// $ and % change, columns by client and by tag group, % of income, and
// the tag split (untagged + one row per group tag + the account total).
// Trial Balance tag split is a post-pass on the exact Trial Balance.
//
// Every amount comes from report-lens.lineSums over exactly the lines the
// standard report reads, keyed by client or group tag, so:
//   - the columns of a split (clients, tags) partition the Total column;
//   - untagged + tags = account_total = the account's unsplit amount;
//   - a cell's drill (its row drill + its column drill on the General
//     Ledger) selects exactly the lines the cell sums.
// All arithmetic is Decimal; percents are 1 place, half away from zero,
// null on a zero base (Q-P28e).

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getPLLabels, getBSLabels, getReportFooter } from './tenant-report-settings.service.js';
import {
  applyAccountTree, dec, dsum, exactStr, legacyNum, percent1, type AccountTreeNode, type Dec,
} from './report-exact.js';
import {
  basisTitleSuffix, getFiscalYearStart, loadAccountTree, type AdjustingFilter,
} from './report.service.js';
import {
  lineSums, loadGroupTags, naturalAmount, type GroupTag, type LineLens, type LineSum, type TagLens,
} from './report-lens.js';

type Basis = 'accrual' | 'cash';
const ZERO = () => dec(0);

export const MAX_PERIOD_RANGES = 36;
export const MAX_CONTACT_COLUMNS = 36;

export interface DateRange { from: string; to: string }

// ─── Dates (string math, UTC) ───────────────────────────────────

function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
/** Whole years back, Feb 29 -> Feb 28 (same rule as the comparative P&L). */
export function shiftYear(d: string, delta: number): string {
  const y = parseInt(d.slice(0, 4), 10) + delta;
  let md = d.slice(5);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (md === '02-29' && !leap) md = '02-28';
  return `${String(y).padStart(4, '0')}-${md}`;
}
/** prior=period: the same number of days just before; prior=year: a year back. */
export function priorRange(r: DateRange, prior: 'period' | 'year'): DateRange {
  if (prior === 'year') return { from: shiftYear(r.from, -1), to: shiftYear(r.to, -1) };
  const len = daysBetween(r.from, r.to) + 1;
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}
/** First day of the fiscal year containing `d`. */
export function fiscalYearStartOf(d: string, fyStartMonth: number): string {
  const y = parseInt(d.slice(0, 4), 10);
  const m = parseInt(d.slice(5, 7), 10);
  const fy = m < fyStartMonth ? y - 1 : y;
  return `${String(fy).padStart(4, '0')}-${String(fyStartMonth).padStart(2, '0')}-01`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(d: string): string {
  return `${MONTHS[parseInt(d.slice(5, 7), 10) - 1]} ${parseInt(d.slice(8, 10), 10)}, ${d.slice(0, 4)}`;
}
/** "Oct 2026", "2026", or "Jan 4, 2026 - Jan 31, 2026". */
export function rangeCaption(r: DateRange): string {
  const lastOfMonth = addDays(`${r.to.slice(0, 7)}-01`, 40).slice(0, 7);
  const monthEnd = addDays(`${lastOfMonth}-01`, -1);
  if (r.from.slice(8) === '01' && r.from.slice(0, 7) === r.to.slice(0, 7) && r.to === monthEnd) {
    return `${MONTHS[parseInt(r.from.slice(5, 7), 10) - 1]} ${r.from.slice(0, 4)}`;
  }
  if (r.from.slice(5) === '01-01' && r.to.slice(5) === '12-31' && r.from.slice(0, 4) === r.to.slice(0, 4)) return r.from.slice(0, 4);
  return `${fmtDay(r.from)} - ${fmtDay(r.to)}`;
}

/** Runs n over items with at most limit at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ─── Columns ─────────────────────────────────────────────────────

export type ColumnKind =
  | 'period' | 'total' | 'ytd' | 'as_of' | 'prior' | 'change' | 'pct_change'
  | 'contact' | 'no_contact' | 'others' | 'tag' | 'no_tag';

/** Query parameters that, added to the row drill, select the cell's lines on the General Ledger. */
export type Drill = Record<string, string>;

export interface ReportColumn {
  key: string;
  caption: string;
  kind: ColumnKind;
  /** 'amount' | 'percent' (pct_change). */
  valueType: 'amount' | 'percent';
  from: string | null;
  to: string | null;
  asOf?: string | null;
  contactId?: string | null;
  tagId?: string | null;
  tagNumber?: string | null;
  /** The column this prior / change / % change column compares with. */
  baseKey?: string | null;
  drill: Drill | null;
}

/** How a column's amounts are computed. */
type ColSource =
  | { type: 'sums'; set: number; pick: (key: string | null) => boolean }
  | { type: 'sum_of'; cols: number[] }
  | { type: 'change'; cur: number; prior: number }
  | { type: 'pct'; cur: number; prior: number };

interface ColDef { col: ReportColumn; src: ColSource }

/** One per distinct line window: per account, per key, natural amount. */
interface SumSet {
  byAccount: Map<string, Map<string | null, Dec>>;
}

function buildSumSet(rows: LineSum[], amountOf: (r: LineSum) => Dec | null): SumSet {
  const byAccount = new Map<string, Map<string | null, Dec>>();
  for (const r of rows) {
    const v = amountOf(r);
    if (v === null) continue;
    const m = byAccount.get(r.accountId) ?? new Map<string | null, Dec>();
    m.set(r.key, (m.get(r.key) ?? ZERO()).plus(v));
    byAccount.set(r.accountId, m);
  }
  return { byAccount };
}

/**
 * Evaluates every column for one value source (an account, a row of a
 * tag split, or a calculated row): `amount(set, pick)` gives a sums-backed
 * column's amount; sums, changes and percents derive from those.
 */
function evalColumns(defs: ColDef[], amount: (set: number, pick: (k: string | null) => boolean) => Dec): Array<Dec | string | null> {
  const out: Array<Dec | string | null> = [];
  for (const d of defs) {
    const s = d.src;
    if (s.type === 'sums') out.push(amount(s.set, s.pick));
    else if (s.type === 'sum_of') out.push(dsum(s.cols.map((i) => out[i] as Dec)));
    else if (s.type === 'change') out.push((out[s.cur] as Dec).minus(out[s.prior] as Dec));
    else out.push(percent1((out[s.cur] as Dec).minus(out[s.prior] as Dec), (out[s.prior] as Dec).abs()));
  }
  return out;
}

function toWire(values: Array<Dec | string | null>, defs: ColDef[]): Array<string | null> {
  return values.map((v, i) => (defs[i]!.src.type === 'pct' ? (v as string | null) : exactStr(v as Dec)));
}

/** Derived columns recomputed from summed amount columns (a rollup or a total). */
function rederive(values: Array<Dec | string | null>, defs: ColDef[]): Array<Dec | string | null> {
  return defs.map((d, i) => {
    const s = d.src;
    if (s.type === 'change') return (values[s.cur] as Dec).minus(values[s.prior] as Dec);
    if (s.type === 'pct') return percent1((values[s.cur] as Dec).minus(values[s.prior] as Dec), (values[s.prior] as Dec).abs());
    return values[i]!;
  });
}

function addValues(a: Array<Dec | string | null>, b: Array<Dec | string | null>, defs: ColDef[]): Array<Dec | string | null> {
  return defs.map((d, i) => (d.src.type === 'pct' ? null : (a[i] as Dec).plus(b[i] as Dec)));
}
const zeroValues = (defs: ColDef[]): Array<Dec | string | null> => defs.map((d) => (d.src.type === 'pct' ? null : ZERO()));

function isAmountCol(d: ColDef): boolean { return d.src.type !== 'pct'; }
/** True when any amount column of the row is non-zero. */
function anyNonZero(values: Array<Dec | string | null>, defs: ColDef[]): boolean {
  return defs.some((d, i) => d.src.type !== 'pct' && d.src.type !== 'change' && !(values[i] as Dec).isZero());
}

// ─── Rows ────────────────────────────────────────────────────────

export type RowKind = 'account' | 'tag' | 'account_total' | 'calculated';

export interface ColumnRow {
  rowKind: RowKind;
  accountId: string | null;
  name: string;
  accountNumber: string | null;
  parentAccountId: string | null;
  depth: number;
  tagId?: string | null;
  tagNumber?: string | null;
  tagName?: string | null;
  valuesExact: Array<string | null>;
  /** Own amount + every descendant, per column (parents only; account rows). */
  rollupValuesExact?: Array<string | null>;
  pctOfIncomeExact?: Array<string | null>;
  /** Added to a column's drill, selects the row's lines on the General Ledger; null = no drill. */
  drill: Drill | null;
}

interface AccountInfo { id: string; name: string; accountNumber: string | null; accountType: string; systemTag: string | null }

async function loadOrderedAccounts(tenantId: string, types: readonly string[]): Promise<AccountInfo[]> {
  const res = await db.execute(sql`
    SELECT id, name, account_number, account_type, system_tag FROM accounts
    WHERE tenant_id = ${tenantId} AND account_type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
    ORDER BY account_number, name
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r['id']), name: String(r['name'] ?? ''), accountNumber: (r['account_number'] as string | null) ?? null,
    accountType: String(r['account_type']), systemTag: (r['system_tag'] as string | null) ?? null,
  }));
}

interface SplitSpec { groupId: string; tags: GroupTag[] }

/**
 * One section's rows: accounts in report order with the account tree
 * (parentAccountId, depth, rollupValuesExact), and under tag split each
 * account's untagged / tag / account_total rows.
 */
function sectionRows(
  accounts: AccountInfo[],
  tree: Map<string, AccountTreeNode>,
  defs: ColDef[],
  valuesFor: (accountId: string, pick: (k: string | null) => boolean) => Array<Dec | string | null>,
  split: SplitSpec | null,
): { rows: ColumnRow[]; total: Array<Dec | string | null> } {
  const all = () => true;
  const totals = new Map<string, Array<Dec | string | null>>();
  type E = { accountId: string; info: AccountInfo };
  const entries: E[] = [];
  for (const a of accounts) {
    const v = valuesFor(a.id, all);
    if (!anyNonZero(v, defs)) continue;
    totals.set(a.id, v);
    entries.push({ accountId: a.id, info: a });
  }
  let sectionTotal = zeroValues(defs);
  for (const v of totals.values()) sectionTotal = addValues(sectionTotal, v, defs);
  sectionTotal = rederive(sectionTotal, defs);

  const placed = applyAccountTree(entries, tree, () => ZERO(), (n) => ({
    accountId: n.id,
    info: { id: n.id, name: n.name, accountNumber: n.accountNumber, accountType: n.accountType, systemTag: null },
  }));
  // Rollups: own + descendants, per column (amount columns summed, derived re-derived).
  const own = (id: string) => totals.get(id) ?? zeroValues(defs);
  const rollup = new Map<string, Array<Dec | string | null>>();
  const hasKids = new Set<string>();
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]!;
    const r = addValues(own(p.accountId), rollup.get(p.accountId) ?? zeroValues(defs), defs);
    if (p.parentAccountId) {
      hasKids.add(p.parentAccountId);
      rollup.set(p.parentAccountId, addValues(rollup.get(p.parentAccountId) ?? zeroValues(defs), r, defs));
    }
    rollup.set(p.accountId, r);
  }

  const rows: ColumnRow[] = [];
  for (const p of placed) {
    const base = {
      accountId: p.accountId, name: p.info.name, accountNumber: p.info.accountNumber,
      parentAccountId: p.parentAccountId, depth: p.depth,
    };
    const rollupValues = hasKids.has(p.accountId) ? { rollupValuesExact: toWire(rederive(rollup.get(p.accountId)!, defs), defs) } : {};
    if (!split) {
      rows.push({ rowKind: 'account', ...base, valuesExact: toWire(own(p.accountId), defs), ...rollupValues, drill: { account_ids: p.accountId } });
      continue;
    }
    const inGroup = new Set(split.tags.map((t) => t.id));
    const untagged = totals.has(p.accountId) ? valuesFor(p.accountId, (k) => k === null || !inGroup.has(k)) : zeroValues(defs);
    rows.push({
      rowKind: 'account', ...base, tagId: null, tagNumber: null, tagName: null,
      valuesExact: toWire(untagged, defs), ...rollupValues,
      drill: { account_ids: p.accountId, tag_scope: 'untagged_in_group', tag_group_id: split.groupId },
    });
    if (totals.has(p.accountId)) {
      for (const t of split.tags) {
        const v = valuesFor(p.accountId, (k) => k === t.id);
        if (!anyNonZero(v, defs)) continue;
        rows.push({
          rowKind: 'tag', ...base, tagId: t.id, tagNumber: t.tagNumber, tagName: t.name,
          valuesExact: toWire(v, defs), drill: { account_ids: p.accountId, tag_id: t.id },
        });
      }
    }
    rows.push({
      rowKind: 'account_total', ...base, tagId: null, tagNumber: null, tagName: null,
      valuesExact: toWire(own(p.accountId), defs), drill: { account_ids: p.accountId },
    });
  }
  return { rows, total: sectionTotal };
}

// ─── Profit and Loss ─────────────────────────────────────────────

const PL_TYPES = ['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'] as const;
type PlSection = 'revenue' | 'cogs' | 'expenses' | 'otherRevenue' | 'otherExpenses';
const PL_SECTION_OF: Record<string, PlSection> = {
  revenue: 'revenue', cogs: 'cogs', expense: 'expenses', other_revenue: 'otherRevenue', other_expense: 'otherExpenses',
};

export interface PlColumnsOptions {
  basis: Basis;
  companyId: string | null;
  adjusting: AdjustingFilter | null;
  /** The report's own tag filter (tag_id): ids or untagged. */
  tagFilter: TagLens | null;
  /** One or more ranges, ascending and not overlapping. */
  ranges: DateRange[];
  /** True when the ranges came from period_ranges (a Total column follows when there are two or more). */
  periodColumns: boolean;
  /** YTD column from this date to the last range's end. */
  ytdFrom: string | null;
  prior: 'period' | 'year' | null;
  compare: null | { kind: 'contact' } | { kind: 'tag'; groupId: string };
  tagSplitGroupId: string | null;
  pctOfIncome: boolean;
}

export class ReportColumnsError extends Error {
  constructor(public param: string, message: string, public code: 'INVALID_PARAM' | 'NOT_FOUND' = 'INVALID_PARAM') { super(message); }
}

export async function buildProfitAndLossColumns(tenantId: string, o: PlColumnsOptions) {
  const lens: LineLens | null = o.tagFilter ? { tag: o.tagFilter } : null;
  const dimension = o.compare?.kind === 'contact'
    ? { kind: 'contact' as const }
    : o.compare?.kind === 'tag'
      ? { kind: 'tag_group' as const, groupId: o.compare.groupId }
      : o.tagSplitGroupId ? { kind: 'tag_group' as const, groupId: o.tagSplitGroupId } : null;
  const groupId = o.compare?.kind === 'tag' ? o.compare.groupId : o.tagSplitGroupId;
  const groupTags = groupId ? await loadGroupTags(tenantId, groupId) : null;
  if (groupId && groupTags === null) throw new ReportColumnsError('tag_group_id', 'tag group not found', 'NOT_FOUND');

  // Distinct line windows -> sum sets.
  const windows: DateRange[] = [];
  const windowIndex = (r: DateRange) => {
    const i = windows.findIndex((w) => w.from === r.from && w.to === r.to);
    if (i >= 0) return i;
    windows.push(r);
    return windows.length - 1;
  };
  const defs: ColDef[] = [];
  const all = () => true;
  const addPrior = (baseIdx: number, r: DateRange) => {
    if (!o.prior) return;
    const pr = priorRange(r, o.prior);
    const base = defs[baseIdx]!.col;
    const priorIdx = defs.length;
    defs.push({ col: { key: `${base.key}_prior`, caption: o.prior === 'year' ? 'Prior year' : 'Prior period', kind: 'prior', valueType: 'amount',
      from: pr.from, to: pr.to, baseKey: base.key, drill: { start_date: pr.from, end_date: pr.to } },
      src: { type: 'sums', set: windowIndex(pr), pick: all } });
    defs.push({ col: { key: `${base.key}_change`, caption: '$ Change', kind: 'change', valueType: 'amount', from: null, to: null, baseKey: base.key, drill: null },
      src: { type: 'change', cur: baseIdx, prior: priorIdx } });
    defs.push({ col: { key: `${base.key}_pct_change`, caption: '% Change', kind: 'pct_change', valueType: 'percent', from: null, to: null, baseKey: base.key, drill: null },
      src: { type: 'pct', cur: baseIdx, prior: priorIdx } });
  };

  // Every sums-backed amount column needs its window's sums before the
  // contact / tag columns can be chosen, so load the windows first.
  const mainRange: DateRange = { from: o.ranges[0]!.from, to: o.ranges[o.ranges.length - 1]!.to };
  const plan: Array<() => void> = [];
  if (o.compare) {
    windowIndex(mainRange);
  } else {
    const periodIdx: number[] = [];
    o.ranges.forEach((r, i) => {
      plan.push(() => {
        const idx = defs.length;
        periodIdx.push(idx);
        defs.push({ col: { key: o.periodColumns ? `p${i}` : 'total', caption: o.periodColumns ? rangeCaption(r) : 'Total',
          kind: o.periodColumns ? 'period' : 'total', valueType: 'amount', from: r.from, to: r.to,
          drill: { start_date: r.from, end_date: r.to } }, src: { type: 'sums', set: windowIndex(r), pick: all } });
        addPrior(idx, r);
      });
    });
    if (o.periodColumns && o.ranges.length > 1) {
      plan.push(() => {
        const contiguous = o.ranges.every((r, i) => i === 0 || addDays(o.ranges[i - 1]!.to, 1) === r.from);
        defs.push({ col: { key: 'total', caption: 'Total', kind: 'total', valueType: 'amount', from: mainRange.from, to: mainRange.to,
          drill: contiguous ? { start_date: mainRange.from, end_date: mainRange.to } : null },
          src: { type: 'sum_of', cols: [...periodIdx] } });
      });
    }
    if (o.ytdFrom) {
      plan.push(() => {
        const r = { from: o.ytdFrom!, to: mainRange.to };
        const idx = defs.length;
        defs.push({ col: { key: 'ytd', caption: 'YTD', kind: 'ytd', valueType: 'amount', from: r.from, to: r.to,
          drill: { start_date: r.from, end_date: r.to } }, src: { type: 'sums', set: windowIndex(r), pick: all } });
        addPrior(idx, r);
      });
    }
  }
  for (const step of plan) step();

  const sets: SumSet[] = await mapLimit(windows, 4, async (w) => {
    const rows = await lineSums(tenantId, {
      basis: o.basis, companyId: o.companyId, adjusting: o.adjusting, from: w.from, to: w.to,
      accountTypes: PL_TYPES, dimension, lens,
    });
    return buildSumSet(rows, (r) => naturalAmount(r.accountType, r.debit, r.credit));
  });

  if (o.compare) {
    const set = 0;
    const s = sets[0]!;
    const drillRange = { start_date: mainRange.from, end_date: mainRange.to };
    if (o.compare.kind === 'contact') {
      // Activity per client: the sum of |account amount|, for choosing the 36 shown.
      const activity = new Map<string, Dec>();
      let noContact = false;
      for (const m of s.byAccount.values()) {
        for (const [k, v] of m) {
          if (v.isZero()) continue;
          if (k === null) { noContact = true; continue; }
          activity.set(k, (activity.get(k) ?? ZERO()).plus(v.abs()));
        }
      }
      const ids = [...activity.keys()];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const res = await db.execute(sql`SELECT id, display_name FROM contacts WHERE tenant_id = ${tenantId}
          AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
        for (const r of res.rows as Array<Record<string, unknown>>) names.set(String(r['id']), String(r['display_name'] ?? ''));
      }
      const chosen = ids
        .sort((a, b) => activity.get(b)!.comparedTo(activity.get(a)!) || (names.get(a) ?? '').localeCompare(names.get(b) ?? '') || a.localeCompare(b))
        .slice(0, MAX_CONTACT_COLUMNS);
      const shown = [...chosen].sort((a, b) => (names.get(a) ?? '').localeCompare(names.get(b) ?? '') || a.localeCompare(b));
      const shownSet = new Set(shown);
      for (const id of shown) {
        defs.push({ col: { key: `c:${id}`, caption: names.get(id) ?? '', kind: 'contact', valueType: 'amount', from: mainRange.from, to: mainRange.to,
          contactId: id, drill: { ...drillRange, contact_id: id } }, src: { type: 'sums', set, pick: (k) => k === id } });
      }
      if (ids.length > shown.length) {
        defs.push({ col: { key: 'others', caption: 'All others', kind: 'others', valueType: 'amount', from: mainRange.from, to: mainRange.to,
          drill: { ...drillRange, contact_id: 'others', ...(shown.length > 0 ? { exclude_contact_ids: shown.join(',') } : {}) } },
          src: { type: 'sums', set, pick: (k) => k !== null && !shownSet.has(k) } });
      }
      if (noContact) {
        defs.push({ col: { key: 'no_contact', caption: 'No client', kind: 'no_contact', valueType: 'amount', from: mainRange.from, to: mainRange.to,
          drill: { ...drillRange, contact_id: 'none' } }, src: { type: 'sums', set, pick: (k) => k === null } });
      }
    } else {
      const withActivity = new Set<string>();
      let untagged = false;
      for (const m of s.byAccount.values()) {
        for (const [k, v] of m) {
          if (v.isZero()) continue;
          if (k === null) untagged = true; else withActivity.add(k);
        }
      }
      for (const t of groupTags!.filter((g) => withActivity.has(g.id))) {
        defs.push({ col: { key: `t:${t.id}`, caption: t.tagNumber ? `${t.tagNumber} ${t.name}` : t.name, kind: 'tag', valueType: 'amount',
          from: mainRange.from, to: mainRange.to, tagId: t.id, tagNumber: t.tagNumber, drill: { ...drillRange, tag_id: t.id } },
          src: { type: 'sums', set, pick: (k) => k === t.id } });
      }
      if (untagged) {
        defs.push({ col: { key: 'no_tag', caption: 'No tag in group', kind: 'no_tag', valueType: 'amount', from: mainRange.from, to: mainRange.to,
          drill: { ...drillRange, tag_scope: 'untagged_in_group', tag_group_id: o.compare.groupId } },
          src: { type: 'sums', set, pick: (k) => k === null } });
      }
    }
    defs.push({ col: { key: 'total', caption: 'Total', kind: 'total', valueType: 'amount', from: mainRange.from, to: mainRange.to, drill: drillRange },
      src: { type: 'sums', set, pick: all } });
  }

  const valuesFor = (accountId: string, rowPick: (k: string | null) => boolean) =>
    evalColumns(defs, (set, colPick) => {
      const m = sets[set]!.byAccount.get(accountId);
      if (!m) return ZERO();
      let acc = ZERO();
      for (const [k, v] of m) if (rowPick(k) && colPick(k)) acc = acc.plus(v);
      return acc;
    });

  const [accounts, tree] = await Promise.all([loadOrderedAccounts(tenantId, PL_TYPES), loadAccountTree(tenantId)]);
  const split: SplitSpec | null = o.tagSplitGroupId ? { groupId: o.tagSplitGroupId, tags: groupTags! } : null;
  const bySection = (type: string) => sectionRows(accounts.filter((a) => a.accountType === type), tree, defs, valuesFor, split);
  const sec = {
    revenue: bySection('revenue'), cogs: bySection('cogs'), expenses: bySection('expense'),
    otherRevenue: bySection('other_revenue'), otherExpenses: bySection('other_expense'),
  };
  const amt = (v: Array<Dec | string | null>, i: number) => v[i] as Dec;
  const combine = (f: (i: number) => Dec) => rederive(defs.map((d, i) => (isAmountCol(d) ? f(i) : null)), defs);
  const hasCogs = sec.cogs.rows.length > 0;
  const hasOther = sec.otherRevenue.rows.length > 0 || sec.otherExpenses.rows.length > 0;
  const gross = combine((i) => amt(sec.revenue.total, i).minus(amt(sec.cogs.total, i)));
  const operating = combine((i) => amt(gross, i).minus(amt(sec.expenses.total, i)));
  const net = combine((i) => amt(sec.revenue.total, i).plus(amt(sec.otherRevenue.total, i)).minus(amt(sec.cogs.total, i))
    .minus(amt(sec.expenses.total, i)).minus(amt(sec.otherExpenses.total, i)));

  const income = sec.revenue.total;
  const pct = (v: Array<string | null>) => v.map((x, i) => (defs[i]!.src.type === 'pct' || defs[i]!.src.type === 'change' || x === null
    ? null : percent1(x, amt(income, i))));
  const withPct = (rows: ColumnRow[]) => (o.pctOfIncome ? rows.map((r) => ({ ...r, pctOfIncomeExact: pct(r.valuesExact) })) : rows);
  const totalsExact = {
    totalRevenue: toWire(sec.revenue.total, defs),
    totalCogs: toWire(sec.cogs.total, defs),
    totalExpenses: toWire(sec.expenses.total, defs),
    totalOtherRevenue: toWire(sec.otherRevenue.total, defs),
    totalOtherExpenses: toWire(sec.otherExpenses.total, defs),
    grossProfit: hasCogs ? toWire(gross, defs) : null,
    operatingIncome: hasCogs || hasOther ? toWire(hasCogs ? operating : combine((i) => amt(sec.revenue.total, i).minus(amt(sec.expenses.total, i))), defs) : null,
    netIncome: toWire(net, defs),
  };
  const pctTotals = o.pctOfIncome
    ? Object.fromEntries(Object.entries(totalsExact).map(([k, v]) => [k, v ? pct(v) : null]))
    : undefined;
  const [labels, footer] = await Promise.all([getPLLabels(tenantId), getReportFooter(tenantId)]);
  return {
    title: 'Profit and Loss' + basisTitleSuffix(o.basis),
    layout: 'columns' as const,
    startDate: mainRange.from, endDate: mainRange.to,
    basis: o.basis, labels, footer,
    columns: defs.map((d) => d.col),
    revenue: withPct(sec.revenue.rows), cogs: withPct(sec.cogs.rows), expenses: withPct(sec.expenses.rows),
    otherRevenue: withPct(sec.otherRevenue.rows), otherExpenses: withPct(sec.otherExpenses.rows),
    totalsExact,
    ...(pctTotals ? { pctOfIncomeTotalsExact: pctTotals } : {}),
    tagSplit: split ? { tagGroupId: split.groupId, tags: split.tags.map((t) => ({ tagId: t.id, tagNumber: t.tagNumber, tagName: t.name })) } : null,
  };
}

// ─── Balance Sheet ───────────────────────────────────────────────

const BS_TYPES = ['asset', 'liability', 'equity'] as const;

export interface BsColumnsOptions {
  basis: Basis;
  companyId: string | null;
  adjusting: AdjustingFilter | null;
  tagFilter: TagLens | null;
  /** One column per as-of date; `from` (optional) is the period start used by prior=period. */
  asOfs: Array<{ asOf: string; from: string | null }>;
  periodColumns: boolean;
  prior: 'period' | 'year' | null;
  tagSplitGroupId: string | null;
}

/** The calculated equity rows the Balance Sheet adds (no account behind them). */
const RE_PRIOR = 'Retained Earnings (Prior Years)';
const NI_CURRENT = 'Net Income (Current Year)';

export async function buildBalanceSheetColumns(tenantId: string, o: BsColumnsOptions) {
  const lens: LineLens | null = o.tagFilter ? { tag: o.tagFilter } : null;
  const groupTags = o.tagSplitGroupId ? await loadGroupTags(tenantId, o.tagSplitGroupId) : null;
  if (o.tagSplitGroupId && groupTags === null) throw new ReportColumnsError('tag_group_id', 'tag group not found', 'NOT_FOUND');
  const dimension = o.tagSplitGroupId ? { kind: 'tag_group' as const, groupId: o.tagSplitGroupId } : null;
  const fyMonth = await getFiscalYearStart(tenantId, o.companyId);

  const dates: string[] = [];
  const dateIndex = (d: string) => { const i = dates.indexOf(d); if (i >= 0) return i; dates.push(d); return dates.length - 1; };
  const defs: ColDef[] = [];
  const all = () => true;
  o.asOfs.forEach((c, i) => {
    const idx = defs.length;
    const key = o.periodColumns ? `p${i}` : 'total';
    defs.push({ col: { key, caption: o.periodColumns ? `As of ${fmtDay(c.asOf)}` : 'Total', kind: o.periodColumns ? 'as_of' : 'total', valueType: 'amount',
      from: c.from, to: c.asOf, asOf: c.asOf, drill: { end_date: c.asOf } }, src: { type: 'sums', set: dateIndex(c.asOf), pick: all } });
    if (o.prior) {
      const pAsOf = o.prior === 'year' ? shiftYear(c.asOf, -1) : addDays(c.from!, -1);
      const pIdx = defs.length;
      defs.push({ col: { key: `${key}_prior`, caption: o.prior === 'year' ? 'Prior year' : 'Prior period', kind: 'prior', valueType: 'amount',
        from: null, to: pAsOf, asOf: pAsOf, baseKey: key, drill: { end_date: pAsOf } }, src: { type: 'sums', set: dateIndex(pAsOf), pick: all } });
      defs.push({ col: { key: `${key}_change`, caption: '$ Change', kind: 'change', valueType: 'amount', from: null, to: null, baseKey: key, drill: null },
        src: { type: 'change', cur: idx, prior: pIdx } });
      defs.push({ col: { key: `${key}_pct_change`, caption: '% Change', kind: 'pct_change', valueType: 'percent', from: null, to: null, baseKey: key, drill: null },
        src: { type: 'pct', cur: idx, prior: pIdx } });
    }
  });

  // Per as-of: balance-sheet accounts through the date, and P&L accounts
  // split at the fiscal year start (prior years -> retained earnings,
  // this year -> current-year net income), exactly as buildBalanceSheet.
  const accounts = await loadOrderedAccounts(tenantId, [...BS_TYPES, ...PL_TYPES]);
  const reAccount = accounts.find((a) => a.accountType === 'equity' && a.systemTag === 'retained_earnings') ?? null;
  type DateSums = { bs: SumSet; priorNi: Map<string | null, Dec>; currentNi: Map<string | null, Dec> };
  const perDate: DateSums[] = await mapLimit(dates, 4, async (asOf) => {
    const fyStart = fiscalYearStartOf(asOf, fyMonth);
    const rows = await lineSums(tenantId, {
      basis: o.basis, companyId: o.companyId, adjusting: o.adjusting, from: null, to: asOf, dimension, splitDate: fyStart, lens,
    });
    const isPl = (t: string) => (PL_TYPES as readonly string[]).includes(t);
    const bs = buildSumSet(rows, (r) => (isPl(r.accountType) ? null : naturalAmount(r.accountType, r.debit, r.credit)));
    const priorNi = new Map<string | null, Dec>();
    const currentNi = new Map<string | null, Dec>();
    for (const r of rows) {
      if (!isPl(r.accountType)) continue;
      // Net income = credit - debit over every income-statement line.
      const m = r.pre ? priorNi : currentNi;
      m.set(r.key, (m.get(r.key) ?? ZERO()).plus(r.credit.minus(r.debit)));
    }
    return { bs, priorNi, currentNi };
  });
  const sumMap = (m: Map<string | null, Dec>, pick: (k: string | null) => boolean) => {
    let acc = ZERO();
    for (const [k, v] of m) if (pick(k)) acc = acc.plus(v);
    return acc;
  };
  const valuesFor = (accountId: string, rowPick: (k: string | null) => boolean) =>
    evalColumns(defs, (set, colPick) => {
      const pick = (k: string | null) => rowPick(k) && colPick(k);
      const ds = perDate[set]!;
      let v = ZERO();
      const m = ds.bs.byAccount.get(accountId);
      if (m) for (const [k, x] of m) if (pick(k)) v = v.plus(x);
      // The designated Retained Earnings account carries the prior years' income.
      if (reAccount && accountId === reAccount.id) v = v.plus(sumMap(ds.priorNi, pick));
      return v;
    });
  const calcValues = (which: 'prior' | 'current', rowPick: (k: string | null) => boolean) =>
    evalColumns(defs, (set, colPick) => sumMap(which === 'prior' ? perDate[set]!.priorNi : perDate[set]!.currentNi, (k) => rowPick(k) && colPick(k)));

  const tree = await loadAccountTree(tenantId);
  const split: SplitSpec | null = o.tagSplitGroupId ? { groupId: o.tagSplitGroupId, tags: groupTags! } : null;
  const section = (type: string) => sectionRows(accounts.filter((a) => a.accountType === type), tree, defs, valuesFor, split);
  const assets = section('asset');
  const liabilities = section('liability');
  const equity = section('equity');

  // Calculated rows: prior years' income (when no Retained Earnings account
  // is designated) and the current year's net income. They have no drill.
  const calcRows: ColumnRow[] = [];
  let equityTotal = equity.total;
  const addCalc = (name: string, which: 'prior' | 'current') => {
    const v = calcValues(which, all);
    if (!anyNonZero(v, defs)) return;
    equityTotal = rederive(addValues(equityTotal, v, defs), defs);
    const base = { accountId: null, name, accountNumber: null, parentAccountId: null, depth: 0 };
    if (!split) { calcRows.push({ rowKind: 'calculated', ...base, valuesExact: toWire(v, defs), drill: null }); return; }
    const inGroup = new Set(split.tags.map((t) => t.id));
    calcRows.push({ rowKind: 'calculated', ...base, tagId: null, tagNumber: null, tagName: null,
      valuesExact: toWire(calcValues(which, (k) => k === null || !inGroup.has(k)), defs), drill: null });
    for (const t of split.tags) {
      const tv = calcValues(which, (k) => k === t.id);
      if (!anyNonZero(tv, defs)) continue;
      calcRows.push({ rowKind: 'tag', ...base, tagId: t.id, tagNumber: t.tagNumber, tagName: t.name, valuesExact: toWire(tv, defs), drill: null });
    }
    calcRows.push({ rowKind: 'account_total', ...base, tagId: null, tagNumber: null, tagName: null, valuesExact: toWire(v, defs), drill: null });
  };
  if (!reAccount) addCalc(RE_PRIOR, 'prior');
  addCalc(NI_CURRENT, 'current');

  const liabAndEquity = rederive(addValues(liabilities.total, equityTotal, defs), defs);
  const [labels, footer] = await Promise.all([getBSLabels(tenantId), getReportFooter(tenantId)]);
  const last = o.asOfs[o.asOfs.length - 1]!.asOf;
  return {
    title: 'Balance Sheet' + basisTitleSuffix(o.basis),
    layout: 'columns' as const,
    asOfDate: last, basis: o.basis, labels, footer,
    columns: defs.map((d) => d.col),
    assets: assets.rows, liabilities: liabilities.rows, equity: [...equity.rows, ...calcRows],
    totalsExact: {
      totalAssets: toWire(assets.total, defs),
      totalLiabilities: toWire(liabilities.total, defs),
      totalEquity: toWire(equityTotal, defs),
      totalLiabilitiesAndEquity: toWire(liabAndEquity, defs),
    },
    tagSplit: split ? { tagGroupId: split.groupId, tags: split.tags.map((t) => ({ tagId: t.id, tagNumber: t.tagNumber, tagName: t.name })) } : null,
  };
}

// ─── Trial Balance tag split ─────────────────────────────────────

type TbRow = Record<string, unknown> & { accountId?: string | null; id?: string | null; netExact?: string; name?: string };

/**
 * Tag split on the exact Trial Balance: each account row becomes the
 * untagged row (rowKind 'account'), one row per group tag with activity
 * ('tag') and the account total ('account_total', the unsplit row). The
 * computed Retained Earnings (Prior Years) row is split the same way.
 * Totals are unchanged. Values follow the Trial Balance window (balance-sheet
 * accounts through the end date, income-statement accounts from the fiscal
 * year start; retained earnings on the accrual basis, as buildTrialBalance).
 */
export async function applyTrialBalanceTagSplit<T extends { data: TbRow[]; endDate: string }>(
  tenantId: string,
  tb: T,
  o: { basis: Basis; companyId: string | null; adjusting: AdjustingFilter | null; tagGroupId: string },
): Promise<T & { tagSplit: { tagGroupId: string; tags: Array<{ tagId: string; tagNumber: string | null; tagName: string }> } }> {
  const tags = await loadGroupTags(tenantId, o.tagGroupId);
  if (tags === null) throw new ReportColumnsError('tag_group_id', 'tag group not found', 'NOT_FOUND');
  const fyMonth = await getFiscalYearStart(tenantId, o.companyId);
  const fyStart = fiscalYearStartOf(tb.endDate, fyMonth);
  const dimension = { kind: 'tag_group' as const, groupId: o.tagGroupId };
  const rows = await lineSums(tenantId, {
    basis: o.basis, companyId: o.companyId, adjusting: o.adjusting, from: null, to: tb.endDate, dimension, splitDate: fyStart,
  });
  const isPl = (t: string) => (PL_TYPES as readonly string[]).includes(t);
  // Net (debit - credit) per account per key in the TB window.
  const net = new Map<string, Map<string | null, Dec>>();
  for (const r of rows) {
    if (isPl(r.accountType) && r.pre) continue;
    const m = net.get(r.accountId) ?? new Map<string | null, Dec>();
    m.set(r.key, (m.get(r.key) ?? ZERO()).plus(r.debit.minus(r.credit)));
    net.set(r.accountId, m);
  }
  // Retained earnings (prior years): accrual P&L lines before the fiscal year.
  const reRows = o.basis === 'accrual'
    ? rows.filter((r) => isPl(r.accountType) && r.pre)
    : (await lineSums(tenantId, {
        basis: 'accrual', companyId: o.companyId, adjusting: o.adjusting, from: null, to: addDays(fyStart, -1),
        accountTypes: PL_TYPES, dimension,
      }));
  const reNet = new Map<string | null, Dec>();
  for (const r of reRows) reNet.set(r.key, (reNet.get(r.key) ?? ZERO()).plus(r.debit.minus(r.credit)));

  const inGroup = new Set(tags.map((t) => t.id));
  const pickNet = (m: Map<string | null, Dec> | undefined, pick: (k: string | null) => boolean) => {
    let acc = ZERO();
    if (m) for (const [k, v] of m) if (pick(k)) acc = acc.plus(v);
    return acc;
  };
  const shape = (base: TbRow, n: Dec, extra: Record<string, unknown>) => ({
    ...base, ...extra,
    debit: n.gt(0) ? legacyNum(n) : 0, credit: n.lt(0) ? legacyNum(n.abs()) : 0,
    debitExact: exactStr(n.gt(0) ? n : 0), creditExact: exactStr(n.lt(0) ? n.abs() : 0), netExact: exactStr(n),
  });
  const out: TbRow[] = [];
  for (const row of tb.data) {
    const accountId = (row.accountId ?? row.id ?? null) as string | null;
    const m = accountId ? net.get(accountId) : (row.name === RE_PRIOR ? reNet : undefined);
    const noDrill = { drill: null };
    const drillOf = (d: Record<string, string>) => (accountId ? { drill: { account_ids: accountId, ...d } } : noDrill);
    out.push(shape(row, pickNet(m, (k) => k === null || !inGroup.has(k)),
      { rowKind: 'account', tagId: null, tagNumber: null, tagName: null, ...drillOf({ tag_scope: 'untagged_in_group', tag_group_id: o.tagGroupId }) }));
    for (const t of tags) {
      const v = pickNet(m, (k) => k === t.id);
      if (v.isZero()) continue;
      out.push(shape(row, v, { rowKind: 'tag', tagId: t.id, tagNumber: t.tagNumber, tagName: t.name, rollupExact: undefined, ...drillOf({ tag_id: t.id }) }));
    }
    out.push({ ...row, rowKind: 'account_total', tagId: null, tagNumber: null, tagName: null, ...drillOf({}) });
  }
  return {
    ...tb, data: out,
    tagSplit: { tagGroupId: o.tagGroupId, tags: tags.map((t) => ({ tagId: t.id, tagNumber: t.tagNumber, tagName: t.name })) },
  };
}
