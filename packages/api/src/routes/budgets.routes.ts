// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import * as budgetService from '../services/budget.service.js';

export const budgetsRouter = Router();
budgetsRouter.use(authenticate);
budgetsRouter.use(requireResource('budgets'));

budgetsRouter.get('/', async (req, res) => {
  const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
  const offset = req.query['offset'] ? Number(req.query['offset']) : undefined;
  const result = await budgetService.list(req.tenantId, { limit, offset });
  // Legacy shape `{ budgets }` preserved for existing callers; new
  // pagination metadata added alongside.
  res.json({ budgets: result.data, total: result.total, limit: result.limit, offset: result.offset });
});

budgetsRouter.post('/', async (req, res) => {
  const budget = await budgetService.create(req.tenantId, req.body, req.userId);
  res.status(201).json({ budget });
});

budgetsRouter.get('/:id', async (req, res) => {
  const budget = await budgetService.getById(req.tenantId, req.params['id']!);
  res.json({ budget });
});

budgetsRouter.put('/:id', async (req, res) => {
  const budget = await budgetService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ budget });
});

budgetsRouter.delete('/:id', async (req, res) => {
  await budgetService.remove(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Budget deleted' });
});

budgetsRouter.get('/:id/lines', async (req, res) => {
  const lines = await budgetService.getLines(req.tenantId, req.params['id']!);
  res.json({ lines });
});

budgetsRouter.put('/:id/lines', async (req, res) => {
  await budgetService.updateLines(req.tenantId, req.params['id']!, req.body.lines);
  res.json({ message: 'Lines saved' });
});

budgetsRouter.post('/:id/fill-from-actuals', async (req, res) => {
  await budgetService.fillFromActuals(req.tenantId, req.params['id']!);
  res.json({ message: 'Filled from actuals' });
});

budgetsRouter.post('/:id/copy-from/:sourceId', async (req, res) => {
  await budgetService.copyFromBudget(req.tenantId, req.params['id']!, req.params['sourceId']!);
  res.json({ message: 'Copied from source budget' });
});

budgetsRouter.post('/:id/adjust-by-percent', async (req, res) => {
  const { percent } = req.body;
  await budgetService.adjustByPercent(req.tenantId, req.params['id']!, Number(percent));
  res.json({ message: 'Adjustment applied' });
});

budgetsRouter.get('/:id/vs-actual', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await budgetService.buildBudgetVsActual(
    req.tenantId, req.params['id']!,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
  );

  if (format === 'csv' || format === 'pdf') {
    // Build export rows
    const fmtN = (n: any) => { const v = parseFloat(n); return isNaN(v) ? '' : v.toFixed(2); };
    const fmtP = (n: any) => { if (n === null || n === undefined || !isFinite(n)) return ''; return `${n >= 0 ? '+' : ''}${parseFloat(n).toFixed(1)}%`; };
    const columns = [
      { key: 'account', label: 'Account' },
      { key: 'budget', label: 'Budget' },
      { key: 'actual', label: 'Actual' },
      { key: 'variance', label: '$ Variance' },
      { key: 'pct', label: '% Variance' },
    ];
    // Row shape used by both PDF export and the HTML table generator
    // downstream. Includes the index signature because the HTML helper
    // does dynamic key lookups against the `columns` map above; without
    // it TS complains on `row[col.key]` access in the body builder.
    interface VarianceRow {
      _section?: boolean;
      _total?: boolean;
      account: string;
      budget: string;
      actual: string;
      variance: string;
      pct: string;
      [key: string]: unknown;
    }
    interface VarianceDetail {
      accountName: string;
      budget: number | string;
      actual: number | string;
      varianceDollar: number | string;
      // The aggregator emits `null` when the budget is zero (% is
      // undefined in that case); the formatter handles null safely.
      variancePercent: number | string | null;
    }
    const rows: VarianceRow[] = [];
    const section = (label: string) => rows.push({ _section: true, account: label, budget: '', actual: '', variance: '', pct: '' });
    const detailRow = (r: VarianceDetail) => rows.push({
      account: r.accountName,
      budget: fmtN(r.budget),
      actual: fmtN(r.actual),
      variance: fmtN(r.varianceDollar),
      pct: fmtP(r.variancePercent),
    });
    const totalRow = (label: string, budget: number, actual: number) => rows.push({
      _total: true,
      account: label,
      budget: fmtN(budget),
      actual: fmtN(actual),
      variance: fmtN(actual - budget),
      pct: '',
    });

    const hasCogs = (data.cogs?.length ?? 0) > 0;
    const hasOtherRev = (data.otherRevenue?.length ?? 0) > 0;
    const hasOtherExp = (data.otherExpenses?.length ?? 0) > 0;

    const L = (data as any).labels as import('@kis-books/shared').PLSectionLabels | undefined;
    const revenueLabel = L?.revenue || 'Revenue';
    const cogsLabel = L?.cogs || 'Cost of Goods Sold';
    const grossProfitLabel = L?.grossProfit || 'Gross Profit';
    const expensesLabel = L?.expenses || 'Expenses';
    const otherRevenueLabel = L?.otherRevenue || 'Other Revenue';
    const otherExpensesLabel = L?.otherExpenses || 'Other Expenses';
    const netIncomeLabel = L?.netIncome || 'Net Income';

    section(`--- ${revenueLabel.toUpperCase()} ---`);
    for (const r of data.revenue) detailRow(r);
    totalRow(`Total ${revenueLabel}`, data.totalRevenueBudget, data.totalRevenueActual);

    if (hasCogs) {
      section(`--- ${cogsLabel.toUpperCase()} ---`);
      for (const r of data.cogs) detailRow(r);
      totalRow(`Total ${cogsLabel}`, data.totalCogsBudget, data.totalCogsActual);
      totalRow(grossProfitLabel,
        data.totalRevenueBudget - data.totalCogsBudget,
        data.totalRevenueActual - data.totalCogsActual);
    }

    section(`--- ${expensesLabel.toUpperCase()} ---`);
    for (const e of data.expenses) detailRow(e);
    totalRow(`Total ${expensesLabel}`, data.totalExpenseBudget, data.totalExpenseActual);

    if (hasOtherRev) {
      section(`--- ${otherRevenueLabel.toUpperCase()} ---`);
      for (const r of data.otherRevenue) detailRow(r);
      totalRow(`Total ${otherRevenueLabel}`, data.totalOtherRevenueBudget, data.totalOtherRevenueActual);
    }

    if (hasOtherExp) {
      section(`--- ${otherExpensesLabel.toUpperCase()} ---`);
      for (const r of data.otherExpenses) detailRow(r);
      totalRow(`Total ${otherExpensesLabel}`, data.totalOtherExpenseBudget, data.totalOtherExpenseActual);
    }

    totalRow(netIncomeLabel.toUpperCase(), data.netIncomeBudget, data.netIncomeActual);

    if (format === 'csv') {
      const { toCsv } = await import('../services/report-export.service.js');
      const csv = toCsv(rows, columns);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="Budget_vs_Actual.csv"');
      return res.send(csv);
    }
    // PDF
    const { toReportHtml, toPdf, escapeHtml } = await import('../services/report-export.service.js');
    const header = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
    const body = rows.map((r) => {
      const first = r.account;
      const style = r._section ? ' style="background:#f3f4f6;font-weight:600"' : r._total ? ' style="font-weight:700;border-top:2px solid #111"' : '';
      return `<tr${style}>${columns.map((c) => {
        const val = r._section && c.key === 'account'
          ? first.replace(/^---\s*|\s*---$/g, '')
          : r[c.key];
        return `<td${c.key !== 'account' ? ' class="amount"' : ''}>${escapeHtml(val || '')}</td>`;
      }).join('')}</tr>`;
    }).join('');
    const tableHtml = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
    const html = toReportHtml(data.title || 'Budget vs Actual', 'Company', `${data.startDate} to ${data.endDate}`, tableHtml);
    const pdf = await toPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Budget_vs_Actual.pdf"');
    return res.send(pdf);
  }

  res.json(data);
});

budgetsRouter.get('/:id/overview', async (req, res) => {
  const data = await budgetService.buildBudgetOverview(req.tenantId, req.params['id']!);
  res.json(data);
});

// ADR 0XW — tag-scoped Budget vs. Actuals. Respects the budget's tag_id
// scope when aggregating actuals from journal_lines. Requires the
// TAG_BUDGETS_V1 env flag to be enabled. Returns a per-account,
// per-month matrix with variances.
budgetsRouter.get('/:id/tag-actuals', async (req, res) => {
  const data = await budgetService.runTagScopedBudgetVsActuals(
    req.tenantId,
    req.params['id']!,
    req.companyId ?? null,
  );
  res.json(data);
});
