// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router, type Request } from 'express';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import * as reportService from '../services/report.service.js';
import * as apReportService from '../services/ap-report.service.js';
import * as exportService from '../services/report-export.service.js';
import * as comparisonService from '../services/report-comparison.service.js';

// Build-plan Phase 5 cache-invalidation hook. We don't run a Redis
// report cache today, but clients may cache report responses locally
// (service workers, HTTP caches, in-memory React Query entries).
// Incrementing this value on a schema-shape change invalidates every
// downstream cache in one step; new clients read the header and throw
// away any locally cached response whose version doesn't match.
//
// Bump on:
//   - any change to the report response JSON shape
//   - any change to tag-filter aggregation semantics
//   - any migration that alters what splits/lines the reports observe
//
// Format: monotonic integer as a string; clients compare by equality.
export const REPORT_SCHEMA_VERSION = '2';

export const reportsRouter = Router();
reportsRouter.use(authenticate);
reportsRouter.use(companyContext);
reportsRouter.use(expensiveOpLimiter);
reportsRouter.use((_req, res, next) => {
  res.setHeader('X-Report-Schema-Version', REPORT_SCHEMA_VERSION);
  next();
});

function resolveCompanyScope(req: Request): string | null {
  const scope = req.query['scope'] as string | undefined;
  if (scope === 'consolidated') return null;
  return req.companyId;
}

