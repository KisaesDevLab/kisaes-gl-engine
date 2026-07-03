// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as reportSvc from './report.service.js';
import { gatherTriad, type PeriodTriad } from './portal-report-evaluator.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 16.6 — visual data blocks.
// Each block type returns a typed payload the renderer (preview +
// portal) can paint without re-querying the books.

export interface TopRow {
  name: string;
  amount: number;
}

export interface AgingBuckets {
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  total: number;
}

export interface PlSummary {
  revenue: number;
  cogs: number;
  grossProfit: number;
  operatingExpense: number;
  netIncome: number;
}

export interface BsSummary {
  assets: number;
  liabilities: number;
  equity: number;
}

export interface PlVsPriorYear {
  current: PlSummary;
  prior: PlSummary | null;
}

// One point per calendar month on the 12-month trend charts.
export interface TrendPoint {
  month: string; // 'YYYY-MM'
  label: string; // 'Jul 25'
  amount: number;
}

export interface CfSummary {
  netIncome: number;
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
}

export interface TbSummaryRow {
  account: string;
  debit: number;
  credit: number;
}

export interface TbSummary {
  rows: TbSummaryRow[];
  totalDebits: number;
  totalCredits: number;
  truncated: boolean;
}

export interface BankBalancesSummary {
  asOfDate: string;
  accounts: Array<{ name: string; balance: number; isInactive: boolean }>;
  totalBalance: number;
}

export type EmbedBasis = 'accrual' | 'cash';

export interface BlockPayload {
  type: string;
  data?: unknown;
  error?: string;
}

interface ResolverArgs {
  tenantId: string;
  companyId: string | null;
  startDate: string;
  endDate: string;
  triad?: PeriodTriad;
}

async function topCustomers(
  args: ResolverArgs,
  topN: number,
): Promise<TopRow[]> {
  const r = await reportSvc.buildSalesByCustomer(
    args.tenantId,
    args.startDate,
    args.endDate,
    args.companyId,
  );
  const rows = (r.data as Array<{ customer_name: string; total: string | number }>).map((row) => ({
    name: row.customer_name,
    amount: Number(row.total ?? 0),
  }));
  return rows.slice(0, topN);
}

async function topVendors(
  args: ResolverArgs,
  topN: number,
): Promise<TopRow[]> {
  const r = await reportSvc.buildExpenseByVendor(
    args.tenantId,
    args.startDate,
    args.endDate,
    args.companyId,
  );
  const rows = (r.data as Array<{ vendor_name: string; total: string | number }>).map((row) => ({
    name: row.vendor_name,
    amount: Number(row.total ?? 0),
  }));
  return rows.slice(0, topN);
}

async function arAging(args: ResolverArgs): Promise<AgingBuckets> {
  const r = await reportSvc.buildARAgingSummary(
    args.tenantId,
    args.endDate,
    args.companyId,
  );
  return {
    current: r.buckets.current,
    days1to30: r.buckets.days1to30,
    days31to60: r.buckets.days31to60,
    days61to90: r.buckets.days61to90,
    over90: r.buckets.over90,
    total: r.total,
  };
}

// AP aging — there's no shared helper for it, so we compute inline
// against unpaid bills.
async function apAging(args: ResolverArgs): Promise<AgingBuckets> {
  const companyCond = args.companyId ? sql`AND t.company_id = ${args.companyId}` : sql``;
  const rows = await db.execute(sql`
    SELECT t.due_date, t.txn_date, t.balance_due, t.total
    FROM transactions t
    WHERE t.tenant_id = ${args.tenantId}
      AND t.status = 'posted'
      AND t.txn_type = 'bill'
      AND COALESCE(t.bill_status, 'unpaid') NOT IN ('paid', 'void')
      AND t.txn_date <= ${args.endDate}
      ${companyCond}
  `);
  const buckets: AgingBuckets = {
    current: 0,
    days1to30: 0,
    days31to60: 0,
    days61to90: 0,
    over90: 0,
    total: 0,
  };
  const asOf = new Date(`${args.endDate}T00:00:00Z`);
  for (const row of rows.rows as Array<{
    due_date: string | null;
    txn_date: string;
    balance_due: string | null;
    total: string | null;
  }>) {
    const balance = Number(row.balance_due ?? row.total ?? 0);
    if (balance <= 0) continue;
    const due = new Date(`${row.due_date ?? row.txn_date}T00:00:00Z`);
    const days = Math.floor((asOf.getTime() - due.getTime()) / 86400000);
    if (days <= 0) buckets.current += balance;
    else if (days <= 30) buckets.days1to30 += balance;
    else if (days <= 60) buckets.days31to60 += balance;
    else if (days <= 90) buckets.days61to90 += balance;
    else buckets.over90 += balance;
    buckets.total += balance;
  }
  return buckets;
}

