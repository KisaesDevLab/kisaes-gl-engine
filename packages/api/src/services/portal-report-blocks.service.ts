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

async function plSummary(args: ResolverArgs): Promise<PlSummary> {
  const triad = args.triad ?? (await gatherTriad(args.tenantId, args.companyId, args.startDate, args.endDate));
  return {
    revenue: triad.current.revenue,
    cogs: triad.current.cogs,
    grossProfit: triad.current.grossProfit,
    operatingExpense: triad.current.operatingExpense,
    netIncome: triad.current.netIncome,
  };
}

async function bsSummary(args: ResolverArgs): Promise<BsSummary> {
  const r = await reportSvc.buildBalanceSheet(args.tenantId, args.endDate, 'accrual', args.companyId);
  return {
    assets: r.totalAssets,
    liabilities: r.totalLiabilities,
    equity: r.totalEquity,
  };
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
        default:
          return { type, error: `Unknown block: ${name}` };
      }
    }
    if (type === 'chart') {
      switch (name) {
        case 'pl_vs_prior_year':
          return { type: 'pl_vs_prior_year', data: await plVsPriorYear(args) };
        case 'revenue_trend_12m':
        case 'expense_trend_12m':
        case 'cash_balance_trend':
          // Not yet implemented — surface a "coming soon" payload so
          // the renderer doesn't fail open.
          return { type: name, error: `Trend chart "${name}" not yet wired` };
        default:
          return { type: name, error: `Unknown chart: ${name}` };
      }
    }
    if (type === 'report') {
      switch (name) {
        case 'profit_loss':
          return { type: 'profit_loss', data: await plSummary(args) };
        case 'balance_sheet':
          return { type: 'balance_sheet', data: await bsSummary(args) };
        default:
          return { type: name, error: `Unknown report embed: ${name}` };
      }
    }
    return { type, error: `Unsupported block type: ${type}` };
  } catch (err) {
    return { type, error: err instanceof Error ? err.message : String(err) };
  }
}
