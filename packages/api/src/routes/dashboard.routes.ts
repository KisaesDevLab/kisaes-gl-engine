// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as dashboardService from '../services/dashboard.service.js';
import * as budgetService from '../services/budget.service.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

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
  const today = new Date();
  const year = today.getFullYear();

  // Find active budget for current year
  const budgetsList = await budgetService.list(req.tenantId);
  const activeBudget = budgetsList.find((b) => b.fiscalYear === year && b.isActive);
  if (!activeBudget) {
    res.json(null);
    return;
  }

  // MTD
  const mtdStart = `${year}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const mtdEnd = today.toISOString().split('T')[0]!;
  const mtdData = await budgetService.buildBudgetVsActual(req.tenantId, activeBudget.id, mtdStart, mtdEnd);

  // YTD
  const ytdStart = `${year}-01-01`;
  const ytdData = await budgetService.buildBudgetVsActual(req.tenantId, activeBudget.id, ytdStart, mtdEnd);

  res.json({
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
  });
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
