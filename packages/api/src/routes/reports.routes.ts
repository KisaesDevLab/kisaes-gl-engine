import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as reportService from '../services/report.service.js';
import * as exportService from '../services/report-export.service.js';
import * as comparisonService from '../services/report-comparison.service.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

// Format a number for export
function fmtNum(n: any): string {
  const v = parseFloat(n);
  return isNaN(v) ? '' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Build structured export rows that match on-screen display
function extractDataAndColumns(reportData: any): { rows: any[]; columns: Array<{ key: string; label: string }> } {
  // ─── Comparative reports (have columns + rows with values arrays) ───
  if (reportData.columns && reportData.rows && Array.isArray(reportData.columns)) {
    const cols = [
      { key: 'account', label: 'Account' },
      ...reportData.columns.map((c: any) => ({ key: c.label, label: c.label })),
    ];

    const rows: any[] = [];

    // Separate by accountType if present
    const revenueRows = reportData.rows.filter((r: any) => r.accountType === 'revenue');
    const expenseRows = reportData.rows.filter((r: any) => r.accountType === 'expense');
    const otherRows = reportData.rows.filter((r: any) => r.accountType !== 'revenue' && r.accountType !== 'expense');

    const mapRow = (r: any) => {
      const row: any = { account: r.accountNumber ? `${r.accountNumber} — ${r.account || r.name}` : (r.account || r.name) };
      (r.values || []).forEach((v: any, i: number) => { row[reportData.columns[i]?.label || `Col${i}`] = fmtNum(v); });
      return row;
    };
    const totalRow = (label: string, values: any[]) => {
      const row: any = { account: label };
      (values || []).forEach((v: any, i: number) => { row[reportData.columns[i]?.label || `Col${i}`] = fmtNum(v); });
      return row;
    };

    if (revenueRows.length) {
      rows.push({ account: '--- REVENUE ---' });
      rows.push(...revenueRows.map(mapRow));
      if (reportData.totalRevenue) rows.push(totalRow('Total Revenue', reportData.totalRevenue));
    }
    if (expenseRows.length) {
      rows.push({ account: '--- EXPENSES ---' });
      rows.push(...expenseRows.map(mapRow));
      if (reportData.totalExpenses) rows.push(totalRow('Total Expenses', reportData.totalExpenses));
    }
    if (otherRows.length) rows.push(...otherRows.map(mapRow));
    if (reportData.netIncome) rows.push(totalRow('Net Income', reportData.netIncome));

    // Comparative Balance Sheet
    if (reportData.assets && reportData.totalAssets) {
      const mapBSRow = (r: any) => {
        const row: any = { account: r.name };
        (r.values || []).forEach((v: any, i: number) => { row[reportData.columns[i]?.label || `Col${i}`] = fmtNum(v); });
        return row;
      };
      rows.length = 0;
      rows.push({ account: '--- ASSETS ---' });
      rows.push(...reportData.assets.map(mapBSRow));
      rows.push(totalRow('Total Assets', reportData.totalAssets));
      rows.push({ account: '--- LIABILITIES ---' });
      rows.push(...reportData.liabilities.map(mapBSRow));
      rows.push(totalRow('Total Liabilities', reportData.totalLiabilities));
      rows.push({ account: '--- EQUITY ---' });
      rows.push(...(reportData.equity || []).map(mapBSRow));
      rows.push(totalRow('Total Equity', reportData.totalEquity));
    }

    return { rows, columns: cols };
  }

  // ─── P&L (standard — has revenue + expenses arrays) ───
  if (reportData.revenue && reportData.expenses && !reportData.columns) {
    const columns = [
      { key: 'account', label: 'Account' },
      { key: 'amount', label: 'Amount' },
    ];
    const rows: any[] = [];
    rows.push({ account: '--- REVENUE ---', amount: '' });
    for (const r of reportData.revenue) {
      rows.push({ account: r.accountNumber ? `${r.accountNumber} — ${r.name}` : r.name, amount: fmtNum(r.amount) });
    }
    rows.push({ account: 'Total Revenue', amount: fmtNum(reportData.totalRevenue) });
    rows.push({ account: '', amount: '' });
    rows.push({ account: '--- EXPENSES ---', amount: '' });
    for (const e of reportData.expenses) {
      rows.push({ account: e.accountNumber ? `${e.accountNumber} — ${e.name}` : e.name, amount: fmtNum(e.amount) });
    }
    rows.push({ account: 'Total Expenses', amount: fmtNum(reportData.totalExpenses) });
    rows.push({ account: '', amount: '' });
    rows.push({ account: 'NET INCOME', amount: fmtNum(reportData.netIncome) });
    return { rows, columns };
  }

  // ─── Balance Sheet (standard — has assets + liabilities + equity arrays) ───
  if (reportData.assets && reportData.liabilities && !reportData.columns) {
    const columns = [
      { key: 'account', label: 'Account' },
      { key: 'balance', label: 'Balance' },
    ];
    const rows: any[] = [];
    rows.push({ account: '--- ASSETS ---', balance: '' });
    for (const a of reportData.assets) rows.push({ account: a.accountNumber ? `${a.accountNumber} — ${a.name}` : a.name, balance: fmtNum(Math.abs(a.balance)) });
    rows.push({ account: 'Total Assets', balance: fmtNum(reportData.totalAssets) });
    rows.push({ account: '', balance: '' });
    rows.push({ account: '--- LIABILITIES ---', balance: '' });
    for (const l of reportData.liabilities) rows.push({ account: l.accountNumber ? `${l.accountNumber} — ${l.name}` : l.name, balance: fmtNum(Math.abs(l.balance)) });
    rows.push({ account: 'Total Liabilities', balance: fmtNum(reportData.totalLiabilities) });
    rows.push({ account: '', balance: '' });
    rows.push({ account: '--- EQUITY ---', balance: '' });
    for (const e of (reportData.equity || [])) rows.push({ account: e.accountNumber ? `${e.accountNumber} — ${e.name}` : e.name, balance: fmtNum(Math.abs(e.balance)) });
    rows.push({ account: 'Total Equity', balance: fmtNum(reportData.totalEquity) });
    rows.push({ account: '', balance: '' });
    rows.push({ account: 'TOTAL LIABILITIES & EQUITY', balance: fmtNum(reportData.totalLiabilitiesAndEquity) });
    return { rows, columns };
  }

  // ─── Cash Flow (scalar values) ───
  if (reportData.operatingActivities !== undefined || reportData.netChange !== undefined) {
    const columns = [{ key: 'label', label: 'Item' }, { key: 'amount', label: 'Amount' }];
    const rows: any[] = [];
    if (reportData.operatingActivities !== undefined) rows.push({ label: 'Operating Activities', amount: fmtNum(reportData.operatingActivities) });
    if (reportData.investingActivities !== undefined) rows.push({ label: 'Investing Activities', amount: fmtNum(reportData.investingActivities) });
    if (reportData.financingActivities !== undefined) rows.push({ label: 'Financing Activities', amount: fmtNum(reportData.financingActivities) });
    if (reportData.netChange !== undefined) rows.push({ label: 'Net Change in Cash', amount: fmtNum(reportData.netChange) });
    if (reportData.beginningCash !== undefined) rows.push({ label: 'Beginning Cash', amount: fmtNum(reportData.beginningCash) });
    if (reportData.endingCash !== undefined) rows.push({ label: 'Ending Cash', amount: fmtNum(reportData.endingCash) });
    return { rows, columns };
  }

  // ─── Generic data array (trial balance, general ledger, etc.) ───
  let rows: any[] = reportData.data || reportData.rows || [];
  if (!rows.length) return { rows: [], columns: [] };

  // Auto-detect columns
  const sample = rows[0];
  const skipKeys = new Set(['id', 'accountId', 'account_id']);
  const columns = Object.keys(sample)
    .filter((k) => !skipKeys.has(k) && typeof sample[k] !== 'object')
    .map((k) => ({
      key: k,
      label: k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()),
    }));

  // Append totals if present
  if (reportData.totalDebits !== undefined) {
    const totalRow: any = {};
    columns.forEach((c) => { totalRow[c.key] = ''; });
    const nameCol = columns.find((c) => c.key === 'name' || c.key === 'account_number');
    if (nameCol) totalRow[nameCol.key] = 'TOTALS';
    const debitCol = columns.find((c) => c.key === 'total_debit');
    const creditCol = columns.find((c) => c.key === 'total_credit');
    if (debitCol) totalRow[debitCol.key] = reportData.totalDebits;
    if (creditCol) totalRow[creditCol.key] = reportData.totalCredits;
    rows = [...rows, totalRow];
  }

  return { rows, columns };
}

