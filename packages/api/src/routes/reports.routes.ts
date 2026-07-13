// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request } from 'express';
import { formatDetailTypeLabel } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
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
reportsRouter.use(requirePermission('reports', 'read'));
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

// Humanized detail type for the grouped P&L / BS export column.
// 'accounts_receivable' → 'Accounts Receivable'; null → 'Other'.
function fmtDetailType(dt: string | null | undefined): string {
  return formatDetailTypeLabel(dt);
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
  // First row of a new transaction group — gets a thicker top rule so the
  // PDF visually separates one transaction (which may span several lines)
  // from the next. Ignored in CSV.
  _groupStart?: boolean;
  // First-column indentation in the rendered PDF/HTML table (grouped
  // display mode). Stripped from CSV like the other underscore flags.
  _indent?: boolean;
};

// Structural shapes for the grouped-export helpers (standard +
// comparative detail-type groups). The report payloads themselves are
// still `any` (legacy), but the new grouping paths are typed.
type ExportPLEntry = { accountNumber?: string | null; name: string; amount: number; detailType?: string | null };
type ExportBSEntry = { accountId?: string | null; accountNumber?: string | null; name: string; balance: number; detailType?: string | null };
type ExportCompRow = { account?: string; name?: string; accountNumber?: string | null; values?: Array<number | null> };
type ExportCompGroup = { label: string; rows: ExportCompRow[]; values: Array<number | null> };

// Expenses by Category detail-mode export shapes (mirrors the
// ExpenseCategoryGroup / ExpenseCategoryDetailLine service types).
type ExportExpCatLine = {
  date: string; txnType: string; txnNumber: string | null; contactName: string | null;
  memo: string; debit: number; credit: number; balance: number;
};
type ExportExpCatGroup = {
  accountNumber: string | null; name: string; lines: ExportExpCatLine[];
  totalDebits: number; totalCredits: number; subtotal: number;
  beginningBalance?: number; endingBalance?: number;
};

// Expenses by Vendor detail-mode export shape (vendor → per-account totals).
type ExportVendorGroup = {
  vendorName: string;
  accounts: Array<{ accountNumber: string | null; name: string; total: number }>;
  total: number;
};

