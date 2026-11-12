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
import { equityEarnings, earningsTotal, priorYearsIncomeByTransactionTag } from '../equity-earnings.js';
import { arOpenItemsAsOf, bucketFor, daysBetween } from '../ar-open-items.js';
import { apOpenItemsAsOf } from '../ap-open-items.js';
import { BANK_DETAIL_TYPES } from '../bank-account-types.js';
import { fiscalYearStartIn, priorRange, shiftYear } from '../report-columns/planner.js';
import { definitionForAccess, parseBuilder, assertRefsInScope, stale, definitionNotFound } from '../report-definitions.service.js';
import { ZERO_COMPANY_UUID } from '../ledger-version.service.js';
import { AppError } from '../../utils/errors.js';
import {
  inSnapshot, tooLargeError, MAX_LINE_ROWS, MAX_DETAIL_ROWS_SCREEN, MAX_DETAIL_ROWS_EXPORT, DETAIL_PAGE_ROWS, type RunExec,
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

function valueExpr(s: RbSectionNode, k: LineCols): SQL {
  const d = raw(k.d), c = raw(k.c);
  switch (s.measure) {
    case 'debit': return sql`${d}`;
    case 'credit': return sql`${c}`;
    case 'count': return sql`1::numeric`;
    case 'quantity': return sql`COALESCE(${raw(k.qty)}, 0)::numeric`;
    case 'tb_net': return sql`(${d} - ${c})`;
    default: {
      const pol = s.polarity && s.polarity !== 'natural' ? s.polarity
        : RB_SOURCE_INFO[s.source].sign === 'natural' ? 'natural'
          : RB_SOURCE_INFO[s.source].sign === 'debit_minus_credit' ? 'debit' : 'credit';
      if (pol === 'debit') return sql`(${d} - ${c})`;
      if (pol === 'credit') return sql`(${c} - ${d})`;
      return sql`(CASE WHEN a.account_type IN (${list(RB_DEBIT_NORMAL_TYPES)}) THEN ${d} - ${c} ELSE ${c} - ${d} END)`;
    }
  }
}

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

/** The window condition of a slot for a section's measure. */
function windowCond(s: RbSectionNode, k: LineCols): SQL {
  const date = raw(k.date);
  if (isFlow(s)) return sql`${date} >= w.f AND ${date} <= w.t`;
  return sql`${date} <= w.t AND (a.account_type IN ('asset', 'liability', 'equity') OR ${date} >= w.fy)`;
}

interface Fact { keys: Array<string | null>; slot: number; v: Dec }

async function lineFacts(ctx: Ctx, s: RbSectionNode, pathKeys: Array<string | null> = []): Promise<Fact[]> {
  const slots = ctx.plan.slots;
  const flow = isFlow(s);
  const minFrom = flow && ctx.plan.mode === 'range' ? slots.reduce((m, x) => (x.from! < m ? x.from! : m), slots[0]!.from!) : null;
  const maxTo = slots.reduce((m, x) => (x.to > m ? x.to : m), slots[0]!.to);
  const L = linesSql(ctx, s, minFrom, maxTo);
  const keys = s.groupBy.map((_, i) => keyExpr(ctx, s, i, L.k, L.cash));
  const eq = pathKeys.map((pk, i) => (pk === null ? sql`${keys[i]!} IS NULL` : sql`${keys[i]!} = ${pk}`));
  const win = sql`(VALUES ${sql.join(slots.map((x, i) => sql`(${i}::int, ${x.from ?? '0001-01-01'}::date, ${x.to}::date, ${x.fy}::date)`), sql`, `)}) w(i, f, t, fy)`;
  const sel = keys.length ? sql.join(keys.map((e, i) => sql`${e} AS ${raw(`k${i}`)}`), sql`, `) : sql`NULL::text AS k_`;
  const grp = keys.map((_, i) => raw(`k${i}`));
  const res = await ctx.exec.execute(sql`
    ${L.with}
    SELECT ${sel}, w.i AS w, SUM(${valueExpr(s, L.k)})::text AS v
    ${L.from} JOIN ${win} ON ${windowCond(s, L.k)}
    WHERE ${L.where} ${eq.length ? sql`AND ${sql.join(eq, sql` AND `)}` : sql``}
    GROUP BY ${sql.join([...grp, raw('w.i')], sql`, `)}`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    keys: s.groupBy.map((_, i) => (r[`k${i}`] as string | null) ?? null),
    slot: Number(r['w']),
    v: dec(String(r['v'] ?? '0')),
  }));
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