function plSummaryFromMetrics(m: ResolverArgs['triad'] extends infer T ? T : never): PlSummary {
  // unused — replaced inline below; kept for type clarity
  return {
    revenue: 0,
    cogs: 0,
    grossProfit: 0,
    operatingExpense: 0,
    netIncome: 0,
  };
}
void plSummaryFromMetrics;

async function plSummary(args: ResolverArgs, basis: EmbedBasis = 'accrual'): Promise<PlSummary> {
  if (basis === 'cash') {
    // The shared triad is accrual-only — a cash-basis embed goes
    // straight to the P&L builder's virtual cash ledger.
    const pl = await reportSvc.buildProfitAndLoss(
      args.tenantId,
      args.startDate,
      args.endDate,
      'cash',
      args.companyId,
    );
    return {
      revenue: pl.totalRevenue,
      cogs: pl.totalCogs,
      grossProfit: pl.grossProfit ?? pl.totalRevenue - pl.totalCogs,
      operatingExpense: pl.totalExpenses,
      netIncome: pl.netIncome,
    };
  }
  const triad = args.triad ?? (await gatherTriad(args.tenantId, args.companyId, args.startDate, args.endDate));
  return {
    revenue: triad.current.revenue,
    cogs: triad.current.cogs,
    grossProfit: triad.current.grossProfit,
    operatingExpense: triad.current.operatingExpense,
    netIncome: triad.current.netIncome,
  };
}

async function bsSummary(args: ResolverArgs, basis: EmbedBasis = 'accrual'): Promise<BsSummary> {
  const r = await reportSvc.buildBalanceSheet(args.tenantId, args.endDate, basis, args.companyId);
  return {
    assets: r.totalAssets,
    liabilities: r.totalLiabilities,
    equity: r.totalEquity,
  };
}

// Cash flow embed — the cash-flow statement is direct-method (built
// from actual cash movements), so it has no accrual/cash basis knob.
async function cfSummary(args: ResolverArgs): Promise<CfSummary> {
  const r = await reportSvc.buildCashFlowStatement(
    args.tenantId,
    args.startDate,
    args.endDate,
    args.companyId,
  );
  return {
    netIncome: r.netIncome,
    operating: r.operatingActivities,
    investing: r.investingActivities,
    financing: r.financingActivities,
    netChange: r.netChange,
  };
}

// Trial-balance embed — slim {account, debit, credit} rows + totals,
// capped so a big COA can't bloat the snapshot/PDF.
const TB_EMBED_MAX_ROWS = 40;
async function tbSummary(args: ResolverArgs): Promise<TbSummary> {
  const r = await reportSvc.buildTrialBalance(
    args.tenantId,
    args.startDate,
    args.endDate,
    args.companyId,
  );
  const all = r.data as Array<{
    account_number: string | null;
    name: string;
    total_debit: number;
    total_credit: number;
  }>;
  const rows = all.slice(0, TB_EMBED_MAX_ROWS).map((row) => ({
    account: row.account_number ? `${row.account_number} · ${row.name}` : row.name,
    debit: Number(row.total_debit ?? 0),
    credit: Number(row.total_credit ?? 0),
  }));
  return {
    rows,
    totalDebits: r.totalDebits,
    totalCredits: r.totalCredits,
    truncated: all.length > TB_EMBED_MAX_ROWS,
  };
}

// Bank balances (embed + data block) — per-account as-of-periodEnd
// balance + total, straight from the Feature-1 report builder.
async function bankBalances(args: ResolverArgs): Promise<BankBalancesSummary> {
  const r = await reportSvc.buildBankBalances(args.tenantId, args.endDate, args.companyId);
  return {
    asOfDate: r.asOfDate,
    accounts: r.accounts.map((a) => ({
      name: a.accountNumber ? `${a.accountNumber} · ${a.name}` : a.name,
      balance: a.balance,
      isInactive: a.isInactive,
    })),
    totalBalance: r.totalBalance,
  };
}

