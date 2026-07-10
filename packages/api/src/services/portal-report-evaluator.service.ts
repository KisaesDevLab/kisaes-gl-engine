// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as reportSvc from './report.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 16.3 — runtime KPI
// evaluator. Reads existing P&L + balance-sheet aggregates and
// derives the stock KPI catalog. Output shape matches the
// renderer contract: data.kpis[key] = formatted string.

interface PeriodMetrics {
  revenue: number;
  cogs: number;
  grossProfit: number;
  operatingExpense: number; // not including cogs
  netIncome: number;
  operatingIncome: number; // grossProfit - opex (or revenue - opex if no cogs)
  // Balance-sheet (as-of period end)
  cash: number;            // checking + savings + cash + petty + undeposited_funds
  bankBalance: number;     // checking + savings + cash + petty (real bank money — excludes undeposited_funds clearing)
  accountsReceivable: number;
  accountsPayable: number;
  inventory: number;
  currentAssets: number;
  currentLiabilities: number;
  // Full balance-sheet totals (as-of period end) — sourced from
  // buildBalanceSheet so retained-earnings math matches the statement.
  totalAssets: number;
  totalLiabilities: number;
  equity: number;
  fixedAssets: number;
  // EBITDA add-backs — period activity on expense accounts whose
  // detail_type marks them as interest / depreciation / amortization.
  interestExpense: number;
  depreciationAmortization: number;
  // Period bounds
  periodDays: number;
}

// The default COA template uses the umbrella detail_type 'bank'
// for checking/savings accounts; the QBO-style import path uses
// the more specific 'checking'/'savings'. Both vocabularies are
// in production data, so we accept either.
const CASH_DETAIL_TYPES = [
  'bank',
  'checking',
  'savings',
  'cash',
  'petty_cash',
  'undeposited_funds',
];

// Real bank money — excludes undeposited_funds (a clearing account
// that holds money received but not yet deposited at a bank).
const BANK_DETAIL_TYPES = [
  'bank',
  'checking',
  'savings',
  'cash',
  'petty_cash',
];

const CURRENT_ASSET_DETAIL_TYPES = [
  ...CASH_DETAIL_TYPES,
  'accounts_receivable',
  'inventory',
  'prepaid_expense',
  'other_current_asset',
];

const CURRENT_LIABILITY_DETAIL_TYPES = [
  'accounts_payable',
  'credit_card',
  'sales_tax_payable',
  'payroll_payable',
  'other_current_liability',
];

// Detail types whose period expense is added back for EBITDA. The
// built-in COA files these under other_expense (see packages/shared
// DETAIL_TYPES), but a tenant may have created them as plain expense
// accounts, so we match on detail_type across every cost account type.
const INTEREST_DETAIL_TYPES = ['interest_expense'];
const DA_DETAIL_TYPES = ['depreciation', 'amortization'];

function dayDiff(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1);
}

// Shift a YYYY-MM-DD by a calendar amount. Used to derive the
// prior-month and prior-year windows.
function shiftDate(date: string, opts: { years?: number; months?: number }): string {
  const [yStr, mStr, dStr] = date.split('-');
  const y = parseInt(yStr ?? '1970', 10) + (opts.years ?? 0);
  const m = parseInt(mStr ?? '1', 10) - 1 + (opts.months ?? 0);
  const d = parseInt(dStr ?? '1', 10);
  // Normalize the month index first (day 1 can never overflow), then
  // CLAMP the day to the target month's length. Constructing
  // Date.UTC(y, m, 31) directly would let a 30-day (or Feb) target
  // month roll into the following month — e.g. prior-month of Mar 31
  // becoming Mar 3 — which makes MoM/YoY windows overlap the current
  // period.
  const firstOfMonth = new Date(Date.UTC(y, m, 1));
  const ty = firstOfMonth.getUTCFullYear();
  const tm = firstOfMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const isoMonth = String(tm + 1).padStart(2, '0');
  const isoDay = String(day).padStart(2, '0');
  return `${ty}-${isoMonth}-${isoDay}`;
}

