// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tags } from '../db/schema/index.js';
import * as reportSvc from './report.service.js';
import * as budgetSvc from './budget.service.js';
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

// Section subtotals for the richer Balance Sheet embed. Additive —
// older snapshots without `sections` still render the three totals.
export interface BsSections {
  currentAssets: number;
  fixedAssets: number;
  otherAssets: number;
  currentLiabilities: number;
  longTermLiabilities: number;
}

export interface BsSummary {
  assets: number;
  liabilities: number;
  equity: number;
  sections?: BsSections;
}

// Budget vs. Actual data block (F1) — slim per-line rows + totals.
export interface BudgetVsActualRow {
  account: string;
  budgeted: number;
  actual: number;
  variance: number;
  variancePct: number | null;
}

export interface BudgetVsActualSummary {
  budgetName: string;
  fiscalYear: number;
  rows: BudgetVsActualRow[];
  totals: { budgeted: number; actual: number; variance: number };
  truncated: boolean;
}

// Tag-segment block (F2) — one per-tag P&L summary row per segment.
export interface TagSegmentRow {
  tagId: string;
  tagName: string;
  revenue: number;
  expenses: number;
  netIncome: number;
}

// Sales Tax Liability embed (F5) — the service reports period totals
// (no per-agency breakdown is modeled yet).
export interface SalesTaxSummary {
  totalSales: number;
  totalTax: number;
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

// Detail-type classification for the Balance Sheet embed sections.
// Both the default-COA umbrella vocabulary ('bank') and the QBO-style
// specific one ('checking'/'savings') appear in production data.
// Unknown (incl. tenant-defined custom) detail types fall to the
// "other assets" / "long-term liabilities" catch-alls.
const BS_CURRENT_ASSET_DETAIL_TYPES = new Set([
  'bank', 'checking', 'savings', 'cash', 'petty_cash', 'undeposited_funds',
  'accounts_receivable', 'inventory', 'prepaid_expense', 'other_current_asset',
]);
const BS_FIXED_ASSET_DETAIL_TYPES = new Set(['fixed_asset', 'accumulated_depreciation']);
const BS_CURRENT_LIABILITY_DETAIL_TYPES = new Set([
  'accounts_payable', 'credit_card', 'sales_tax_payable', 'payroll_payable',
  'other_current_liability',
]);

async function bsSummary(args: ResolverArgs, basis: EmbedBasis = 'accrual'): Promise<BsSummary> {
  // groupBy detail_type gives per-detail subtotals in one pass, so the
  // section rollups don't need extra balance queries.
  const r = await reportSvc.buildBalanceSheet(
    args.tenantId,
    args.endDate,
    basis,
    args.companyId,
    null,
    'detail_type',
  );
  const sections: BsSections = {
    currentAssets: 0,
    fixedAssets: 0,
    otherAssets: 0,
    currentLiabilities: 0,
    longTermLiabilities: 0,
  };
  type Group = { detailType: string | null; subtotal: number };
  for (const g of ((r.groups?.assets ?? []) as Group[])) {
    if (g.detailType && BS_CURRENT_ASSET_DETAIL_TYPES.has(g.detailType)) {
      sections.currentAssets += g.subtotal;
    } else if (g.detailType && BS_FIXED_ASSET_DETAIL_TYPES.has(g.detailType)) {
      sections.fixedAssets += g.subtotal;
    } else {
      sections.otherAssets += g.subtotal;
    }
  }
  for (const g of ((r.groups?.liabilities ?? []) as Group[])) {
    if (g.detailType && BS_CURRENT_LIABILITY_DETAIL_TYPES.has(g.detailType)) {
      sections.currentLiabilities += g.subtotal;
    } else {
      sections.longTermLiabilities += g.subtotal;
    }
  }
  return {
    assets: r.totalAssets,
    liabilities: r.totalLiabilities,
    equity: r.totalEquity,
    sections,
  };
}

// Budget vs. Actual (F1) — slims buildBudgetVsActual to per-line
// budget/actual/variance rows, capped like the trial-balance embed.
const BVA_EMBED_MAX_ROWS = 40;
async function budgetVsActual(
  args: ResolverArgs,
  budgetId: string,
): Promise<BudgetVsActualSummary> {
  const r = await budgetSvc.buildBudgetVsActual(
    args.tenantId,
    budgetId,
    args.startDate,
    args.endDate,
    args.companyId,
  );
  type BvaLine = {
    accountName: string;
    accountNumber: string | null;
    budget: number;
    actual: number;
    varianceDollar: number;
    variancePercent: number | null;
  };
  const all = [
    ...(r.revenue as BvaLine[]),
    ...(r.cogs as BvaLine[]),
    ...(r.expenses as BvaLine[]),
    ...(r.otherRevenue as BvaLine[]),
    ...(r.otherExpenses as BvaLine[]),
  ];
  const rows = all.slice(0, BVA_EMBED_MAX_ROWS).map((line) => ({
    account: line.accountNumber ? `${line.accountNumber} · ${line.accountName}` : line.accountName,
    budgeted: line.budget,
    actual: line.actual,
    variance: line.varianceDollar,
    variancePct: line.variancePercent,
  }));
  return {
    budgetName: r.budgetName,
    fiscalYear: r.fiscalYear,
    rows,
    totals: {
      budgeted: r.netIncomeBudget,
      actual: r.netIncomeActual,
      variance: r.netIncomeActual - r.netIncomeBudget,
    },
    truncated: all.length > BVA_EMBED_MAX_ROWS,
  };
}

// Tag segments (F2) — one accrual P&L per tag (line-level tag filter),
// summarized to revenue / expenses / net income. Tag names resolve
// tenant-scoped; ids that don't belong to the tenant are dropped.
const TAG_SEGMENT_MAX_TAGS = 10;
async function tagSegments(args: ResolverArgs, tagIds: string[]): Promise<TagSegmentRow[]> {
  const ids = tagIds.slice(0, TAG_SEGMENT_MAX_TAGS);
  const nameRows = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(and(eq(tags.tenantId, args.tenantId), inArray(tags.id, ids)));
  const nameById = new Map(nameRows.map((t) => [t.id, t.name]));
  const rows: TagSegmentRow[] = [];
  for (const tagId of ids) {
    const tagName = nameById.get(tagId);
    if (!tagName) continue; // deleted or foreign-tenant id
    const pl = await reportSvc.buildProfitAndLoss(
      args.tenantId,
      args.startDate,
      args.endDate,
      'accrual',
      args.companyId,
      tagId,
    );
    rows.push({
      tagId,
      tagName,
      revenue: pl.totalRevenue + pl.totalOtherRevenue,
      expenses: pl.totalCogs + pl.totalExpenses + pl.totalOtherExpenses,
      netIncome: pl.netIncome,
    });
  }
  return rows;
}

// Expense by Category (F4) — reuses the summary mode of the report.
async function expenseByCategory(args: ResolverArgs, topN: number): Promise<TopRow[]> {
  const r = await reportSvc.buildExpenseByCategory(
    args.tenantId,
    args.startDate,
    args.endDate,
    args.companyId,
  );
  const rows = (r.data as Array<{ category: string; total: string | number }>).map((row) => ({
    name: row.category,
    amount: Number(row.total ?? 0),
  }));
  return rows.slice(0, topN);
}

// Sales Tax Liability embed (F5).
async function salesTaxSummary(args: ResolverArgs): Promise<SalesTaxSummary> {
  const r = await reportSvc.buildSalesTaxLiability(
    args.tenantId,
    args.startDate,
    args.endDate,
    args.companyId,
  );
  return { totalSales: r.totalSales, totalTax: r.totalTax };
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

// Net income per month. Income is signed credit−debit and costs
// debit−credit (P&L convention), so net income = Σ income − Σ costs
// = Σ (credit − debit) across ALL P&L account types in one sum.
async function netIncomeTrend12m(args: ResolverArgs): Promise<TrendPoint[]> {
  const w = trendWindow(args.endDate);
  const companyCond = args.companyId ? sql`AND t.company_id = ${args.companyId}` : sql``;
  const rows = await db.execute(sql`
    SELECT to_char(date_trunc('month', t.txn_date), 'YYYY-MM') AS month,
      COALESCE(SUM(jl.credit - jl.debit), 0) AS amount
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${args.tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${args.tenantId}
    WHERE jl.tenant_id = ${args.tenantId}
      AND t.status = 'posted'
      AND t.txn_date >= ${w.startDate} AND t.txn_date <= ${w.endDate}
      AND a.account_type IN ('revenue', 'other_revenue', 'cogs', 'expense', 'other_expense')
      ${companyCond}
    GROUP BY 1
  `);
  const byMonth = new Map<string, number>();
  for (const row of rows.rows as Array<{ month: string; amount: string | number | null }>) {
    byMonth.set(row.month, Number(row.amount ?? 0));
  }
  return w.months.map((mo) => ({ month: mo, label: monthLabel(mo), amount: byMonth.get(mo) ?? 0 }));
}

// Gross margin % per month — (revenue − cogs) / revenue, null-safe to
// 0 when a month has no revenue. Amounts are percentage points
// (e.g. 42.5), NOT dollars; renderers label the axis accordingly.
async function grossMarginTrend12m(args: ResolverArgs): Promise<TrendPoint[]> {
  const w = trendWindow(args.endDate);
  const companyCond = args.companyId ? sql`AND t.company_id = ${args.companyId}` : sql``;
  const rows = await db.execute(sql`
    SELECT to_char(date_trunc('month', t.txn_date), 'YYYY-MM') AS month,
      COALESCE(SUM(CASE WHEN a.account_type IN ('revenue', 'other_revenue')
        THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN a.account_type = 'cogs'
        THEN jl.debit - jl.credit ELSE 0 END), 0) AS cogs
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${args.tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${args.tenantId}
    WHERE jl.tenant_id = ${args.tenantId}
      AND t.status = 'posted'
      AND t.txn_date >= ${w.startDate} AND t.txn_date <= ${w.endDate}
      AND a.account_type IN ('revenue', 'other_revenue', 'cogs')
      ${companyCond}
    GROUP BY 1
  `);
  const byMonth = new Map<string, number>();
  for (const row of rows.rows as Array<{ month: string; revenue: string | number | null; cogs: string | number | null }>) {
    const rev = Number(row.revenue ?? 0);
    const cogs = Number(row.cogs ?? 0);
    const pct = rev === 0 ? 0 : ((rev - cogs) / rev) * 100;
    byMonth.set(row.month, Math.round(pct * 10) / 10);
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

// Resolve a `block`/`chart`/`report`/`tag-segment` block to a
// renderable payload. Unknown names get { error } so the renderer can
// show a helpful message instead of nothing.
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
        case 'expense_by_category':
          return { type: 'expense_by_category', data: await expenseByCategory(args, topN) };
        case 'budget_vs_actual': {
          const budgetId = typeof block['budgetId'] === 'string' ? block['budgetId'] : '';
          if (!budgetId) {
            return {
              type: 'budget_vs_actual',
              error: 'No budget selected — pick one in the layout editor.',
            };
          }
          return { type: 'budget_vs_actual', data: await budgetVsActual(args, budgetId) };
        }
        default:
          return { type, error: `Unknown block: ${name}` };
      }
    }
    if (type === 'tag-segment') {
      const tagIds = Array.isArray(block['tags'])
        ? (block['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      if (tagIds.length === 0) {
        return {
          type: 'tag_segments',
          error: 'No tags selected — pick tags in the layout editor.',
        };
      }
      const rows = await tagSegments(args, tagIds);
      if (rows.length === 0) {
        return {
          type: 'tag_segments',
          error: 'The selected tags no longer exist — re-pick them in the layout editor.',
        };
      }
      return { type: 'tag_segments', data: rows };
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
        case 'net_income_trend_12m':
          return { type: 'net_income_trend_12m', data: await netIncomeTrend12m(args) };
        case 'gross_margin_trend_12m':
          return { type: 'gross_margin_trend_12m', data: await grossMarginTrend12m(args) };
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
        case 'sales_tax':
          return { type: 'sales_tax', data: await salesTaxSummary(args) };
        default:
          return { type: name, error: `Unknown report embed: ${name}` };
      }
    }
    return { type, error: `Unsupported block type: ${type}` };
  } catch (err) {
    return { type, error: err instanceof Error ? err.message : String(err) };
  }
}