// Build structured export rows that match on-screen display.
// Exported for tests: lets the suite assert on the export layout (CSV
// rows and PDF HTML) without launching Puppeteer.
export function extractDataAndColumns(reportData: any): { rows: any[]; columns: ExportColumn[] } {
  // Mirrors the on-screen "Account #" toggle (P&L / Balance Sheet / General
  // Ledger). When the caller exported with account numbers hidden, drop them
  // from the composed labels so the PDF/CSV matches the screen.
  const hideAcctNums = reportData._hideAccountNumbers === true;
  // ─── Comparative reports (have columns + per-column values) ───
  // The comparative P&L carries a flat `rows` array; the comparative
  // BALANCE SHEET carries assets/liabilities/equity sections with
  // array-valued totals and no `rows` key — the old `&& reportData.rows`
  // gate silently dropped it into the generic (empty) path, so every
  // comparative BS CSV/PDF exported as "No data".
  const isComparativeBS = !!reportData.assets && Array.isArray(reportData.totalAssets);
  if (reportData.columns && Array.isArray(reportData.columns) && (reportData.rows || isComparativeBS)) {
    // ?show_pct=1 on a comparative P&L: each period column gains a
    // companion "% of Revenue" column (common-size — the amount over
    // THAT period's total revenue). Variance / % change columns are
    // ratios already and get no companion. Not applicable to the BS.
    const showCmpPct = reportData.showPct === true && !isComparativeBS;
    const isPeriodCol = (c: { label: string; type?: string } | undefined) =>
      c?.type !== 'variance' && c?.type !== 'percent_variance';
    const pctKeyFor = (c: { label: string; type?: string }) => `${c.label} %`;
    const pctOfColumn = (v: unknown, i: number): string => {
      const rev = Number(reportData.totalRevenue?.[i]) || 0;
      if (rev === 0) return '—';
      return `${(((Number(v) || 0) / rev) * 100).toFixed(1)}%`;
    };
    const cols: ExportColumn[] = [
      { key: 'account', label: 'Account' },
      ...reportData.columns.flatMap((c: any) => [
        { key: c.label, label: c.label, align: 'right' as const },
        ...(showCmpPct && isPeriodCol(c)
          ? [{ key: pctKeyFor(c), label: pctKeyFor(c), align: 'right' as const }]
          : []),
      ]),
    ];
    const fillPct = (row: Record<string, unknown>, values: Array<unknown>) => {
      if (!showCmpPct) return;
      (values || []).forEach((v, i) => {
        const c = reportData.columns[i];
        if (c && isPeriodCol(c)) row[pctKeyFor(c)] = pctOfColumn(v, i);
      });
    };

    const rows: any[] = [];

    const rowsByType = (t: string) => (reportData.rows || []).filter((r: any) => r.accountType === t);
    const revenueRows = rowsByType('revenue');
    const cogsRows = rowsByType('cogs');
    const expenseRows = rowsByType('expense');
    const otherRevenueRows = rowsByType('other_revenue');
    const otherExpenseRows = rowsByType('other_expense');
    const L = reportData.labels as import('@kis-books/shared').PLSectionLabels | undefined;
    const lab = (k: keyof import('@kis-books/shared').PLSectionLabels, fallback: string) =>
      L?.[k] || fallback;

    const mapRow = (r: any) => {
      const row: any = { account: r.accountNumber && !hideAcctNums ? `${r.accountNumber} — ${r.account || r.name}` : (r.account || r.name) };
      (r.values || []).forEach((v: any, i: number) => { row[reportData.columns[i]?.label || `Col${i}`] = fmtNum(v); });
      fillPct(row, r.values || []);
      return row;
    };
    const totalRow = (label: string, values: any[]) => {
      const row: any = { _total: true, account: label };
      (values || []).forEach((v: any, i: number) => { row[reportData.columns[i]?.label || `Col${i}`] = fmtNum(v); });
      fillPct(row, values || []);
      return row;
    };

    // Detail-type grouping / condensed display (?group_by=detail_type
    // [+ ?display=condensed]). The comparative builders return additive
    // per-section `groups`; here we mirror the on-screen presentation:
    // grouped = group header + indented member rows + per-column
    // subtotal row; condensed = only the subtotal rows.
    const condensed = reportData.display === 'condensed';
    const cmpGroups = reportData.groups as undefined | Record<string, ExportCompGroup[]>;
    const groupSubtotalRow = (label: string, values: Array<number | null>) => {
      const row: Record<string, unknown> = { _summary: true, account: label };
      (values || []).forEach((v, i) => { row[reportData.columns[i]?.label || `Col${i}`] = fmtNum(v); });
      fillPct(row, values || []);
      return row;
    };
    const pushSectionRows = (
      sectionRows: ExportCompRow[],
      groupsForSection?: ExportCompGroup[],
    ) => {
      if (!groupsForSection) { rows.push(...sectionRows.map(mapRow)); return; }
      for (const g of groupsForSection) {
        if (condensed) { rows.push(groupSubtotalRow(g.label, g.values)); continue; }
        rows.push({ _section: true, _label: g.label, account: g.label });
        for (const r of g.rows) rows.push({ ...mapRow(r), _indent: true });
        rows.push(groupSubtotalRow(`Total ${g.label}`, g.values));
      }
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
      pushSectionRows(revenueRows, cmpGroups?.['revenue']);
      if (reportData.totalRevenue) rows.push(totalRow(`Total ${revenueLabel}`, reportData.totalRevenue));
    }
    if (hasCogs) {
      rows.push({ account: `--- ${cogsLabel.toUpperCase()} ---` });
      pushSectionRows(cogsRows, cmpGroups?.['cogs']);
      if (reportData.totalCogs) rows.push(totalRow(`Total ${cogsLabel}`, reportData.totalCogs));
      rows.push(totalRow(grossProfitLabel, zipSubtract(reportData.totalRevenue, reportData.totalCogs)));
    }
    if (expenseRows.length) {
      rows.push({ account: `--- ${expensesLabel.toUpperCase()} ---` });
      pushSectionRows(expenseRows, cmpGroups?.['expenses']);
      if (reportData.totalExpenses) rows.push(totalRow(`Total ${expensesLabel}`, reportData.totalExpenses));
    }
    if (showOperatingIncome) {
      const gp = hasCogs ? zipSubtract(reportData.totalRevenue, reportData.totalCogs) : reportData.totalRevenue;
      rows.push(totalRow(operatingIncomeLabel, zipSubtract(gp, reportData.totalExpenses)));
    }
    if (hasOtherRev) {
      rows.push({ account: `--- ${otherRevenueLabel.toUpperCase()} ---` });
      pushSectionRows(otherRevenueRows, cmpGroups?.['otherRevenue']);
      if (reportData.totalOtherRevenue) rows.push(totalRow(`Total ${otherRevenueLabel}`, reportData.totalOtherRevenue));
    }
    if (hasOtherExp) {
      rows.push({ account: `--- ${otherExpensesLabel.toUpperCase()} ---` });
      pushSectionRows(otherExpenseRows, cmpGroups?.['otherExpenses']);
      if (reportData.totalOtherExpenses) rows.push(totalRow(`Total ${otherExpensesLabel}`, reportData.totalOtherExpenses));
    }
    if (reportData.netIncome) rows.push(totalRow(netIncomeLabel, reportData.netIncome));

    // Comparative Balance Sheet
    if (reportData.assets && reportData.totalAssets) {
      const BS = reportData.labels as import('@kis-books/shared').BSSectionLabels | undefined;
      const assetsLabel = BS?.assets || 'Assets';
      const liabilitiesLabel = BS?.liabilities || 'Liabilities';
      const equityLabel = BS?.equity || 'Equity';
      rows.length = 0;
      rows.push({ account: `--- ${assetsLabel.toUpperCase()} ---` });
      pushSectionRows(reportData.assets, cmpGroups?.['assets']);
      rows.push(totalRow(`Total ${assetsLabel}`, reportData.totalAssets));
      rows.push({ account: `--- ${liabilitiesLabel.toUpperCase()} ---` });
      pushSectionRows(reportData.liabilities, cmpGroups?.['liabilities']);
      rows.push(totalRow(`Total ${liabilitiesLabel}`, reportData.totalLiabilities));
      rows.push({ account: `--- ${equityLabel.toUpperCase()} ---` });
      pushSectionRows(reportData.equity || [], cmpGroups?.['equity']);
      rows.push(totalRow(`Total ${equityLabel}`, reportData.totalEquity));
      // Closing grand total — mirrors the standard BS export.
      if (reportData.totalLiabilitiesAndEquity) {
        const totalLELabel = BS?.totalLiabilitiesAndEquity || 'Total Liabilities & Equity';
        rows.push(totalRow(totalLELabel.toUpperCase(), reportData.totalLiabilitiesAndEquity));
      }
    }

    return { rows, columns: cols };
  }

  // ─── P&L (standard — has revenue + expenses arrays) ───
  if (reportData.revenue && reportData.expenses && !reportData.columns) {
    // Grouped mode (?group_by=detail_type): mirrors the on-screen
    // presentation — group header rows, indented member accounts, and a
    // subtotal row per group (condensed = subtotal rows only) — and
    // keeps a Detail Type column so the CSV still pivots cleanly.
    // ?show_pct=1 adds the on-screen "% of Revenue" column.
    const grouped = reportData.groupBy === 'detail_type';
    const condensed = reportData.display === 'condensed';
    const showPct = reportData.showPct === true;
    const totalRev = Number(reportData.totalRevenue) || 0;
    const pctOf = (amount: number): string => {
      if (!showPct) return '';
      if (totalRev === 0) return '\u2014';
      return `${((amount / totalRev) * 100).toFixed(1)}%`;
    };
    const columns: ExportColumn[] = [
      { key: 'account', label: 'Account' },
      ...(grouped ? [{ key: 'detail_type', label: 'Detail Type' }] : []),
      { key: 'amount', label: 'Amount', align: 'right' },
      ...(showPct ? [{ key: 'pct', label: '% of Revenue', align: 'right' as const }] : []),
    ];
    const rows: any[] = [];
    const line = (account: string, amount: any = '') => rows.push({ account, detail_type: '', amount, pct: '' });
    const totalLine = (account: string, amount: any = '', pct: string = '') => rows.push({ _total: true, account, detail_type: '', amount, pct });
    const accountRow = (entry: ExportPLEntry) => ({
      account: entry.accountNumber && !hideAcctNums ? `${entry.accountNumber} — ${entry.name}` : entry.name,
      detail_type: grouped ? fmtDetailType(entry.detailType) : '',
      amount: fmtNum(entry.amount),
      pct: pctOf(entry.amount),
    });
    const accountLine = (entry: ExportPLEntry) => rows.push(accountRow(entry));
    // Emit one section's account rows honoring the display mode.
    type PLGroupShape = { label: string; entries: ExportPLEntry[]; subtotal: number };
    const emitEntries = (entries: ExportPLEntry[], groupsForSection?: PLGroupShape[]) => {
      if (!grouped || !groupsForSection) { for (const e of entries) accountLine(e); return; }
      for (const g of groupsForSection) {
        if (condensed) {
          rows.push({ _summary: true, account: g.label, detail_type: '', amount: fmtNum(g.subtotal), pct: pctOf(g.subtotal) });
          continue;
        }
        rows.push({ _section: true, _label: g.label, account: g.label, detail_type: '', amount: '', pct: '' });
        for (const e of g.entries) rows.push({ ...accountRow(e), _indent: true });
        rows.push({ _summary: true, account: `Total ${g.label}`, detail_type: '', amount: fmtNum(g.subtotal), pct: pctOf(g.subtotal) });
      }
    };

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
    emitEntries(reportData.revenue, reportData.groups?.revenue);
    totalLine(`Total ${revenueLabel}`, fmtNum(reportData.totalRevenue), pctOf(totalRev));
    line('');

    if (hasCogs) {
      line(`--- ${cogsLabel.toUpperCase()} ---`);
      emitEntries(reportData.cogs, reportData.groups?.cogs);
      totalLine(`Total ${cogsLabel}`, fmtNum(reportData.totalCogs), pctOf(Number(reportData.totalCogs) || 0));
      totalLine(grossProfitLabel, fmtNum(reportData.grossProfit ?? 0), pctOf(Number(reportData.grossProfit ?? 0)));
      line('');
    }

    line(`--- ${expensesLabel.toUpperCase()} ---`);
    emitEntries(reportData.expenses, reportData.groups?.expenses);
    totalLine(`Total ${expensesLabel}`, fmtNum(reportData.totalExpenses), pctOf(Number(reportData.totalExpenses) || 0));
    line('');

    if (showOperatingIncome) {
      totalLine(operatingIncomeLabel, fmtNum(reportData.operatingIncome ?? 0), pctOf(Number(reportData.operatingIncome ?? 0)));
      line('');
    }

    if (hasOtherRev) {
      line(`--- ${otherRevenueLabel.toUpperCase()} ---`);
      emitEntries(reportData.otherRevenue, reportData.groups?.otherRevenue);
      totalLine(`Total ${otherRevenueLabel}`, fmtNum(reportData.totalOtherRevenue), pctOf(Number(reportData.totalOtherRevenue) || 0));
      line('');
    }

    if (hasOtherExp) {
      line(`--- ${otherExpensesLabel.toUpperCase()} ---`);
      emitEntries(reportData.otherExpenses, reportData.groups?.otherExpenses);
      totalLine(`Total ${otherExpensesLabel}`, fmtNum(reportData.totalOtherExpenses), pctOf(Number(reportData.totalOtherExpenses) || 0));
      line('');
    }

    totalLine(netIncomeLabel.toUpperCase(), fmtNum(reportData.netIncome), pctOf(Number(reportData.netIncome) || 0));
    return { rows, columns };
  }

  // ─── Balance Sheet (standard — has assets + liabilities + equity arrays) ───
  if (reportData.assets && reportData.liabilities && !reportData.columns) {
    const BS = reportData.labels as import('@kis-books/shared').BSSectionLabels | undefined;
    const assetsLabel = BS?.assets || 'Assets';
    const liabilitiesLabel = BS?.liabilities || 'Liabilities';
    const equityLabel = BS?.equity || 'Equity';
    const totalLELabel = BS?.totalLiabilitiesAndEquity || 'Total Liabilities & Equity';
    const grouped = reportData.groupBy === 'detail_type';
    const columns: ExportColumn[] = [
      { key: 'account', label: 'Account' },
      ...(grouped ? [{ key: 'detail_type', label: 'Detail Type' }] : []),
      { key: 'balance', label: 'Balance', align: 'right' },
    ];
    // Computed equity rows (Retained Earnings (Prior Years) / Net Income
    // (Current Year)) have no account, so in grouped mode they label as
    // 'Equity (Calculated)' rather than 'Other'.
    const dtFor = (e: { accountId?: string | null; detailType?: string | null }): string => {
      if (!grouped) return '';
      if (e.accountId === null || e.accountId === undefined) return 'Equity (Calculated)';
      return fmtDetailType(e.detailType);
    };
    const rows: any[] = [];
    const condensed = reportData.display === 'condensed';
    const accountRowBS = (e: ExportBSEntry) => ({
      account: e.accountNumber && !hideAcctNums ? `${e.accountNumber} — ${e.name}` : e.name,
      detail_type: dtFor(e),
      balance: fmtNum(Math.abs(e.balance)),
    });
    // Emit one section honoring the display mode: detail = flat account
    // rows; grouped = group header + indented members + subtotal row;
    // condensed = only the group subtotal rows.
    type BSGroupShape = { label: string; entries: ExportBSEntry[]; subtotal: number };
    const emitBSSection = (entries: ExportBSEntry[], groupsForSection?: BSGroupShape[]) => {
      if (!grouped || !groupsForSection) { for (const e of entries) rows.push(accountRowBS(e)); return; }
      for (const g of groupsForSection) {
        if (condensed) {
          rows.push({ _summary: true, account: g.label, detail_type: '', balance: fmtNum(g.subtotal) });
          continue;
        }
        rows.push({ _section: true, _label: g.label, account: g.label, detail_type: '', balance: '' });
        for (const e of g.entries) rows.push({ ...accountRowBS(e), _indent: true });
        rows.push({ _summary: true, account: `Total ${g.label}`, detail_type: '', balance: fmtNum(g.subtotal) });
      }
    };
    rows.push({ account: `--- ${assetsLabel.toUpperCase()} ---`, detail_type: '', balance: '' });
    emitBSSection(reportData.assets, reportData.groups?.assets);
    rows.push({ _total: true, account: `Total ${assetsLabel}`, detail_type: '', balance: fmtNum(reportData.totalAssets) });
    rows.push({ account: '', detail_type: '', balance: '' });
    rows.push({ account: `--- ${liabilitiesLabel.toUpperCase()} ---`, detail_type: '', balance: '' });
    emitBSSection(reportData.liabilities, reportData.groups?.liabilities);
    rows.push({ _total: true, account: `Total ${liabilitiesLabel}`, detail_type: '', balance: fmtNum(reportData.totalLiabilities) });
    rows.push({ account: '', detail_type: '', balance: '' });
    rows.push({ account: `--- ${equityLabel.toUpperCase()} ---`, detail_type: '', balance: '' });
    emitBSSection(reportData.equity || [], reportData.groups?.equity);
    rows.push({ _total: true, account: `Total ${equityLabel}`, detail_type: '', balance: fmtNum(reportData.totalEquity) });
    rows.push({ account: '', detail_type: '', balance: '' });
    rows.push({ _total: true, account: totalLELabel.toUpperCase(), detail_type: '', balance: fmtNum(reportData.totalLiabilitiesAndEquity) });
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
      const acctLabel = `${!hideAcctNums && acct.accountNumber ? acct.accountNumber : ''} ${acct.name}`.trim();
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

  // ─── Expenses by Vendor — detail mode (vendor → per-account totals).
  // Detected by array-valued `groups` whose entries carry `accounts`
  // (distinct from the category detail's `lines` + `grandTotal`).
  if (Array.isArray(reportData.groups) && reportData.groups.length > 0
      && Array.isArray((reportData.groups[0] as { accounts?: unknown }).accounts)) {
    const columns: ExportColumn[] = [
      { key: 'account_number', label: '#', width: '72px' },
      { key: 'name', label: 'Account' },
      { key: 'total', label: 'Total', align: 'right', width: '120px' },
    ];
    const rows: ExportRow[] = [];
    for (const g of reportData.groups as ExportVendorGroup[]) {
      rows.push({ account_number: '', name: g.vendorName, total: '', _section: true, _label: g.vendorName });
      for (const a of g.accounts) {
        rows.push({ account_number: a.accountNumber || '', name: a.name, total: fmtNum(a.total) });
      }
      rows.push({ account_number: '', name: `Total ${g.vendorName}`, total: fmtNum(g.total), _summary: true });
      rows.push({ account_number: '', name: '', total: '' });
    }
    return { rows, columns };
  }

  // ─── Expenses by Category — detail mode (account groups with GL-style
  // transaction lines). Detected by the array-valued `groups` +
  // `grandTotal` pair, which no other report shape carries (the P&L/BS
  // `groups` is an object keyed by section). Mirrors the on-screen
  // sectioned view: account header band, transaction lines, per-account
  // subtotal, grand TOTAL.
  if (Array.isArray(reportData.groups) && reportData.grandTotal !== undefined) {
    const columns: ExportColumn[] = [
      { key: 'date', label: 'Date', width: '72px' },
      { key: 'type', label: 'Type', width: '52px' },
      { key: 'ref', label: 'Number', width: '64px' },
      { key: 'name', label: 'Name', width: '160px' },
      { key: 'memo', label: 'Memo' },
      { key: 'debit', label: 'Debit', align: 'right', width: '92px' },
      { key: 'credit', label: 'Credit', align: 'right', width: '92px' },
      { key: 'balance', label: 'Balance', align: 'right', width: '100px' },
    ];
    const blank = { date: '', type: '', ref: '', name: '', memo: '', debit: '', credit: '', balance: '' };
    const rows: ExportRow[] = [];
    for (const group of reportData.groups as ExportExpCatGroup[]) {
      const label = group.accountNumber ? `${group.accountNumber} — ${group.name}` : group.name;
      // Section header spans the table in PDF; the label also lands in
      // the Memo column so CSV (column-oriented) still shows it.
      rows.push({ ...blank, _section: true, _label: label, memo: label });
      // Carry-forward reports open each section with the beginning balance.
      if (group.beginningBalance !== undefined) {
        rows.push({ ...blank, memo: 'Beginning Balance', balance: fmtNum(group.beginningBalance) });
      }
      for (const line of group.lines) {
        rows.push({
          date: line.date,
          type: fmtTxnType(line.txnType),
          ref: line.txnNumber || '',
          name: line.contactName || '',
          memo: line.memo || '',
          debit: line.debit ? fmtNum(line.debit) : '',
          credit: line.credit ? fmtNum(line.credit) : '',
          balance: fmtNum(line.balance),
        });
      }
      rows.push({
        ...blank,
        _summary: true,
        // Carry-forward: the section closes on the ending balance.
        memo: group.endingBalance !== undefined ? `Ending Balance ${label}` : `Total ${label}`,
        debit: fmtNum(group.totalDebits),
        credit: fmtNum(group.totalCredits),
        balance: fmtNum(group.endingBalance ?? group.subtotal),
      });
      // Spacer row between accounts
      rows.push({ ...blank });
    }
    rows.push({ ...blank, _total: true, memo: 'TOTAL', balance: fmtNum(reportData.grandTotal) });
    return { rows, columns };
  }

  // ─── Cash Flow (scalar values) ───
  if (reportData.operatingActivities !== undefined || reportData.netChange !== undefined) {
    const CF = reportData.labels as import('@kis-books/shared').CFSectionLabels | undefined;
    const columns: ExportColumn[] = [{ key: 'label', label: 'Item' }, { key: 'amount', label: 'Amount', align: 'right' }];
    const rows: any[] = [];
    if (reportData.operatingActivities !== undefined) rows.push({ label: CF?.operatingActivities || 'Operating Activities', amount: fmtNum(reportData.operatingActivities) });
    if (reportData.investingActivities !== undefined) rows.push({ label: CF?.investingActivities || 'Investing Activities', amount: fmtNum(reportData.investingActivities) });
    if (reportData.financingActivities !== undefined) rows.push({ label: CF?.financingActivities || 'Financing Activities', amount: fmtNum(reportData.financingActivities) });
    if (reportData.netChange !== undefined) rows.push({ _total: true, label: CF?.netChange || 'Net Change in Cash', amount: fmtNum(reportData.netChange) });
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
    // Carry rendering directives through the column projection (the
    // transaction-group boundary rule renders off `_groupStart`).
    if (row._groupStart) formatted._groupStart = true;
    return formatted;
  });

  // Append totals if present. The Trial Balance uses netted `debit` /
  // `credit` columns; the Account Activity Summary keeps the gross
  // `total_debit` / `total_credit` activity columns plus a signed `net`.
  if (reportData.totalDebits !== undefined) {
    const totalRow: any = {};
    columns.forEach((c) => { totalRow[c.key] = ''; });
    const nameCol = columns.find((c) => c.key === 'name' || c.key === 'account_number');
    if (nameCol) totalRow[nameCol.key] = 'TOTALS';
    const debitCol = columns.find((c) => c.key === 'total_debit' || c.key === 'debit');
    const creditCol = columns.find((c) => c.key === 'total_credit' || c.key === 'credit');
    const netCol = columns.find((c) => c.key === 'net');
    if (debitCol) totalRow[debitCol.key] = fmtNum(reportData.totalDebits);
    if (creditCol) totalRow[creditCol.key] = fmtNum(reportData.totalCredits);
    if (netCol && reportData.totalNet !== undefined) totalRow[netCol.key] = fmtNum(reportData.totalNet);
    rows = [...rows, totalRow];
  }

  return { rows, columns };
}