interface Tree { key: string | null; vals: Vals; children: Map<string, Tree> }

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
  meta: { basis: string; dates: unknown; notes: string[]; truncated: boolean; hiddenNotice: null; denied: string[] };
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

interface NodeTotal { vals: Vals | null; denied: boolean; pairs?: Array<Dec | null> }

async function assemble(ctx: Ctx, req: RunRequest): Promise<{ columns: RunColumn[]; rows: RunRow[]; meta: RunResult['meta'] }> {
  const { plan } = ctx;
  const def = plan.def;
  const n = nVals(plan);
  const open = new Set(req.open.map(pathId));
  const collapsed = new Set(req.collapsed.map(pathId));
  const detailCap = req.purpose === 'export' ? MAX_DETAIL_ROWS_EXPORT : MAX_DETAIL_ROWS_SCREEN;
  let detailLeft = detailCap;
  let lineRows = 0;
  let truncated = false;
  const denied: string[] = [];
  const totals = new Map<string, NodeTotal>();
  const sectionData = new Map<string, { tree: Tree; earnings: Array<{ caption: string; vals: Vals; drill: RunDrill | null }> }>();

  // Pass 1: facts and totals of every node, in pre-order.
  const visit = async (nodes: RbNode[]): Promise<void> => {
    for (const node of nodes) {
      if (node.type === 'section') {
        const rights = sectionRights(node, plan.basis);
        if (!rights.every((r) => can(ctx.v.permissions, r as never, 'read'))) {
          denied.push(node.id);
          totals.set(node.id, { vals: null, denied: true });
          continue;
        }
        await checkPolarity(ctx, node);
        const facts = RB_SOURCE_INFO[node.source].openItems ? await openFacts(ctx, node) : await lineFacts(ctx, node);
        const tree = buildTree(facts, node.groupBy.length, n);
        const earnings = node.earnings ? await earningsRows(ctx, node) : [];
        const vals = tree.vals.slice();
        for (const e of earnings) addInto(vals, e.vals);
        sectionData.set(node.id, { tree, earnings });
        totals.set(node.id, { vals, denied: false });
      } else if (node.type === 'group') {
        await visit(node.children);
        let acc: Vals | null = zeros(n);
        for (const c of node.children) {
          if (c.type !== 'section' && c.type !== 'group') continue;
          const t = totals.get(c.id)!;
          if (t.vals === null) { acc = null; break; }
          addInto(acc, t.vals);
        }
        totals.set(node.id, { vals: acc, denied: acc === null });
      } else if (node.type === 'formula') {
        let acc: Vals | null = zeros(n);
        for (const term of node.terms) {
          const t = totals.get(term.nodeId);
          if (!t || t.vals === null) { acc = null; break; }
          for (let i = 0; i < n; i++) acc[i] = acc[i]!.plus(term.sign === 1 ? t.vals[i]! : t.vals[i]!.neg());
        }
        totals.set(node.id, { vals: acc, denied: acc === null });
      }
    }
  };
  await visit(def.nodes);

  const percentBase = (sectionVals: Vals | null): Array<Dec | null> | null => {
    const p = def.columns.percentOf;
    if (!p) return null;
    const vals = p === 'section' ? sectionVals : totals.get(p)?.vals ?? null;
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
          if (s.hideZero && !anyNonZero(c)) continue;
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
        const take = Math.min(detailLeft, DETAIL_PAGE_ROWS * 10);
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
        row({ kind: 'earnings', nodeId: s.id, level: level + 1, path: [...np, `earnings:${e.caption === PRIOR_YEARS ? 'prior' : 'current'}`], caption: e.caption, cells, drill: e.drill });
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
    meta: { basis: plan.basis, dates: null, notes, truncated, hiddenNotice: null, denied },
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

const PRIOR_YEARS = 'Prior years\' net income';
const CURRENT_YEAR = 'Net income this year';

async function earningsRows(ctx: Ctx, s: RbSectionNode): Promise<Array<{ caption: string; vals: Vals; drill: RunDrill | null }>> {
  const { plan } = ctx;
  const n = nVals(plan);
  const tagF = s.filters.find((f) => f.field === 'tag' && f.op === 'in');
  const slots = plan.slots;
  if (s.earnings === 'trial_balance') {
    // TB: the prior years' income as one equity row (Q-313, Q-A07n); tb net is debit - credit.
    const prior = zeros(n);
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i]!;
      const income = tagF
        ? await priorYearsIncomeByTransactionTag(ctx.v.tenantId, { basis: plan.basis, companyId: ctx.v.companyId, adjusting: plan.adjusting, fiscalYearStart: sl.fy, tagId: tagF.ids!.join(','), endDate: sl.to, exec: ctx.exec.tx })
        : earningsTotal((await equityEarnings(ctx.v.tenantId, { basis: plan.basis, companyId: ctx.v.companyId, adjusting: plan.adjusting, asOfs: [{ asOf: sl.to, fiscalYearStart: sl.fy }], exec: ctx.exec.tx }))[0]!.priorYears);
      prior[i] = income.neg();
    }
    if (prior.every((x) => x.isZero())) return [];
    // In tag mode the transaction-level figure has no line-level drill (the one exemption).
    const sl = slots[0]!;
    return [{ caption: 'Retained Earnings (Prior Years)', vals: prior, drill: tagF ? null : { type: 'profit_loss', from: '0001-01-01', to: addDays(sl.fy, -1) } }];
  }
  const lens = tagF ? { tag: { kind: 'ids' as const, ids: tagF.ids! } } : null;
  const splits = await equityEarnings(ctx.v.tenantId, {
    basis: plan.basis, companyId: ctx.v.companyId, adjusting: plan.adjusting, lens, exec: ctx.exec.tx,
    asOfs: slots.map((sl) => ({ asOf: sl.to, fiscalYearStart: sl.fy })),
  });
  const sign = s.polarity === 'debit' ? -1 : 1;
  const prior = zeros(n), current = zeros(n);
  splits.forEach((sp, i) => {
    const p = earningsTotal(sp.priorYears), c = earningsTotal(sp.currentYear);
    prior[i] = sign === 1 ? p : p.neg();
    current[i] = sign === 1 ? c : c.neg();
  });
  const sl = slots[0]!;
  const out: Array<{ caption: string; vals: Vals; drill: RunDrill | null }> = [];
  if (prior.some((x) => !x.isZero())) out.push({ caption: PRIOR_YEARS, vals: prior, drill: { type: 'profit_loss', from: '0001-01-01', to: addDays(sl.fy, -1) } });
  if (current.some((x) => !x.isZero())) out.push({ caption: CURRENT_YEAR, vals: current, drill: { type: 'profit_loss', from: sl.fy, to: sl.to } });
  return out;
}

