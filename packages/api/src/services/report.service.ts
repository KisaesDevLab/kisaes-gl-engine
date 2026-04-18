// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, lte, gte, between, count, or, ne } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import { type PLSectionLabels, isDebitNormal as isDebitNormalShared, COST_TYPES } from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, journalLines, accounts, contacts } from '../db/schema/index.js';
import { getPLLabels } from './tenant-report-settings.service.js';

// Money parsers. Reports expose `number` to the UI, but every SUM /
// DIFFERENCE runs through Decimal so aggregating hundreds of rows
// doesn't drift a P&L total or balance-sheet line by a few cents.
// Treat these helpers like `parseFloat` with exact arithmetic.
function num(x: string | number | null | undefined): number {
  return Number(new Decimal(x || 0).toFixed(4));
}
function sub(a: string | number | null | undefined, b: string | number | null | undefined): number {
  return Number(new Decimal(a || 0).minus(b || 0).toFixed(4));
}

type Basis = 'accrual' | 'cash';

interface DateRange { startDate?: string; endDate?: string }

// Helper: get posted txn filter
function postedFilter(tenantId: string) {
  return sql`jl.tenant_id = ${tenantId} AND jl.transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted')`;
}

function dateFilter(startDate?: string, endDate?: string) {
  const parts = [];
  if (startDate) parts.push(sql`t.txn_date >= ${startDate}`);
  if (endDate) parts.push(sql`t.txn_date <= ${endDate}`);
  return parts.length > 0 ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

function companyFilter(companyId: string | null, alias: string = 't') {
  if (!companyId) return sql`TRUE`;
  if (alias === 'jl') return sql`jl.company_id = ${companyId}`;
  return sql`t.company_id = ${companyId}`;
}

async function getFiscalYearStart(tenantId: string, companyId: string | null): Promise<number> {
  if (companyId) {
    const row = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE id = ${companyId}`);
    return (row.rows as any[])[0]?.fiscal_year_start_month ?? 1;
  }
  const row = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT 1`);
  return (row.rows as any[])[0]?.fiscal_year_start_month ?? 1;
}

// ─── FINANCIAL STATEMENTS ────────────────────────────────────────

export interface PLEntry { accountId: string; name: string; accountNumber: string | null; amount: number }

export interface PLResult {
  title: string;
  startDate: string;
  endDate: string;
  basis: Basis;
  labels: PLSectionLabels;
  revenue: PLEntry[];
  totalRevenue: number;
  cogs: PLEntry[];
  totalCogs: number;
  expenses: PLEntry[];
  totalExpenses: number;
  otherRevenue: PLEntry[];
  totalOtherRevenue: number;
  otherExpenses: PLEntry[];
  totalOtherExpenses: number;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number;
}

export async function buildProfitAndLoss(
  tenantId: string,
  startDate: string,
  endDate: string,
  basis: Basis = 'accrual',
  companyId: string | null = null,
): Promise<PLResult> {
  const rows = await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
        AND txn_date >= ${startDate} AND txn_date <= ${endDate}
        AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
      )
    WHERE a.tenant_id = ${tenantId}
      AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense')
    GROUP BY a.id ORDER BY a.account_number, a.name
  `);

  const revenue: PLEntry[] = [];
  const cogs: PLEntry[] = [];
  const expenses: PLEntry[] = [];
  const otherRevenue: PLEntry[] = [];
  const otherExpenses: PLEntry[] = [];
  let totalRevenue = 0;
  let totalCogs = 0;
  let totalExpenses = 0;
  let totalOtherRevenue = 0;
  let totalOtherExpenses = 0;

  for (const row of rows.rows as any[]) {
    const amount = Math.abs(sub(row.total_credit, row.total_debit));
    if (amount === 0) continue;
    const entry: PLEntry = { accountId: row.id, name: row.name, accountNumber: row.account_number, amount };
    switch (row.account_type) {
      case 'revenue': revenue.push(entry); totalRevenue += amount; break;
      case 'cogs': cogs.push(entry); totalCogs += amount; break;
      case 'expense': expenses.push(entry); totalExpenses += amount; break;
      case 'other_revenue': otherRevenue.push(entry); totalOtherRevenue += amount; break;
      case 'other_expense': otherExpenses.push(entry); totalOtherExpenses += amount; break;
    }
  }

  const hasCogs = cogs.length > 0;
  const hasOther = otherRevenue.length > 0 || otherExpenses.length > 0;
  const grossProfit = hasCogs ? totalRevenue - totalCogs : null;
  const operatingIncome = hasCogs || hasOther
    ? (grossProfit ?? totalRevenue) - totalExpenses
    : null;
  const netIncome =
    totalRevenue + totalOtherRevenue - totalCogs - totalExpenses - totalOtherExpenses;

  const labels = await getPLLabels(tenantId);

  return {
    title: 'Profit and Loss',
    startDate, endDate, basis,
    labels,
    revenue, totalRevenue,
    cogs, totalCogs,
    expenses, totalExpenses,
    otherRevenue, totalOtherRevenue,
    otherExpenses, totalOtherExpenses,
    grossProfit,
    operatingIncome,
    netIncome,
  };
}

export async function buildBalanceSheet(tenantId: string, asOfDate: string, basis: Basis = 'accrual', companyId: string | null = null) {
  const rows = await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type, a.system_tag,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
        AND txn_date <= ${asOfDate}
        AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
      )
    WHERE a.tenant_id = ${tenantId} AND a.account_type IN ('asset', 'liability', 'equity')
    GROUP BY a.id ORDER BY a.account_number, a.name
  `);

  type BSEntry = { accountId: string | null; name: string; accountNumber: string | null; balance: number };
  const assets: BSEntry[] = [];
  const liabilities: BSEntry[] = [];
  const equity: BSEntry[] = [];
  let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;

  for (const row of rows.rows as any[]) {
    // Skip the Retained Earnings system account — we compute it dynamically below
    if (row.system_tag === 'retained_earnings') continue;
    const balance = sub(row.total_debit, row.total_credit);
    if (balance === 0) continue;
    const entry: BSEntry = { accountId: row.id, name: row.name, accountNumber: row.account_number, balance };
    if (row.account_type === 'asset') { assets.push(entry); totalAssets += balance; }
    else if (row.account_type === 'liability') { liabilities.push(entry); totalLiabilities += Math.abs(balance); }
    else { equity.push(entry); totalEquity += Math.abs(balance); }
  }

  // Automatic year-end closing: split into Retained Earnings (prior years) + Current Year Net Income
  const fyStartMonth = await getFiscalYearStart(tenantId, companyId);

  // Compute current fiscal year start date
  const asOf = new Date(asOfDate);
  let currentFYStartYear = asOf.getFullYear();
  if (asOf.getMonth() + 1 < fyStartMonth) currentFYStartYear--;
  const currentFYStart = `${currentFYStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  // Retained Earnings = net income for all completed fiscal years (before current FY start)
  const retainedPL = await buildProfitAndLoss(tenantId, '1900-01-01', (() => {
    const d = new Date(currentFYStart);
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0]!;
  })(), basis, companyId);
  if (retainedPL.netIncome !== 0) {
    equity.push({ accountId: null, name: 'Retained Earnings (Prior Years)', accountNumber: null, balance: retainedPL.netIncome });
    totalEquity += retainedPL.netIncome;
  }

  // Current year net income
  const currentPL = await buildProfitAndLoss(tenantId, currentFYStart, asOfDate, basis, companyId);
  if (currentPL.netIncome !== 0) {
    equity.push({ accountId: null, name: 'Net Income (Current Year)', accountNumber: null, balance: currentPL.netIncome });
    totalEquity += currentPL.netIncome;
  }

  return {
    title: 'Balance Sheet', asOfDate, basis,
    assets, totalAssets,
    liabilities, totalLiabilities,
    equity, totalEquity,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
  };
}

export async function buildCashFlowStatement(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  const pl = await buildProfitAndLoss(tenantId, startDate, endDate, 'accrual', companyId);
  return {
    title: 'Cash Flow Statement', startDate, endDate,
    operatingActivities: pl.netIncome,
    investingActivities: 0,
    financingActivities: 0,
    netChange: pl.netIncome,
  };
}

// ─── RECEIVABLES ─────────────────────────────────────────────────

export async function buildARAgingSummary(tenantId: string, asOfDate: string, companyId: string | null = null) {
  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.txn_date, t.due_date, t.total, t.amount_paid, t.balance_due,
      t.contact_id, c.display_name as customer_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE t.tenant_id = ${tenantId} AND t.txn_type = 'invoice' AND t.status = 'posted'
      AND t.invoice_status NOT IN ('paid', 'void')
      AND t.txn_date <= ${asOfDate}
      AND ${companyFilter(companyId)}
    ORDER BY t.due_date
  `);

  const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
  const asOf = new Date(asOfDate);
  const details: any[] = [];

  for (const row of rows.rows as any[]) {
    const balance = num(row.balance_due || row.total || '0');
    if (balance <= 0) continue;
    const dueDate = new Date(row.due_date || row.txn_date);
    const daysOverdue = Math.floor((asOf.getTime() - dueDate.getTime()) / 86400000);

    let bucket: string;
    if (daysOverdue <= 0) { buckets.current += balance; bucket = 'current'; }
    else if (daysOverdue <= 30) { buckets.days1to30 += balance; bucket = '1-30'; }
    else if (daysOverdue <= 60) { buckets.days31to60 += balance; bucket = '31-60'; }
    else if (daysOverdue <= 90) { buckets.days61to90 += balance; bucket = '61-90'; }
    else { buckets.over90 += balance; bucket = '90+'; }

    details.push({ ...row, balance, daysOverdue, bucket });
  }

  return {
    title: 'AR Aging Summary', asOfDate,
    buckets, total: Object.values(buckets).reduce((a, b) => a + b, 0),
    details,
  };
}

