// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report Builder run engine (U-119, capability report-builder-v1; ClientLedger
 * A07 PR-C). One generic run over a builder definition (schema v1):
 *
 *   - Line sources (sales, item_sales, purchases, item_purchases, gl, bank,
 *     tax): one SQL statement per section over the posted journal (accrual)
 *     or the cash-basis virtual ledger (cash), grouped by the section's
 *     group-by keys and the column windows, SUM(numeric). Subtotals of the
 *     outer group-bys are Decimal sums of the leaf groups (exact; a real
 *     NULL key is the path segment `<key>:none`).
 *   - Open-item sources (ar_open, ap_open): the U-121 open items as of each
 *     column's end date (exact), grouped in Decimal.
 *   - Earnings rows (balance_sheet / trial_balance): equity-earnings.
 *   - Formulas, $ change, % change and percent-of in Decimal; percents 1
 *     place, half away from zero, null on a zero base.
 *   - Signs (U-218, report-builder-formula-sign-v1): a section's polarity
 *     ("Show as positive") signs only the cells of its own rows (lines,
 *     earnings, Total, and their $ / % change and % of, computed from those
 *     shown amounts) and a group's shown subtotal. Every node total also has
 *     a normal-sign value (each section as if its polarity were natural: gl
 *     lines by their account's normal side, other sources their default
 *     sign, earnings credit - debit); formulas add terms in that sign and a
 *     percent-of node base is in it, so flipping a section's polarity never
 *     changes a formula row or another section's percents.
 *
 * Everything runs in one READ ONLY REPEATABLE READ snapshot with a 30 s
 * deadline (limits.ts); the stamp is read in it. Amounts are exact strings
 * (never "-0"). No floating point touches an amount.
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  RB_SOURCE_INFO, RB_DEBIT_NORMAL_TYPES, RB_MEASURE_UNIT, TXN_TYPE_LABELS, can,
  type BuilderDefinition, type RbSectionNode, type RbNode, type RbDetailField, type RbFilter, type EffectivePermissions,
} from '@kis-books/shared';
import { dec, exactStr, percent1, type Dec } from '../report-exact.js';
import { adjustingCond, cashBasisLinesWith, docNumberSql, getFiscalYearStart, salesAccrualCond, salesCashCond } from '../report.service.js';
import { tagInGroupKey } from '../report-lens.js';
import { priorYearsIncomeByTransactionTag } from '../equity-earnings.js';
import { arOpenItemsAsOf, bucketFor, daysBetween } from '../ar-open-items.js';
import { apOpenItemsAsOf } from '../ap-open-items.js';
import { BANK_DETAIL_TYPES } from '../bank-account-types.js';
import { fiscalYearStartIn, priorRange, shiftYear } from '../report-columns/planner.js';
import { definitionForAccess, parseBuilder, assertRefsInScope, stale, definitionNotFound } from '../report-definitions.service.js';
import { ZERO_COMPANY_UUID } from '../ledger-version.service.js';
import { AppError } from '../../utils/errors.js';
import {
  inSnapshot, tooLargeError, MAX_LINE_ROWS, MAX_DETAIL_ROWS_SCREEN, MAX_DETAIL_ROWS_EXPORT, DETAIL_PAGE_ROWS, PREVIEW_DETAIL_ROWS_PER_LINE, type RunExec,
} from './limits.js';
import {
  fingerprintOf, encodeCursor, decodeCursor, runChanged, type RunRequest, type DetailRequest, type Cursor,
} from './request.js';
import { sectionRights } from './rights.js';

// ── Types ──────────────────────────────────────────────────────────

export type RowKind =
  | 'header' | 'group' | 'line' | 'detail' | 'subtotal' | 'total' | 'formula' | 'text' | 'blank' | 'page_break'
  | 'more' | 'denied' | 'earnings' | 'opening';

export interface RunDrill {
  type: 'detail' | 'transaction' | 'profit_loss';
  nodeId?: string; path?: string[]; range?: { from: string; to: string };
  txnId?: string; txnType?: string; from?: string; to?: string;
  /** profit_loss drills of a tag-filtered section: the lines carry one of these tags. */
  tagIds?: string[];
}

export interface RunRow {
  kind: RowKind;
  nodeId: string;
  level: number;
  path: string[];
  caption: string;
  cells: Array<string | null>;
  fields?: { txnId: string; txnType: string; lineId: string | null };
  drill?: RunDrill | null;
  expandable: boolean;
  expanded: boolean;
  cursor?: string | null;
}

export interface RunColumn { key: string; caption: string; kind: string; field?: RbDetailField; range?: { from: string | null; to: string } }

export interface Viewer { tenantId: string; companyId: string; permissions: EffectivePermissions; userId?: string; userRole?: string; isSuperAdmin?: boolean }

interface Slot { from: string | null; to: string; fy: string }

type ColSpec =
  | { t: 'field'; field: RbDetailField }
  | { t: 'amount' | 'debit' | 'credit'; slot: number; base: boolean }
  | { t: 'sum'; slots: number[] }
  | { t: 'change' | 'pct_change'; a: number; b: number }
  | { t: 'percent'; of: number };

interface Plan {
  def: BuilderDefinition;
  basis: 'accrual' | 'cash';
  adjusting: 'include' | 'exclude' | 'only';
  mode: 'range' | 'asOf';
  slots: Slot[];
  /** Base (non-compare) slot indexes. */
  base: number[];
  buckets: boolean;
  cols: RunColumn[];
  specs: ColSpec[];
  /** Index of the first value column. */
  firstValue: number;
}

const ZERO = () => dec(0);
const BS_TYPES = ['asset', 'liability', 'equity'];
const isDebitNormal = (t: string) => (RB_DEBIT_NORMAL_TYPES as readonly string[]).includes(t);
const RB_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'over_90'] as const;
const BUCKET_OF: Record<string, (typeof RB_BUCKETS)[number]> = {
  current: 'current', days1to30: 'd1_30', days31to60: 'd31_60', days61to90: 'd61_90', over90: 'over_90',
};
const BUCKET_CAPTION: Record<string, string> = { current: 'Current', d1_30: '1 - 30', d31_60: '31 - 60', d61_90: '61 - 90', over_90: 'Over 90' };
const FIELD_CAPTION: Record<RbDetailField, string> = {
  date: 'Date', txn_type: 'Type', number: 'Num', contact: 'Name', memo: 'Memo', description: 'Description', account: 'Account',
  item: 'Item', quantity: 'Qty', unit_price: 'Rate', tag: 'Tag', cleared: 'Clr', debit: 'Debit', credit: 'Credit', amount: 'Amount',
  running_balance: 'Balance', due_date: 'Due Date', days_past_due: 'Past Due', aging_bucket: 'Aging', open_balance: 'Open Balance',
  original_amount: 'Original Amount', service_date: 'Service Date',
};