export function buildHtmlTable(rows: ExportRow[], columns: ExportColumn[]): string {
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

    const cells = columns.map((c, idx) => {
      let val = row[c.key];
      if (typeof val === 'string' && val.startsWith('---')) val = val.replace(/^---\s*|\s*---$/g, '');
      const isNum = typeof val === 'number';
      // Apply `.amount` if the column declares right-alignment OR the
      // value is a JS number (legacy auto-detect for older report shapes).
      const cls = (c.align === 'right' || isNum) ? ' class="amount"' : '';
      // Merge width + grouped-mode indentation into one style attribute.
      const styles: string[] = [];
      if (c.width) styles.push(`width:${c.width}`);
      if (idx === 0 && row._indent) styles.push('padding-left:22px');
      const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
      const rendered = val === null || val === undefined
        ? ''
        : isNum ? fmtNum(val) : exportService.escapeHtml(val);
      return `<td${cls}${styleAttr}>${rendered}</td>`;
    }).join('');

    // Explicit summary row marker (per-account beginning / ending /
    // period total in the General Ledger). Bold + tinted background.
    if (row._summary) return `<tr style="font-weight:600;background:#fafafa">${cells}</tr>`;

    // Legacy detection for the older P&L / BS / Trial Balance flatteners
    // that haven't been migrated to explicit row metadata.
    if (isLegacySection) return `<tr style="background:#f3f4f6;font-weight:600">${cells}</tr>`;
    if (isLegacyTotal) return `<tr class="total-row" style="font-weight:700;border-top:2px solid #111">${cells}</tr>`;
    // Thicker rule at the start of each transaction group.
    if (row._groupStart) return `<tr style="border-top:2px solid #9ca3af">${cells}</tr>`;
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

// Helper: respond with json, csv, or pdf
async function respond(res: any, reportData: any, format: string | undefined) {
  // Footer is only set by the three financial-statement builders (P&L,
  // Balance Sheet, Cash Flow). For other reports it's empty/undefined,
  // which both renderers treat as "no footer".
  const footer: string = typeof reportData.footer === 'string' ? reportData.footer : '';

  if (format === 'csv') {
    const { rows, columns } = extractDataAndColumns(reportData);
    if (!rows.length) { res.status(404).json({ error: { message: 'No data to export' } }); return; }
    let csv = exportService.toCsv(rows, columns);
    if (footer.trim().length > 0) {
      // Append the footer as plain free-text lines after the table. Each
      // line is wrapped in the first column so spreadsheet tools display
      // it as a value, not as a malformed extra column.
      const padCols = columns.length > 1 ? ',' + Array(columns.length - 1).fill('""').join(',') : '';
      const escaped = footer.split(/\r?\n/).map((line) => `"${line.replace(/"/g, '""')}"${padCols}`);
      csv = csv + '\n' + escaped.join('\n');
    }
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
    const isWideReport = (Array.isArray(reportData.accounts) && reportData.accounts[0]?.lines !== undefined)
      // Expenses by Category detail mode shares the GL's 8-column layout.
      || (Array.isArray(reportData.groups) && reportData.grandTotal !== undefined)
      // Explicit hint for wide column layouts (e.g. the Transaction List).
      || reportData._landscape === true;
    const orientation: 'portrait' | 'landscape' = isWideReport ? 'landscape' : 'portrait';

    const html = exportService.toReportHtml(reportData.title || 'Report', companyName, dateLabel, tableHtml, footer);
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

// ?basis=cash | accrual (default accrual). Anything else falls back to accrual.
function readBasis(req: { query: Record<string, unknown> }): 'cash' | 'accrual' {
  return req.query['basis'] === 'cash' ? 'cash' : 'accrual';
}

// ?account_numbers=0 mirrors the on-screen "Account #" toggle into exports —
// the PDF/CSV drops account numbers from labels to match the screen.
function readHideAcctNums(req: { query: Record<string, unknown> }): { _hideAccountNumbers?: true } {
  return req.query['account_numbers'] === '0' ? { _hideAccountNumbers: true } : {};
}

// Multi-account filter: ?account_ids=<uuid>,<uuid>,... (comma-separated).
// Malformed entries are dropped rather than 400ing — the SQL join
// re-validates tenant ownership + account type anyway, so a bad id can
// never widen the result set. Empty after filtering = no filter.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readAccountIds(req: { query: Record<string, unknown> }): string[] | null {
  const raw = req.query['account_ids'];
  if (!raw || typeof raw !== 'string') return null;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s));
  return ids.length > 0 ? ids : null;
}