// Format a number for export
function fmtNum(n: any): string {
  const v = parseFloat(n);
  return isNaN(v) ? '' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Friendly transaction type abbreviations used in CSV / PDF exports.
// Mirrors the TXN_TYPE_LABELS map in
// packages/web/src/features/reports/GeneralLedgerReport.tsx — keep these
// two in sync. (They're not yet in @kis-books/shared because the backend
// only needs them for export rendering, not for any business logic.)
const TXN_TYPE_LABELS: Record<string, string> = {
  invoice: 'INV',
  customer_payment: 'PMT',
  cash_sale: 'SALE',
  expense: 'CHK',
  deposit: 'DEP',
  transfer: 'XFR',
  journal_entry: 'JE',
  credit_memo: 'CM',
  customer_refund: 'REF',
  bill: 'BILL',
  bill_payment: 'BP',
  vendor_credit: 'VC',
};
function fmtTxnType(t: string | null | undefined): string {
  if (!t) return '';
  return TXN_TYPE_LABELS[t] || t.toUpperCase();
}

// Column metadata for the export helpers.
//   - `align`  controls text-align in the rendered HTML/PDF cell.
//              Right-aligned columns get the `.amount` class which the
//              embedded report stylesheet styles as monospace + right.
//   - `width`  is a CSS width string (e.g., '72px') applied to <th> and
//              <td> in the rendered table. Columns without an explicit
//              width auto-size, so a flex column like Description gets
//              the leftover space.
type ExportColumn = { key: string; label: string; align?: 'left' | 'right'; width?: string };

// Optional per-row rendering directives. A row that sets `_section: true`
// is rendered as a single cell spanning the full table (gray header band)
// using the `_label` field as the text. A row that sets `_summary: true`
// keeps its normal column cells but is styled bold + tinted to mark it
// as a subtotal / beginning / ending balance. Both fields are stripped
// from CSV export because CSV is column-oriented and doesn't have a
// concept of colspan rows — for CSV the row is rendered using its
// regular column keys, so put the label in one of the regular columns
// too if you want it to appear in the spreadsheet output.
type ExportRow = Record<string, unknown> & {
  _section?: boolean;
  _summary?: boolean;
  _total?: boolean;
  _label?: string;
};

// Build structured export rows that match on-screen display
function extractDataAndColumns(reportData: any): { rows: any[]; columns: ExportColumn[] } {
  // ─── Comparative reports (have columns + rows with values arrays) ───
  if (reportData.columns && reportData.rows && Array.isArray(reportData.columns)) {
    const cols: ExportColumn[] = [
      { key: 'account', label: 'Account' },
      ...reportData.columns.map((c: any) => ({ key: c.label, label: c.label, align: 'right' as const })),
    ];

    const rows: any[] = [];

    const rowsByType = (t: string) => reportData.rows.filter((r: any) => r.accountType === t);
    const revenueRows = rowsByType('revenue');
    const cogsRows = rowsByType('cogs');
    const expenseRows = rowsByType('expense');
    const otherRevenueRows = rowsByType('other_revenue');
    const otherExpenseRows = rowsByType('other_expense');
    const L = reportData.labels as import('@kis-books/shared').PLSectionLabels | undefined;
    const lab = (k: keyof import('@kis-books/shared').PLSectionLabels, fallback: string) =>
      L?.[k] || fallback;

    const mapRow = (r: any) => {
      const row: any = { account: r.accountNumber ? `${r.accountNumber} — ${r.account || r.name}` : (r.account || r.name) };
      (r.values || []).forEach((v: any, i: number) => { row[reportData.columns[i]?.label || `Col${i}`] = fmtNum(v); });
      return row;
    };
    const totalRow = (label: string, values: any[]) => {
      const row: any = { _total: true, account: label };
      (values || []).forEach((v: any, i: number) => { row[reportData.columns[i]?.label || `Col${i}`] = fmtNum(v); });
      return row;
    };
    // Build a subtotal row "a − b" across all period columns. Handles
    // comparative report column shapes (current / prior / $ change /
    // % change) correctly — percent columns are re-derived from the new
    // current/prior rather than naively subtracting source percents.
    const zipSubtract = (a: number[], b: number[]) => {
      const base = (a || []).map((v, i) =>
        reportData.columns[i]?.type === 'percent_variance'
          ? null
          : (v ?? 0) - (b?.[i] ?? 0),
      );
      for (let i = 0; i < base.length; i++) {
        const col = reportData.columns[i];
        if (col?.type === 'variance') {
          base[i] = (base[0] ?? 0) - (base[1] ?? 0);
        } else if (col?.type === 'percent_variance') {
          const cur = base[0] ?? 0;
          const pr = base[1] ?? 0;
          base[i] = pr === 0 ? null : ((cur - pr) / Math.abs(pr)) * 100;
        }
      }
      return base;
    };

    const hasCogs = cogsRows.length > 0;
    const hasOtherRev = otherRevenueRows.length > 0;
    const hasOtherExp = otherExpenseRows.length > 0;
    const showOperatingIncome = hasCogs || hasOtherRev || hasOtherExp;

    const revenueLabel = lab('revenue', 'Revenue');
    const cogsLabel = lab('cogs', 'Cost of Goods Sold');
    const grossProfitLabel = lab('grossProfit', 'Gross Profit');
    const expensesLabel = lab('expenses', 'Expenses');
    const operatingIncomeLabel = lab('operatingIncome', 'Operating Income');
    const otherRevenueLabel = lab('otherRevenue', 'Other Revenue');
    const otherExpensesLabel = lab('otherExpenses', 'Other Expenses');
    const netIncomeLabel = lab('netIncome', 'Net Income');

    if (revenueRows.length) {
      rows.push({ account: `--- ${revenueLabel.toUpperCase()} ---` });
      rows.push(...revenueRows.map(mapRow));
      if (reportData.totalRevenue) rows.push(totalRow(`Total ${revenueLabel}`, reportData.totalRevenue));
    }
    if (hasCogs) {
      rows.push({ account: `--- ${cogsLabel.toUpperCase()} ---` });
      rows.push(...cogsRows.map(mapRow));
      if (reportData.totalCogs) rows.push(totalRow(`Total ${cogsLabel}`, reportData.totalCogs));
      rows.push(totalRow(grossProfitLabel, zipSubtract(reportData.totalRevenue, reportData.totalCogs)));
    }
    if (expenseRows.length) {
      rows.push({ account: `--- ${expensesLabel.toUpperCase()} ---` });
      rows.push(...expenseRows.map(mapRow));
      if (reportData.totalExpenses) rows.push(totalRow(`Total ${expensesLabel}`, reportData.totalExpenses));
    }
    if (showOperatingIncome) {
      const gp = hasCogs ? zipSubtract(reportData.totalRevenue, reportData.totalCogs) : reportData.totalRevenue;
      rows.push(totalRow(operatingIncomeLabel, zipSubtract(gp, reportData.totalExpenses)));
    }
    if (hasOtherRev) {
      rows.push({ account: `--- ${otherRevenueLabel.toUpperCase()} ---` });
      rows.push(...otherRevenueRows.map(mapRow));
      if (reportData.totalOtherRevenue) rows.push(totalRow(`Total ${otherRevenueLabel}`, reportData.totalOtherRevenue));
    }
    if (hasOtherExp) {
      rows.push({ account: `--- ${otherExpensesLabel.toUpperCase()} ---` });
      rows.push(...otherExpenseRows.map(mapRow));
      if (reportData.totalOtherExpenses) rows.push(totalRow(`Total ${otherExpensesLabel}`, reportData.totalOtherExpenses));
    }
    if (reportData.netIncome) rows.push(totalRow(netIncomeLabel, reportData.netIncome));

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
    const columns: ExportColumn[] = [
      { key: 'account', label: 'Account' },
      { key: 'amount', label: 'Amount', align: 'right' },
    ];
    const rows: any[] = [];
    const line = (account: string, amount: any = '') => rows.push({ account, amount });
    const totalLine = (account: string, amount: any = '') => rows.push({ _total: true, account, amount });
    const accountLine = (entry: any) => line(
      entry.accountNumber ? `${entry.accountNumber} — ${entry.name}` : entry.name,
      fmtNum(entry.amount),
    );

    const hasCogs = (reportData.cogs?.length ?? 0) > 0;
    const hasOtherRev = (reportData.otherRevenue?.length ?? 0) > 0;
    const hasOtherExp = (reportData.otherExpenses?.length ?? 0) > 0;
    const showOperatingIncome = hasCogs || hasOtherRev || hasOtherExp;

    const L = reportData.labels as import('@kis-books/shared').PLSectionLabels | undefined;
    const revenueLabel = L?.revenue || 'Revenue';
    const cogsLabel = L?.cogs || 'Cost of Goods Sold';
    const grossProfitLabel = L?.grossProfit || 'Gross Profit';
    const expensesLabel = L?.expenses || 'Expenses';
    const operatingIncomeLabel = L?.operatingIncome || 'Operating Income';
    const otherRevenueLabel = L?.otherRevenue || 'Other Revenue';
    const otherExpensesLabel = L?.otherExpenses || 'Other Expenses';
    const netIncomeLabel = L?.netIncome || 'Net Income';

    line(`--- ${revenueLabel.toUpperCase()} ---`);
    for (const r of reportData.revenue) accountLine(r);
    totalLine(`Total ${revenueLabel}`, fmtNum(reportData.totalRevenue));
    line('');

    if (hasCogs) {
      line(`--- ${cogsLabel.toUpperCase()} ---`);
      for (const r of reportData.cogs) accountLine(r);
      totalLine(`Total ${cogsLabel}`, fmtNum(reportData.totalCogs));
      totalLine(grossProfitLabel, fmtNum(reportData.grossProfit ?? 0));
      line('');
    }

    line(`--- ${expensesLabel.toUpperCase()} ---`);
    for (const e of reportData.expenses) accountLine(e);
    totalLine(`Total ${expensesLabel}`, fmtNum(reportData.totalExpenses));
    line('');

    if (showOperatingIncome) {
      totalLine(operatingIncomeLabel, fmtNum(reportData.operatingIncome ?? 0));
      line('');
    }

    if (hasOtherRev) {
      line(`--- ${otherRevenueLabel.toUpperCase()} ---`);
      for (const r of reportData.otherRevenue) accountLine(r);
      totalLine(`Total ${otherRevenueLabel}`, fmtNum(reportData.totalOtherRevenue));
      line('');
    }

    if (hasOtherExp) {
      line(`--- ${otherExpensesLabel.toUpperCase()} ---`);
      for (const r of reportData.otherExpenses) accountLine(r);
      totalLine(`Total ${otherExpensesLabel}`, fmtNum(reportData.totalOtherExpenses));
      line('');
    }

    totalLine(netIncomeLabel.toUpperCase(), fmtNum(reportData.netIncome));
    return { rows, columns };
  }

  // ─── Balance Sheet (standard — has assets + liabilities + equity arrays) ───
  if (reportData.assets && reportData.liabilities && !reportData.columns) {
    const columns: ExportColumn[] = [
      { key: 'account', label: 'Account' },
      { key: 'balance', label: 'Balance', align: 'right' },
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

  // ─── General Ledger (grouped by account) ───
  // Detected by the presence of `accounts` array where each entry has a
  // `lines` array — that's our new GL shape from buildGeneralLedger.
  if (Array.isArray(reportData.accounts) && reportData.accounts[0]?.lines !== undefined) {
    // Explicit column widths so the Date column doesn't expand to fit
    // the longest section-header label. The Description column is the
    // only flex column — it takes the remaining horizontal space.
    const columns: ExportColumn[] = [
      { key: 'date', label: 'Date', width: '72px' },
      { key: 'type', label: 'Type', width: '52px' },
      { key: 'ref', label: 'Ref', width: '64px' },
      { key: 'name', label: 'Name', width: '160px' },
      { key: 'description', label: 'Description' },
      { key: 'debit', label: 'Debit', align: 'right', width: '92px' },
      { key: 'credit', label: 'Credit', align: 'right', width: '92px' },
      { key: 'balance', label: 'Balance', align: 'right', width: '100px' },
    ];
    const rows: ExportRow[] = [];
    for (const acct of reportData.accounts as any[]) {
      const acctLabel = `${acct.accountNumber || ''} ${acct.name}`.trim();
      const sectionLabel = `${acctLabel} (${acct.accountType})`;

      // Section header: spans the full table via colspan in PDF, and
      // also lands in the Description column so CSV (which is column-
      // oriented and has no concept of colspan) still shows it.
      rows.push({
        _section: true,
        _label: sectionLabel,
        date: '', type: '', ref: '', name: '',
        description: sectionLabel,
        debit: '', credit: '', balance: '',
      });

      // Beginning balance row — labeled in the Description column so the
      // narrow Date column doesn't have to widen to fit "Beginning balance".
      rows.push({
        _summary: true,
        date: '', type: '', ref: '', name: '',
        description: 'Beginning balance',
        debit: '', credit: '',
        balance: fmtNum(acct.beginningBalance),
      });

      // Activity rows — txn type rendered as friendly abbreviation
      // (CHK / PMT / SALE / etc.) to match the on-screen view.
      for (const line of acct.lines as any[]) {
        rows.push({
          date: line.date,
          type: fmtTxnType(line.txnType),
          ref: line.txnNumber || '',
          name: line.contactName || '',
          description: line.description || '',
          debit: line.debit ? fmtNum(line.debit) : '',
          credit: line.credit ? fmtNum(line.credit) : '',
          balance: fmtNum(line.runningBalance),
        });
      }

      // Period total — label in Description, money in their columns.
      rows.push({
        _summary: true,
        date: '', type: '', ref: '', name: '',
        description: 'Total period activity',
        debit: fmtNum(acct.periodDebits),
        credit: fmtNum(acct.periodCredits),
        balance: '',
      });

      // Ending balance — same shape as beginning.
      rows.push({
        _summary: true,
        date: '', type: '', ref: '', name: '',
        description: 'Ending balance',
        debit: '', credit: '',
        balance: fmtNum(acct.endingBalance),
      });

      // Spacer row between accounts
      rows.push({ date: '', type: '', ref: '', name: '', description: '', debit: '', credit: '', balance: '' });
    }
    return { rows, columns };
  }

  // ─── Cash Flow (scalar values) ───
  if (reportData.operatingActivities !== undefined || reportData.netChange !== undefined) {
    const columns: ExportColumn[] = [{ key: 'label', label: 'Item' }, { key: 'amount', label: 'Amount', align: 'right' }];
    const rows: any[] = [];
    if (reportData.operatingActivities !== undefined) rows.push({ label: 'Operating Activities', amount: fmtNum(reportData.operatingActivities) });
    if (reportData.investingActivities !== undefined) rows.push({ label: 'Investing Activities', amount: fmtNum(reportData.investingActivities) });
    if (reportData.financingActivities !== undefined) rows.push({ label: 'Financing Activities', amount: fmtNum(reportData.financingActivities) });
    if (reportData.netChange !== undefined) rows.push({ label: 'Net Change in Cash', amount: fmtNum(reportData.netChange) });
    if (reportData.beginningCash !== undefined) rows.push({ label: 'Beginning Cash', amount: fmtNum(reportData.beginningCash) });
    if (reportData.endingCash !== undefined) rows.push({ label: 'Ending Cash', amount: fmtNum(reportData.endingCash) });
    return { rows, columns };
  }

  // ─── AP Aging Summary/Detail (has vendors and/or details arrays) ───
  if (reportData.vendors && Array.isArray(reportData.vendors)) {
    const columns = [
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'current', label: 'Current', align: 'right' as const },
      { key: 'bucket1to30', label: '1-30', align: 'right' as const },
      { key: 'bucket31to60', label: '31-60', align: 'right' as const },
      { key: 'bucket61to90', label: '61-90', align: 'right' as const },
      { key: 'bucketOver90', label: '90+', align: 'right' as const },
      { key: 'total', label: 'Total', align: 'right' as const },
    ];
    const rows = reportData.vendors.map((v: any) => ({
      vendor_name: v.vendor_name || v.vendorName || 'Unknown',
      current: fmtNum(v.current),
      bucket1to30: fmtNum(v.bucket1to30),
      bucket31to60: fmtNum(v.bucket31to60),
      bucket61to90: fmtNum(v.bucket61to90),
      bucketOver90: fmtNum(v.bucketOver90),
      total: fmtNum(v.total),
    }));
    // Append totals row
    if (reportData.totals) {
      rows.push({
        vendor_name: 'TOTALS',
        current: fmtNum(reportData.totals.current),
        bucket1to30: fmtNum(reportData.totals.bucket1to30),
        bucket31to60: fmtNum(reportData.totals.bucket31to60),
        bucket61to90: fmtNum(reportData.totals.bucket61to90),
        bucketOver90: fmtNum(reportData.totals.bucketOver90),
        total: fmtNum(reportData.totals.total),
      });
    }
    return { rows, columns };
  }

  // ─── Generic data array (trial balance, general ledger, etc.) ───
  let rows: any[] = reportData.data || reportData.rows || reportData.details || [];
  if (!rows.length) return { rows: [], columns: [] };

  // If the report provides explicit export columns, use those instead of auto-detecting.
  // This ensures CSV/PDF matches the on-screen HTML view exactly.
  const moneyPatterns = /amount|total|balance|paid|debit|credit|price|cost|due|current|bucket|over_90/i;

  let columns: ExportColumn[];
  if (reportData._exportColumns && Array.isArray(reportData._exportColumns)) {
    columns = reportData._exportColumns.map((c: any) => ({
      key: c.key,
      label: c.label,
      ...(c.align ? { align: c.align } : moneyPatterns.test(c.key) ? { align: 'right' as const } : {}),
    }));
  } else {
    // Auto-detect columns — skip internal/redundant keys
    const sample = rows[0];
    const skipKeys = new Set([
      'id', 'accountId', 'account_id', 'contact_id', 'contactId',
      'bill_id', 'billId', 'tenant_id', 'tenantId', 'company_id', 'companyId',
    ]);

    columns = Object.keys(sample)
      .filter((k) => !skipKeys.has(k) && typeof sample[k] !== 'object')
      .map((k) => ({
        key: k,
        label: k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()),
        ...(moneyPatterns.test(k) ? { align: 'right' as const } : {}),
      }));
  }

  // Format numeric values to 2 decimal places
  rows = rows.map((row: any) => {
    const formatted: any = {};
    for (const col of columns) {
      const val = row[col.key];
      if (col.align === 'right' && val !== null && val !== undefined && val !== '') {
        const num = parseFloat(String(val));
        formatted[col.key] = isNaN(num) ? val : fmtNum(num);
      } else {
        formatted[col.key] = val;
      }
    }
    return formatted;
  });

  // Append totals if present
  if (reportData.totalDebits !== undefined) {
    const totalRow: any = {};
    columns.forEach((c) => { totalRow[c.key] = ''; });
    const nameCol = columns.find((c) => c.key === 'name' || c.key === 'account_number');
    if (nameCol) totalRow[nameCol.key] = 'TOTALS';
    const debitCol = columns.find((c) => c.key === 'total_debit');
    const creditCol = columns.find((c) => c.key === 'total_credit');
    if (debitCol) totalRow[debitCol.key] = fmtNum(reportData.totalDebits);
    if (creditCol) totalRow[creditCol.key] = fmtNum(reportData.totalCredits);
    rows = [...rows, totalRow];
  }

  return { rows, columns };
}

function buildHtmlTable(rows: ExportRow[], columns: ExportColumn[]): string {
  if (!rows.length) return '<p>No data</p>';

  // Per-column width style attribute. Columns without an explicit width
  // get nothing (auto-size), so the description column flexes to fill
  // the remaining space.
  const widthStyle = (c: ExportColumn) => (c.width ? ` style="width:${c.width}"` : '');

  // Right-aligned columns get the `.amount` class on BOTH the header and
  // every body cell so the column edge is consistent (including for empty
  // cells like blank debits/credits).
  const header = columns.map((c) => {
    const cls = c.align === 'right' ? ' class="amount"' : '';
    return `<th${cls}${widthStyle(c)}>${exportService.escapeHtml(c.label)}</th>`;
  }).join('');

  const body = rows.map((row) => {
    // Explicit section row → single cell spanning all columns. Used by
    // the General Ledger to render account headers as full-width bands
    // instead of cramming the label into the Date column.
    if (row._section) {
      return `<tr style="background:#f3f4f6;font-weight:600"><td colspan="${columns.length}">${exportService.escapeHtml(row._label || '')}</td></tr>`;
    }

    // Per-column cell rendering, used by both _summary rows and normal
    // data rows.
    const firstKey = columns[0]?.key;
    const firstVal = firstKey ? row[firstKey] : undefined;
    // Prefer explicit markers (`_total`, `_section`) — rows emitted from
    // paths that know their role tag themselves. Fall back to string
    // detection for older flatteners that just push raw rows.
    // Note: explicit `_section` rows are already handled via early return
    // above, so by this point row._section is always falsy.
    const isLegacySection = typeof firstVal === 'string' && firstVal.startsWith('---');
    const isLegacyTotal = row._total === true
      || (typeof firstVal === 'string' && (firstVal.startsWith('Total') || firstVal.startsWith('TOTAL') || firstVal === 'NET INCOME'));

    const cells = columns.map((c) => {
      let val = row[c.key];
      if (typeof val === 'string' && val.startsWith('---')) val = val.replace(/^---\s*|\s*---$/g, '');
      const isNum = typeof val === 'number';
      // Apply `.amount` if the column declares right-alignment OR the
      // value is a JS number (legacy auto-detect for older report shapes).
      const cls = (c.align === 'right' || isNum) ? ' class="amount"' : '';
      const rendered = val === null || val === undefined
        ? ''
        : isNum ? fmtNum(val) : exportService.escapeHtml(val);
      return `<td${cls}${widthStyle(c)}>${rendered}</td>`;
    }).join('');

    // Explicit summary row marker (per-account beginning / ending /
    // period total in the General Ledger). Bold + tinted background.
    if (row._summary) return `<tr style="font-weight:600;background:#fafafa">${cells}</tr>`;

    // Legacy detection for the older P&L / BS / Trial Balance flatteners
    // that haven't been migrated to explicit row metadata.
    if (isLegacySection) return `<tr style="background:#f3f4f6;font-weight:600">${cells}</tr>`;
    if (isLegacyTotal) return `<tr class="total-row" style="font-weight:700;border-top:2px solid #111">${cells}</tr>`;
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

    let companyName = 'Company';
    try {
      const { db } = await import('../db/index.js');
      const { sql } = await import('drizzle-orm');
      const scope = res.req.query['scope'] as string | undefined;
      if (scope === 'consolidated') {
        companyName = 'Consolidated';
      } else if (res.req.companyId) {
        const result = await db.execute(sql`SELECT business_name FROM companies WHERE id = ${res.req.companyId}`);
        companyName = (result.rows as any[])[0]?.business_name || 'Company';
      } else {
        const result = await db.execute(sql`SELECT business_name FROM companies WHERE tenant_id = ${res.req.tenantId} LIMIT 1`);
        companyName = (result.rows as any[])[0]?.business_name || 'Company';
      }
    } catch { /* use default */ }

    // Wide reports use landscape so all columns fit without truncation.
    // The General Ledger has 8 columns (Date / Type / Ref / Name /
    // Description / Debit / Credit / Balance) which won't fit on portrait
    // letter at a readable font size.
    const isWideReport = Array.isArray(reportData.accounts) && reportData.accounts[0]?.lines !== undefined;
    const orientation: 'portrait' | 'landscape' = isWideReport ? 'landscape' : 'portrait';

    const html = exportService.toReportHtml(reportData.title || 'Report', companyName, dateLabel, tableHtml);
    const pdf = await exportService.toPdf(html, { orientation });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(reportData.title || 'report').replace(/\s+/g, '_')}.pdf"`);
    return res.send(pdf);
  }
  res.json(reportData);
}

// ADR 0XX §5 — single-select tag filter. Accepts `tag_id` (preferred) and
// `tagId` as a fallback so clients that already send camelCase don't break.
// Empty string is treated as "no filter" the same as absent.
function readTagFilter(req: { query: Record<string, unknown> }): string | null {
  const raw = (req.query['tag_id'] ?? req.query['tagId']) as string | undefined;
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  return raw;
}

// Financial Statements
reportsRouter.get('/profit-loss', async (req, res) => {
  const { start_date, end_date, basis, format, compare, periods, period_type } = req.query as Record<string, string>;
  const today = new Date();
  const sd = start_date || `${today.getFullYear()}-01-01`;
  const ed = end_date || today.toISOString().split('T')[0]!;
  const b = (basis as 'cash' | 'accrual') || 'accrual';
  const companyId = resolveCompanyScope(req);
  const tagId = readTagFilter(req);

  if (compare) {
    const data = await comparisonService.buildComparativePL(
      req.tenantId, sd, ed, b,
      compare as any,
      parseInt(periods || '6'),
      (period_type as any) || 'month',
      companyId,
    );
    await respond(res, data, format);
  } else {
    const data = await reportService.buildProfitAndLoss(req.tenantId, sd, ed, b, companyId, tagId);
    await respond(res, data, format);
  }
});

reportsRouter.get('/balance-sheet', async (req, res) => {
  const { as_of_date, basis, format, compare } = req.query as Record<string, string>;
  const companyId = resolveCompanyScope(req);
  const tagId = readTagFilter(req);
  if (compare) {
    const data = await comparisonService.buildComparativeBS(
      req.tenantId,
      as_of_date || new Date().toISOString().split('T')[0]!,
      (basis as 'cash' | 'accrual') || 'accrual',
      compare as any,
      companyId,
    );
    await respond(res, data, format);
    return;
  }
  const data = await reportService.buildBalanceSheet(
    req.tenantId,
    as_of_date || new Date().toISOString().split('T')[0]!,
    (basis as 'cash' | 'accrual') || 'accrual',
    companyId,
    tagId,
  );
  await respond(res, data, format);
});

reportsRouter.get('/cash-flow', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const companyId = resolveCompanyScope(req);
  const tagId = readTagFilter(req);
  const data = await reportService.buildCashFlowStatement(
    req.tenantId,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
    companyId,
    tagId,
  );
  await respond(res, data, format);
});