function invalidAt(path: string, code: string, message: string): AppError {
  return AppError.badRequest(message, 'DEFINITION_INVALID', { path, code });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
const rangeCaption = (s: Slot) => (s.from ? `${fmtDay(s.from)} - ${fmtDay(s.to)}` : `As of ${fmtDay(s.to)}`);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ── Definition and plan ────────────────────────────────────────────

/** The definition of a run: inline (checked, ids in this company) or saved (kind builder, the version the caller has). */
export async function loadDefinition(exec: RunExec, v: Viewer, req: Pick<RunRequest, 'definition' | 'definitionId' | 'version'>): Promise<BuilderDefinition> {
  if ((req.definition === undefined) === (req.definitionId === undefined)) {
    throw AppError.badRequest('Send a definition or a definitionId.', 'VALIDATION_ERROR', { field: 'definition' });
  }
  if (req.definition !== undefined) {
    const { definition, refs } = parseBuilder(req.definition);
    await assertRefsInScope(exec.tx, v.tenantId, v.companyId, refs, 'NOT_IN_COMPANY');
    return definition;
  }
  const row = await definitionForAccess(v.tenantId, v.companyId, req.definitionId!).catch(() => { throw definitionNotFound(); });
  if (row.kind !== 'builder') throw invalidAt('definitionId', 'SCHEMA', 'This saved report is not a Report Builder report.');
  if (req.version !== undefined && req.version !== row.version) throw stale(row.version);
  return row.definitionJson as unknown as BuilderDefinition;
}

async function makePlan(v: Viewer, def: BuilderDefinition, req: RunRequest | DetailRequest): Promise<Plan> {
  const mode = def.dates.mode;
  const basis = req.basis ?? def.basis ?? 'accrual';
  const adjusting = req.adjusting ?? def.adjusting ?? 'include';
  const dates = req.dates as { from?: string; to?: string; asOf?: string };
  if (mode === 'range' && !dates.from) throw AppError.badRequest('This report needs a date range {from, to}.', 'INVALID_PARAM', { field: 'dates' });
  if (mode === 'asOf' && !dates.asOf) throw AppError.badRequest('This report needs an as-of date {asOf}.', 'INVALID_PARAM', { field: 'dates' });
  const fyMonth = await getFiscalYearStart(v.tenantId, v.companyId);
  const fyOf = (d: string) => {
    const s = fiscalYearStartIn(d, req.fiscalYearStarts, fyMonth);
    if (s === null) throw AppError.badRequest(`fiscalYearStarts has no fiscal year start for ${d}`, 'INVALID_PARAM', { field: 'fiscalYearStarts' });
    return s;
  };
  if (def.columns.agingBuckets) {
    // Aging columns age every item as of the report date: no period or compare columns (BUCKETS_PERIODS), and no other date.
    const pr = req.periodRanges;
    if (req.compareRanges !== undefined || (pr && (pr.length !== 1 || pr[0]!.to !== (dates.asOf ?? dates.to)))) {
      throw AppError.badRequest('Aging columns age everything as of the report date; send no periodRanges or compareRanges.', 'INVALID_PARAM', { field: req.compareRanges !== undefined ? 'compareRanges' : 'periodRanges' });
    }
  }
  const baseRanges = req.periodRanges ?? (mode === 'range' ? [{ from: dates.from!, to: dates.to! }] : [{ from: dates.asOf!, to: dates.asOf! }]);
  for (let i = 1; i < baseRanges.length; i++) {
    if (baseRanges[i]!.from <= baseRanges[i - 1]!.to) throw AppError.badRequest('periodRanges must be ascending and not overlap.', 'INVALID_PARAM', { field: 'periodRanges' });
  }
  const slot = (r: { from: string; to: string }): Slot => ({ from: mode === 'range' ? r.from : null, to: r.to, fy: fyOf(r.to) });
  const slots: Slot[] = baseRanges.map(slot);
  const base = slots.map((_, i) => i);
  const compare = def.columns.compare;
  const compareSlots: number[][] = compare.map((c, ci) => {
    const given = req.compareRanges?.[ci];
    if (given && given.length !== baseRanges.length) throw AppError.badRequest('Each compareRanges entry needs one range per period.', 'INVALID_PARAM', { field: 'compareRanges' });
    return baseRanges.map((r, i) => {
      const pr = given?.[i] ?? (c.base === 'prior_year' ? { from: shiftYear(r.from, -1), to: shiftYear(r.to, -1) } : priorRange(r, 'period'));
      slots.push(slot(pr));
      return slots.length - 1;
    });
  });
  const sections = sectionsOf(def.nodes);
  const tb = sections.some((s) => s.measure === 'tb_net');
  const cols: RunColumn[] = def.columns.detailFields.map((f) => ({ key: `f:${f}`, caption: def.columns.headers[`f:${f}`] ?? FIELD_CAPTION[f], kind: 'field', field: f }));
  const specs: ColSpec[] = def.columns.detailFields.map((f) => ({ t: 'field', field: f }));
  const firstValue = cols.length;
  const caption = (key: string, fallback: string) => def.columns.headers[key] ?? fallback;
  const add = (c: RunColumn, s: ColSpec) => { cols.push(c); specs.push(s); return cols.length - 1; };
  const amountCols = (si: number, key: string, cap: string, kind: string, isBase: boolean): number => {
    const range = { from: slots[si]!.from, to: slots[si]!.to };
    if (tb) {
      const d = add({ key: `${key}:debit`, caption: caption(`${key}:debit`, `${cap} Debit`.trim()), kind: `${kind}_debit`, range }, { t: 'debit', slot: si, base: isBase });
      add({ key: `${key}:credit`, caption: caption(`${key}:credit`, `${cap} Credit`.trim()), kind: `${kind}_credit`, range }, { t: 'credit', slot: si, base: isBase });
      return d;
    }
    return add({ key, caption: caption(key, cap), kind, range }, { t: 'amount', slot: si, base: isBase });
  };
  const buckets = !!def.columns.agingBuckets;
  if (buckets) {
    // Aging columns: one slot (the as-of date); bucket b is value index b, the total sums them.
    RB_BUCKETS.forEach((b, i) => add({ key: `bucket:${b}`, caption: caption(`bucket:${b}`, BUCKET_CAPTION[b]!), kind: 'bucket' }, { t: 'amount', slot: i, base: true }));
    add({ key: 'total', caption: caption('total', 'Total'), kind: 'total' }, { t: 'sum', slots: [0, 1, 2, 3, 4] });
  } else {
    const multi = baseRanges.length > 1;
    const baseCols: number[] = [];
    base.forEach((si, i) => {
      const key = multi ? `p${i}` : 'total';
      const cap = multi ? rangeCaption(slots[si]!) : (tb ? '' : 'Total');
      const cur = amountCols(si, key, cap, multi ? 'period' : 'total', true);
      baseCols.push(cur);
      compare.forEach((c, ci) => {
        const pk = `${key}:c${ci}`;
        const pcap = c.base === 'prior_year' ? 'Prior Year' : 'Prior Period';
        const prior = c.amount || c.dollarChange || c.percentChange ? amountCols(compareSlots[ci]![i]!, pk, pcap, 'prior', false) : -1;
        if (!tb && c.dollarChange) add({ key: `${pk}:change`, caption: caption(`${pk}:change`, '$ Change'), kind: 'change' }, { t: 'change', a: cur, b: prior });
        if (!tb && c.percentChange) add({ key: `${pk}:pct_change`, caption: caption(`${pk}:pct_change`, '% Change'), kind: 'pct_change' }, { t: 'pct_change', a: cur, b: prior });
      });
      if (def.columns.percentOf && !tb) add({ key: `${key}:pct`, caption: caption(`${key}:pct`, '%'), kind: 'percent' }, { t: 'percent', of: cur });
    });
    if (multi && mode === 'range' && !tb) {
      const tot = add({ key: 'total', caption: caption('total', 'Total'), kind: 'total' }, { t: 'sum', slots: base });
      if (def.columns.percentOf) add({ key: 'total:pct', caption: caption('total:pct', '%'), kind: 'percent' }, { t: 'percent', of: tot });
    }
    // Compare columns not shown as amounts are still computed (they feed the changes); hide them from the wire.
    for (let i = specs.length - 1; i >= 0; i--) {
      const s = specs[i]!;
      if ((s.t === 'amount' || s.t === 'debit' || s.t === 'credit') && !s.base) {
        const ci = Number(cols[i]!.key.split(':c')[1]?.[0]);
        if (!compare[ci]?.amount) cols[i] = { ...cols[i]!, kind: 'hidden' };
      }
    }
  }
  if (cols.filter((c) => c.kind !== 'field').length === 0) throw AppError.badRequest('This report has no columns.', 'INVALID_PARAM');
  for (const s of sections) {
    if (basis === 'cash' && RB_SOURCE_INFO[s.source].accrualOnly.includes(s.measure)) {
      throw invalidAt(`node:${s.id}.measure`, 'NOT_ON_CASH', 'Quantity is not available on cash basis.');
    }
  }
  return { def, basis, adjusting, mode, slots, base, buckets, cols, specs, firstValue };
}

function sectionsOf(nodes: RbNode[]): RbSectionNode[] {
  const out: RbSectionNode[] = [];
  const walk = (ns: RbNode[]) => ns.forEach((n) => { if (n.type === 'section') out.push(n); else if (n.type === 'group') walk(n.children); });
  walk(nodes);
  return out;
}

// ── Line sources: SQL ──────────────────────────────────────────────

interface LineCols {
  date: string; d: string; c: string; contact: string; docContact: string; item: string; tag: string; lineId: string; vkey: string;
  rawType: string; txnType: string; memo: string; desc: string; qty: string; price: string; svc: string; number: SQL; created: string;
  txnId: string; due: string;
}

const ACCRUAL: LineCols = {
  date: 't.txn_date', d: 'jl.debit', c: 'jl.credit', contact: 'COALESCE(jl.contact_id, t.contact_id)', docContact: 't.contact_id',
  item: 'jl.item_id', tag: 'jl.tag_id', lineId: 'jl.id', vkey: 'jl.id::text', rawType: 't.txn_type',
  txnType: "CASE WHEN t.txn_type = 'expense' AND t.is_check THEN 'check' ELSE t.txn_type END", memo: 't.memo', desc: 'jl.description',
  qty: 'jl.quantity', price: 'jl.unit_price', svc: 'jl.service_date', number: docNumberSql('t'), created: 't.created_at', txnId: 't.id', due: 't.due_date',
};
const CASH: LineCols = {
  date: 'cb.txn_date', d: 'cb.debit', c: 'cb.credit', contact: 'COALESCE(cb.line_contact_id, cb.txn_contact_id)', docContact: 'cb.txn_contact_id',
  item: 'cb.item_id', tag: 'cb.tag_id', lineId: 'cb.line_id', vkey: 'cb.vkey', rawType: 'cb.txn_type',
  txnType: "CASE WHEN cb.txn_type = 'expense' AND t.is_check THEN 'check' ELSE cb.txn_type END", memo: 'cb.memo', desc: 'cb.description',
  qty: 'NULL::numeric', price: 'NULL::numeric', svc: 'NULL::date', number: sql.raw('cb.txn_number'), created: 't.created_at', txnId: 'cb.transaction_id', due: 't.due_date',
};
const raw = (s: string) => sql.raw(s);
const list = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
const uuids = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}::uuid`), sql`, `);

function clearedExpr(tenantId: string, lineCol: string): SQL {
  const any = sql`EXISTS (SELECT 1 FROM reconciliation_lines lrl JOIN reconciliations lr ON lr.id = lrl.reconciliation_id AND lr.tenant_id = ${tenantId}
    WHERE lrl.journal_line_id = ${raw(lineCol)} AND lrl.is_cleared)`;
  const done = sql`EXISTS (SELECT 1 FROM reconciliation_lines lrl JOIN reconciliations lr ON lr.id = lrl.reconciliation_id AND lr.tenant_id = ${tenantId}
    WHERE lrl.journal_line_id = ${raw(lineCol)} AND lrl.is_cleared AND lr.status = 'complete')`;
  return sql`(CASE WHEN ${raw(lineCol)} IS NULL THEN 'uncleared' WHEN ${done} THEN 'reconciled' WHEN ${any} THEN 'cleared' ELSE 'uncleared' END)`;
}

interface Ctx { v: Viewer; exec: RunExec; plan: Plan; fyStarts: string[] }

function sourceCond(s: RbSectionNode, cash: boolean, k: LineCols): SQL {
  const purchaseTypes = cash ? ['bill', 'vendor_credit', 'expense', 'bill_payment'] : ['bill', 'vendor_credit', 'expense'];
  switch (s.source) {
    case 'sales': case 'item_sales': return cash ? salesCashCond() : salesAccrualCond();
    case 'purchases': return sql`a.account_type IN ('expense', 'cogs', 'other_expense') AND ${raw(k.rawType)} IN (${list(purchaseTypes)})`;
    case 'item_purchases': return sql`${raw(k.item)} IS NOT NULL AND ${raw(k.rawType)} IN (${list(purchaseTypes)})`;
    case 'bank': return sql`a.detail_type IN (${list(BANK_DETAIL_TYPES)})`;
    case 'tax': return sql`a.system_tag = 'sales_tax_payable'`;
    default: return sql`TRUE`;
  }
}

function filterCol(ctx: Ctx, s: RbSectionNode, f: RbFilter, k: LineCols): SQL {
  switch (f.field) {
    case 'account': return sql`a.id`;
    case 'account_type': return sql`a.account_type`;
    case 'contact': return raw(s.source === 'tax' ? k.docContact : k.contact);
    case 'item': return raw(k.item);
    case 'tag': return raw(k.tag);
    case 'txn_type': return raw(k.txnType);
    case 'cleared': return clearedExpr(ctx.v.tenantId, k.lineId);
    default: return sql`NULL`;
  }
}

function filterSql(ctx: Ctx, s: RbSectionNode, k: LineCols, cash: boolean): SQL {
  const parts: SQL[] = [];
  const tbTagMode = s.earnings === 'trial_balance';
  for (const f of s.filters) {
    if (f.field === 'amount') {
      parts.push(f.op === 'gte' ? sql`abs(${raw(k.d)} - ${raw(k.c)}) >= ${f.value}::numeric` : sql`abs(${raw(k.d)} - ${raw(k.c)}) <= ${f.value}::numeric`);
      continue;
    }
    if (f.field === 'tag' && tbTagMode && f.op === 'in') {
      // Trial Balance tag mode (U-213 S2): every line of a transaction with a line carrying the tag.
      parts.push(cash
        ? sql`EXISTS (SELECT 1 FROM cb_lines cb2 WHERE cb2.transaction_id = cb.transaction_id AND cb2.tag_id IN (${uuids(f.ids!)}))`
        : sql`EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.transaction_id = t.id AND jl2.tenant_id = ${ctx.v.tenantId} AND jl2.tag_id IN (${uuids(f.ids!)}))`);
      continue;
    }
    const col = filterCol(ctx, s, f, k);
    const vals = f.ids ? uuids(f.ids) : f.values ? list(f.values) : null;
    if (f.op === 'is_none') parts.push(sql`${col} IS NULL`);
    else if (f.op === 'in') parts.push(sql`${col} IN (${vals!})`);
    else if (f.op === 'not_in') parts.push(sql`(${col} IS NULL OR ${col} NOT IN (${vals!}))`);
  }
  return parts.length ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

function keyExpr(ctx: Ctx, s: RbSectionNode, level: number, k: LineCols, cash: boolean): SQL {
  const g = s.groupBy[level]!;
  const date = raw(k.date);
  const starts = sql`ARRAY[${list(ctx.fyStarts)}]::date[]`;
  const fyOf = sql`COALESCE((SELECT max(fs) FROM unnest(${starts}) fs WHERE fs <= ${date}), date_trunc('year', ${date})::date)`;
  switch (g.key) {
    case 'account': return sql`a.id::text`;
    case 'account_type': return sql`a.account_type::text`;
    case 'contact': return sql`(${raw(s.source === 'tax' ? k.docContact : k.contact)})::text`;
    case 'item': return sql`(${raw(k.item)})::text`;
    case 'txn_type': return raw(k.txnType);
    case 'tag': return sql`(${tagInGroupKey(ctx.v.tenantId, g.tagGroupId!, k.tag)})::text`;
    case 'month': return sql`to_char(date_trunc('month', ${date}), 'YYYY-MM-DD')`;
    case 'year': return sql`to_char(${fyOf}, 'YYYY-MM-DD')`;
    case 'quarter': return sql`to_char((${fyOf} + make_interval(months => (3 * floor(((extract(year FROM age(${date}, ${fyOf})) * 12 + extract(month FROM age(${date}, ${fyOf}))) / 3))::int)))::date, 'YYYY-MM-DD')`;
    case 'cleared': return clearedExpr(ctx.v.tenantId, k.lineId);
    default: return cash ? sql`NULL::text` : sql`NULL::text`;
  }
}

/**
 * A line's value as the section shows it. `normal` (U-218): the value in the
 * section's normal accounting sign instead, as if its polarity were
 * `natural` — a gl line by its account's normal side (asset, cogs, expense
 * and other expense debit - credit; revenue, other revenue, liability and
 * equity credit - debit), any other source by its default sign. Formulas,
 * group and percent-of bases read normal-sign totals, so "Show as positive"
 * changes only the section's own shown cells.
 */
function valueExpr(s: RbSectionNode, k: LineCols, normal = false): SQL {
  const d = raw(k.d), c = raw(k.c);
  switch (s.measure) {
    case 'debit': return sql`${d}`;
    case 'credit': return sql`${c}`;
    case 'count': return sql`1::numeric`;
    case 'quantity': return sql`COALESCE(${raw(k.qty)}, 0)::numeric`;
    case 'tb_net': return sql`(${d} - ${c})`;
    default: {
      const pol = !normal && s.polarity && s.polarity !== 'natural' ? s.polarity
        : RB_SOURCE_INFO[s.source].sign === 'natural' ? 'natural'
          : RB_SOURCE_INFO[s.source].sign === 'debit_minus_credit' ? 'debit' : 'credit';
      if (pol === 'debit') return sql`(${d} - ${c})`;
      if (pol === 'credit') return sql`(${c} - ${d})`;
      return sql`(CASE WHEN a.account_type IN (${list(RB_DEBIT_NORMAL_TYPES)}) THEN ${d} - ${c} ELSE ${c} - ${d} END)`;
    }
  }
}

/** Whether a section's shown sign may differ from its normal sign (U-218): an amount or balance with an explicit polarity. */
const signSet = (s: RbSectionNode) => !RB_SOURCE_INFO[s.source].openItems && (s.measure === 'amount' || s.measure === 'balance')
  && s.polarity !== undefined && s.polarity !== 'natural';

const isFlow = (s: RbSectionNode) => s.measure !== 'balance' && s.measure !== 'tb_net';

/** The lines of a section through `to` (from `from` when given): FROM … WHERE … for either basis. */
function linesSql(ctx: Ctx, s: RbSectionNode, from: string | null, to: string): { with: SQL; from: SQL; where: SQL; k: LineCols; cash: boolean } {
  const { tenantId, companyId } = ctx.v;
  const cash = ctx.plan.basis === 'cash';
  const k = cash ? CASH : ACCRUAL;
  const adj = ctx.plan.adjusting;
  if (cash) {
    return {
      with: sql`WITH ${cashBasisLinesWith(tenantId, from, to, companyId, adj)}`,
      from: sql`FROM cb_lines cb JOIN transactions t ON t.id = cb.transaction_id AND t.tenant_id = ${tenantId}
        JOIN accounts a ON a.id = cb.account_id AND a.tenant_id = ${tenantId}`,
      where: sql`${sourceCond(s, true, k)} AND ${filterSql(ctx, s, k, true)}`,
      k, cash,
    };
  }
  return {
    with: sql``,
    from: sql`FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
      JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}`,
    where: sql`jl.tenant_id = ${tenantId} AND t.status = 'posted' AND t.basis <> 'cash'
      AND t.company_id = ${companyId} AND ${adjustingCond(adj, 't.is_adjusting')}
      ${from ? sql`AND t.txn_date >= ${from}` : sql``} AND t.txn_date <= ${to}
      AND ${sourceCond(s, false, k)} AND ${filterSql(ctx, s, k, false)}`,
    k, cash,
  };
}

/**
 * `keep`: the line shows even when zero (an account with only an opening balance, U-119f).
 * `nv`: the value in the section's normal sign when it differs from `v` (U-218).
 */
interface Fact { keys: Array<string | null>; slot: number; v: Dec; nv?: Dec; keep?: boolean }

/**
 * Facts of every line section of a run in ONE statement (one cash-basis
 * ledger per run, not one per section or column): each section's activity
 * is summed per date bucket — buckets are cut at every column's end, the day
 * before every column's start and the day before every fiscal year start —
 * and each column then adds its buckets: a flow measure the buckets inside
 * its range, a balance (balance, tb_net) every bucket through its date
 * (income-statement accounts only from its fiscal year start). Exact: the
 * same lines and Decimal sums. `earnings` adds the line-mode earnings
 * (credit - debit over income-statement lines, the section's line-level tag).
 */
interface BatchItem { sid: string; s: RbSectionNode; pathKeys: Array<string | null>; earningsOf?: boolean }
interface BucketRow { keys: Array<string | null>; lo: string; hi: string; bs: boolean; v: Dec; nv?: Dec }

async function bucketFacts(ctx: Ctx, items: BatchItem[]): Promise<Map<string, BucketRow[]>> {
  const out = new Map<string, BucketRow[]>(items.map((x) => [x.sid, []]));
  if (items.length === 0) return out;
  const slots = ctx.plan.slots;
  const cutSet = new Set<string>();
  for (const sl of slots) { cutSet.add(sl.to); cutSet.add(addDays(sl.fy, -1)); if (sl.from) cutSet.add(addDays(sl.from, -1)); }
  const cuts = [...cutSet].sort();
  const maxTo = cuts[cuts.length - 1]!;
  const allFlow = items.every((x) => !x.earningsOf && isFlow(x.s)) && ctx.plan.mode === 'range';
  const minFrom = allFlow ? slots.reduce((m, x) => (x.from! < m ? x.from! : m), slots[0]!.from!) : null;
  const L0 = linesSql(ctx, items[0]!.s, minFrom, maxTo);
  const buckets = sql`(VALUES ${sql.join(cuts.map((hi, i) => sql`(${i}::int, ${i === 0 ? '0001-01-01' : addDays(cuts[i - 1]!, 1)}::date, ${hi}::date)`), sql`, `)}) b(i, lo, hi)`;
  const parts = items.map((it) => {
    const L = linesSql(ctx, it.s, minFrom, maxTo);
    const keys = it.s.groupBy.map((_, i) => keyExpr(ctx, it.s, i, L.k, L.cash));
    const eq = it.pathKeys.map((pk, i) => (pk === null ? sql`${keys[i]!} IS NULL` : sql`${keys[i]!} = ${pk}`));
    const k3 = [0, 1, 2].map((i) => (keys[i] ? sql`${keys[i]!}` : sql`NULL::text`));
    const val = it.earningsOf ? sql`(${raw(L.k.c)} - ${raw(L.k.d)})` : valueExpr(it.s, L.k);
    // The normal-sign sum (U-218), only where it can differ from the shown one.
    const nval = !it.earningsOf && signSet(it.s) ? sql`SUM(${valueExpr(it.s, L.k, true)})::text` : sql`NULL::text`;
    const pl = it.earningsOf ? sql`AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense')` : sql``;
    return sql`SELECT ${it.sid}::text AS sid, ${k3[0]!} AS k0, ${k3[1]!} AS k1, ${k3[2]!} AS k2, b.i AS b,
        (a.account_type IN ('asset', 'liability', 'equity')) AS bs, SUM(${val})::text AS v, ${nval} AS nv
      ${L.from} JOIN ${buckets} ON ${raw(L.k.date)} >= b.lo AND ${raw(L.k.date)} <= b.hi
      WHERE ${L.where} ${pl} ${eq.length ? sql`AND ${sql.join(eq, sql` AND `)}` : sql``}
      GROUP BY 1, 2, 3, 4, 5, 6`;
  });
  const res = await ctx.exec.execute(sql`${L0.with} ${sql.join(parts, sql` UNION ALL `)}`);
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const bi = Number(r['b']);
    out.get(String(r['sid']))!.push({
      keys: [r['k0'], r['k1'], r['k2']].map((x) => (x as string | null) ?? null),
      lo: bi === 0 ? '0001-01-01' : addDays(cuts[bi - 1]!, 1), hi: cuts[bi]!, bs: r['bs'] === true, v: dec(String(r['v'] ?? '0')),
      ...(r['nv'] === null || r['nv'] === undefined ? {} : { nv: dec(String(r['nv'])) }),
    });
  }
  return out;
}