export function priorMonthWindow(start: string, end: string): { start: string; end: string } {
  return {
    start: shiftDate(start, { months: -1 }),
    end: shiftDate(end, { months: -1 }),
  };
}

export function priorYearWindow(start: string, end: string): { start: string; end: string } {
  return {
    start: shiftDate(start, { years: -1 }),
    end: shiftDate(end, { years: -1 }),
  };
}

async function balanceByDetailType(
  tenantId: string,
  companyId: string | null,
  asOfDate: string,
  accountType: 'asset' | 'liability',
  detailTypes: string[],
): Promise<number> {
  if (detailTypes.length === 0) return 0;
  const companyCond = companyId ? sql`company_id = ${companyId}` : sql`TRUE`;
  // Build the IN-list as a comma-separated set of bound parameters —
  // sql.join is the Drizzle-idiomatic way to do this and avoids the
  // record-vs-array cast problem you hit with `= ANY(::text[])`.
  const detailList = sql.join(detailTypes.map((d) => sql`${d}`), sql`, `);
  // The transaction filters (status/date/company) MUST live on the
  // journal_lines join itself — mirroring report.service's
  // buildBalanceSheet. A separate LEFT JOIN transactions with these
  // conditions in its ON clause is a no-op filter: every journal line
  // still sums, including drafts, voids, future-dated activity, and
  // other companies' books.
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit), 0) AS dr, COALESCE(SUM(jl.credit), 0) AS cr
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
        AND basis <> 'cash'
        AND txn_date <= ${asOfDate}
        AND ${companyCond}
      )
    WHERE a.tenant_id = ${tenantId}
      AND a.account_type = ${accountType}
      AND a.detail_type IN (${detailList})
  `);
  const row = (result.rows as Array<{ dr: string | number; cr: string | number }>)[0];
  if (!row) return 0;
  const dr = Number(row.dr ?? 0);
  const cr = Number(row.cr ?? 0);
  // Assets normal balance = debit; liabilities = credit.
  return accountType === 'asset' ? dr - cr : cr - dr;
}

// Period activity (debit − credit) on cost accounts with the given
// detail types — the EBITDA add-back amounts. Mirrors the P&L's
// posted/date/company filters so the add-backs reconcile with the
// net income they're added to.
async function costActivityByDetailType(
  tenantId: string,
  companyId: string | null,
  startDate: string,
  endDate: string,
  detailTypes: string[],
): Promise<number> {
  if (detailTypes.length === 0) return 0;
  const companyCond = companyId ? sql`company_id = ${companyId}` : sql`TRUE`;
  const detailList = sql.join(detailTypes.map((d) => sql`${d}`), sql`, `);
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId}
      AND a.account_type IN ('cogs', 'expense', 'other_expense')
      AND a.detail_type IN (${detailList})
      AND jl.transaction_id IN (
        SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
        AND basis <> 'cash'
        AND txn_date >= ${startDate} AND txn_date <= ${endDate}
        AND ${companyCond}
      )
  `);
  const row = (result.rows as Array<{ amount: string | number | null }>)[0];
  return Number(row?.amount ?? 0);
}