// Receivables
reportsRouter.get('/ar-aging-summary', async (req, res) => {
  const { as_of_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildARAgingSummary(req.tenantId, as_of_date || new Date().toISOString().split('T')[0]!, resolveCompanyScope(req), readTagFilter(req));
  // For CSV/PDF, aggregate by customer to match on-screen summary layout.
  // Build vendor-shaped rows so extractDataAndColumns' AP aging handler renders them.
  if (format === 'csv' || format === 'pdf') {
    const custMap = new Map<string, { vendor_name: string; current: number; bucket1to30: number; bucket31to60: number; bucket61to90: number; bucketOver90: number; total: number }>();
    for (const d of (data.details || [])) {
      const key = d.contact_id || 'unknown';
      const entry = custMap.get(key) || { vendor_name: d.customer_name || 'Unknown', current: 0, bucket1to30: 0, bucket31to60: 0, bucket61to90: 0, bucketOver90: 0, total: 0 };
      const bal = parseFloat(d.balance || d.balance_due || '0');
      if (d.bucket === 'current') entry.current += bal;
      else if (d.bucket === '1-30') entry.bucket1to30 += bal;
      else if (d.bucket === '31-60') entry.bucket31to60 += bal;
      else if (d.bucket === '61-90') entry.bucket61to90 += bal;
      else entry.bucketOver90 += bal;
      entry.total += bal;
      custMap.set(key, entry);
    }
    const vendors = Array.from(custMap.values()).sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
    const exportData = {
      ...data,
      vendors,
      totals: {
        current: data.buckets?.current || 0,
        bucket1to30: data.buckets?.days1to30 || 0,
        bucket31to60: data.buckets?.days31to60 || 0,
        bucket61to90: data.buckets?.days61to90 || 0,
        bucketOver90: data.buckets?.over90 || 0,
        total: data.total || 0,
      },
    };
    await respond(res, exportData, format);
    return;
  }
  await respond(res, data, format);
});

reportsRouter.get('/ar-aging-detail', async (req, res) => {
  const { as_of_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildARAgingDetail(req.tenantId, as_of_date || new Date().toISOString().split('T')[0]!, resolveCompanyScope(req), readTagFilter(req));
  // For CSV/PDF, export line-level detail matching on-screen layout
  if (format === 'csv' || format === 'pdf') {
    const exportData = {
      ...data,
      data: data.details,
      _exportColumns: [
        { key: 'txn_number', label: 'Invoice' },
        { key: 'customer_name', label: 'Customer' },
        { key: 'txn_date', label: 'Date' },
        { key: 'due_date', label: 'Due' },
        { key: 'balance', label: 'Balance', align: 'right' },
      ],
    };
    await respond(res, exportData, format);
    return;
  }
  await respond(res, data, format);
});

// Accounts Payable
reportsRouter.get('/ap-aging-summary', async (req, res) => {
  const { as_of_date, format } = req.query as Record<string, string>;
  const data = await apReportService.buildApAgingSummary(req.tenantId, as_of_date || new Date().toISOString().split('T')[0]!, resolveCompanyScope(req), readTagFilter(req));
  await respond(res, data, format);
});

reportsRouter.get('/ap-aging-detail', async (req, res) => {
  const { as_of_date, format } = req.query as Record<string, string>;
  const data = await apReportService.buildApAgingDetail(req.tenantId, as_of_date || new Date().toISOString().split('T')[0]!, resolveCompanyScope(req), readTagFilter(req));
  // For CSV/PDF export, use the line-level details instead of the vendor summary
  if (format === 'csv' || format === 'pdf') {
    const { vendors, totals, ...rest } = data;
    const exportData = {
      ...rest,
      data: data.details,
      _exportColumns: [
        { key: 'vendor_name', label: 'Vendor' },
        { key: 'txn_number', label: 'Bill #' },
        { key: 'vendor_invoice_number', label: 'Vendor Inv #' },
        { key: 'txn_date', label: 'Date' },
        { key: 'due_date', label: 'Due' },
        { key: 'days_overdue', label: 'Days Overdue', align: 'right' },
        { key: 'balance', label: 'Balance', align: 'right' },
      ],
    };
    await respond(res, exportData, format);
    return;
  }
  await respond(res, data, format);
});

reportsRouter.get('/unpaid-bills', async (req, res) => {
  const { contact_id, due_on_or_before, overdue_only, format } = req.query as Record<string, string>;
  const data = await apReportService.buildUnpaidBills(req.tenantId, {
    contactId: contact_id || undefined,
    dueOnOrBefore: due_on_or_before || undefined,
    overdueOnly: overdue_only === 'true',
  }, resolveCompanyScope(req));
  // Provide explicit columns so CSV/PDF matches the on-screen layout
  await respond(res, { ...data, _exportColumns: [
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'txn_number', label: 'Bill #' },
    { key: 'vendor_invoice_number', label: 'Vendor Inv #' },
    { key: 'txn_date', label: 'Date' },
    { key: 'due_date', label: 'Due' },
    { key: 'total', label: 'Total', align: 'right' },
    { key: 'balance_due', label: 'Balance', align: 'right' },
  ]}, format);
});

reportsRouter.get('/bill-payment-history', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const data = await apReportService.buildBillPaymentHistory(req.tenantId, {
    startDate: start_date,
    endDate: end_date,
  }, resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_number', label: 'Payment #' },
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'check_number', label: 'Check #' },
    { key: 'bill_count', label: '# Bills', align: 'right' },
    { key: 'total', label: 'Amount', align: 'right' },
  ]}, format);
});