/** A section's facts per column from its bucket rows. */
function factsFromBuckets(ctx: Ctx, s: RbSectionNode, rows: BucketRow[]): Fact[] {
  const out: Fact[] = [];
  const flow = isFlow(s);
  for (const r of rows) {
    const keys = r.keys.slice(0, s.groupBy.length);
    ctx.plan.slots.forEach((sl, si) => {
      if (r.hi > sl.to) return;
      if (flow) { if (sl.from !== null && r.lo < sl.from) return; } else if (!r.bs && r.lo < sl.fy) return;
      out.push({ keys, slot: si, v: r.v, ...(r.nv ? { nv: r.nv } : {}) });
    });
  }
  return out;
}

/**
 * Whether a section lists accounts with an opening balance and no activity in
 * the range, as the standard General Ledger does (U-119f): a range run whose
 * detail rows carry a running balance (innermost group-by the account).
 */
function listsOpeningOnly(plan: Plan, s: RbSectionNode): boolean {
  return plan.mode === 'range' && !RB_SOURCE_INFO[s.source].openItems && isFlow(s) && s.display !== 'summary'
    && plan.def.columns.detailFields.includes('running_balance') && s.groupBy[s.groupBy.length - 1]?.key === 'account';
}

/**
 * Zero facts (kept) for the innermost lines with an opening balance before the
 * run's first date: the standard General Ledger's rule (balance-sheet accounts
 * from the start, income-statement accounts from the fiscal year start; a
 * balance under half a cent is left out, as there).
 */