// ── Detail rows ────────────────────────────────────────────────────

function pathKeys(s: RbSectionNode, path: string[]): Array<string | null> {
  if (path[0] !== `n:${s.id}` || path.length - 1 > s.groupBy.length) throw AppError.badRequest('The row path does not belong to this part of the report.', 'INVALID_PARAM', { field: 'path' });
  return path.slice(1).map((seg, i) => {
    const key = s.groupBy[i]!.key;
    if (!seg.startsWith(`${key}:`)) throw AppError.badRequest('The row path does not belong to this part of the report.', 'INVALID_PARAM', { field: 'path' });
    const v = seg.slice(key.length + 1);
    return v === 'none' ? null : v;
  });
}

/** The detail window: the base columns' dates (flow) or through the last as-of (balances). */
function detailWindow(plan: Plan, s: RbSectionNode, range?: { from: string; to: string }): { from: string | null; to: string } {
  if (range) return { from: isFlow(s) || plan.mode === 'range' ? range.from : null, to: range.to };
  const base = plan.base.map((i) => plan.slots[i]!);
  const to = base.reduce((m, x) => (x.to > m ? x.to : m), base[0]!.to);
  const from = plan.mode === 'range' ? base.reduce((m, x) => (x.from! < m ? x.from! : m), base[0]!.from!) : null;
  return { from, to };
}