// ── 12-month trend charts ───────────────────────────────────────

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[parseInt(m ?? '1', 10) - 1]} ${(y ?? '').slice(2)}`;
}

// 12 calendar months ending with the month of `endDate`. The window
// spans whole months (1st of the first month → last day of the end
// month) so each bucket is a full-month total.
function trendWindow(endDate: string): { startDate: string; endDate: string; months: string[] } {
  const [yRaw, mRaw] = endDate.split('-');
  const y = parseInt(yRaw ?? '1970', 10);
  const m = parseInt(mRaw ?? '1', 10);
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const last = new Date(Date.UTC(y, m, 0)); // last day of the end month
  return {
    startDate: `${months[0]}-01`,
    endDate: `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`,
    months,
  };
}

// Revenue / expense monthly totals — one grouped query per chart.
// Revenue is signed credit−debit (income convention, like the P&L);
// expenses (expense + cogs + other_expense) are debit−credit.
async function plTrend12m(args: ResolverArgs, kind: 'revenue' | 'expense'): Promise<TrendPoint[]> {
  const w = trendWindow(args.endDate);
  const companyCond = args.companyId ? sql`AND t.company_id = ${args.companyId}` : sql``;
  const typeCond =
    kind === 'revenue'
      ? sql`a.account_type IN ('revenue', 'other_revenue')`
      : sql`a.account_type IN ('cogs', 'expense', 'other_expense')`;
  const signed = kind === 'revenue' ? sql`jl.credit - jl.debit` : sql`jl.debit - jl.credit`;
  const rows = await db.execute(sql`
    SELECT to_char(date_trunc('month', t.txn_date), 'YYYY-MM') AS month,
      COALESCE(SUM(${signed}), 0) AS amount
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${args.tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${args.tenantId}
    WHERE jl.tenant_id = ${args.tenantId}
      AND t.status = 'posted'
      AND t.txn_date >= ${w.startDate} AND t.txn_date <= ${w.endDate}
      AND ${typeCond}
      ${companyCond}
    GROUP BY 1
  `);
  const byMonth = new Map<string, number>();
  for (const row of rows.rows as Array<{ month: string; amount: string | number | null }>) {
    byMonth.set(row.month, Number(row.amount ?? 0));
  }
  return w.months.map((mo) => ({ month: mo, label: monthLabel(mo), amount: byMonth.get(mo) ?? 0 }));
}

// Month-END total balance across all bank accounts for the same 12
// months — cumulative as of each month end. One query buckets all
// journal-line activity ('opening' = everything before the window),
// then a running sum in JS produces the month-end balances.
async function cashBalanceTrend(args: ResolverArgs): Promise<TrendPoint[]> {
  const w = trendWindow(args.endDate);
  const companyCond = args.companyId ? sql`AND t.company_id = ${args.companyId}` : sql``;
  const detailList = sql.join(
    reportSvc.BANK_ACCOUNT_DETAIL_TYPES.map((d) => sql`${d}`),
    sql`, `,
  );
  const rows = await db.execute(sql`
    SELECT CASE WHEN t.txn_date < ${w.startDate} THEN 'opening'
      ELSE to_char(date_trunc('month', t.txn_date), 'YYYY-MM') END AS bucket,
      COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${args.tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${args.tenantId}
    WHERE jl.tenant_id = ${args.tenantId}
      AND t.status = 'posted'
      AND t.txn_date <= ${w.endDate}
      AND a.account_type = 'asset'
      AND a.detail_type IN (${detailList})
      ${companyCond}
    GROUP BY 1
  `);
  const byBucket = new Map<string, number>();
  for (const row of rows.rows as Array<{ bucket: string; amount: string | number | null }>) {
    byBucket.set(row.bucket, Number(row.amount ?? 0));
  }
  let running = byBucket.get('opening') ?? 0;
  return w.months.map((mo) => {
    running += byBucket.get(mo) ?? 0;
    // Round the running sum so accumulated float noise doesn't leak
    // fractional cents into the chart payload.
    const amount = Math.round(running * 100) / 100;
    return { month: mo, label: monthLabel(mo), amount };
  });
}

async function plVsPriorYear(args: ResolverArgs): Promise<PlVsPriorYear> {
  const triad =
    args.triad ?? (await gatherTriad(args.tenantId, args.companyId, args.startDate, args.endDate));
  const cur = triad.current;
  return {
    current: {
      revenue: cur.revenue,
      cogs: cur.cogs,
      grossProfit: cur.grossProfit,
      operatingExpense: cur.operatingExpense,
      netIncome: cur.netIncome,
    },
    prior: triad.priorYear
      ? {
          revenue: triad.priorYear.revenue,
          cogs: triad.priorYear.cogs,
          grossProfit: triad.priorYear.grossProfit,
          operatingExpense: triad.priorYear.operatingExpense,
          netIncome: triad.priorYear.netIncome,
        }
      : null,
  };
}

// Resolve a `block`/`chart`/`report` block to a renderable payload.
// Unknown names get { error } so the renderer can show a helpful
// message instead of nothing.
export async function resolveBlock(
  block: Record<string, unknown>,
  args: ResolverArgs,
): Promise<BlockPayload> {
  const type = String(block['type'] ?? '');
  const name =
    (block['name'] as string | undefined) ??
    (block['report'] as string | undefined) ??
    (block['key'] as string | undefined) ??
    '';
  const topN = Number(block['topN'] ?? 10);
  // Optional accounting basis on report-embed blocks. Default accrual —
  // absent/unknown values keep the historical behavior.
  const basis: EmbedBasis = block['basis'] === 'cash' ? 'cash' : 'accrual';

  try {
    if (type === 'block') {
      switch (name) {
        case 'top_customers':
          return { type: 'top_customers', data: await topCustomers(args, topN) };
        case 'top_vendors':
          return { type: 'top_vendors', data: await topVendors(args, topN) };
        case 'ar_aging':
          return { type: 'ar_aging', data: await arAging(args) };
        case 'ap_aging':
          return { type: 'ap_aging', data: await apAging(args) };
        case 'pl_bar':
          return { type: 'pl_bar', data: await plSummary(args) };
        case 'bank_balances':
          return { type: 'bank_balances', data: await bankBalances(args) };
        default:
          return { type, error: `Unknown block: ${name}` };
      }
    }
    if (type === 'chart') {
      switch (name) {
        case 'pl_vs_prior_year':
          return { type: 'pl_vs_prior_year', data: await plVsPriorYear(args) };
        case 'revenue_trend_12m':
          return { type: 'revenue_trend_12m', data: await plTrend12m(args, 'revenue') };
        case 'expense_trend_12m':
          return { type: 'expense_trend_12m', data: await plTrend12m(args, 'expense') };
        case 'cash_balance_trend':
          return { type: 'cash_balance_trend', data: await cashBalanceTrend(args) };
        default:
          return { type: name, error: `Unknown chart: ${name}` };
      }
    }
    if (type === 'report') {
      switch (name) {
        case 'profit_loss':
          return { type: 'profit_loss', data: await plSummary(args, basis) };
        case 'balance_sheet':
          return { type: 'balance_sheet', data: await bsSummary(args, basis) };
        case 'cash_flow':
          return { type: 'cash_flow', data: await cfSummary(args) };
        case 'trial_balance':
          return { type: 'trial_balance', data: await tbSummary(args) };
        case 'bank_balances':
          return { type: 'bank_balances', data: await bankBalances(args) };
        // The A/R / A/P aging embeds reuse the data-block resolvers —
        // same payload type, so every renderer handles them already.
        // (These options were in the embed dropdown since Phase 16 but
        // never had resolvers; they always returned an error payload.)
        case 'ar_aging':
          return { type: 'ar_aging', data: await arAging(args) };
        case 'ap_aging':
          return { type: 'ap_aging', data: await apAging(args) };
        default:
          return { type: name, error: `Unknown report embed: ${name}` };
      }
    }
    return { type, error: `Unsupported block type: ${type}` };
  } catch (err) {
    return { type, error: err instanceof Error ? err.message : String(err) };
  }
}