async function openingOnlyFacts(ctx: Ctx, s: RbSectionNode): Promise<Fact[]> {
  const { plan } = ctx;
  const lowFrom = plan.base.reduce((m, i) => (plan.slots[i]!.from! < m ? plan.slots[i]!.from! : m), plan.slots[plan.base[0]!]!.from!);
  const L = linesSql(ctx, s, null, addDays(lowFrom, -1));
  const keys = s.groupBy.map((_, i) => keyExpr(ctx, s, i, L.k, L.cash));
  const res = await ctx.exec.execute(sql`${L.with}
    SELECT ${sql.join(keys.map((k, i) => sql`${k} AS ${raw(`k${i}`)}`), sql`, `)}
    ${L.from} WHERE ${L.where}
      AND (a.account_type IN ('asset', 'liability', 'equity') OR ${raw(L.k.date)} >= ${fiscalYearStartIn(lowFrom, ctx.fyStarts, 1) ?? lowFrom}::date)
    GROUP BY ${sql.join(keys.map((_, i) => raw(String(i + 1))), sql`, `)}
    HAVING abs(SUM(${valueExpr(s, L.k)})) >= 0.005`);
  const out: Fact[] = [];
  for (const r of res.rows as Array<Record<string, string | null>>) {
    const k = s.groupBy.map((_, i) => r[`k${i}`] ?? null);
    for (const slot of plan.base) out.push({ keys: k, slot, v: ZERO(), keep: true });
  }
  return out;
}

async function lineFacts(ctx: Ctx, s: RbSectionNode, pathKeys: Array<string | null> = []): Promise<Fact[]> {
  const m = await bucketFacts(ctx, [{ sid: s.id, s, pathKeys }]);
  return factsFromBuckets(ctx, s, m.get(s.id)!);
}

// ── Open-item sources ──────────────────────────────────────────────

interface OpenRow { contactId: string | null; txnId: string; txnType: string; number: string | null; date: string; dueDate: string | null; openExact: string; originalExact: string }

async function openItems(ctx: Ctx, s: RbSectionNode, asOf: string): Promise<OpenRow[]> {
  const tagIds: string[] = [];
  for (const f of s.filters) {
    if (f.field !== 'tag') continue;
    if (f.op !== 'in') throw invalidAt(`node:${s.id}.filters`, 'NOT_IN_SOURCE', 'On open items a tag can only be required (in).');
    tagIds.push(...f.ids!);
  }
  const q = { tenantId: ctx.v.tenantId, companyId: ctx.v.companyId, asOf, ...(tagIds.length ? { tagIds } : {}) };
  const items: OpenRow[] = s.source === 'ar_open'
    ? (await arOpenItemsAsOf(ctx.exec.tx, q)).map((i) => ({ contactId: i.contactId, txnId: i.txnId, txnType: i.txnType, number: i.number, date: i.date, dueDate: i.dueDate, openExact: i.openExact, originalExact: i.originalExact }))
    : (await apOpenItemsAsOf(ctx.exec.tx, q)).map((i) => ({ contactId: i.contactId, txnId: i.txnId, txnType: i.txnType, number: i.number, date: i.date, dueDate: i.dueDate, openExact: i.openExact, originalExact: i.originalExact }));
  const bucketOf = (i: OpenRow) => BUCKET_OF[bucketFor(daysBetween(i.dueDate ?? i.date, asOf))]!;
  const dueOf = (i: OpenRow) => (i.dueDate !== null && i.dueDate < asOf ? 'overdue' : 'current');
  return items.filter((i) => s.filters.every((f) => {
    const val = f.field === 'contact' ? i.contactId : f.field === 'txn_type' ? i.txnType : f.field === 'due_status' ? dueOf(i) : f.field === 'aging_bucket' ? bucketOf(i) : undefined;
    if (f.field === 'tag' || val === undefined) return true;
    const set = f.ids ?? f.values ?? [];
    if (f.op === 'is_none') return val === null;
    if (f.op === 'in') return val !== null && set.includes(val);
    if (f.op === 'not_in') return val === null || !set.includes(val);
    return true;
  }));
}

function openKey(key: string, i: OpenRow, asOf: string): string | null {
  switch (key) {
    case 'contact': return i.contactId;
    case 'txn_type': return i.txnType;
    case 'due_status': return i.dueDate !== null && i.dueDate < asOf ? 'overdue' : 'current';
    case 'aging_bucket': return BUCKET_OF[bucketFor(daysBetween(i.dueDate ?? i.date, asOf))]!;
    default: return null;
  }
}

const openValue = (s: RbSectionNode, i: OpenRow) => (s.measure === 'count' ? dec(1) : dec(s.measure === 'original_amount' ? i.originalExact : i.openExact));

/** The code-point order of open items: (contact, date, number, transaction). */
export function compareOpen(a: { contactId: string | null; date: string; number: string | null; txnId: string }, b: typeof a): number {
  const t = (x: typeof a) => [x.contactId ?? '', x.date, x.number ?? '', x.txnId];
  const ta = t(a), tb = t(b);
  for (let i = 0; i < 4; i++) { if (ta[i]! < tb[i]!) return -1; if (ta[i]! > tb[i]!) return 1; }
  return 0;
}

async function openFacts(ctx: Ctx, s: RbSectionNode, pathKeys: Array<string | null> = []): Promise<Fact[]> {
  const out: Fact[] = [];
  const asOfs = ctx.plan.buckets ? [ctx.plan.slots[0]!.to] : ctx.plan.slots.map((x) => x.to);
  for (let si = 0; si < asOfs.length; si++) {
    const asOf = asOfs[si]!;
    for (const i of await openItems(ctx, s, asOf)) {
      const keys = s.groupBy.map((g) => openKey(g.key, i, asOf));
      if (pathKeys.some((pk, j) => pk !== keys[j])) continue;
      const slot = ctx.plan.buckets ? RB_BUCKETS.indexOf(openKey('aging_bucket', i, asOf) as (typeof RB_BUCKETS)[number]) : si;
      out.push({ keys, slot, v: openValue(s, i) });
    }
  }
  return out;
}

// ── Values to cells ────────────────────────────────────────────────

type Vals = Dec[];
const zeros = (n: number): Vals => Array.from({ length: n }, ZERO);
const nVals = (p: Plan) => (p.buckets ? RB_BUCKETS.length : p.slots.length);
const addInto = (a: Vals, b: Vals) => { for (let i = 0; i < a.length; i++) a[i] = a[i]!.plus(b[i]!); };

/** Cells of a row from its values; tb sections show the net in debit or credit. `base` gives percent-of bases per column. */
function cellsOf(plan: Plan, vals: Vals | null, base: Array<Dec | null> | null, pairs?: Array<Dec | null>): Array<string | null> {
  const out: Array<Dec | string | null> = [];
  plan.specs.forEach((s, i) => {
    if (vals === null) { out.push(null); return; }
    switch (s.t) {
      case 'field': out.push(null); break;
      case 'amount': out.push(vals[s.slot]!); break;
      case 'debit': out.push(pairs ? pairs[i] ?? null : (vals[s.slot]!.gt(0) ? vals[s.slot]! : null)); break;
      case 'credit': out.push(pairs ? pairs[i] ?? null : (vals[s.slot]!.lt(0) ? vals[s.slot]!.neg() : null)); break;
      case 'sum': out.push(s.slots.reduce((acc, x) => acc.plus(vals[x]!), ZERO())); break;
      case 'change': out.push((out[s.a] as Dec).minus(out[s.b] as Dec)); break;
      case 'pct_change': { const a = out[s.a] as Dec, b = out[s.b] as Dec; out.push(percent1(a.minus(b), b.abs())); break; }
      case 'percent': { const b = base?.[s.of] ?? null; out.push(b === null ? null : percent1(out[s.of] as Dec, b)); break; }
    }
  });
  return out.map((x, i) => (plan.cols[i]!.kind === 'hidden' ? null : x === null || typeof x === 'string' ? x : exactStr(x)));
}

/** The Dec values of the amount columns of a row's cells (for percent bases and tb totals). */
function decCells(plan: Plan, vals: Vals | null): Array<Dec | null> {
  if (vals === null) return plan.specs.map(() => null);
  return plan.specs.map((s) => {
    if (s.t === 'amount') return vals[s.slot]!;
    if (s.t === 'sum') return s.slots.reduce((acc, x) => acc.plus(vals[x]!), ZERO());
    return null;
  });
}

// ── Names ──────────────────────────────────────────────────────────