// Optional grouping mode for P&L / Balance Sheet: ?group_by=detail_type.
// Anything else (absent, empty, unknown value) means "no grouping".
function readGroupBy(req: { query: Record<string, unknown> }): 'detail_type' | null {
  return req.query['group_by'] === 'detail_type' ? 'detail_type' : null;
}

// Display mode for exports: ?display=condensed collapses grouped
// sections to their subtotal rows only (used with group_by=detail_type
// so PDFs/CSVs mirror the on-screen condensed view). Rides along on the
// JSON response too (additive) where the client simply ignores it.
function readDisplay(req: { query: Record<string, unknown> }): 'condensed' | null {
  return req.query['display'] === 'condensed' ? 'condensed' : null;
}

// Financial Statements
reportsRouter.get('/profit-loss', async (req, res) => {
  const { start_date, end_date, basis, format, compare, periods, period_type } = req.query as Record<string, string>;
  const today = new Date();
  const sd = start_date || `${today.getFullYear()}-01-01`;
  const ed = end_date || today.toISOString().split('T')[0]!;
  const b = readBasis(req);
  const companyId = resolveCompanyScope(req);
  const tagId = readTagFilter(req);

  const display = readDisplay(req);
  // ?show_pct=1 mirrors the on-screen "% of Revenue" toggle into the
  // standard P&L export (PDF/CSV gain the column).
  const showPct = req.query['show_pct'] === '1' || req.query['show_pct'] === 'true';
  if (compare) {
    const data = await comparisonService.buildComparativePL(
      req.tenantId, sd, ed, b,
      compare as any,
      parseInt(periods || '6'),
      (period_type as any) || 'month',
      companyId,
      readGroupBy(req),
    );
    await respond(res, { ...data, ...(display ? { display } : {}), ...(showPct ? { showPct: true } : {}), ...readHideAcctNums(req) }, format);
  } else {
    const data = await reportService.buildProfitAndLoss(req.tenantId, sd, ed, b, companyId, tagId, readGroupBy(req));
    await respond(res, { ...data, ...(display ? { display } : {}), ...(showPct ? { showPct: true } : {}), ...readHideAcctNums(req) }, format);
  }
});