export async function gatherMetrics(
  tenantId: string,
  companyId: string | null,
  startDate: string,
  endDate: string,
): Promise<PeriodMetrics> {
  // Period P&L for the requested window — gives us revenue, cogs,
  // expense, net income, operating income.
  const pl = await reportSvc.buildProfitAndLoss(
    tenantId,
    startDate,
    endDate,
    'accrual',
    companyId,
    null,
  );

  const periodDays = dayDiff(startDate, endDate);

  // Balance-sheet figures as of the period end. The full-statement
  // totals come from buildBalanceSheet so the equity figure carries the
  // computed retained-earnings / current-year-income rows.
  const [
    cash, bankBalance, ar, ap, inventory, currentAssets, currentLiabilities,
    fixedAssets, bs, interestExpense, depreciationAmortization,
  ] = await Promise.all([
    balanceByDetailType(tenantId, companyId, endDate, 'asset', CASH_DETAIL_TYPES),
    balanceByDetailType(tenantId, companyId, endDate, 'asset', BANK_DETAIL_TYPES),
    balanceByDetailType(tenantId, companyId, endDate, 'asset', ['accounts_receivable']),
    balanceByDetailType(tenantId, companyId, endDate, 'liability', ['accounts_payable']),
    balanceByDetailType(tenantId, companyId, endDate, 'asset', ['inventory']),
    balanceByDetailType(tenantId, companyId, endDate, 'asset', CURRENT_ASSET_DETAIL_TYPES),
    balanceByDetailType(tenantId, companyId, endDate, 'liability', CURRENT_LIABILITY_DETAIL_TYPES),
    balanceByDetailType(tenantId, companyId, endDate, 'asset', ['fixed_asset']),
    reportSvc.buildBalanceSheet(tenantId, endDate, 'accrual', companyId),
    costActivityByDetailType(tenantId, companyId, startDate, endDate, INTEREST_DETAIL_TYPES),
    costActivityByDetailType(tenantId, companyId, startDate, endDate, DA_DETAIL_TYPES),
  ]);

  return {
    revenue: pl.totalRevenue,
    cogs: pl.totalCogs,
    grossProfit: pl.grossProfit ?? pl.totalRevenue - pl.totalCogs,
    operatingExpense: pl.totalExpenses,
    netIncome: pl.netIncome,
    operatingIncome:
      pl.operatingIncome ?? (pl.totalRevenue - pl.totalCogs - pl.totalExpenses),
    cash,
    bankBalance,
    accountsReceivable: ar,
    accountsPayable: ap,
    inventory,
    currentAssets,
    currentLiabilities,
    totalAssets: bs.totalAssets,
    totalLiabilities: bs.totalLiabilities,
    equity: bs.totalEquity,
    fixedAssets,
    interestExpense,
    depreciationAmortization,
    periodDays,
  };
}