async function namesFor(ctx: Ctx, kind: 'account' | 'contact' | 'item' | 'tag', ids: string[]): Promise<Map<string, { name: string; sort: string }>> {
  const m = new Map<string, { name: string; sort: string }>();
  const real = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (real.length === 0) return m;
  const t = ctx.v.tenantId;
  const q = kind === 'account'
    ? sql`SELECT id::text AS id, name, COALESCE(account_number, '') AS n FROM accounts WHERE tenant_id = ${t} AND id IN (${uuids(real)})`
    : kind === 'contact'
      ? sql`SELECT id::text AS id, display_name AS name, '' AS n FROM contacts WHERE tenant_id = ${t} AND id IN (${uuids(real)})`
      : kind === 'item'
        ? sql`SELECT id::text AS id, name, '' AS n FROM items WHERE tenant_id = ${t} AND id IN (${uuids(real)})`
        : sql`SELECT id::text AS id, name, COALESCE(tag_number, '') AS n FROM tags WHERE tenant_id = ${t} AND id IN (${uuids(real)})`;
  for (const r of (await ctx.exec.execute(q)).rows as Array<{ id: string; name: string; n: string }>) {
    m.set(r.id, { name: r.n && kind === 'account' ? `${r.n} ${r.name}` : r.name, sort: `${r.n}\u0000${r.name.toLowerCase()}` });
  }
  return m;
}

const NONE_CAPTION: Record<string, string> = { contact: 'No name', item: 'No item', tag: 'No tag', account: 'No account' };
const TYPE_LABEL = (t: string) => (t === 'check' ? 'Check' : (TXN_TYPE_LABELS as Record<string, string>)[t] ?? t);
const TITLE = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function keyCaption(key: string, value: string | null, names: Map<string, { name: string; sort: string }>): { caption: string; sort: string } {
  if (value === null) return { caption: NONE_CAPTION[key] ?? 'None', sort: '￿' };
  switch (key) {
    case 'account': case 'contact': case 'item': case 'tag': { const n = names.get(value); return { caption: n?.name ?? '(deleted)', sort: n?.sort ?? value }; }
    case 'txn_type': return { caption: TYPE_LABEL(value), sort: TYPE_LABEL(value).toLowerCase() };
    case 'month': return { caption: `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`, sort: value };
    case 'quarter': return { caption: `Quarter from ${fmtDay(value)}`, sort: value };
    case 'year': return { caption: `Fiscal year from ${fmtDay(value)}`, sort: value };
    case 'aging_bucket': return { caption: BUCKET_CAPTION[value] ?? value, sort: String(RB_BUCKETS.indexOf(value as never)) };
    default: return { caption: TITLE(value), sort: value };
  }
}

// ── The run ────────────────────────────────────────────────────────

interface Tree { key: string | null; vals: Vals; children: Map<string, Tree>; keep?: boolean }

function buildTree(facts: Fact[], depth: number, n: number): Tree {
  const root: Tree = { key: null, vals: zeros(n), children: new Map() };
  for (const f of facts) {
    let node = root;
    node.vals[f.slot] = node.vals[f.slot]!.plus(f.v);
    for (let i = 0; i < depth; i++) {
      const k = f.keys[i] ?? null;
      const id = k ?? '\u0000none';
      let c = node.children.get(id);
      if (!c) { c = { key: k, vals: zeros(n), children: new Map() }; node.children.set(id, c); }
      c.vals[f.slot] = c.vals[f.slot]!.plus(f.v);
      if (f.keep) c.keep = true;
      node = c;
    }
  }
  return root;
}

const anyNonZero = (t: Tree): boolean => t.vals.some((x) => !x.isZero()) || [...t.children.values()].some(anyNonZero);
const pathSeg = (key: string, value: string | null) => `${key}:${value ?? 'none'}`;
const pathId = (p: string[]) => p.join('\u0001');

export interface RunResult {
  columns: RunColumn[];
  rows: RunRow[];
  meta: {
    basis: string; dates: unknown; notes: string[]; truncated: boolean; hiddenNotice: null; denied: string[];
    /** Preview runs only (report-builder-preview-v1): the per-line detail row cut. */
    preview?: { detailRowsPerLine: number };
  };
  fingerprint: string;
  stamp: number;
}

async function readStamp(ctx: Ctx): Promise<number> {
  const r = await ctx.exec.execute(sql`SELECT COALESCE(SUM(counter), 0)::text AS n FROM gl_version_stamps
    WHERE tenant_id = ${ctx.v.tenantId} AND company_id IN (${ctx.v.companyId}::uuid, ${ZERO_COMPANY_UUID}::uuid)`);
  return Number((r.rows[0] as { n: string }).n);
}

export async function runReport(v: Viewer, req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
  return inSnapshot(async (exec) => {
    const def = await loadDefinition(exec, v, req);
    const plan = await makePlan(v, def, req);
    const ctx: Ctx = { v, exec, plan, fyStarts: req.fiscalYearStarts };
    const stamp = await readStamp(ctx);
    const out = await assemble(ctx, req);
    return { ...out, fingerprint: fingerprintOf(req), stamp, meta: { ...out.meta, basis: plan.basis, dates: req.dates } };
  }, { signal });
}

/**
 * `vals`: the totals as shown (a section's polarity applied; a group sums its children as shown).
 * `nat`: the totals in each section's normal sign (U-218), which formulas and percent-of bases read.
 */
interface NodeTotal { vals: Vals | null; nat: Vals | null; denied: boolean; pairs?: Array<Dec | null> }