function buildHtmlTable(rows: any[], columns: Array<{ key: string; label: string }>): string {
  if (!rows.length) return '<p>No data</p>';
  const header = columns.map((c) => `<th>${c.label}</th>`).join('');
  const body = rows.map((row) => {
    const firstKey = columns[0]?.key;
    const firstVal = firstKey ? row[firstKey] : undefined;
    const isSectionHeader = typeof firstVal === 'string' && firstVal.startsWith('---');
    const isTotalRow = typeof firstVal === 'string' && (firstVal.startsWith('Total') || firstVal.startsWith('TOTAL') || firstVal === 'NET INCOME');
    const cells = columns.map((c) => {
      let val = row[c.key];
      if (typeof val === 'string' && val.startsWith('---')) val = val.replace(/^---\s*|\s*---$/g, '');
      const isNum = typeof val === 'number';
      return `<td${isNum ? ' class="amount"' : ''}>${val !== null && val !== undefined ? (isNum ? fmtNum(val) : val) : ''}</td>`;
    }).join('');
    if (isSectionHeader) return `<tr style="background:#f3f4f6;font-weight:600">${cells}</tr>`;
    if (isTotalRow) return `<tr class="total-row" style="font-weight:700;border-top:2px solid #111">${cells}</tr>`;
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

// Helper: respond with json, csv, or pdf
async function respond(res: any, reportData: any, format: string | undefined) {
  if (format === 'csv') {
    const { rows, columns } = extractDataAndColumns(reportData);
    if (!rows.length) { res.status(404).json({ error: { message: 'No data to export' } }); return; }
    const csv = exportService.toCsv(rows, columns);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${(reportData.title || 'report').replace(/\s+/g, '_')}.csv"`);
    return res.send(csv);
  }
  if (format === 'pdf') {
    const { rows, columns } = extractDataAndColumns(reportData);
    const dateLabel = reportData.startDate && reportData.endDate
      ? `${reportData.startDate} to ${reportData.endDate}`
      : reportData.asOfDate ? `As of ${reportData.asOfDate}` : '';
    const tableHtml = buildHtmlTable(rows, columns);

    // Get company name scoped to tenant
    let companyName = 'Company';
    try {
      const { db } = await import('../db/index.js');
      const { sql } = await import('drizzle-orm');
      const result = await db.execute(sql`SELECT business_name FROM companies WHERE tenant_id = ${res.req.tenantId} LIMIT 1`);
      companyName = (result.rows as any[])[0]?.business_name || 'Company';
    } catch { /* use default */ }

    const html = exportService.toReportHtml(reportData.title || 'Report', companyName, dateLabel, tableHtml);
    const pdf = await exportService.toPdf(html);
    res.setHeader('Content-Type', pdf[0] === 0x3c ? 'text/html' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(reportData.title || 'report').replace(/\s+/g, '_')}.pdf"`);
    return res.send(pdf);
  }
  res.json(reportData);
}

// Financial Statements
reportsRouter.get('/profit-loss', async (req, res) => {
  const { start_date, end_date, basis, format, compare, periods, period_type } = req.query as Record<string, string>;
  const today = new Date();
  const sd = start_date || `${today.getFullYear()}-01-01`;
  const ed = end_date || today.toISOString().split('T')[0]!;
  const b = (basis as 'cash' | 'accrual') || 'accrual';

  if (compare) {
    const data = await comparisonService.buildComparativePL(
      req.tenantId, sd, ed, b,
      compare as any,
      parseInt(periods || '6'),
      (period_type as any) || 'month',
    );
    await respond(res, data, format);
  } else {
    const data = await reportService.buildProfitAndLoss(req.tenantId, sd, ed, b);
    await respond(res, data, format);
  }
});

reportsRouter.get('/balance-sheet', async (req, res) => {
  const { as_of_date, basis, format, compare } = req.query as Record<string, string>;
  if (compare) {
    const data = await comparisonService.buildComparativeBS(
      req.tenantId,
      as_of_date || new Date().toISOString().split('T')[0]!,
      (basis as 'cash' | 'accrual') || 'accrual',
      compare as any,
    );
    await respond(res, data, format);
    return;
  }
  const data = await reportService.buildBalanceSheet(
    req.tenantId,
    as_of_date || new Date().toISOString().split('T')[0]!,
    (basis as 'cash' | 'accrual') || 'accrual',
  );
  await respond(res, data, format);
});

reportsRouter.get('/cash-flow', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildCashFlowStatement(
    req.tenantId,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
  );
  await respond(res, data, format);
});

// Receivables
reportsRouter.get('/ar-aging-summary', async (req, res) => {
  const { as_of_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildARAgingSummary(req.tenantId, as_of_date || new Date().toISOString().split('T')[0]!);
  await respond(res, data, format);
});

reportsRouter.get('/ar-aging-detail', async (req, res) => {
  const { as_of_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildARAgingDetail(req.tenantId, as_of_date || new Date().toISOString().split('T')[0]!);
  await respond(res, data, format);
});

reportsRouter.get('/customer-balance-summary', async (req, res) => {
  const data = await reportService.buildCustomerBalanceSummary(req.tenantId);
  await respond(res, data, req.query['format'] as string);
});

reportsRouter.get('/customer-balance-detail', async (req, res) => {
  const data = await reportService.buildCustomerBalanceDetail(req.tenantId);
  await respond(res, data, req.query['format'] as string);
});

reportsRouter.get('/invoice-list', async (req, res) => {
  const { start_date, end_date, status, format } = req.query as Record<string, string>;
  const data = await reportService.buildInvoiceList(req.tenantId, { startDate: start_date, endDate: end_date, status });
  await respond(res, data, format);
});

// Expenses
reportsRouter.get('/expense-by-vendor', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildExpenseByVendor(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!);
  await respond(res, data, format);
});

reportsRouter.get('/expense-by-category', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildExpenseByCategory(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!);
  await respond(res, data, format);
});

reportsRouter.get('/vendor-balance-summary', async (req, res) => {
  const data = await reportService.buildVendorBalanceSummary(req.tenantId);
  await respond(res, data, req.query['format'] as string);
});

reportsRouter.get('/transaction-list-by-vendor', async (req, res) => {
  const { vendor_id, start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildTransactionListByVendor(req.tenantId, vendor_id || '', { startDate: start_date, endDate: end_date });
  await respond(res, data, format);
});

// Banking
reportsRouter.get('/bank-reconciliation-summary', async (req, res) => {
  const data = await reportService.buildBankReconciliationSummary(req.tenantId, (req.query['account_id'] as string) || '');
  await respond(res, data, req.query['format'] as string);
});

reportsRouter.get('/deposit-detail', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildDepositDetail(req.tenantId, { startDate: start_date, endDate: end_date });
  await respond(res, data, format);
});

reportsRouter.get('/check-register', async (req, res) => {
  const { account_id, start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildCheckRegister(req.tenantId, account_id || '', { startDate: start_date, endDate: end_date });
  await respond(res, data, format);
});

// Tax
reportsRouter.get('/sales-tax-liability', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildSalesTaxLiability(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!);
  await respond(res, data, format);
});

reportsRouter.get('/taxable-sales-summary', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildTaxableSalesSummary(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!);
  await respond(res, data, format);
});

reportsRouter.get('/sales-tax-payments', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildSalesTaxPayments(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!);
  await respond(res, data, format);
});