function fmtCurrency(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}
function fmtPercent(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}
function fmtDays(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n)} d`;
}
function safeDiv(a: number, b: number): number {
  return b === 0 ? NaN : a / b;
}

// Single source of truth for the denominator of the "days" KPIs
// (ap_days, inventory_days, cash_conversion_cycle): use COGS when the
// period has any, otherwise fall back to operating expense. Exported
// so the custom-KPI pre-resolution in portal-reports.service applies
// the exact same rule — the two used to drift (NaN vs. opex vs. 1).
export function daysDenominator(cogs: number, operatingExpense: number): number {
  return cogs > 0 ? cogs : operatingExpense;
}

export interface PeriodTriad {
  current: PeriodMetrics;
  priorMonth?: PeriodMetrics;
  priorYear?: PeriodMetrics;
}

// Compute every supported stock KPI key. Prior-period metrics are
// optional; passing them in unlocks the YoY/MoM KPIs.
export function computeStockKpis(m: PeriodMetrics | PeriodTriad, keys: string[]): Record<string, string> {
  const triad: PeriodTriad =
    'current' in m ? m : { current: m };
  const out: Record<string, string> = {};
  for (const key of keys) {
    out[key] = computeOne(key, triad);
  }
  return out;
}

// Convenience: gather metrics for current + prior-month + prior-year
// in a single call. Each prior gather is best-effort — if a prior
// window has no posted activity the metrics are still well-defined
// (zeros), so YoY/MoM still produce a result.
export async function gatherTriad(
  tenantId: string,
  companyId: string | null,
  startDate: string,
  endDate: string,
): Promise<PeriodTriad> {
  const current = await gatherMetrics(tenantId, companyId, startDate, endDate);
  const pm = priorMonthWindow(startDate, endDate);
  const py = priorYearWindow(startDate, endDate);
  const [priorMonth, priorYear] = await Promise.all([
    gatherMetrics(tenantId, companyId, pm.start, pm.end).catch(() => undefined),
    gatherMetrics(tenantId, companyId, py.start, py.end).catch(() => undefined),
  ]);
  return { current, priorMonth, priorYear };
}

// ── Custom KPI AST evaluator ────────────────────────────────────
//
// Supports the shapes the FormulaBuilder produces:
//   { kind: 'literal', value: 0 }
//   { kind: 'op', op: '+'|'-'|'*'|'/', left: …, right: … }
//   { kind: 'category', value: 'revenue', period?: 'current'|'prior_month'|'prior_year' }
//   { kind: 'metric', value: 'period_days', period?: … }
//   { kind: 'kpi', value: 'gross_margin_pct', period?: … }
//
// Period overrides resolve against pre-fetched prior-period metrics
// when supplied; default is current.

export interface EvalContext {
  current: PeriodMetrics;
  priorMonth?: PeriodMetrics;
  priorYear?: PeriodMetrics;
  /** Resolved values of stock + previously-computed custom KPIs,
   *  keyed by key. The evaluator references this map for the
   *  `kpi` node kind so a custom KPI can build on top of others. */
  resolvedKpis: Record<string, number>;
}

export interface AstNode {
  kind?: string;
  value?: number | string | string[];
  op?: string;
  left?: AstNode;
  right?: AstNode;
  period?: 'current' | 'prior_month' | 'prior_year';
  // Tolerate the alternate shape from the stock catalog where
  // operations carry `op` and operand keys `a`/`b` instead of
  // left/right.
  a?: AstNode;
  b?: AstNode;
  type?: string;
}

function pickMetrics(ctx: EvalContext, period?: 'current' | 'prior_month' | 'prior_year'): PeriodMetrics | null {
  switch (period) {
    case 'prior_month':
      return ctx.priorMonth ?? null;
    case 'prior_year':
      return ctx.priorYear ?? null;
    default:
      return ctx.current;
  }
}

function categoryValue(m: PeriodMetrics, name: string): number {
  switch (name) {
    case 'revenue': return m.revenue;
    case 'expense': return m.operatingExpense;
    case 'cogs': return m.cogs;
    case 'cash': return m.cash;
    case 'bank': return m.bankBalance;
    case 'accounts_receivable': return m.accountsReceivable;
    case 'accounts_payable': return m.accountsPayable;
    case 'current_asset': return m.currentAssets;
    case 'current_liability': return m.currentLiabilities;
    case 'inventory': return m.inventory;
    default: return 0;
  }
}

function metricValue(m: PeriodMetrics, name: string): number {
  switch (name) {
    case 'period_days': return m.periodDays;
    case 'avg_monthly_burn': return (m.operatingExpense / m.periodDays) * 30;
    case 'avg_daily_expense': return m.operatingExpense / m.periodDays;
    case 'operating_income': return m.operatingIncome;
    case 'net_income': return m.netIncome;
    // Net income + interest + depreciation & amortization — same math
    // as the stock EBITDA KPI.
    case 'ebitda': return m.netIncome + m.interestExpense + m.depreciationAmortization;
    case 'ar_balance': return m.accountsReceivable;
    case 'ap_balance': return m.accountsPayable;
    case 'inventory_balance': return m.inventory;
    case 'bank_balance': return m.bankBalance;
    case 'cash_balance': return m.cash;
    case 'total_assets': return m.totalAssets;
    case 'total_liabilities': return m.totalLiabilities;
    case 'equity': return m.equity;
    case 'fixed_assets': return m.fixedAssets;
    case 'interest_expense': return m.interestExpense;
    case 'depreciation_amortization': return m.depreciationAmortization;
    default: return 0;
  }
}

// Recursion ceiling for formula ASTs. Custom-KPI formulas are stored
// as caller-supplied JSON — without a depth guard a deeply nested (or
// adversarial) formula can blow the JS stack. 32 levels is far beyond
// any formula the builder UI produces.
const MAX_AST_DEPTH = 32;

export function evaluateAst(node: AstNode | undefined | null, ctx: EvalContext, depth = 0): number {
  if (depth > MAX_AST_DEPTH) {
    throw new Error(`KPI formula is nested too deeply (max ${MAX_AST_DEPTH} levels)`);
  }
  if (!node || typeof node !== 'object') return 0;
  // FormulaBuilder shape: kind+left/right
  if (node.kind === 'literal') {
    const n = Number(node.value ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
  if (node.kind === 'op') {
    const a = evaluateAst(node.left, ctx, depth + 1);
    const b = evaluateAst(node.right, ctx, depth + 1);
    switch (node.op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? NaN : a / b;
      default: return 0;
    }
  }
  if (node.kind === 'category') {
    const m = pickMetrics(ctx, node.period);
    return m ? categoryValue(m, String(node.value ?? '')) : 0;
  }
  if (node.kind === 'metric') {
    const m = pickMetrics(ctx, node.period);
    return m ? metricValue(m, String(node.value ?? '')) : 0;
  }
  if (node.kind === 'kpi') {
    const k = String(node.value ?? '');
    return ctx.resolvedKpis[k] ?? 0;
  }
  // Stock-catalog shape: { op: 'div', a: {...}, b: {...} } and
  // { type: 'category', value: '...' } — preserved so a stock entry
  // can be evaluated by the same walker if needed.
  if (node.op && (node.a || node.b)) {
    const left = evaluateAst(node.a, ctx, depth + 1);
    const right = evaluateAst(node.b, ctx, depth + 1);
    switch (node.op) {
      case 'div': return right === 0 ? NaN : left / right;
      case 'sub': return left - right;
      case 'add': return left + right;
      case 'mul': return left * right;
      default: return 0;
    }
  }
  if (node.type === 'category') {
    const m = pickMetrics(ctx, node.period);
    return m ? categoryValue(m, String(node.value ?? '')) : 0;
  }
  if (node.type === 'category_sum' && Array.isArray(node.value)) {
    const m = pickMetrics(ctx, node.period);
    if (!m) return 0;
    return (node.value as string[]).reduce((sum, name) => sum + categoryValue(m, name), 0);
  }
  if (node.type) {
    // Treat any other type token as a metric (revenue/cogs/net_income/etc.)
    const m = pickMetrics(ctx, node.period);
    return m ? metricValue(m, String(node.type)) : 0;
  }
  return 0;
}

// Format a raw numeric result against the KPI's display format.
export function formatKpiValue(
  value: number,
  format: 'currency' | 'percent' | 'ratio' | 'days',
): string {
  if (!Number.isFinite(value)) return '—';
  switch (format) {
    case 'currency':
      return value.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'ratio':
      return value.toFixed(2);
    case 'days':
      return `${Math.round(value)} d`;
    default:
      return value.toFixed(2);
  }
}

function computeOne(key: string, triad: PeriodTriad): string {
  const m = triad.current;
  switch (key) {
    case 'gross_margin_pct':
      return fmtPercent(safeDiv(m.grossProfit, m.revenue));
    case 'operating_margin_pct':
      return fmtPercent(safeDiv(m.operatingIncome, m.revenue));
    case 'net_margin_pct':
      return fmtPercent(safeDiv(m.netIncome, m.revenue));
    case 'ebitda':
      // Net income + interest + depreciation & amortization. The
      // add-backs come from period activity on cost accounts whose
      // detail_type is interest_expense / depreciation / amortization
      // (tax add-back detail is not modeled, so this is EBITDA to the
      // extent income tax expense isn't booked as an expense account).
      return fmtCurrency(m.netIncome + m.interestExpense + m.depreciationAmortization);
    case 'working_capital':
      return fmtCurrency(m.currentAssets - m.currentLiabilities);
    case 'debt_to_equity':
      return fmtRatio(safeDiv(m.totalLiabilities, m.equity));
    case 'bank_balance':
      return fmtCurrency(m.bankBalance);
    case 'cash_balance':
      // Includes undeposited_funds — strictly "money on hand" as the
      // ledger sees it, rather than just bank-account dollars.
      return fmtCurrency(m.cash);
    case 'current_ratio':
      return fmtRatio(safeDiv(m.currentAssets, m.currentLiabilities));
    case 'quick_ratio':
      return fmtRatio(safeDiv(m.cash + m.accountsReceivable, m.currentLiabilities));
    case 'cash_runway_months': {
      const monthlyBurn = (m.operatingExpense / m.periodDays) * 30;
      return fmtRatio(safeDiv(m.cash, monthlyBurn));
    }
    case 'days_cash_on_hand': {
      const dailyExpense = m.operatingExpense / m.periodDays;
      return fmtDays(safeDiv(m.cash, dailyExpense));
    }
    case 'ar_days':
      return fmtDays(safeDiv(m.accountsReceivable, m.revenue) * m.periodDays);
    case 'ap_days':
      return fmtDays(safeDiv(m.accountsPayable, daysDenominator(m.cogs, m.operatingExpense)) * m.periodDays);
    case 'inventory_days':
      return fmtDays(safeDiv(m.inventory, daysDenominator(m.cogs, m.operatingExpense)) * m.periodDays);
    case 'cash_conversion_cycle': {
      const arDays = safeDiv(m.accountsReceivable, m.revenue) * m.periodDays;
      const apDays = safeDiv(m.accountsPayable, daysDenominator(m.cogs, m.operatingExpense)) * m.periodDays;
      const invDays = safeDiv(m.inventory, daysDenominator(m.cogs, m.operatingExpense)) * m.periodDays;
      return fmtDays(arDays + invDays - apDays);
    }
    case 'revenue_mom': {
      if (!triad.priorMonth) return '—';
      const prior = triad.priorMonth.revenue;
      if (prior === 0) return '—';
      return fmtPercent((m.revenue - prior) / prior);
    }
    case 'revenue_yoy': {
      if (!triad.priorYear) return '—';
      const prior = triad.priorYear.revenue;
      if (prior === 0) return '—';
      return fmtPercent((m.revenue - prior) / prior);
    }
    case 'expense_yoy': {
      if (!triad.priorYear) return '—';
      const prior = triad.priorYear.operatingExpense;
      if (prior === 0) return '—';
      return fmtPercent((m.operatingExpense - prior) / prior);
    }
    case 'net_income_mom': {
      if (!triad.priorMonth) return '—';
      const prior = triad.priorMonth.netIncome;
      if (prior === 0) return '—';
      // Net income can be negative — divide by |prior| so "improved
      // from a loss" reads positive (mirrors the PDF Δ% convention).
      return fmtPercent((m.netIncome - prior) / Math.abs(prior));
    }
    case 'net_income_yoy': {
      if (!triad.priorYear) return '—';
      const prior = triad.priorYear.netIncome;
      if (prior === 0) return '—';
      return fmtPercent((m.netIncome - prior) / Math.abs(prior));
    }
    default:
      return '—';
  }
}

// ── KPI target thresholds (F7) ──────────────────────────────────
//
// Stored on kpi_definitions.threshold_jsonb as
//   { direction: 'above_is_good' | 'below_is_good', green: n, amber: n }
// and compared against the RAW numeric KPI value. Snapshot carries the
// resulting status alongside the formatted value (data.kpi_status).

export interface KpiThreshold {
  direction: 'above_is_good' | 'below_is_good';
  green: number;
  amber: number;
}

export type KpiStatus = 'green' | 'amber' | 'red';

// Defensive parse — threshold_jsonb is caller-supplied JSON; anything
// malformed reads as "no threshold" rather than throwing mid-compute.
export function parseKpiThreshold(raw: unknown): KpiThreshold | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const direction = t['direction'];
  const green = Number(t['green']);
  const amber = Number(t['amber']);
  if (direction !== 'above_is_good' && direction !== 'below_is_good') return null;
  if (!Number.isFinite(green) || !Number.isFinite(amber)) return null;
  return { direction, green, amber };
}

export function computeKpiStatus(value: number, threshold: KpiThreshold): KpiStatus | null {
  if (!Number.isFinite(value)) return null;
  if (threshold.direction === 'below_is_good') {
    if (value <= threshold.green) return 'green';
    if (value <= threshold.amber) return 'amber';
    return 'red';
  }
  if (value >= threshold.green) return 'green';
  if (value >= threshold.amber) return 'amber';
  return 'red';
}