async function assemble(ctx: Ctx, req: RunRequest): Promise<{ columns: RunColumn[]; rows: RunRow[]; meta: RunResult['meta'] }> {
  const { plan } = ctx;
  const def = plan.def;
  const n = nVals(plan);
  const open = new Set(req.open.map(pathId));
  const collapsed = new Set(req.collapsed.map(pathId));
  const detailCap = req.purpose === 'export' ? MAX_DETAIL_ROWS_EXPORT : MAX_DETAIL_ROWS_SCREEN;
  // Preview (U-217): the same walk and detail query as a screen run, cut at
  // PREVIEW_DETAIL_ROWS_PER_LINE rows per line, so the rows up to the cut are
  // the full run's rows; the cut is the usual more row with its cursor.
  const preview = req.purpose === 'preview';
  const perLine = preview ? PREVIEW_DETAIL_ROWS_PER_LINE : DETAIL_PAGE_ROWS * 10;
  let detailLeft = detailCap;
  let lineRows = 0;
  let truncated = false;
  const denied: string[] = [];
  const totals = new Map<string, NodeTotal>();
  const sectionData = new Map<string, { tree: Tree; earnings: EarningsRow[] }>();

  // Rights, then every line section's facts (and line-mode earnings) in one statement.
  const allowed = sectionsOf(def.nodes).filter((x) => {
    const ok = sectionRights(x, plan.basis).every((r) => can(ctx.v.permissions, r as never, 'read'));
    if (!ok) denied.push(x.id);
    return ok;
  });
  for (const x of allowed) await checkPolarity(ctx, x);
  const batch: BatchItem[] = [];
  for (const x of allowed) {
    if (!RB_SOURCE_INFO[x.source].openItems) batch.push({ sid: x.id, s: x, pathKeys: [] });
    const tbTagged = x.earnings === 'trial_balance' && x.filters.some((f) => f.field === 'tag' && f.op === 'in');
    if (x.earnings && !tbTagged) batch.push({ sid: `${x.id}#earnings`, s: earningsSection(x), pathKeys: [], earningsOf: true });
  }
  const prefetched = await bucketFacts(ctx, batch);

  // Pass 1: facts and totals of every node, in pre-order.
  const visit = async (nodes: RbNode[]): Promise<void> => {
    for (const node of nodes) {
      if (node.type === 'section') {
        if (denied.includes(node.id)) {
          totals.set(node.id, { vals: null, nat: null, denied: true });
          continue;
        }
        const facts = RB_SOURCE_INFO[node.source].openItems ? await openFacts(ctx, node) : factsFromBuckets(ctx, node, prefetched.get(node.id)!);
        if (listsOpeningOnly(plan, node)) facts.push(...await openingOnlyFacts(ctx, node));
        const tree = buildTree(facts, node.groupBy.length, n);
        const earnings = node.earnings ? await earningsRows(ctx, node, prefetched.get(`${node.id}#earnings`) ?? []) : [];
        const vals = tree.vals.slice();
        const nat = zeros(n);
        for (const f of facts) nat[f.slot] = nat[f.slot]!.plus(f.nv ?? f.v);
        for (const e of earnings) { addInto(vals, e.vals); addInto(nat, e.nat); }
        sectionData.set(node.id, { tree, earnings });
        totals.set(node.id, { vals, nat, denied: false });
      } else if (node.type === 'group') {
        await visit(node.children);
        let acc: Vals | null = zeros(n);
        let nat: Vals | null = zeros(n);
        for (const c of node.children) {
          if (c.type !== 'section' && c.type !== 'group') continue;
          const t = totals.get(c.id)!;
          if (t.vals === null || t.nat === null) { acc = null; nat = null; break; }
          addInto(acc, t.vals);
          addInto(nat!, t.nat);
        }
        totals.set(node.id, { vals: acc, nat, denied: acc === null });
      } else if (node.type === 'formula') {
        // Terms in their normal sign (U-218, Q-A08ai): a section's polarity never changes a formula.
        let acc: Vals | null = zeros(n);
        for (const term of node.terms) {
          const t = totals.get(term.nodeId);
          if (!t || t.nat === null) { acc = null; break; }
          for (let i = 0; i < n; i++) acc[i] = acc[i]!.plus(term.sign === 1 ? t.nat[i]! : t.nat[i]!.neg());
        }
        totals.set(node.id, { vals: acc, nat: acc, denied: acc === null });
      }
    }
  };
  await visit(def.nodes);

  const percentBase = (sectionVals: Vals | null): Array<Dec | null> | null => {
    const p = def.columns.percentOf;
    if (!p) return null;
    // A node base in its normal sign (U-218); 'section' divides a section's shown cells by its shown total.
    const vals = p === 'section' ? sectionVals : totals.get(p)?.nat ?? null;
    return decCells(plan, vals).map((x) => (x === null ? null : x));
  };

  // Names for every group-by value.
  const ids: Record<'account' | 'contact' | 'item' | 'tag', Set<string>> = { account: new Set(), contact: new Set(), item: new Set(), tag: new Set() };
  const collect = (t: Tree, s: RbSectionNode, level: number) => {
    for (const c of t.children.values()) {
      const key = s.groupBy[level]!.key;
      if (c.key !== null && key in ids) ids[key as keyof typeof ids].add(c.key);
      collect(c, s, level + 1);
    }
  };
  for (const s of sectionsOf(def.nodes)) { const d = sectionData.get(s.id); if (d) collect(d.tree, s, 0); }
  const names = new Map<string, Map<string, { name: string; sort: string }>>();
  for (const k of Object.keys(ids) as Array<keyof typeof ids>) names.set(k, await namesFor(ctx, k, [...ids[k]]));

  const rows: RunRow[] = [];
  const row = (r: Omit<RunRow, 'expandable' | 'expanded'> & Partial<Pick<RunRow, 'expandable' | 'expanded'>>) =>
    rows.push({ expandable: false, expanded: false, ...r });

  // Pass 2: rows.
  const render = async (nodes: RbNode[], level: number): Promise<void> => {
    for (const node of nodes) {
      const np = [`n:${node.id}`];
      if (node.type === 'text') { row({ kind: 'text', nodeId: node.id, level, path: np, caption: node.text, cells: plan.cols.map(() => null) }); continue; }
      if (node.type === 'blank' || node.type === 'page_break') { row({ kind: node.type, nodeId: node.id, level, path: np, caption: '', cells: plan.cols.map(() => null) }); continue; }
      if (node.type === 'formula') {
        const t = totals.get(node.id)!;
        row({ kind: 'formula', nodeId: node.id, level, path: np, caption: node.caption, cells: cellsOf(plan, t.vals, percentBase(null)), drill: null });
        continue;
      }
      if (node.type === 'group') {
        row({ kind: 'group', nodeId: node.id, level, path: np, caption: node.caption, cells: plan.cols.map(() => null) });
        await render(node.children, level + 1);
        if (node.showTotal) {
          const t = totals.get(node.id)!;
          row({ kind: 'subtotal', nodeId: node.id, level, path: np, caption: node.totalCaption ?? `Total ${node.caption}`, cells: cellsOf(plan, t.vals, percentBase(null)) });
        }
        continue;
      }
      // Section.
      const s = node;
      if (denied.includes(s.id)) {
        row({ kind: 'denied', nodeId: s.id, level, path: np, caption: 'Your role can\'t see this part of the report', cells: plan.cols.map(() => null) });
        continue;
      }
      const data = sectionData.get(s.id)!;
      const secTotal = totals.get(s.id)!.vals!;
      const base = percentBase(secTotal);
      row({ kind: 'header', nodeId: s.id, level, path: np, caption: s.caption, cells: plan.cols.map(() => null) });
      const tb = s.measure === 'tb_net';
      const tbSum = plan.specs.map(() => ZERO());
      const emitLine = (cells: Array<string | null>) => {
        if (!tb) return;
        cells.forEach((c, i) => { if (c !== null && (plan.specs[i]!.t === 'debit' || plan.specs[i]!.t === 'credit')) tbSum[i] = tbSum[i]!.plus(dec(c)); });
      };
      const expanded = (p: string[]) => req.expandAll || open.has(pathId(p)) || (s.defaultExpanded && !collapsed.has(pathId(p)));
      const walk = async (t: Tree, level2: number, path: string[]): Promise<void> => {
        const depth = path.length - 1;
        if (depth === s.groupBy.length) {
          // Innermost: detail rows.
          if (s.display === 'summary') return;
          await detailRows(path, level2);
          return;
        }
        const key = s.groupBy[depth]!.key;
        const kids = [...t.children.values()].map((c) => ({ c, ...keyCaption(key, c.key, names.get(key) ?? new Map()) }))
          .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
        for (const { c, caption } of kids) {
          if (s.hideZero && !anyNonZero(c) && !c.keep) continue;
          if (++lineRows > MAX_LINE_ROWS) throw tooLargeError();
          const p = [...path, pathSeg(key, c.key)];
          const inner = depth + 1 === s.groupBy.length;
          const hasMore = !inner || s.display !== 'summary';
          const exp = s.display === 'detail' || (s.display === 'summary' && !inner) || (s.display === 'expandable' && hasMore && expanded(p));
          const cells = cellsOf(plan, c.vals, base);
          emitLine(cells);
          row({
            kind: 'line', nodeId: s.id, level: level2, path: p, caption, cells,
            drill: { type: 'detail', nodeId: s.id, path: p },
            expandable: s.display === 'expandable' && hasMore, expanded: exp && hasMore,
          });
          if (exp && hasMore) await walk(c, level2 + 1, p);
        }
      };
      const detailRows = async (path: string[], lvl: number) => {
        if (detailLeft <= 0) {
          truncated = true;
          row({ kind: 'more', nodeId: s.id, level: lvl, path, caption: 'More rows', cells: plan.cols.map(() => null), cursor: null });
          return;
        }
        const take = Math.min(detailLeft, perLine);
        const page = await detailPage(ctx, s, path, null, take);
        detailLeft -= page.rows.length;
        for (const r of page.rows) rows.push({ ...r, level: lvl });
        if (page.cursor) {
          truncated = true;
          row({ kind: 'more', nodeId: s.id, level: lvl, path, caption: 'More rows', cells: plan.cols.map(() => null), cursor: page.cursor });
        }
      };
      if (s.groupBy.length === 0) {
        if (s.display === 'detail' || (s.display === 'expandable' && expanded(np))) await detailRows(np, level + 1);
      } else {
        await walk(data.tree, level + 1, np);
      }
      for (const e of data.earnings) {
        const cells = cellsOf(plan, e.vals, base);
        emitLine(cells);
        row({ kind: 'earnings', nodeId: s.id, level: level + 1, path: [...np, `earnings:${e.part}`], caption: e.caption, cells, drill: e.drill });
      }
      if (s.showTotal) {
        const cells = tb
          ? cellsOf(plan, secTotal, base, tbSum.map((x, i) => (plan.specs[i]!.t === 'debit' || plan.specs[i]!.t === 'credit' ? x : null)))
          : cellsOf(plan, secTotal, base);
        row({ kind: 'total', nodeId: s.id, level, path: np, caption: s.totalCaption ?? `Total ${s.caption}`, cells, drill: tb ? null : { type: 'detail', nodeId: s.id, path: np } });
      }
    }
  };
  await render(def.nodes, 0);
  const notes: string[] = [];
  if (rows.length === 0 || rows.every((r) => r.cells.every((c) => c === null || /^-?0(\.0+)?$/.test(c)))) notes.push('No activity for these dates');
  return {
    columns: plan.cols.filter((c) => c.kind !== 'hidden').length === plan.cols.length ? plan.cols : plan.cols,
    rows,
    meta: {
      basis: plan.basis, dates: null, notes, truncated, hiddenNotice: null, denied,
      ...(preview ? { preview: { detailRowsPerLine: PREVIEW_DETAIL_ROWS_PER_LINE } } : {}),
    },
  };
}

async function checkPolarity(ctx: Ctx, s: RbSectionNode): Promise<void> {
  if (s.source !== 'gl' || (s.polarity && s.polarity !== 'natural') || !['amount', 'balance'].includes(s.measure)) return;
  const typeFilter = s.filters.find((f) => f.field === 'account_type' && f.op === 'in');
  if (typeFilter) return;
  const acc = s.filters.find((f) => f.field === 'account' && f.op === 'in');
  if (!acc) return;
  const r = await ctx.exec.execute(sql`SELECT DISTINCT account_type FROM accounts WHERE tenant_id = ${ctx.v.tenantId} AND id IN (${uuids(acc.ids!)})`);
  const sides = new Set((r.rows as Array<{ account_type: string }>).map((x) => isDebitNormal(x.account_type)));
  if (sides.size > 1) throw invalidAt(`node:${s.id}.polarity`, 'MIXED_POLARITY', 'Natural signs need accounts of one kind (all debit or all credit); choose Debit or Credit.');
}

/** An earnings row: 'prior' (prior years, also the TB's one row) or 'current' (this year); its path ends in earnings:<part>. */
interface EarningsRow {
  part: 'prior' | 'current'; caption: string; vals: Vals; drill: RunDrill | null;
  /** The values in the normal sign (credit - debit, as equity; U-218); tb rows: the same as vals. */
  nat: Vals;
}

const PRIOR_YEARS = 'Prior years\' net income';
const CURRENT_YEAR = 'Net income this year';

/** The lines line-mode earnings read: every account (income-statement ones are picked in SQL), the section's tag filter. */
function earningsSection(s: RbSectionNode): RbSectionNode {
  return {
    type: 'section', id: s.id, caption: '', source: 'gl', measure: 'balance', polarity: 'credit',
    filters: s.filters.filter((f) => f.field === 'tag' && f.op === 'in'), groupBy: [], display: 'summary', defaultExpanded: false, showTotal: false, hideZero: false,
  };
}

async function earningsRows(ctx: Ctx, s: RbSectionNode, buckets: BucketRow[]): Promise<EarningsRow[]> {
  const { plan } = ctx;
  const n = nVals(plan);
  const tagF = s.filters.find((f) => f.field === 'tag' && f.op === 'in');
  const slots = plan.slots;
  if (s.earnings === 'trial_balance') {
    // TB: the prior years' income as one equity row (Q-313, Q-A07n); tb net is debit - credit.
    const prior = zeros(n);
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i]!;
      const income = !tagF
        ? buckets.filter((r) => r.hi < sl.fy).reduce((acc, r) => acc.plus(r.v), dec(0))
        : await priorYearsIncomeByTransactionTag(ctx.v.tenantId, { basis: plan.basis, companyId: ctx.v.companyId, adjusting: plan.adjusting, fiscalYearStart: sl.fy, tagId: tagF.ids!.join(','), endDate: sl.to, exec: ctx.exec.tx });
      prior[i] = income.neg();
    }
    if (prior.every((x) => x.isZero())) return [];
    // In tag mode the transaction-level figure has no line-level drill (the one exemption).
    const sl = slots[0]!;
    return [{ part: 'prior', caption: 'Retained Earnings (Prior Years)', vals: prior, nat: prior, drill: tagF ? null : { type: 'profit_loss', from: '0001-01-01', to: addDays(sl.fy, -1) } }];
  }
  // Line mode (equity-earnings' rule: credit - debit over every income-statement line, line-level tag), from the run's batch.
  const sign = s.polarity === 'debit' ? -1 : 1;
  const prior = zeros(n), current = zeros(n);
  for (const r of buckets) {
    const hi = r.hi;
    const v = sign === 1 ? r.v : r.v.neg();
    slots.forEach((sl, i) => {
      if (hi > sl.to) return;
      if (hi < sl.fy) prior[i] = prior[i]!.plus(v);
      else current[i] = current[i]!.plus(v);
    });
  }
  const sl = slots[0]!;
  // A tag-filtered section drills to a P&L of the same lines: tagIds = the tags a line may carry (every tag filter holds).
  const tagFs = s.filters.filter((f) => f.field === 'tag' && f.op === 'in');
  const tags = tagFs.length ? { tagIds: tagFs.slice(1).reduce((acc, f) => acc.filter((x) => f.ids!.includes(x)), [...tagFs[0]!.ids!]) } : {};
  const out: EarningsRow[] = [];
  // Normal sign: credit - debit, as the equity the earnings are (U-218).
  const nat = (v: Vals) => (sign === 1 ? v : v.map((x) => x.neg()));
  if (prior.some((x) => !x.isZero())) out.push({ part: 'prior', caption: PRIOR_YEARS, vals: prior, nat: nat(prior), drill: { type: 'profit_loss', from: '0001-01-01', to: addDays(sl.fy, -1), ...tags } });
  if (current.some((x) => !x.isZero())) out.push({ part: 'current', caption: CURRENT_YEAR, vals: current, nat: nat(current), drill: { type: 'profit_loss', from: sl.fy, to: sl.to, ...tags } });
  return out;
}