reportsRouter.get('/balance-sheet', async (req, res) => {
  const { as_of_date, basis, format, compare } = req.query as Record<string, string>;
  const companyId = resolveCompanyScope(req);
  const tagId = readTagFilter(req);
  const display = readDisplay(req);
  if (compare) {
    const data = await comparisonService.buildComparativeBS(
      req.tenantId,
      as_of_date || new Date().toISOString().split('T')[0]!,
      readBasis(req),
      compare as any,
      companyId,
      readGroupBy(req),
    );
    await respond(res, { ...data, ...(display ? { display } : {}), ...readHideAcctNums(req) }, format);
    return;
  }
  const data = await reportService.buildBalanceSheet(
    req.tenantId,
    as_of_date || new Date().toISOString().split('T')[0]!,
    readBasis(req),
    companyId,
    tagId,
    readGroupBy(req),
  );
  await respond(res, { ...data, ...(display ? { display } : {}), ...readHideAcctNums(req) }, format);
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
  // ?display=detail expands each vendor into per-account totals + a vendor
  // total; the default stays the flat vendor→total summary.
  const detail = req.query['display'] === 'detail';
  const data = await reportService.buildExpenseByVendor(
    req.tenantId,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
    resolveCompanyScope(req), readTagFilter(req), detail, readBasis(req),
  );
  if (detail) {
    // Detail exports flatten via the vendorGroups branch in
    // extractDataAndColumns (vendor header, account rows, vendor subtotal).
    await respond(res, data, format);
    return;
  }
  await respond(res, { ...data, _exportColumns: [
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'total', label: 'Total', align: 'right' },
  ]}, format);
});

