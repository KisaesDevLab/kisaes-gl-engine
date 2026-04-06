import { eq, and, sql, lte, gte, between, count, or, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, journalLines, accounts, contacts } from '../db/schema/index.js';

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

// ─── FINANCIAL STATEMENTS ────────────────────────────────────────

export async function buildProfitAndLoss(tenantId: string, startDate: string, endDate: string, basis: Basis = 'accrual') {
  const rows = await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
        AND txn_date >= ${startDate} AND txn_date <= ${endDate}
      )
    WHERE a.tenant_id = ${tenantId} AND a.account_type IN ('revenue', 'expense')
    GROUP BY a.id ORDER BY a.account_number, a.name
  `);

  const revenue: Array<{ name: string; accountNumber: string | null; amount: number }> = [];
  const expenses: Array<{ name: string; accountNumber: string | null; amount: number }> = [];
  let totalRevenue = 0, totalExpenses = 0;

  for (const row of rows.rows as any[]) {
    const amount = Math.abs(parseFloat(row.total_credit) - parseFloat(row.total_debit));
    if (amount === 0) continue;
    const entry = { name: row.name, accountNumber: row.account_number, amount };
    if (row.account_type === 'revenue') {
      revenue.push(entry);
      totalRevenue += amount;
    } else {
      expenses.push(entry);
      totalExpenses += amount;
    }
  }

  return {
    title: 'Profit and Loss',
    startDate, endDate, basis,
    revenue, totalRevenue,
    expenses, totalExpenses,
    netIncome: totalRevenue - totalExpenses,
  };
}

export async function buildBalanceSheet(tenantId: string, asOfDate: string, basis: Basis = 'accrual') {
  const rows = await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type, a.system_tag,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
        AND txn_date <= ${asOfDate}
      )
    WHERE a.tenant_id = ${tenantId} AND a.account_type IN ('asset', 'liability', 'equity')
    GROUP BY a.id ORDER BY a.account_number, a.name
  `);

  const assets: Array<{ name: string; accountNumber: string | null; balance: number }> = [];
  const liabilities: Array<{ name: string; accountNumber: string | null; balance: number }> = [];
  const equity: Array<{ name: string; accountNumber: string | null; balance: number }> = [];
  let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;

  for (const row of rows.rows as any[]) {
    // Skip the Retained Earnings system account — we compute it dynamically below
    if (row.system_tag === 'retained_earnings') continue;
    const balance = parseFloat(row.total_debit) - parseFloat(row.total_credit);
    if (balance === 0) continue;
    const entry = { name: row.name, accountNumber: row.account_number, balance };
    if (row.account_type === 'asset') { assets.push(entry); totalAssets += balance; }
    else if (row.account_type === 'liability') { liabilities.push(entry); totalLiabilities += Math.abs(balance); }
    else { equity.push(entry); totalEquity += Math.abs(balance); }
  }

  // Automatic year-end closing: split into Retained Earnings (prior years) + Current Year Net Income
  // Get fiscal year start month
  const companyRow = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE tenant_id = ${tenantId} LIMIT 1`);
  const fyStartMonth = (companyRow.rows as any[])[0]?.fiscal_year_start_month || 1;

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
  })(), basis);
  if (retainedPL.netIncome !== 0) {
    equity.push({ name: 'Retained Earnings (Prior Years)', accountNumber: null, balance: retainedPL.netIncome });
    totalEquity += retainedPL.netIncome;
  }

  // Current year net income
  const currentPL = await buildProfitAndLoss(tenantId, currentFYStart, asOfDate, basis);
  if (currentPL.netIncome !== 0) {
    equity.push({ name: 'Net Income (Current Year)', accountNumber: null, balance: currentPL.netIncome });
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

export async function buildCashFlowStatement(tenantId: string, startDate: string, endDate: string) {
  // Simplified: operating = net income, investing/financing = transfers to/from asset accounts
  const pl = await buildProfitAndLoss(tenantId, startDate, endDate, 'accrual');
  return {
    title: 'Cash Flow Statement', startDate, endDate,
    operatingActivities: pl.netIncome,
    investingActivities: 0,
    financingActivities: 0,
    netChange: pl.netIncome,
  };
}

// ─── RECEIVABLES ─────────────────────────────────────────────────

export async function buildARAgingSummary(tenantId: string, asOfDate: string) {
  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.txn_date, t.due_date, t.total, t.amount_paid, t.balance_due,
      t.contact_id, c.display_name as customer_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE t.tenant_id = ${tenantId} AND t.txn_type = 'invoice' AND t.status = 'posted'
      AND t.invoice_status NOT IN ('paid', 'void')
      AND t.txn_date <= ${asOfDate}
    ORDER BY t.due_date
  `);

  const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
  const asOf = new Date(asOfDate);
  const details: any[] = [];

  for (const row of rows.rows as any[]) {
    const balance = parseFloat(row.balance_due || row.total || '0');
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

export async function buildARAgingDetail(tenantId: string, asOfDate: string) {
  return buildARAgingSummary(tenantId, asOfDate);
}

export async function buildCustomerBalanceSummary(tenantId: string) {
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name,
      COALESCE(SUM(CASE WHEN t.txn_type = 'invoice' AND t.status = 'posted' THEN CAST(t.balance_due AS DECIMAL) ELSE 0 END), 0) as balance
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
    WHERE c.tenant_id = ${tenantId} AND c.contact_type IN ('customer', 'both') AND c.is_active = true
    GROUP BY c.id ORDER BY c.display_name
  `);

  return {
    title: 'Customer Balance Summary',
    data: (rows.rows as any[]).filter(r => parseFloat(r.balance) !== 0),
  };
}

export async function buildCustomerBalanceDetail(tenantId: string) {
  return buildCustomerBalanceSummary(tenantId);
}

export async function buildInvoiceList(tenantId: string, filters?: { startDate?: string; endDate?: string; status?: string }) {
  const conditions = [sql`t.tenant_id = ${tenantId}`, sql`t.txn_type = 'invoice'`];
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

export async function buildExpenseByVendor(tenantId: string, startDate: string, endDate: string) {
  const rows = await db.execute(sql`
    SELECT COALESCE(c.display_name, 'Uncategorized') as vendor_name,
      SUM(jl.debit) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type = 'expense'
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND jl.debit > 0
    GROUP BY c.display_name ORDER BY total DESC
  `);

  return { title: 'Expenses by Vendor', startDate, endDate, data: rows.rows };
}

export async function buildExpenseByCategory(tenantId: string, startDate: string, endDate: string) {
  const rows = await db.execute(sql`
    SELECT a.name as category, a.account_number,
      SUM(jl.debit) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type = 'expense'
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND jl.debit > 0
    GROUP BY a.id ORDER BY total DESC
  `);

  return { title: 'Expenses by Category', startDate, endDate, data: rows.rows };
}

export async function buildVendorBalanceSummary(tenantId: string) {
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name,
      COALESCE(SUM(CASE WHEN t.status = 'posted' THEN CAST(t.total AS DECIMAL) ELSE 0 END), 0) as total_spent
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId} AND t.txn_type = 'expense'
    WHERE c.tenant_id = ${tenantId} AND c.contact_type IN ('vendor', 'both') AND c.is_active = true
    GROUP BY c.id ORDER BY c.display_name
  `);

  return { title: 'Vendor Balance Summary', data: rows.rows };
}

