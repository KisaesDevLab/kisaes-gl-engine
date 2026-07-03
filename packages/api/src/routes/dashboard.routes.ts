// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import * as dashboardService from '../services/dashboard.service.js';
import * as budgetService from '../services/budget.service.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);
dashboardRouter.use(requirePermission('dashboard', 'read'));

// Build the budget-performance panel. Extracted into a helper so the
// single-request /summary endpoint can call the same code path as the
// legacy /budget-performance endpoint.
async function computeBudgetPerformance(tenantId: string) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]!;
  const budgetsList = await budgetService.list(tenantId);
  // Active budget = the one whose FISCAL WINDOW contains today (the old
  // `fiscalYear === calendar year` pick broke for non-January fiscal
  // years, where FY2026 spans two calendar years).
  const activeBudget = budgetsList.data.find((b) => {
    if (!b.isActive) return false;
    const fyStart = String((b as { fiscalYearStart?: string | null }).fiscalYearStart ?? `${b.fiscalYear}-01-01`).slice(0, 10);
    const fyEndYear = parseInt(fyStart.slice(0, 4), 10) + 1;
    const fyEnd = `${fyEndYear}${fyStart.slice(4)}`;
    return fyStart <= todayStr && todayStr < fyEnd;
  });
  if (!activeBudget) return null;

  const year = today.getUTCFullYear();
  const mtdStart = `${year}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const mtdEnd = todayStr;
  const mtdData = await budgetService.buildBudgetVsActual(tenantId, activeBudget.id, mtdStart, mtdEnd);

  // Fiscal YTD — from the budget's own fiscal year start, not Jan 1.
  // buildBudgetVsActual prorates the budget to this window, so YTD
  // actuals compare against the elapsed months' budget instead of the
  // full-year number.
  const ytdStart = String((activeBudget as { fiscalYearStart?: string | null }).fiscalYearStart ?? `${activeBudget.fiscalYear}-01-01`).slice(0, 10);
  const ytdData = await budgetService.buildBudgetVsActual(tenantId, activeBudget.id, ytdStart, mtdEnd);

  return {
    budgetName: activeBudget.name,
    budgetId: activeBudget.id,
    mtd: {
      revenueBudget: mtdData.totalRevenueBudget,
      revenueActual: mtdData.totalRevenueActual,
      expenseBudget: mtdData.totalExpenseBudget,
      expenseActual: mtdData.totalExpenseActual,
      netBudget: mtdData.netIncomeBudget,
      netActual: mtdData.netIncomeActual,
    },
    ytd: {
      revenueBudget: ytdData.totalRevenueBudget,
      revenueActual: ytdData.totalRevenueActual,
      expenseBudget: ytdData.totalExpenseBudget,
      expenseActual: ytdData.totalExpenseActual,
      netBudget: ytdData.netIncomeBudget,
      netActual: ytdData.netIncomeActual,
    },
  };
}

// Fetch the banking-health panel. Inlined copy of the legacy endpoint's
// body so /summary can call it directly. Kept short — no caching semantics
// yet; Promise.allSettled at the call site handles per-panel failure.
async function computeBankingHealth(tenantId: string) {
  const { db } = await import('../db/index.js');
  const { plaidItems, plaidAccountMappings, plaidAccounts } = await import('../db/schema/index.js');
  const { eq, and, sql, inArray } = await import('drizzle-orm');

  const tenantMappings = await db.select({ plaidAccountId: plaidAccountMappings.plaidAccountId }).from(plaidAccountMappings)
    .where(eq(plaidAccountMappings.tenantId, tenantId));
  const mappedAccountIds = tenantMappings.map((m) => m.plaidAccountId);

  let items: any[] = [];
  if (mappedAccountIds.length > 0) {
    const accts = await db.select({ plaidItemId: plaidAccounts.plaidItemId }).from(plaidAccounts)
      .where(inArray(plaidAccounts.id, mappedAccountIds));
    const itemIds = [...new Set(accts.map((a) => a.plaidItemId))];
    if (itemIds.length > 0) {
      items = await db.select().from(plaidItems).where(and(inArray(plaidItems.id, itemIds), sql`removed_at IS NULL`));
    }
  }

  const needsAttention = items.filter((i) =>
    ['login_required', 'pending_disconnect', 'error'].includes(i.itemStatus || ''),
  );

  const pendingFeedCount = await db.execute(sql`
    SELECT COUNT(*) as count FROM bank_feed_items
    WHERE tenant_id = ${tenantId} AND status = 'pending'
  `);

  return {
    totalConnections: items.length,
    needsAttention: needsAttention.length,
    needsAttentionItems: needsAttention.map((i) => ({
      id: i.id, institutionName: i.institutionName, itemStatus: i.itemStatus, errorMessage: i.errorMessage,
    })),
    pendingFeedItems: parseInt((pendingFeedCount.rows[0] as any)?.count || '0'),
  };
}

// Bundled dashboard endpoint. Previously the DashboardPage fired nine
// separate useQuery calls on mount — nine independent HTTP round-trips,
// nine DB connections, nine middleware chains. On a fresh load over a
// slow LAN link that's an observable delay, and it also makes the client
// error banner noisier (each query can independently fail).
//
// /summary runs all nine panels in parallel server-side with
// Promise.allSettled so a single panel's failure doesn't collapse the
// whole response — the client still sees the successful panels and gets
// explicit null for the failing ones. The shape matches the individual
// endpoints one-to-one so the UI code only changed its fetching layer.
dashboardRouter.get('/summary', async (req, res) => {
  const months = parseInt(req.query['months'] as string) || 6;
  const [
    snapshot, trend, cashPosition, receivables, payables,
    actionItems, budgetPerformance, bankingHealth,
  ] = await Promise.allSettled([
    dashboardService.getFinancialSnapshot(req.tenantId),
    dashboardService.getRevExpTrend(req.tenantId, months),
    dashboardService.getCashPosition(req.tenantId),
    dashboardService.getReceivablesSummary(req.tenantId),
    dashboardService.getPayablesSummary(req.tenantId),
    dashboardService.getActionItems(req.tenantId),
    computeBudgetPerformance(req.tenantId),
    computeBankingHealth(req.tenantId),
  ]);

  const unwrap = <T>(r: PromiseSettledResult<T>) => r.status === 'fulfilled' ? r.value : null;
  const errored = (r: PromiseSettledResult<unknown>, label: string) =>
    r.status === 'rejected' ? label : null;

  // Client-side error banner reads `errors` to label which panel(s) broke.
  // Matches the labels the old multi-query dashboard used so the UI copy
  // didn't have to change.
  const errors = [
    errored(snapshot, 'Financial snapshot'),
    errored(trend, 'Revenue/expense trend'),
    errored(cashPosition, 'Cash position'),
    errored(receivables, 'Receivables'),
    errored(payables, 'Payables'),
    errored(actionItems, 'Action items'),
    errored(budgetPerformance, 'Budget performance'),
    errored(bankingHealth, 'Banking health'),
  ].filter((x): x is string => x !== null);

  // Log server-side failures so an operator looking at the logs sees the
  // underlying cause — the API response only carries the labels.
  for (const panel of [snapshot, trend, cashPosition, receivables, payables, actionItems, budgetPerformance, bankingHealth]) {
    if (panel.status === 'rejected') {
      console.warn('[dashboard/summary] panel failed:', panel.reason);
    }
  }

  res.json({
    snapshot: unwrap(snapshot),
    trend: unwrap(trend) ? { data: unwrap(trend) } : null,
    cashPosition: unwrap(cashPosition),
    receivables: unwrap(receivables),
    payables: unwrap(payables),
    actionItems: unwrap(actionItems),
    budgetPerformance: unwrap(budgetPerformance),
    bankingHealth: unwrap(bankingHealth),
    errors,
  });
});

dashboardRouter.get('/snapshot', async (req, res) => {
  const data = await dashboardService.getFinancialSnapshot(req.tenantId);
  res.json(data);
});

dashboardRouter.get('/trend', async (req, res) => {
  const months = parseInt(req.query['months'] as string) || 6;
  const data = await dashboardService.getRevExpTrend(req.tenantId, months);
  res.json({ data });
});

dashboardRouter.get('/cash-position', async (req, res) => {
  const data = await dashboardService.getCashPosition(req.tenantId);
  res.json(data);
});

dashboardRouter.get('/receivables', async (req, res) => {
  const data = await dashboardService.getReceivablesSummary(req.tenantId);
  res.json(data);
});

dashboardRouter.get('/payables', async (req, res) => {
  const data = await dashboardService.getPayablesSummary(req.tenantId);
  res.json(data);
});

dashboardRouter.get('/action-items', async (req, res) => {
  const data = await dashboardService.getActionItems(req.tenantId);
  res.json(data);
});

dashboardRouter.get('/budget-performance', async (req, res) => {
  // Same code path as /summary — fiscal-window budget selection,
  // fiscal YTD window, prorated budget comparison.
  res.json(await computeBudgetPerformance(req.tenantId));
});

dashboardRouter.get('/banking-health', async (req, res) => {
  const { db } = await import('../db/index.js');
  const { plaidItems, plaidAccountMappings, plaidAccounts, bankFeedItems } = await import('../db/schema/index.js');
  const { eq, and, sql, inArray } = await import('drizzle-orm');

  // Find items connected to this tenant via mappings
  const tenantMappings = await db.select({ plaidAccountId: plaidAccountMappings.plaidAccountId }).from(plaidAccountMappings)
    .where(eq(plaidAccountMappings.tenantId, req.tenantId));
  const mappedAccountIds = tenantMappings.map((m) => m.plaidAccountId);

  let items: any[] = [];
  if (mappedAccountIds.length > 0) {
    const accts = await db.select({ plaidItemId: plaidAccounts.plaidItemId }).from(plaidAccounts)
      .where(inArray(plaidAccounts.id, mappedAccountIds));
    const itemIds = [...new Set(accts.map((a) => a.plaidItemId))];
    if (itemIds.length > 0) {
      items = await db.select().from(plaidItems).where(and(inArray(plaidItems.id, itemIds), sql`removed_at IS NULL`));
    }
  }

  const needsAttention = items.filter((i) =>
    ['login_required', 'pending_disconnect', 'error'].includes(i.itemStatus || ''),
  );

  const pendingFeedCount = await db.execute(sql`
    SELECT COUNT(*) as count FROM bank_feed_items
    WHERE tenant_id = ${req.tenantId} AND status = 'pending'
  `);

  res.json({
    totalConnections: items.length,
    needsAttention: needsAttention.length,
    needsAttentionItems: needsAttention.map((i) => ({
      id: i.id, institutionName: i.institutionName, itemStatus: i.itemStatus, errorMessage: i.errorMessage,
    })),
    pendingFeedItems: parseInt((pendingFeedCount.rows[0] as any)?.count || '0'),
  });
});