// Revenues / Assets / Liabilities / Equity by account — same GL-style detail
// (and summary) as Expenses by Category, for the other account-type groups.
function accountDetailReportRoute(
  path: string,
  cfg: { title: string; accountTypes: string[]; normalSide: 'debit' | 'credit'; summaryLabel: string; carryForward?: boolean },
) {
  reportsRouter.get(path, async (req, res) => {
    const { start_date, end_date, format } = req.query as Record<string, string>;
    const today = new Date();
    const detail = req.query['display'] === 'detail';
    const data = await reportService.buildAccountDetailReport(
      req.tenantId,
      start_date || `${today.getFullYear()}-01-01`,
      end_date || today.toISOString().split('T')[0]!,
      {
        title: cfg.title,
        accountTypes: cfg.accountTypes,
        normalSide: cfg.normalSide,
        companyId: resolveCompanyScope(req),
        tagId: readTagFilter(req),
        accountIds: readAccountIds(req),
        detail,
        carryForward: cfg.carryForward ?? false,
        basis: readBasis(req),
      },
    );
    if (detail) { await respond(res, data, format); return; }
    await respond(res, { ...data, _exportColumns: [
      { key: 'account_number', label: '#' },
      { key: 'category', label: cfg.summaryLabel },
      { key: 'total', label: 'Total', align: 'right' },
    ]}, format);
  });
}
// Revenues reset each period (P&L); the balance-sheet groups carry a
// beginning balance forward so the running balance ties to the Balance Sheet.
accountDetailReportRoute('/revenue-by-category', { title: 'Revenues by Category', accountTypes: ['revenue', 'other_revenue'], normalSide: 'credit', summaryLabel: 'Category' });
accountDetailReportRoute('/assets-by-account', { title: 'Assets by Account', accountTypes: ['asset'], normalSide: 'debit', summaryLabel: 'Account', carryForward: true });
accountDetailReportRoute('/liabilities-by-account', { title: 'Liabilities by Account', accountTypes: ['liability'], normalSide: 'credit', summaryLabel: 'Account', carryForward: true });
accountDetailReportRoute('/equity-by-account', { title: 'Equity by Account', accountTypes: ['equity'], normalSide: 'credit', summaryLabel: 'Account', carryForward: true });