reportsRouter.get('/vendor-statement', async (req, res) => {
  const { vendor_id, start_date, end_date, format } = req.query as Record<string, string>;
  if (!vendor_id) {
    return res.status(400).json({ error: { message: 'vendor_id is required' } });
  }
  const data = await apReportService.buildVendorStatement(req.tenantId, vendor_id, {
    startDate: start_date,
    endDate: end_date,
  }, resolveCompanyScope(req));
  // Reshape for CSV/PDF: turn lines + opening/closing into a proper data array
  if (format === 'csv' || format === 'pdf') {
    const rows: any[] = [];
    rows.push({ txn_date: '', txn_type: '', txn_number: '', memo: 'Opening Balance', charge: '', payment: '', balance: data.openingBalance });
    for (const line of (data.lines || [])) {
      rows.push({
        txn_date: line.txn_date,
        txn_type: fmtTxnType(line.txn_type),
        txn_number: line.txn_number || line.vendor_invoice_number || '',
        memo: line.memo || '',
        charge: line.charge || '',
        payment: line.payment || '',
        balance: line.balance,
      });
    }
    rows.push({ txn_date: '', txn_type: '', txn_number: '', memo: 'Closing Balance', charge: '', payment: '', balance: data.closingBalance });
    const exportData = {
      ...data,
      data: rows,
      _exportColumns: [
        { key: 'txn_date', label: 'Date' },
        { key: 'txn_type', label: 'Type' },
        { key: 'txn_number', label: 'Reference' },
        { key: 'memo', label: 'Memo' },
        { key: 'charge', label: 'Charges', align: 'right' },
        { key: 'payment', label: 'Payments', align: 'right' },
        { key: 'balance', label: 'Balance', align: 'right' },
      ],
    };
    return respond(res, exportData, format);
  }
  return respond(res, data, format);
});