export async function buildARAgingDetail(tenantId: string, asOfDate: string, companyId: string | null = null) {
  return buildARAgingSummary(tenantId, asOfDate, companyId);
}

export async function buildCustomerBalanceSummary(tenantId: string, companyId: string | null = null) {
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name,
      COALESCE(SUM(CASE WHEN t.txn_type = 'invoice' AND t.status = 'posted' THEN CAST(t.balance_due AS DECIMAL) ELSE 0 END), 0) as balance
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
      AND ${companyFilter(companyId)}
    WHERE c.tenant_id = ${tenantId} AND c.contact_type IN ('customer', 'both') AND c.is_active = true
    GROUP BY c.id ORDER BY c.display_name
  `);

  return {
    title: 'Customer Balance Summary',
    data: (rows.rows as any[]).filter(r => num(r.balance) !== 0),
  };
}

export async function buildCustomerBalanceDetail(tenantId: string, companyId: string | null = null) {
  return buildCustomerBalanceSummary(tenantId, companyId);
}

export async function buildInvoiceList(tenantId: string, filters?: { startDate?: string; endDate?: string; status?: string }, companyId: string | null = null) {
  const conditions = [sql`t.tenant_id = ${tenantId}`, sql`t.txn_type = 'invoice'`, companyFilter(companyId)];
  if (filters?.startDate) conditions.push(sql`t.txn_date >= ${filters.startDate}`);
  if (filters?.endDate) conditions.push(sql`t.txn_date <= ${filters.endDate}`);
  if (filters?.status) conditions.push(sql`t.invoice_status = ${filters.status}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.txn_date, t.due_date, t.total, t.amount_paid, t.balance_due,
      t.invoice_status, t.status, c.display_name as customer_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC
  `);

  return { title: 'Invoice List', data: rows.rows };
}

// ─── EXPENSES ────────────────────────────────────────────────────

export async function buildExpenseByVendor(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  const rows = await db.execute(sql`
    SELECT c.id as contact_id, COALESCE(c.display_name, 'Uncategorized') as vendor_name,
      SUM(jl.debit) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND jl.debit > 0
      AND ${companyFilter(companyId)}
    GROUP BY c.id, c.display_name ORDER BY total DESC
  `);

  return { title: 'Expenses by Vendor', startDate, endDate, data: rows.rows };
}

export async function buildExpenseByCategory(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  const rows = await db.execute(sql`
    SELECT a.id as account_id, a.name as category, a.account_number, a.account_type,
      SUM(jl.debit) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND jl.debit > 0
      AND ${companyFilter(companyId)}
    GROUP BY a.id ORDER BY total DESC
  `);

  return { title: 'Expenses by Category', startDate, endDate, data: rows.rows };
}

export async function buildVendorBalanceSummary(tenantId: string, companyId: string | null = null) {
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name,
      COALESCE(SUM(CASE WHEN t.status = 'posted' THEN CAST(t.total AS DECIMAL) ELSE 0 END), 0) as total_spent
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId} AND t.txn_type = 'expense'
      AND ${companyFilter(companyId)}
    WHERE c.tenant_id = ${tenantId} AND c.contact_type IN ('vendor', 'both') AND c.is_active = true
    GROUP BY c.id ORDER BY c.display_name
  `);

  return { title: 'Vendor Balance Summary', data: rows.rows };
}