reportsRouter.get('/expense-by-category', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date();
  // ?display=detail switches to the GL-style per-account view (groups +
  // grandTotal ride along in the JSON; exports mirror the sectioned
  // screen). The DEFAULT (no display param) stays summary-shaped for
  // api-v2 / MCP / older clients — additive-param precedent, same as
  // group_by / display=condensed elsewhere.
  const detail = req.query['display'] === 'detail';
  const data = await reportService.buildExpenseByCategory(
    req.tenantId,
    start_date || `${today.getFullYear()}-01-01`,
    end_date || today.toISOString().split('T')[0]!,
    resolveCompanyScope(req),
    readTagFilter(req),
    readAccountIds(req),
    detail,
    readBasis(req),
  );
  if (detail) {
    // Detail exports are flattened by the dedicated groups+grandTotal
    // branch in extractDataAndColumns (section headers, transaction
    // lines, per-account subtotals, grand TOTAL) — no _exportColumns.
    await respond(res, data, format);
    return;
  }
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
    readBasis(req),
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
    readBasis(req),
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
reportsRouter.get('/bank-balances', async (req, res) => {
  const { as_of_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildBankBalances(
    req.tenantId,
    as_of_date || new Date().toISOString().split('T')[0]!,
    resolveCompanyScope(req),
  );
  // Export rows mirror the on-screen table: one row per bank account
  // plus a TOTAL row. Right-aligned numbers are formatted by
  // extractDataAndColumns (fmtNum) like every other report export.
  const exportRows = [
    ...data.accounts.map((a) => ({
      account: a.accountNumber ? `${a.accountNumber} · ${a.name}` : a.name,
      balance: a.balance,
    })),
    { account: 'TOTAL', balance: data.totalBalance },
  ];
  await respond(res, {
    ...data,
    data: exportRows,
    _exportColumns: [
      { key: 'account', label: 'Account' },
      { key: 'balance', label: 'Balance', align: 'right' },
    ],
  }, format);
});

reportsRouter.get('/bank-reconciliation-summary', async (req, res) => {
  const data = await reportService.buildBankReconciliationSummary(req.tenantId, (req.query['account_id'] as string) || '', resolveCompanyScope(req));
  // Export mirrors the on-screen shape: the per-account summary table,
  // then a stale-outstanding-checks section (legacy '---' section marker —
  // rendered as a full-width band in PDF and a label row in CSV).
  const exportRows: Array<Record<string, unknown>> = data.accounts.map((a) => ({
    account: a.accountNumber ? `${a.accountNumber} · ${a.name}` : a.name,
    last_reconciled: a.lastReconciledDate ?? '',
    reconciled_balance: a.lastReconciledBalance,
    latest_statement: a.latestStatementEnd ?? '',
    gap_months: a.statementGapCount,
    uncleared_items: a.unclearedCount,
    oldest_uncleared: a.oldestUnclearedDate ?? '',
  }));
  if (data.staleChecks.length > 0) {
    exportRows.push({ account: '--- Stale Outstanding Checks (older than 90 days) ---' });
    for (const c of data.staleChecks) {
      exportRows.push({
        account: c.accountName,
        last_reconciled: c.txnDate,
        latest_statement: `Check #${c.checkNumber ?? '?'}${c.payee ? ` — ${c.payee}` : ''}`,
        reconciled_balance: c.amount,
      });
    }
  }
  await respond(res, {
    ...data,
    data: exportRows,
    _exportColumns: [
      { key: 'account', label: 'Account' },
      { key: 'last_reconciled', label: 'Last Reconciled / Check Date' },
      { key: 'reconciled_balance', label: 'Balance / Amount', align: 'right' },
      { key: 'latest_statement', label: 'Latest Statement / Check' },
      // No `align: right` on count columns — right-aligned export cells run
      // through fmtNum, which would render the integer counts as "1.00".
      { key: 'gap_months', label: 'Missing Months' },
      { key: 'uncleared_items', label: 'Uncleared Items' },
      { key: 'oldest_uncleared', label: 'Oldest Uncleared' },
    ],
  }, req.query['format'] as string);
});

// Completed-reconciliation detail report. Requires ?reconciliation_id= —
// linked from the Reconciliation History page (not the reports landing
// page, which has no reconciliation picker).
reportsRouter.get('/reconciliation-detail', async (req, res) => {
  const reconciliationId = req.query['reconciliation_id'] as string | undefined;
  if (!reconciliationId) {
    res.status(400).json({ error: { message: 'reconciliation_id is required', code: 'VALIDATION_ERROR' } });
    return;
  }
  const data = await reportService.buildReconciliationDetail(req.tenantId, reconciliationId);
  const lineRow = (l: typeof data.cleared[number]) => ({
    txn_date: l.txnDate,
    txn_type: l.txnType,
    txn_number: l.txnNumber ?? '',
    description: l.description ?? '',
    payment: l.payment,
    deposit: l.deposit,
  });
  const exportRows: Array<Record<string, unknown>> = [
    { txn_date: `--- Cleared Transactions (${data.cleared.length}) ---` },
    ...data.cleared.map(lineRow),
    {
      txn_date: 'Total Cleared', payment: data.totals.clearedPayments, deposit: data.totals.clearedDeposits, _total: true,
    },
    { txn_date: `--- Uncleared as of ${data.reconciliation.statementDate} (${data.uncleared.length}) ---` },
    ...data.uncleared.map(lineRow),
    {
      txn_date: 'Total Uncleared', payment: data.totals.unclearedPayments, deposit: data.totals.unclearedDeposits, _total: true,
    },
  ];
  await respond(res, {
    ...data,
    // ASCII-only title: it feeds the Content-Disposition filename, where a
    // non-Latin-1 character (em dash) makes res.setHeader throw.
    title: `Reconciliation Detail - ${data.reconciliation.accountName} ${data.reconciliation.statementDate}`,
    data: exportRows,
    _exportColumns: [
      { key: 'txn_date', label: 'Date' },
      { key: 'txn_type', label: 'Type' },
      { key: 'txn_number', label: 'Number' },
      { key: 'description', label: 'Description' },
      { key: 'payment', label: 'Payment', align: 'right' },
      { key: 'deposit', label: 'Deposit', align: 'right' },
    ],
  }, req.query['format'] as string);
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
  const data = await reportService.buildGeneralLedger(req.tenantId, start_date || `${today.getFullYear()}-01-01`, end_date || today.toISOString().split('T')[0]!, resolveCompanyScope(req), readTagFilter(req), readBasis(req));
  await respond(res, { ...data, ...readHideAcctNums(req) }, format);
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
    readBasis(req),
  );
  await respond(res, { ...data, _exportColumns: [
    { key: 'account_number', label: '#' },
    { key: 'name', label: 'Account' },
    { key: 'account_type', label: 'Type' },
    // Proper TB format: each account's NET balance in exactly one
    // column (rows also carry gross total_debit/total_credit for
    // API compatibility — see buildTrialBalance).
    { key: 'debit', label: 'Debit', align: 'right' },
    { key: 'credit', label: 'Credit', align: 'right' },
  ]}, format);
});

// Account Activity Summary — per-account gross debits/credits for the
// period plus a signed Net column. Preserves the activity-sums view the
// Trial Balance had before it moved to netted single-column format.
reportsRouter.get('/account-activity-summary', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const today = new Date().toISOString().split('T')[0]!;
  const year = new Date().getFullYear();
  const data = await reportService.buildAccountActivitySummary(
    req.tenantId,
    start_date || `${year}-01-01`,
    end_date || today,
    resolveCompanyScope(req),
    readTagFilter(req),
  );
  await respond(res, { ...data, _exportColumns: [
    { key: 'account_number', label: '#' },
    { key: 'name', label: 'Account' },
    { key: 'account_type', label: 'Type' },
    { key: 'total_debit', label: 'Total Debits', align: 'right' },
    { key: 'total_credit', label: 'Total Credits', align: 'right' },
    { key: 'net', label: 'Net', align: 'right' },
  ]}, format);
});