reportsRouter.get('/ap-1099-prep', async (req, res) => {
  const { tax_year, format } = req.query as Record<string, string>;
  const year = tax_year ? parseInt(tax_year, 10) : new Date().getFullYear();
  const data = await apReportService.buildAp1099Prep(req.tenantId, year, resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'address', label: 'Address' },
    { key: 'tax_id', label: 'Tax ID' },
    { key: 'total_paid', label: 'Total Paid', align: 'right' },
  ]}, format);
});

reportsRouter.get('/customer-balance-summary', async (req, res) => {
  const data = await reportService.buildCustomerBalanceSummary(req.tenantId, resolveCompanyScope(req), readTagFilter(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'display_name', label: 'Customer' },
    { key: 'balance', label: 'Balance', align: 'right' },
  ]}, req.query['format'] as string);
});

reportsRouter.get('/customer-balance-detail', async (req, res) => {
  const data = await reportService.buildCustomerBalanceDetail(req.tenantId, resolveCompanyScope(req), readTagFilter(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'display_name', label: 'Customer' },
    { key: 'balance', label: 'Balance', align: 'right' },
  ]}, req.query['format'] as string);
});

reportsRouter.get('/invoice-list', async (req, res) => {
  const { start_date, end_date, status, format } = req.query as Record<string, string>;
  const tagId = readTagFilter(req);
  const data = await reportService.buildInvoiceList(req.tenantId, { startDate: start_date, endDate: end_date, status, ...(tagId ? { tagId } : {}) }, resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_number', label: 'Number' },
    { key: 'customer_name', label: 'Customer' },
    { key: 'txn_date', label: 'Date' },
    { key: 'invoice_status', label: 'Status' },
    { key: 'total', label: 'Total', align: 'right' },
    { key: 'balance_due', label: 'Balance', align: 'right' },
  ]}, format);
});