// ── Detail rows ────────────────────────────────────────────────────

/** Which earnings lines a detail read adds: none, both rows of a section (its Total), or one earnings row. */
type EarningsPart = 'none' | 'all' | 'prior' | 'current';

const badPath = () => AppError.badRequest('The row path does not belong to this part of the report.', 'INVALID_PARAM', { field: 'path' });

/** The group-by keys of a row path: "n:<id>" then a prefix of the section's group-bys (a section or an outer line drills too). */
function pathKeys(s: RbSectionNode, path: string[]): Array<string | null> {
  if (path[0] !== `n:${s.id}` || path.length - 1 > s.groupBy.length) throw badPath();
  return path.slice(1).map((seg, i) => {
    const key = s.groupBy[i]!.key;
    if (!seg.startsWith(`${key}:`)) throw badPath();
    const v = seg.slice(key.length + 1);
    return v === 'none' ? null : v;
  });
}

/** A /run/detail path: group-by keys, or an earnings row ["n:<id>", "earnings:prior" | "earnings:current"]; a section path adds its earnings. */
function parseDetailPath(s: RbSectionNode, path: string[]): { keys: Array<string | null>; earnings: EarningsPart } {
  const e = path.length === 2 && path[0] === `n:${s.id}` && /^earnings:(prior|current)$/.test(path[1]!) ? (path[1]!.slice(9) as 'prior' | 'current') : null;
  if (e && !s.earnings) throw badPath();
  const keys = e ? [] : pathKeys(s, path);
  const earnings: EarningsPart = e ?? (s.earnings && keys.length === 0 ? 'all' : 'none');
  if (earnings !== 'none' && s.earnings === 'trial_balance') {
    if (s.filters.some((f) => f.field === 'tag' && f.op === 'in')) {
      throw AppError.badRequest('In tag mode the prior years\' figure of a Trial Balance has no line detail.', 'INVALID_PARAM', { field: 'path' });
    }
    if (earnings === 'current') throw badPath();
  }
  return { keys, earnings };
}

/** The slots a detail read covers: the column whose range is `range` (as-of columns match on `to`), else every base column. */
function drillSlots(plan: Plan, range?: { from?: string | null; to: string }): number[] {
  if (!range) return plan.base;
  if (plan.buckets) throw AppError.badRequest('Aging columns have no date range: drill without range.', 'INVALID_PARAM', { field: 'range' });
  const sel = plan.slots.map((_, i) => i).filter((i) => {
    const sl = plan.slots[i]!;
    return sl.to === range.to && (plan.mode === 'asOf' || sl.from === (range.from ?? null));
  });
  if (sel.length === 0) throw AppError.badRequest('range is not the date range of a column of this report.', 'INVALID_PARAM', { field: 'range' });
  return sel;
}

/** A line is in a column: a flow inside its dates; a balance through its date (income-statement accounts from its fiscal year start). */
const inSlot = (flow: boolean, sl: Slot, date: string, bs: boolean) =>
  (flow ? (sl.from === null || date >= sl.from) && date <= sl.to : date <= sl.to && (bs || date >= sl.fy));
/** An earnings line is in a column's prior-years or this-year row (either, for the section Total). */
const inEarnings = (part: EarningsPart, sl: Slot, date: string) =>
  date <= sl.to && (part === 'prior' ? date < sl.fy : part === 'current' ? date >= sl.fy : true);

async function detailPage(
  ctx: Ctx, s: RbSectionNode, path: string[], cursor: Cursor | null, limit: number,
  opts: { keys?: Array<string | null>; earnings?: EarningsPart; sel?: number[] } = {},
): Promise<{ rows: RunRow[]; cursor: string | null }> {
  const keys = opts.keys ?? pathKeys(s, path);
  const earnings = opts.earnings ?? 'none';
  const { plan } = ctx;
  const sel = opts.sel ?? plan.base;
  if (RB_SOURCE_INFO[s.source].openItems) return openDetailPage(ctx, s, keys, path, cursor, limit, sel);
  const fields = plan.def.columns.detailFields;
  const flow = isFlow(s);
  const slots = sel.map((i) => plan.slots[i]!);
  const maxTo = slots.reduce((m, x) => (x.to > m ? x.to : m), slots[0]!.to);
  // A range report's lines start at its first date (a running balance then starts with an opening row).
  const lowFrom = plan.mode === 'range' ? slots.reduce((m, x) => (x.from! < m ? x.from! : m), slots[0]!.from!) : null;
  const withLines = earnings === 'none' || earnings === 'all';
  const L = linesSql(ctx, s, earnings === 'none' ? lowFrom : null, maxTo);
  const k = L.k;
  const date = raw(k.date);
  const keyEq = keys.map((kv, i) => {
    const e = keyExpr(ctx, s, i, k, L.cash);
    return kv === null ? sql`${e} IS NULL` : sql`${e} = ${kv}`;
  });
  // A running balance runs within one innermost line, over its own lines.
  const running = fields.includes('running_balance') && keys.length === s.groupBy.length && earnings === 'none';
  let opening = ZERO();
  if (running && lowFrom) {
    const OL = linesSql(ctx, s, null, addDays(lowFrom, -1));
    const ob = await ctx.exec.execute(sql`${OL.with}
      SELECT COALESCE(SUM(${valueExpr(s, k)}), 0)::text AS v
      ${OL.from} WHERE ${OL.where} AND ${keyEq.length ? sql.join(keyEq, sql` AND `) : sql`TRUE`}
        AND (a.account_type IN ('asset', 'liability', 'equity') OR ${date} >= ${fiscalYearStartIn(lowFrom, ctx.fyStarts, 1) ?? lowFrom}::date)`);
    opening = dec(String((ob.rows[0] as { v: string }).v));
  }
  const select = (part: 'l' | 'e', where: SQL, value: SQL, src: RbSectionNode) => sql`
      SELECT ${part}::text AS part, ${date}::date AS d, ${raw(k.created)} AS created, to_char(${raw(k.created)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_text,
        ${raw(k.txnId)} AS txn_id, ${part === 'e' ? sql`'earnings:' || ${raw(k.vkey)}` : raw(k.vkey)} AS vkey, ${raw(k.lineId)}::text AS line_id,
        ${raw(k.txnType)} AS txn_type, ${k.number} AS num, ct.display_name AS contact, ${raw(k.memo)} AS memo, ${raw(k.desc)} AS description,
        CASE WHEN a.account_number IS NULL OR a.account_number = '' THEN a.name ELSE a.account_number || ' ' || a.name END AS account,
        it.name AS item, ${raw(k.qty)}::text AS qty, ${raw(k.price)}::text AS price, tg.name AS tag, ${clearedExpr(ctx.v.tenantId, k.lineId)} AS cleared,
        ${raw(k.d)}::text AS debit, ${raw(k.c)}::text AS credit, (${value})::numeric AS v, ${raw(k.svc)}::text AS svc, ${raw(k.due)}::text AS due,
        (a.account_type IN ('asset', 'liability', 'equity')) AS bs
      ${L.from}
      LEFT JOIN contacts ct ON ct.id = ${raw(src.source === 'tax' ? k.docContact : k.contact)} AND ct.tenant_id = ${ctx.v.tenantId}
      LEFT JOIN items it ON it.id = ${raw(k.item)} AND it.tenant_id = ${ctx.v.tenantId}
      LEFT JOIN tags tg ON tg.id = ${raw(k.tag)} AND tg.tenant_id = ${ctx.v.tenantId}
      WHERE ${where}`;
  const parts: SQL[] = [];
  if (withLines) {
    const slotCond = sql.join(slots.map((sl) => (flow
      ? sql`(${sl.from ? sql`${date} >= ${sl.from}::date AND ` : sql``}${date} <= ${sl.to}::date)`
      : sql`(${date} <= ${sl.to}::date AND (a.account_type IN ('asset', 'liability', 'equity') OR ${date} >= ${sl.fy}::date))`)), sql` OR `);
    parts.push(select('l', sql`${L.where} AND (${slotCond}) ${lowFrom ? sql`AND ${date} >= ${lowFrom}::date` : sql``}
        ${keyEq.length ? sql`AND ${sql.join(keyEq, sql` AND `)}` : sql``}`, valueExpr(s, k), s));
  }
  if (earnings !== 'none') {
    // Earnings lines (equity-earnings' rule): income-statement lines, credit - debit (debit - credit for a debit or tb section).
    const es = earningsSection(s);
    const E = linesSql(ctx, es, null, maxTo);
    const partCond = sql.join(slots.map((sl) => sql`(${date} <= ${sl.to}::date${earnings === 'prior' ? sql` AND ${date} < ${sl.fy}::date` : earnings === 'current' ? sql` AND ${date} >= ${sl.fy}::date` : sql``})`), sql` OR `);
    const value = s.earnings === 'trial_balance' || s.polarity === 'debit' ? sql`(${raw(k.d)} - ${raw(k.c)})` : sql`(${raw(k.c)} - ${raw(k.d)})`;
    parts.push(select('e', sql`${E.where} AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense') AND (${partCond})`, value, es));
  }
  const after = cursor && cursor.k === 'line'
    ? sql`AND (x.d, x.created, x.txn_id, x.vkey COLLATE "C") > (${cursor.d}::date, ${cursor.c}::timestamptz, ${cursor.t}::uuid, ${cursor.v} COLLATE "C")`
    : sql``;
  const res = await ctx.exec.execute(sql`
    ${L.with}
    SELECT x.*, x.v::text AS v_text, x.run::text AS run_text FROM (
      SELECT u.*, SUM(u.v) OVER (ORDER BY u.d, u.created, u.txn_id, u.vkey COLLATE "C" ROWS UNBOUNDED PRECEDING) AS run
      FROM (${sql.join(parts, sql` UNION ALL `)}) u
    ) x
    WHERE TRUE ${after}
    ORDER BY x.d, x.created, x.txn_id, x.vkey COLLATE "C"
    LIMIT ${limit + 1}`);
  const all = res.rows as Array<Record<string, unknown>>;
  const more = all.length > limit;
  const page = all.slice(0, limit);
  const out: RunRow[] = [];
  if (!cursor && running && lowFrom) {
    out.push({ kind: 'opening', nodeId: s.id, level: 0, path, caption: 'Opening balance', cells: plan.specs.map((sp) => (sp.t === 'field' && sp.field === 'running_balance' ? exactStr(opening) : null)), expandable: false, expanded: false });
  }
  for (const r0 of page) {
    const r = r0 as Record<string, string | null>;
    const day = String(r0['d']).slice(0, 10);
    const val = dec(r['v_text'] ?? '0');
    const bs = r0['bs'] === true;
    const member = (si: number) => sel.includes(si)
      && (r['part'] === 'e' ? inEarnings(earnings, plan.slots[si]!, day) : inSlot(flow, plan.slots[si]!, day, bs));
    const cells = plan.specs.map((sp, i): string | null => {
      if (plan.cols[i]!.kind === 'hidden') return null;
      if (sp.t === 'field') return detailField(sp.field, r, day, opening, running);
      if (sp.t === 'amount') return member(sp.slot) ? exactStr(val) : null;
      if (sp.t === 'debit') return member(sp.slot) && val.gt(0) ? exactStr(val) : null;
      if (sp.t === 'credit') return member(sp.slot) && val.lt(0) ? exactStr(val.neg()) : null;
      if (sp.t === 'sum') return sp.slots.some(member) ? exactStr(val) : null;
      return null;
    });
    out.push({
      kind: 'detail', nodeId: s.id, level: 0, path, caption: '', cells,
      fields: { txnId: String(r['txn_id']), txnType: String(r['txn_type']), lineId: r['line_id'] ?? null },
      drill: { type: 'transaction', txnId: String(r['txn_id']), txnType: String(r['txn_type']) },
      expandable: false, expanded: false,
    });
  }
  const last = page[page.length - 1];
  return {
    rows: out,
    cursor: more && last ? encodeCursor({ k: 'line', d: String(last['d']).slice(0, 10), c: String(last['created_text']), t: String(last['txn_id']), v: String(last['vkey']) }) : null,
  };
}