export async function buildTransactionListByVendor(tenantId: string, vendorId: string, dateRange?: DateRange) {
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.contact_id = ${vendorId}`,
    sql`t.status = 'posted'`,
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

export async function buildBankReconciliationSummary(tenantId: string, accountId: string) {
  return { title: 'Bank Reconciliation Summary', accountId, data: [] };
}

export async function buildDepositDetail(tenantId: string, dateRange?: DateRange) {
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.txn_type = 'deposit'`,
    sql`t.status = 'posted'`,
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

export async function buildCheckRegister(tenantId: string, accountId: string, dateRange?: DateRange) {
  const conditions = [
    sql`jl.tenant_id = ${tenantId}`,
    sql`jl.account_id = ${accountId}`,
    sql`t.status = 'posted'`,
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

export async function buildSalesTaxLiability(tenantId: string, startDate: string, endDate: string) {
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(CAST(t.tax_amount AS DECIMAL)), 0) as total_tax,
      COALESCE(SUM(CAST(t.subtotal AS DECIMAL)), 0) as total_sales
    FROM transactions t
    WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_type IN ('invoice', 'cash_sale')
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
  `);

  const row = (rows.rows as any[])[0] || { total_tax: '0', total_sales: '0' };
  return {
    title: 'Sales Tax Liability', startDate, endDate,
    totalSales: parseFloat(row.total_sales),
    totalTax: parseFloat(row.total_tax),
  };
}

export async function buildTaxableSalesSummary(tenantId: string, startDate: string, endDate: string) {
  return buildSalesTaxLiability(tenantId, startDate, endDate);
}

export async function buildSalesTaxPayments(tenantId: string, startDate: string, endDate: string) {
  return { title: 'Sales Tax Payments', startDate, endDate, data: [] };
}

export async function build1099VendorSummary(tenantId: string, year: string) {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const rows = await db.execute(sql`
    SELECT c.id, c.display_name, c.tax_id,
      COALESCE(SUM(CAST(t.total AS DECIMAL)), 0) as total_paid
    FROM contacts c
    JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
      AND t.txn_type = 'expense' AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
    WHERE c.tenant_id = ${tenantId} AND c.is_1099_eligible = true
    GROUP BY c.id ORDER BY total_paid DESC
  `);

  return { title: '1099 Vendor Summary', year, data: rows.rows };
}

// ─── GENERAL ─────────────────────────────────────────────────────

export async function buildGeneralLedger(tenantId: string, startDate: string, endDate: string) {
  const rows = await db.execute(sql`
    SELECT a.id as account_id, a.account_number, a.name as account_name, a.account_type,
      jl.id as line_id, jl.debit, jl.credit, jl.description,
      t.txn_date, t.txn_type, t.txn_number, t.memo
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
    ORDER BY a.account_number, a.name, t.txn_date, jl.line_order
  `);

  return { title: 'General Ledger', startDate, endDate, data: rows.rows };
}

export async function buildTrialBalance(tenantId: string, startDate: string, endDate: string) {
  // Get fiscal year start month
  const companyRow = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE tenant_id = ${tenantId} LIMIT 1`);
  const fyStartMonth = (companyRow.rows as any[])[0]?.fiscal_year_start_month || 1;

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
    LEFT JOIN transactions t ON t.id = jl.transaction_id AND t.status = 'posted' AND t.txn_date <= ${endDate}
    WHERE a.tenant_id = ${tenantId}
    GROUP BY a.id
    HAVING COALESCE(SUM(jl.debit), 0) > 0 OR COALESCE(SUM(jl.credit), 0) > 0
    ORDER BY a.account_number, a.name
  `);

  let totalDebits = 0, totalCredits = 0;
  const data = (rows.rows as any[]).map(r => {
    const d = parseFloat(r.total_debit);
    const c = parseFloat(r.total_credit);
    totalDebits += d;
    totalCredits += c;
    return { ...r, total_debit: d, total_credit: c };
  });

  // Add Retained Earnings row for prior-year net income (virtual closing)
  if (fyStart > '1900-01-02') {
    const priorEndDate = new Date(fyStart);
    priorEndDate.setDate(priorEndDate.getDate() - 1);
    const priorEnd = priorEndDate.toISOString().split('T')[0]!;
    const retainedPL = await buildProfitAndLoss(tenantId, '1900-01-01', priorEnd, 'accrual');
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
}) {
  const conditions = [sql`t.tenant_id = ${tenantId}`, sql`t.status = 'posted'`];
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

export async function buildJournalEntryReport(tenantId: string, dateRange?: DateRange) {
  return buildTransactionList(tenantId, { ...dateRange, txnType: 'journal_entry' });
}

export async function buildAccountReport(tenantId: string, accountId: string, dateRange?: DateRange) {
  return buildCheckRegister(tenantId, accountId, dateRange);
}