// Expenses
reportsRouter.get('/expense-by-vendor', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildExpenseByVendor(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!, resolveCompanyScope(req), readTagFilter(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'total', label: 'Total', align: 'right' },
  ]}, format);
});

reportsRouter.get('/expense-by-category', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildExpenseByCategory(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!, resolveCompanyScope(req), readTagFilter(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'account_number', label: '#' },
    { key: 'category', label: 'Category' },
    { key: 'total', label: 'Total', align: 'right' },
  ]}, format);
});

// Sales
reportsRouter.get('/sales-by-customer', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildSalesByCustomer(
    req.tenantId,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
    resolveCompanyScope(req),
    readTagFilter(req),
  );
  await respond(res, { ...data, _exportColumns: [
    { key: 'customer_name', label: 'Customer' },
    { key: 'total', label: 'Total', align: 'right' },
  ]}, format);
});

reportsRouter.get('/sales-by-item', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildSalesByItem(
    req.tenantId,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
    resolveCompanyScope(req),
    readTagFilter(req),
  );
  await respond(res, { ...data, _exportColumns: [
    { key: 'item_sku', label: 'SKU' },
    { key: 'item_name', label: 'Item' },
    { key: 'txn_count', label: 'Txns', align: 'right' },
    { key: 'total', label: 'Total', align: 'right' },
  ]}, format);
});