export async function buildTransactionListByVendor(tenantId: string, vendorId: string, dateRange?: DateRange, companyId: string | null = null) {
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.contact_id = ${vendorId}`,
    sql`t.status = 'posted'`,
    companyFilter(companyId),
  ];
  if (dateRange?.startDate) conditions.push(sql`t.txn_date >= ${dateRange.startDate}`);
  if (dateRange?.endDate) conditions.push(sql`t.txn_date <= ${dateRange.endDate}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.total, t.memo
    FROM transactions t
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC
  `);

  return { title: 'Transactions by Vendor', vendorId, data: rows.rows };
}

// ─── BANKING ─────────────────────────────────────────────────────

export async function buildBankReconciliationSummary(tenantId: string, accountId: string, companyId: string | null = null) {
  return { title: 'Bank Reconciliation Summary', accountId, data: [] };
}

export async function buildDepositDetail(tenantId: string, dateRange?: DateRange, companyId: string | null = null) {
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.txn_type = 'deposit'`,
    sql`t.status = 'posted'`,
    companyFilter(companyId),
  ];
  if (dateRange?.startDate) conditions.push(sql`t.txn_date >= ${dateRange.startDate}`);
  if (dateRange?.endDate) conditions.push(sql`t.txn_date <= ${dateRange.endDate}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.txn_date, t.total, t.memo
    FROM transactions t
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC
  `);

  return { title: 'Deposit Detail', data: rows.rows };
}