reportsRouter.get('/vendor-1099-summary', async (req, res) => {
  const { year, format } = req.query as Record<string, string>;
  const data = await reportService.build1099VendorSummary(req.tenantId, year || String(new Date().getFullYear()));
  await respond(res, data, format);
});

// General
reportsRouter.get('/general-ledger', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildGeneralLedger(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!);
  await respond(res, data, format);
});

reportsRouter.get('/trial-balance', async (req, res) => {
  const { start_date, end_date, as_of_date, format } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const data = await reportService.buildTrialBalance(
    req.tenantId,
    start_date || `${year}-01-01`,
    end_date || as_of_date || today,
  );
  await respond(res, data, format);
});

reportsRouter.get('/transaction-list', async (req, res) => {
  const { start_date, end_date, txn_type, account_id, format } = req.query as Record<string, string>;
  const data = await reportService.buildTransactionList(req.tenantId, { startDate: start_date, endDate: end_date, txnType: txn_type, accountId: account_id });
  await respond(res, data, format);
});

reportsRouter.get('/journal-entry-report', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildJournalEntryReport(req.tenantId, { startDate: start_date, endDate: end_date });
  await respond(res, data, format);
});

reportsRouter.get('/account-report', async (req, res) => {
  const { account_id, start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildAccountReport(req.tenantId, account_id || '', { startDate: start_date, endDate: end_date });
  await respond(res, data, format);
});