reportsRouter.get('/vendor-balance-summary', async (req, res) => {
  const data = await reportService.buildVendorBalanceSummary(req.tenantId, resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'display_name', label: 'Vendor' },
    { key: 'total_spent', label: 'Total Spent', align: 'right' },
  ]}, req.query['format'] as string);
});

reportsRouter.get('/transaction-list-by-vendor', async (req, res) => {
  const { vendor_id, start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildTransactionListByVendor(req.tenantId, vendor_id || '', { startDate: start_date, endDate: end_date }, resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_type', label: 'Type' },
    { key: 'txn_number', label: 'Number' },
    { key: 'total', label: 'Amount', align: 'right' },
    { key: 'memo', label: 'Memo' },
  ]}, format);
});

// Banking
reportsRouter.get('/bank-reconciliation-summary', async (req, res) => {
  const data = await reportService.buildBankReconciliationSummary(req.tenantId, (req.query['account_id'] as string) || '', resolveCompanyScope(req));
  await respond(res, data, req.query['format'] as string);
});

reportsRouter.get('/deposit-detail', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildDepositDetail(req.tenantId, { startDate: start_date, endDate: end_date }, resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_number', label: 'Number' },
    { key: 'total', label: 'Amount', align: 'right' },
    { key: 'memo', label: 'Memo' },
  ]}, format);
});