export async function buildCheckRegister(tenantId: string, accountId: string, dateRange?: DateRange, companyId: string | null = null) {
  const conditions = [
    sql`jl.tenant_id = ${tenantId}`,
    sql`jl.account_id = ${accountId}`,
    sql`t.status = 'posted'`,
    companyFilter(companyId),
  ];
  if (dateRange?.startDate) conditions.push(sql`t.txn_date >= ${dateRange.startDate}`);
  if (dateRange?.endDate) conditions.push(sql`t.txn_date <= ${dateRange.endDate}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.memo,
      jl.debit, jl.credit
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC, t.created_at DESC
  `);

  return { title: 'Check Register', accountId, data: rows.rows };
}

// ─── TAX ─────────────────────────────────────────────────────────

export async function buildSalesTaxLiability(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(CAST(t.tax_amount AS DECIMAL)), 0) as total_tax,
      COALESCE(SUM(CAST(t.subtotal AS DECIMAL)), 0) as total_sales
    FROM transactions t
    WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_type IN ('invoice', 'cash_sale')
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
  `);

  const row = (rows.rows as any[])[0] || { total_tax: '0', total_sales: '0' };
  return {
    title: 'Sales Tax Liability', startDate, endDate,
    totalSales: num(row.total_sales),
    totalTax: num(row.total_tax),
  };
}

export async function buildTaxableSalesSummary(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  return buildSalesTaxLiability(tenantId, startDate, endDate, companyId);
}

export async function buildSalesTaxPayments(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  return { title: 'Sales Tax Payments', startDate, endDate, data: [] };
}

export async function build1099VendorSummary(tenantId: string, year: string, companyId: string | null = null) {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const rows = await db.execute(sql`
    SELECT c.id, c.display_name, c.tax_id,
      COALESCE(SUM(CAST(t.total AS DECIMAL)), 0) as total_paid
    FROM contacts c
    JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
      AND t.txn_type = 'expense' AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
    WHERE c.tenant_id = ${tenantId} AND c.is_1099_eligible = true
    GROUP BY c.id ORDER BY total_paid DESC
  `);

  return { title: '1099 Vendor Summary', year, data: rows.rows };
}

// ─── GENERAL ─────────────────────────────────────────────────────

/**
 * General Ledger report — properly grouped by account, with beginning
 * balance, line-by-line running balance, period totals, and ending
 * balance for each account. This matches the format any accountant or
 * auditor expects to see.
 *
 * Income statement accounts (revenue/expense) use a fiscal-year reset
 * for the beginning balance: their "beginning of period" balance is
 * computed from the fiscal year start, not from the beginning of time,
 * because revenue/expense accounts conceptually close to retained
 * earnings at fiscal year end. Balance sheet accounts (asset, liability,
 * equity) carry their cumulative balance forward forever.
 *
 * Running balances are shown using the natural sign convention:
 *   - debit-normal accounts (asset, expense):  balance = debits - credits
 *   - credit-normal accounts (liab, equity, revenue):  balance = credits - debits
 * so a "normal" balance is always displayed as a positive number.
 */
export async function buildGeneralLedger(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  const fyStartMonth = await getFiscalYearStart(tenantId, companyId);
  const startDt = new Date(startDate);
  let fyStartYear = startDt.getFullYear();
  if (startDt.getMonth() + 1 < fyStartMonth) fyStartYear--;
  const fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  // 1. All accounts (so we can include accounts that have beginning
  //    balance only and no period activity).
  const accountsResult = await db.execute(sql`
    SELECT id, account_number, name, account_type, system_tag, is_system
    FROM accounts
    WHERE tenant_id = ${tenantId}
    ORDER BY
      CASE account_type
        WHEN 'asset' THEN 1
        WHEN 'liability' THEN 2
        WHEN 'equity' THEN 3
        WHEN 'revenue' THEN 4
        WHEN 'expense' THEN 5
        ELSE 6
      END,
      account_number NULLS LAST,
      name
  `);

  // 2. Beginning balances (per account) — debit-side and credit-side sums
  //    of all activity strictly before the report startDate. For income
  //    statement accounts, only count activity from the fiscal year start.
  const beginResult = await db.execute(sql`
    SELECT a.id,
      COALESCE(SUM(
        CASE
          WHEN a.account_type IN ('asset','liability','equity') THEN jl.debit
          WHEN t.txn_date >= ${fyStart} THEN jl.debit
          ELSE 0
        END
      ), 0) AS begin_debit,
      COALESCE(SUM(
        CASE
          WHEN a.account_type IN ('asset','liability','equity') THEN jl.credit
          WHEN t.txn_date >= ${fyStart} THEN jl.credit
          ELSE 0
        END
      ), 0) AS begin_credit
    FROM accounts a
    LEFT JOIN journal_lines jl
      ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions
        WHERE tenant_id = ${tenantId} AND status = 'posted' AND txn_date < ${startDate}
        AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
      )
    LEFT JOIN transactions t
      ON t.id = jl.transaction_id
    WHERE a.tenant_id = ${tenantId}
    GROUP BY a.id
  `);

  // 3. Period activity (all journal lines in [startDate, endDate])
  const linesResult = await db.execute(sql`
    SELECT
      jl.id AS line_id,
      jl.account_id,
      jl.debit,
      jl.credit,
      jl.description AS line_description,
      jl.line_order,
      t.id AS transaction_id,
      t.txn_date,
      t.txn_type,
      t.txn_number,
      t.memo AS txn_memo,
      c.display_name AS contact_name
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE jl.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.txn_date >= ${startDate}
      AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
    ORDER BY jl.account_id, t.txn_date, t.created_at, jl.line_order
  `);

  // ── Build the response ───────────────────────────────────────
  type AccountRow = {
    id: string;
    account_number: string | null;
    name: string;
    account_type: string;
    system_tag: string | null;
    is_system: boolean;
  };
  type BeginRow = { id: string; begin_debit: string; begin_credit: string };
  type LineRow = {
    line_id: string;
    account_id: string;
    debit: string;
    credit: string;
    line_description: string | null;
    line_order: number;
    transaction_id: string;
    txn_date: string;
    txn_type: string;
    txn_number: string | null;
    txn_memo: string | null;
    contact_name: string | null;
  };

  const allAccounts = accountsResult.rows as unknown as AccountRow[];
  const beginRows = beginResult.rows as unknown as BeginRow[];
  const lines = linesResult.rows as unknown as LineRow[];

  // Index beginning balances and period lines by account id
  const beginMap = new Map<string, { debit: number; credit: number }>();
  for (const r of beginRows) {
    beginMap.set(r.id, { debit: num(r.begin_debit), credit: num(r.begin_credit) });
  }
  const linesByAccount = new Map<string, LineRow[]>();
  for (const line of lines) {
    const arr = linesByAccount.get(line.account_id) || [];
    arr.push(line);
    linesByAccount.set(line.account_id, arr);
  }

  // Helper: signed balance using the account's natural sign convention.
  // asset / cogs / expense / other_expense are debit-normal; the rest
  // (liability / equity / revenue / other_revenue) are credit-normal.
  const naturalBalance = (type: string, debit: number, credit: number) =>
    isDebitNormalShared(type) ? debit - credit : credit - debit;

  let totalDebits = 0;
  let totalCredits = 0;

  const accounts = allAccounts
    .map((acct) => {
      const begin = beginMap.get(acct.id) || { debit: 0, credit: 0 };
      const beginningBalance = naturalBalance(acct.account_type, begin.debit, begin.credit);
      const periodLines = linesByAccount.get(acct.id) || [];

      // Skip accounts with no activity AND no beginning balance — they're
      // noise on the report. (This is what every commercial GL does.)
      if (periodLines.length === 0 && Math.abs(beginningBalance) < 0.005) {
        return null;
      }

      let running = beginningBalance;
      let periodDebits = 0;
      let periodCredits = 0;

      const reportLines = periodLines.map((line) => {
        const debit = num(line.debit);
        const credit = num(line.credit);
        // Running balance accumulates through many lines — running +=
        // naturalBalance via float drifts at the cent level. Go
        // through Decimal on every add to keep the GL column exact.
        running = Number(new Decimal(running).plus(naturalBalance(acct.account_type, debit, credit)).toFixed(4));
        periodDebits = Number(new Decimal(periodDebits).plus(debit).toFixed(4));
        periodCredits = Number(new Decimal(periodCredits).plus(credit).toFixed(4));

        return {
          lineId: line.line_id,
          transactionId: line.transaction_id,
          date: line.txn_date,
          txnType: line.txn_type,
          txnNumber: line.txn_number,
          contactName: line.contact_name,
          // Prefer the per-line description, fall back to the transaction memo
          description: line.line_description || line.txn_memo || '',
          debit,
          credit,
          runningBalance: running,
        };
      });

      totalDebits += periodDebits;
      totalCredits += periodCredits;

      return {
        id: acct.id,
        accountNumber: acct.account_number,
        name: acct.name,
        accountType: acct.account_type,
        normalBalance: isDebitNormalShared(acct.account_type) ? ('debit' as const) : ('credit' as const),
        beginningBalance,
        lines: reportLines,
        periodDebits,
        periodCredits,
        endingBalance: running,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  return {
    title: 'General Ledger',
    startDate,
    endDate,
    fiscalYearStart: fyStart,
    accounts,
    totalDebits,
    totalCredits,
  };
}

export async function buildTrialBalance(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  const fyStartMonth = await getFiscalYearStart(tenantId, companyId);

  // Compute current fiscal year start based on the report end date
  const endDt = new Date(endDate);
  let fyStartYear = endDt.getFullYear();
  if (endDt.getMonth() + 1 < fyStartMonth) fyStartYear--;
  const fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  // For balance sheet accounts (asset, liability, equity): show cumulative balance through end date
  // For income statement accounts (revenue, expense): show balance only from fiscal year start through end date
  // This implements virtual year-end closing — revenue/expense reset at fiscal year boundaries

  const rows = await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.account_type,
      COALESCE(SUM(
        CASE WHEN a.account_type IN ('asset', 'liability', 'equity')
          THEN jl.debit ELSE
          CASE WHEN t.txn_date >= ${fyStart} THEN jl.debit ELSE 0 END
        END
      ), 0) as total_debit,
      COALESCE(SUM(
        CASE WHEN a.account_type IN ('asset', 'liability', 'equity')
          THEN jl.credit ELSE
          CASE WHEN t.txn_date >= ${fyStart} THEN jl.credit ELSE 0 END
        END
      ), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions
        WHERE tenant_id = ${tenantId} AND status = 'posted' AND txn_date <= ${endDate}
        AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
      )
    LEFT JOIN transactions t ON t.id = jl.transaction_id
    WHERE a.tenant_id = ${tenantId}
    GROUP BY a.id
    HAVING COALESCE(SUM(jl.debit), 0) > 0 OR COALESCE(SUM(jl.credit), 0) > 0
    ORDER BY a.account_number, a.name
  `);

  // Trial balance totals must tie out to the penny for every user.
  // Accumulate through Decimal so the "totalDebits === totalCredits"
  // check at the bottom of the report isn't off by fractional cents.
  let td = new Decimal('0');
  let tc = new Decimal('0');
  const data = (rows.rows as any[]).map(r => {
    const d = num(r.total_debit);
    const c = num(r.total_credit);
    td = td.plus(d);
    tc = tc.plus(c);
    return { ...r, total_debit: d, total_credit: c };
  });
  const totalDebits = Number(td.toFixed(4));
  const totalCredits = Number(tc.toFixed(4));

  // Add Retained Earnings row for prior-year net income (virtual closing)
  if (fyStart > '1900-01-02') {
    const priorEndDate = new Date(fyStart);
    priorEndDate.setDate(priorEndDate.getDate() - 1);
    const priorEnd = priorEndDate.toISOString().split('T')[0]!;
    const retainedPL = await buildProfitAndLoss(tenantId, '1900-01-01', priorEnd, 'accrual', companyId);
    if (retainedPL.netIncome !== 0) {
      // Retained earnings is a credit-balance equity account
      const reDebit = retainedPL.netIncome < 0 ? Math.abs(retainedPL.netIncome) : 0;
      const reCredit = retainedPL.netIncome > 0 ? retainedPL.netIncome : 0;
      data.push({
        id: null, account_number: '3900', name: 'Retained Earnings', account_type: 'equity',
        total_debit: reDebit, total_credit: reCredit,
      });
      totalDebits += reDebit;
      totalCredits += reCredit;
    }
  }

  // Sort by account number to maintain proper order after adding Retained Earnings
  data.sort((a: any, b: any) => {
    const numA = a.account_number || '9999';
    const numB = b.account_number || '9999';
    return numA.localeCompare(numB, undefined, { numeric: true });
  });

  return { title: 'Trial Balance', startDate, endDate, data, totalDebits, totalCredits };
}

export async function buildTransactionList(tenantId: string, filters?: {
  startDate?: string; endDate?: string; txnType?: string; accountId?: string;
}, companyId: string | null = null) {
  const conditions = [sql`t.tenant_id = ${tenantId}`, sql`t.status = 'posted'`, companyFilter(companyId)];
  if (filters?.startDate) conditions.push(sql`t.txn_date >= ${filters.startDate}`);
  if (filters?.endDate) conditions.push(sql`t.txn_date <= ${filters.endDate}`);
  if (filters?.txnType) conditions.push(sql`t.txn_type = ${filters.txnType}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.total, t.memo, t.status,
      c.display_name as contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC, t.created_at DESC
  `);

  return { title: 'Transaction List', data: rows.rows };
}

export async function buildJournalEntryReport(tenantId: string, dateRange?: DateRange, companyId: string | null = null) {
  return buildTransactionList(tenantId, { ...dateRange, txnType: 'journal_entry' }, companyId);
}

export async function buildAccountReport(tenantId: string, accountId: string, dateRange?: DateRange, companyId: string | null = null) {
  return buildCheckRegister(tenantId, accountId, dateRange, companyId);
}