reportsRouter.get('/transaction-list', async (req, res) => {
  const { start_date, end_date, txn_type, account_id, format } = req.query as Record<string, string>;
  const tagId = readTagFilter(req);
  const data = await reportService.buildTransactionList(req.tenantId, { startDate: start_date, endDate: end_date, txnType: txn_type, accountId: account_id, ...(tagId ? { tagId } : {}), basis: readBasis(req) }, resolveCompanyScope(req));
  // One row per journal line: mark the first line of each transaction so the
  // PDF draws a thicker rule between transactions. Wide 8-column layout →
  // landscape.
  const listRows = (data.data as Array<{ id?: string }>).map((r, i, arr) => ({
    ...r,
    _groupStart: i > 0 && r.id !== arr[i - 1]!.id,
  }));
  await respond(res, { ...data, data: listRows, _landscape: true, _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_type', label: 'Type' },
    { key: 'txn_number', label: 'Number' },
    { key: 'contact_name', label: 'Contact' },
    { key: 'account', label: 'Account' },
    // Signed to the accounting convention: debits positive, credits negative.
    { key: 'amount', label: 'Amount', align: 'right' },
    { key: 'memo', label: 'Memo' },
    // Per-line tag.
    { key: 'line_tag', label: 'Tag' },
  ]}, format);
});

reportsRouter.get('/journal-entry-report', async (req, res) => {
  const { start_date, end_date, format } = req.query as Record<string, string>;
  const data = await reportService.buildJournalEntryReport(req.tenantId, { startDate: start_date, endDate: end_date }, resolveCompanyScope(req), readTagFilter(req));
  // One row per journal line so every debit/credit of each entry is shown.
  await respond(res, { ...data, title: 'Journal Entry Report', _exportColumns: [
    { key: 'txn_date', label: 'Date' },
    { key: 'txn_number', label: 'Number' },
    { key: 'account', label: 'Account' },
    { key: 'debit', label: 'Debit', align: 'right' },
    { key: 'credit', label: 'Credit', align: 'right' },
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
