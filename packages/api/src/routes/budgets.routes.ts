import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as budgetService from '../services/budget.service.js';

export const budgetsRouter = Router();
budgetsRouter.use(authenticate);

budgetsRouter.get('/', async (req, res) => {
  const budgets = await budgetService.list(req.tenantId);
  res.json({ budgets });
});

budgetsRouter.post('/', async (req, res) => {
  const budget = await budgetService.create(req.tenantId, req.body);
  res.status(201).json({ budget });
});

budgetsRouter.get('/:id', async (req, res) => {
  const budget = await budgetService.getById(req.tenantId, req.params['id']!);
  res.json({ budget });
});

budgetsRouter.put('/:id', async (req, res) => {
  const budget = await budgetService.update(req.tenantId, req.params['id']!, req.body);
  res.json({ budget });
});

budgetsRouter.delete('/:id', async (req, res) => {
  await budgetService.remove(req.tenantId, req.params['id']!);
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
    const rows: any[] = [];
    rows.push({ account: '--- REVENUE ---', budget: '', actual: '', variance: '', pct: '' });
    for (const r of data.revenue) rows.push({ account: r.accountName, budget: fmtN(r.budget), actual: fmtN(r.actual), variance: fmtN(r.varianceDollar), pct: fmtP(r.variancePercent) });
    rows.push({ account: 'Total Revenue', budget: fmtN(data.totalRevenueBudget), actual: fmtN(data.totalRevenueActual), variance: fmtN(data.totalRevenueActual - data.totalRevenueBudget), pct: '' });
    rows.push({ account: '--- EXPENSES ---', budget: '', actual: '', variance: '', pct: '' });
    for (const e of data.expenses) rows.push({ account: e.accountName, budget: fmtN(e.budget), actual: fmtN(e.actual), variance: fmtN(e.varianceDollar), pct: fmtP(e.variancePercent) });
    rows.push({ account: 'Total Expenses', budget: fmtN(data.totalExpenseBudget), actual: fmtN(data.totalExpenseActual), variance: fmtN(data.totalExpenseActual - data.totalExpenseBudget), pct: '' });
    rows.push({ account: 'NET INCOME', budget: fmtN(data.netIncomeBudget), actual: fmtN(data.netIncomeActual), variance: fmtN(data.netIncomeActual - data.netIncomeBudget), pct: '' });

    if (format === 'csv') {
      const { toCsv } = await import('../services/report-export.service.js');
      const csv = toCsv(rows, columns);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="Budget_vs_Actual.csv"');
      return res.send(csv);
    }
    // PDF
    const { toReportHtml, toPdf } = await import('../services/report-export.service.js');
    const header = columns.map((c) => `<th>${c.label}</th>`).join('');
    const body = rows.map((r) => {
      const first = r.account;
      const isSection = typeof first === 'string' && first.startsWith('---');
      const isTotal = typeof first === 'string' && (first.startsWith('Total') || first === 'NET INCOME');
      const style = isSection ? ' style="background:#f3f4f6;font-weight:600"' : isTotal ? ' style="font-weight:700;border-top:2px solid #111"' : '';
      return `<tr${style}>${columns.map((c) => `<td${c.key !== 'account' ? ' class="amount"' : ''}>${(isSection ? first.replace(/^---\s*|\s*---$/g, '') : r[c.key]) || ''}</td>`).join('')}</tr>`;
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