async function detailPage(ctx: Ctx, s: RbSectionNode, path: string[], cursor: Cursor | null, limit: number, range?: { from: string; to: string }): Promise<{ rows: RunRow[]; cursor: string | null }> {
  const keys = pathKeys(s, path);
  if (keys.length !== s.groupBy.length) throw AppError.badRequest('Detail rows are under the innermost grouping.', 'INVALID_PARAM', { field: 'path' });
  if (RB_SOURCE_INFO[s.source].openItems) return openDetailPage(ctx, s, keys, cursor, limit);
  const { plan } = ctx;
  const fields = plan.def.columns.detailFields;
  const win = detailWindow(plan, s, range);
  const L = linesSql(ctx, s, win.from, win.to);
  const k = L.k;
  const keyEq = s.groupBy.map((_, i) => {
    const e = keyExpr(ctx, s, i, k, L.cash);
    return keys[i] === null ? sql`${e} IS NULL` : sql`${e} = ${keys[i]}`;
  });
  // Balances (and the P&L accounts of a tb) read income accounts from the fiscal year start.
  const fyCond = isFlow(s) ? sql`TRUE` : sql`(a.account_type IN ('asset', 'liability', 'equity') OR ${raw(k.date)} >= ${plan.slots[0]!.fy}::date)`;
  const running = fields.includes('running_balance');
  let opening = ZERO();
  if (running && win.from) {
    const ob = await ctx.exec.execute(sql`${linesSql(ctx, s, null, addDays(win.from, -1)).with}
      SELECT COALESCE(SUM(${valueExpr(s, k)}), 0)::text AS v, MIN(a.account_type) AS at
      ${L.from} WHERE ${linesSql(ctx, s, null, addDays(win.from, -1)).where} AND ${keyEq.length ? sql.join(keyEq, sql` AND `) : sql`TRUE`}
        AND (a.account_type IN ('asset', 'liability', 'equity') OR ${raw(k.date)} >= ${fiscalYearStartIn(win.from, ctx.fyStarts, 1) ?? win.from}::date)`);
    opening = dec(String((ob.rows[0] as { v: string }).v));
  }
  const after = cursor && cursor.k === 'line'
    ? sql`AND (x.d, x.created, x.txn_id, x.vkey COLLATE "C") > (${cursor.d}::date, ${cursor.c}::timestamptz, ${cursor.t}::uuid, ${cursor.v} COLLATE "C")`
    : sql``;
  const res = await ctx.exec.execute(sql`
    ${L.with}
    SELECT x.* FROM (
      SELECT ${raw(k.date)}::date AS d, ${raw(k.created)} AS created, to_char(${raw(k.created)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_text,
        ${raw(k.txnId)} AS txn_id, ${raw(k.vkey)} AS vkey, ${raw(k.lineId)}::text AS line_id,
        ${raw(k.txnType)} AS txn_type, ${k.number} AS num, ct.display_name AS contact, ${raw(k.memo)} AS memo, ${raw(k.desc)} AS description,
        CASE WHEN a.account_number IS NULL OR a.account_number = '' THEN a.name ELSE a.account_number || ' ' || a.name END AS account,
        it.name AS item, ${raw(k.qty)}::text AS qty, ${raw(k.price)}::text AS price, tg.name AS tag, ${clearedExpr(ctx.v.tenantId, k.lineId)} AS cleared,
        ${raw(k.d)}::text AS debit, ${raw(k.c)}::text AS credit, (${valueExpr(s, k)})::text AS v, ${raw(k.svc)}::text AS svc, ${raw(k.due)}::text AS due,
        (SUM(${valueExpr(s, k)}) OVER (ORDER BY ${raw(k.date)}, ${raw(k.created)}, ${raw(k.txnId)}, ${raw(k.vkey)} COLLATE "C" ROWS UNBOUNDED PRECEDING))::text AS run
      ${L.from}
      LEFT JOIN contacts ct ON ct.id = ${raw(s.source === 'tax' ? k.docContact : k.contact)} AND ct.tenant_id = ${ctx.v.tenantId}
      LEFT JOIN items it ON it.id = ${raw(k.item)} AND it.tenant_id = ${ctx.v.tenantId}
      LEFT JOIN tags tg ON tg.id = ${raw(k.tag)} AND tg.tenant_id = ${ctx.v.tenantId}
      WHERE ${L.where} AND ${fyCond} ${win.from ? sql`AND ${raw(k.date)} >= ${win.from}::date` : sql``} AND ${raw(k.date)} <= ${win.to}::date
        ${keyEq.length ? sql`AND ${sql.join(keyEq, sql` AND `)}` : sql``}
    ) x
    WHERE TRUE ${after}
    ORDER BY x.d, x.created, x.txn_id, x.vkey COLLATE "C"
    LIMIT ${limit + 1}`);
  const all = res.rows as Array<Record<string, string | null>>;
  const more = all.length > limit;
  const page = all.slice(0, limit);
  const out: RunRow[] = [];
  if (!cursor && running && win.from && plan.mode === 'range') {
    out.push({ kind: 'opening', nodeId: s.id, level: 0, path, caption: 'Opening balance', cells: plan.specs.map((sp) => (sp.t === 'field' && sp.field === 'running_balance' ? exactStr(opening) : null)), expandable: false, expanded: false });
  }
  for (const r of page) {
    const date = String(r['d']).slice(0, 10);
    const val = dec(r['v'] ?? '0');
    const cells = plan.specs.map((sp, i): string | null => {
      if (plan.cols[i]!.kind === 'hidden') return null;
      if (sp.t === 'field') return detailField(sp.field, r, date, opening);
      if (sp.t === 'amount') { const sl = plan.slots[sp.slot]!; return sp.base && inSlot(s, sl, date) ? exactStr(val) : null; }
      if (sp.t === 'debit') { const x = dec(r['debit'] ?? '0').minus(dec(r['credit'] ?? '0')); return sp.base && x.gt(0) ? exactStr(x) : null; }
      if (sp.t === 'credit') { const x = dec(r['debit'] ?? '0').minus(dec(r['credit'] ?? '0')); return sp.base && x.lt(0) ? exactStr(x.neg()) : null; }
      if (sp.t === 'sum') return sp.slots.some((x) => inSlot(s, plan.slots[x]!, date)) ? exactStr(val) : null;
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

const inSlot = (s: RbSectionNode, sl: Slot, date: string) => (isFlow(s) ? (sl.from === null || date >= sl.from) && date <= sl.to : date <= sl.to);

function detailField(f: RbDetailField, r: Record<string, string | null>, date: string, opening: Dec): string | null {
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
    case 'amount': return exactStr(r['v'] ?? '0');
    case 'running_balance': return exactStr(opening.plus(dec(r['run'] ?? '0')));
    case 'service_date': return r['svc'] ? r['svc'].slice(0, 10) : null;
    case 'due_date': return r['due'] ? r['due'].slice(0, 10) : null;
    default: return null;
  }
}

async function openDetailPage(ctx: Ctx, s: RbSectionNode, keys: Array<string | null>, cursor: Cursor | null, limit: number): Promise<{ rows: RunRow[]; cursor: string | null }> {
  const { plan } = ctx;
  const asOf = plan.slots[plan.base[plan.base.length - 1]!]!.to;
  const items = (await openItems(ctx, s, asOf))
    .filter((i) => s.groupBy.every((g, j) => openKey(g.key, i, asOf) === keys[j]))
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
      if (sp.t === 'amount') return plan.buckets ? (RB_BUCKETS[sp.slot] === bucket ? exactStr(val) : null) : sp.base && sp.slot === plan.base[plan.base.length - 1] ? exactStr(val) : null;
      if (sp.t === 'sum') return exactStr(val);
      return null;
    });
    return {
      kind: 'detail', nodeId: s.id, level: 0, path: [], caption: '', cells,
      fields: { txnId: i.txnId, txnType: i.txnType, lineId: null },
      drill: { type: 'transaction', txnId: i.txnId, txnType: i.txnType }, expandable: false, expanded: false,
    };
  });
  const last = page[page.length - 1];
  return { rows, cursor: more && last ? encodeCursor({ k: 'open', p: last.contactId ?? '', d: last.date, n: last.number ?? '', t: last.txnId }) : null };
}

// ── /run/detail ────────────────────────────────────────────────────

export interface DetailResult { rows: RunRow[]; cursor: string | null; subtotal: Array<string | null> }

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
    const keys = pathKeys(s, req.path);
    const cursor = req.cursor ? decodeCursor(req.cursor) : null;
    const page = await detailPage(ctx, s, req.path, cursor, DETAIL_PAGE_ROWS, req.range);
    const facts = RB_SOURCE_INFO[s.source].openItems ? await openFacts(ctx, s, keys) : await lineFacts(ctx, s, keys);
    const tree = buildTree(facts, keys.length, nVals(plan));
    return { rows: page.rows.map((r) => ({ ...r, path: req.path })), cursor: page.cursor, subtotal: cellsOf(plan, tree.vals, null) };
  }, { signal });
}

export { RB_MEASURE_UNIT };