function detailField(f: RbDetailField, r: Record<string, string | null>, date: string, opening: Dec, running: boolean): string | null {
  switch (f) {
    case 'date': return date;
    case 'txn_type': return r['txn_type'] ? TYPE_LABEL(r['txn_type']) : null;
    case 'number': return r['num'] ?? null;
    case 'contact': return r['contact'] ?? null;
    case 'memo': return r['memo'] ?? null;
    case 'description': return r['description'] ?? null;
    case 'account': return r['account'] ?? null;
    case 'item': return r['item'] ?? null;
    case 'quantity': return r['qty'] ? exactStr(r['qty']) : null;
    case 'unit_price': return r['price'] ? exactStr(r['price']) : null;
    case 'tag': return r['tag'] ?? null;
    case 'cleared': return r['cleared'] ?? null;
    case 'debit': return r['debit'] && !dec(r['debit']).isZero() ? exactStr(r['debit']) : null;
    case 'credit': return r['credit'] && !dec(r['credit']).isZero() ? exactStr(r['credit']) : null;
    case 'amount': return exactStr(r['v_text'] ?? '0');
    case 'running_balance': return running ? exactStr(opening.plus(dec(r['run_text'] ?? '0'))) : null;
    case 'service_date': return r['svc'] ? r['svc'].slice(0, 10) : null;
    case 'due_date': return r['due'] ? r['due'].slice(0, 10) : null;
    default: return null;
  }
}

async function openDetailPage(ctx: Ctx, s: RbSectionNode, keys: Array<string | null>, path: string[], cursor: Cursor | null, limit: number, sel: number[]): Promise<{ rows: RunRow[]; cursor: string | null }> {
  const { plan } = ctx;
  const asOfSlot = sel[sel.length - 1]!;
  const asOf = plan.slots[asOfSlot]!.to;
  const items = (await openItems(ctx, s, asOf))
    .filter((i) => keys.every((kv, j) => openKey(s.groupBy[j]!.key, i, asOf) === kv))
    .sort(compareOpen);
  const start = cursor && cursor.k === 'open'
    ? items.findIndex((i) => compareOpen(i, { contactId: cursor.p === '' ? null : cursor.p, date: cursor.d, number: cursor.n === '' ? null : cursor.n, txnId: cursor.t }) > 0)
    : 0;
  const from = start < 0 ? items.length : start;
  const page = items.slice(from, from + limit);
  const more = from + limit < items.length;
  const cn = await namesFor(ctx, 'contact', [...new Set(page.map((i) => i.contactId).filter((x): x is string => x !== null))]);
  const rows: RunRow[] = page.map((i) => {
    const days = daysBetween(i.dueDate ?? i.date, asOf);
    const bucket = BUCKET_OF[bucketFor(days)]!;
    const val = openValue(s, i);
    const cells = plan.specs.map((sp, ci): string | null => {
      if (plan.cols[ci]!.kind === 'hidden') return null;
      if (sp.t === 'field') {
        switch (sp.field) {
          case 'date': return i.date;
          case 'txn_type': return TYPE_LABEL(i.txnType);
          case 'number': return i.number;
          case 'contact': return i.contactId ? cn.get(i.contactId)?.name ?? null : null;
          case 'due_date': return i.dueDate;
          case 'days_past_due': return String(Math.max(days, 0));
          case 'aging_bucket': return BUCKET_CAPTION[bucket]!;
          case 'open_balance': return exactStr(i.openExact);
          case 'original_amount': return exactStr(i.originalExact);
          default: return null;
        }
      }
      if (sp.t === 'amount') return plan.buckets ? (RB_BUCKETS[sp.slot] === bucket ? exactStr(val) : null) : sp.slot === asOfSlot ? exactStr(val) : null;
      if (sp.t === 'sum') return plan.buckets || sp.slots.includes(asOfSlot) ? exactStr(val) : null;
      return null;
    });
    return {
      kind: 'detail', nodeId: s.id, level: 0, path, caption: '', cells,
      fields: { txnId: i.txnId, txnType: i.txnType, lineId: null },
      drill: { type: 'transaction', txnId: i.txnId, txnType: i.txnType }, expandable: false, expanded: false,
    };
  });
  const last = page[page.length - 1];
  return { rows, cursor: more && last ? encodeCursor({ k: 'open', p: last.contactId ?? '', d: last.date, n: last.number ?? '', t: last.txnId }) : null };
}

// ── /run/detail ────────────────────────────────────────────────────

export interface DetailResult { rows: RunRow[]; cursor: string | null; subtotal: Array<string | null> }

/**
 * The detail of one row: an innermost line, an outer group-by line, a section (its Total: every line of the section plus
 * its earnings lines) or an earnings row. `range` picks one column: rows and subtotal hold only that column's lines and the
 * subtotal's other value columns are null. Without `range`, every base column.
 */
export async function runDetail(v: Viewer, req: DetailRequest, signal?: AbortSignal): Promise<DetailResult> {
  return inSnapshot(async (exec) => {
    if (fingerprintOf(req) !== req.fingerprint) throw runChanged('params');
    const def = await loadDefinition(exec, v, req);
    const plan = await makePlan(v, def, req);
    const ctx: Ctx = { v, exec, plan, fyStarts: req.fiscalYearStarts };
    if ((await readStamp(ctx)) !== req.stamp) throw runChanged('books');
    const s = sectionsOf(def.nodes).find((x) => x.id === req.nodeId);
    if (!s) throw AppError.badRequest('No such part of the report.', 'INVALID_PARAM', { field: 'nodeId' });
    if (!sectionRights(s, plan.basis).every((r) => can(v.permissions, r as never, 'read'))) {
      throw AppError.forbidden('Your role can\'t see this part of the report.', 'PERMISSION_DENIED');
    }
    const { keys, earnings } = parseDetailPath(s, req.path);
    const sel = drillSlots(plan, req.range);
    const cursor = req.cursor ? decodeCursor(req.cursor) : null;
    const page = await detailPage(ctx, s, req.path, cursor, DETAIL_PAGE_ROWS, { keys, earnings, sel });
    const n = nVals(plan);
    const vals = zeros(n);
    if (earnings === 'none' || earnings === 'all') {
      const facts = RB_SOURCE_INFO[s.source].openItems ? await openFacts(ctx, s, keys) : await lineFacts(ctx, s, keys);
      addInto(vals, buildTree(facts, keys.length, n).vals);
    }
    if (earnings !== 'none') {
      const pre = await bucketFacts(ctx, [{ sid: 'e', s: earningsSection(s), pathKeys: [], earningsOf: true }]);
      for (const e of await earningsRows(ctx, s, pre.get('e') ?? [])) {
        if (earnings === 'all' || earnings === e.part) addInto(vals, e.vals);
      }
    }
    let subtotal: Array<string | null>;
    if (req.range) {
      // One column: the other columns' values are not part of this drill.
      for (let i = 0; i < n; i++) if (!sel.includes(i)) vals[i] = ZERO();
      const cells = cellsOf(plan, vals, null);
      subtotal = plan.specs.map((sp, i) => {
        if (sp.t === 'amount' || sp.t === 'debit' || sp.t === 'credit') return sel.includes(sp.slot) ? cells[i]! : null;
        if (sp.t === 'sum') return sp.slots.some((x) => sel.includes(x)) ? cells[i]! : null;
        return null;
      });
    } else {
      subtotal = cellsOf(plan, vals, null);
    }
    return { rows: page.rows.map((r) => ({ ...r, path: req.path })), cursor: page.cursor, subtotal };
  }, { signal });
}

export { RB_MEASURE_UNIT };