reportsRouter.get('/check-register', async (req, res) => {
  const { account_id, start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildCheckRegister(req.tenantId, account_id || '', { startDate: start_date, endDate: end_date }, resolveCompanyScope(req), readTagFilter(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_type', label: 'Type' },
    { key: 'txn_number', label: 'Number' },
    { key: 'memo', label: 'Memo' },
    { key: 'debit', label: 'Debit', align: 'right' },
    { key: 'credit', label: 'Credit', align: 'right' },
  ]}, format);
});

// Tax
reportsRouter.get('/sales-tax-liability', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildSalesTaxLiability(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!, resolveCompanyScope(req));
  // Reshape scalar values into a data array for CSV/PDF export
  const exportData = {
    ...data,
    data: [
      { item: 'Total Taxable Sales', amount: data.totalSales },
      { item: 'Total Sales Tax Collected', amount: data.totalTax },
    ],
    _exportColumns: [
      { key: 'item', label: 'Item' },
      { key: 'amount', label: 'Amount', align: 'right' },
    ],
  };
  await respond(res, exportData, format);
});

reportsRouter.get('/taxable-sales-summary', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildTaxableSalesSummary(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!, resolveCompanyScope(req));
  const exportData = {
    ...data,
    data: [
      { item: 'Total Taxable Sales', amount: data.totalSales },
      { item: 'Total Sales Tax Collected', amount: data.totalTax },
    ],
    _exportColumns: [
      { key: 'item', label: 'Item' },
      { key: 'amount', label: 'Amount', align: 'right' },
    ],
  };
  await respond(res, exportData, format);
});

reportsRouter.get('/sales-tax-payments', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildSalesTaxPayments(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!, resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'total', label: 'Amount', align: 'right' },
  ]}, format);
});

reportsRouter.get('/vendor-1099-summary', async (req, res) => {
  const { year, format } = req.query as Record<string, string>;
  const data = await reportService.build1099VendorSummary(req.tenantId, year || String(new Date().getFullYear()), resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'display_name', label: 'Vendor' },
    { key: 'tax_id', label: 'Tax ID' },
    { key: 'total_paid', label: 'Total Paid', align: 'right' },
  ]}, format);
});

// General
reportsRouter.get('/general-ledger', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  const data = await reportService.buildGeneralLedger(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!, resolveCompanyScope(req), readTagFilter(req));
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
    resolveCompanyScope(req),
    readTagFilter(req),
  );
  await respond(res, { ...data, _exportColumns: [
    { key: 'account_number', label: '#' },
    { key: 'name', label: 'Account' },
    { key: 'account_type', label: 'Type' },
    { key: 'total_debit', label: 'Debit', align: 'right' },
    { key: 'total_credit', label: 'Credit', align: 'right' },
  ]}, format);
});

reportsRouter.get('/transaction-list', async (req, res) => {
  const { start_date, end_date, txn_type, account_id, format } = req.query as Record<string, string>;
  const tagId = readTagFilter(req);
  const data = await reportService.buildTransactionList(req.tenantId, { startDate: start_date, endDate: end_date, txnType: txn_type, accountId: account_id, ...(tagId ? { tagId } : {}) }, resolveCompanyScope(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_type', label: 'Type' },
    { key: 'txn_number', label: 'Number' },
    { key: 'contact_name', label: 'Contact' },
    { key: 'total', label: 'Amount', align: 'right' },
    { key: 'memo', label: 'Memo' },
    // ADR 0XX §6.3 — line-level tag aggregation on the export row.
    { key: 'line_tag', label: 'Tag' },
  ]}, format);
});

reportsRouter.get('/journal-entry-report', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildJournalEntryReport(req.tenantId, { startDate: start_date, endDate: end_date }, resolveCompanyScope(req), readTagFilter(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_number', label: 'Number' },
    { key: 'total', label: 'Amount', align: 'right' },
    { key: 'memo', label: 'Memo' },
  ]}, format);
});

reportsRouter.get('/account-report', async (req, res) => {
  const { account_id, start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildAccountReport(req.tenantId, account_id || '', { startDate: start_date, endDate: end_date }, resolveCompanyScope(req), readTagFilter(req));
  await respond(res, { ...data, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_type', label: 'Type' },
    { key: 'txn_number', label: 'Number' },
    { key: 'memo', label: 'Memo' },
    { key: 'debit', label: 'Debit', align: 'right' },
    { key: 'credit', label: 'Credit', align: 'right' },
  ]}, format);
});
