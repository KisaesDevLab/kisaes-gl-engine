// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, journalLines, accounts, bankFeedItems, reconciliations } from '../db/schema/index.js';

async function getFiscalYearStart(tenantId: string): Promise<string> {
  const result = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE tenant_id = ${tenantId} LIMIT 1`);
  const fyStartMonth = (result.rows as any[])[0]?.fiscal_year_start_month || 1;
  const now = new Date();
  let year = now.getFullYear();
  // If we haven't reached the FY start month yet this calendar year, FY started last year
  if (now.getMonth() + 1 < fyStartMonth) year--;
  return `${year}-${String(fyStartMonth).padStart(2, '0')}-01`;
}

export async function getFinancialSnapshot(tenantId: string) {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const ytdStart = await getFiscalYearStart(tenantId);
  const mtdStart = `${now.getFullYear()}-${month}-01`;
  const today = now.toISOString().split('T')[0]!;

  async function getPL(start: string, end: string) {
    const rows = await db.execute(sql`
      SELECT a.account_type,
        COALESCE(SUM(jl.debit), 0) as total_debit,
        COALESCE(SUM(jl.credit), 0) as total_credit
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
        AND t.txn_date >= ${start} AND t.txn_date <= ${end}
        AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense')
      GROUP BY a.account_type
    `);

    let revenue = 0, expenses = 0;
    for (const row of rows.rows as any[]) {
      const amt = Math.abs(parseFloat(row.total_credit) - parseFloat(row.total_debit));
      if (row.account_type === 'revenue' || row.account_type === 'other_revenue') revenue += amt;
      else expenses += amt;
    }
    return { revenue, expenses, netIncome: revenue - expenses };
  }

  const mtd = await getPL(mtdStart, today);
  const ytd = await getPL(ytdStart, today);

  return { mtd, ytd };
}

export async function getRevExpTrend(tenantId: string, months: number = 6) {
  const data: Array<{ month: string; revenue: number; expenses: number }> = [];
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const endD = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const end = `${endD.getFullYear()}-${String(endD.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

    const rows = await db.execute(sql`
      SELECT a.account_type,
        COALESCE(SUM(jl.debit), 0) as total_debit,
        COALESCE(SUM(jl.credit), 0) as total_credit
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
        AND t.txn_date >= ${start} AND t.txn_date <= ${end}
        AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense')
      GROUP BY a.account_type
    `);

    let revenue = 0, expenses = 0;
    for (const row of rows.rows as any[]) {
      const amt = Math.abs(parseFloat(row.total_credit) - parseFloat(row.total_debit));
      if (row.account_type === 'revenue' || row.account_type === 'other_revenue') revenue += amt;
      else expenses += amt;
    }
    data.push({ month: label, revenue, expenses });
  }

  return data;
}

export async function getCashPosition(tenantId: string) {
  const rows = await db.execute(sql`
    SELECT a.id, a.name, a.account_number, a.detail_type, a.balance
    FROM accounts a
    WHERE a.tenant_id = ${tenantId} AND a.is_active = true
      AND a.detail_type IN ('bank', 'credit_card')
    ORDER BY a.detail_type, a.account_number, a.name
  `);

  const bankAccounts: Array<{ name: string; balance: number }> = [];
  const creditCards: Array<{ name: string; balance: number }> = [];

  for (const row of rows.rows as any[]) {
    const entry = { name: row.name, balance: parseFloat(row.balance || '0') };
    if (row.detail_type === 'bank') bankAccounts.push(entry);
    else creditCards.push(entry);
  }

  return {
    bankAccounts,
    creditCards,
    totalBank: bankAccounts.reduce((s, a) => s + a.balance, 0),
    totalCC: creditCards.reduce((s, a) => s + Math.abs(a.balance), 0),
  };
}

export async function getReceivablesSummary(tenantId: string) {
  const today = new Date().toISOString().split('T')[0]!;

  const rows = await db.execute(sql`
    SELECT t.id, t.due_date, t.balance_due, t.total
    FROM transactions t
    WHERE t.tenant_id = ${tenantId} AND t.txn_type = 'invoice' AND t.status = 'posted'
      AND t.invoice_status NOT IN ('paid', 'void')
  `);

  let totalOutstanding = 0, overdueCount = 0, overdueAmount = 0;
  const todayDate = new Date(today);

  for (const row of rows.rows as any[]) {
    const balance = parseFloat(row.balance_due || row.total || '0');
    if (balance <= 0) continue;
    totalOutstanding += balance;

    const due = new Date(row.due_date || row.txn_date);
    if (due < todayDate) {
      overdueCount++;
      overdueAmount += balance;
    }
  }

  return {
    totalOutstanding,
    overdueCount,
    overdueAmount,
    invoiceCount: (rows.rows as any[]).length,
  };
}

export async function getPayablesSummary(tenantId: string) {
  const today = new Date().toISOString().split('T')[0]!;

  // Open bills for this tenant
  const billsResult = await db.execute(sql`
    SELECT t.id, t.due_date, t.balance_due, t.total
    FROM transactions t
    WHERE t.tenant_id = ${tenantId}
      AND t.txn_type = 'bill'
      AND t.status = 'posted'
      AND t.bill_status IN ('unpaid', 'partial', 'overdue')
      AND COALESCE(t.balance_due, 0) > 0
  `);

  const todayDate = new Date(today);
  const oneWeek = new Date(todayDate);
  oneWeek.setDate(oneWeek.getDate() + 7);

  let totalOwed = 0;
  let overdueCount = 0;
  let overdueAmount = 0;
  let dueThisWeekCount = 0;
  let dueThisWeekAmount = 0;
  let billCount = 0;

  for (const row of billsResult.rows as any[]) {
    const balance = parseFloat(row.balance_due || row.total || '0');
    if (balance <= 0) continue;
    billCount++;
    totalOwed += balance;

    if (row.due_date) {
      const due = new Date(row.due_date);
      if (due < todayDate) {
        overdueCount++;
        overdueAmount += balance;
      } else if (due <= oneWeek) {
        dueThisWeekCount++;
        dueThisWeekAmount += balance;
      }
    }
  }

  // Available vendor credits
  const creditsResult = await db.execute(sql`
    SELECT COUNT(*) as count, COALESCE(SUM(CAST(balance_due AS DECIMAL)), 0) as total
    FROM transactions
    WHERE tenant_id = ${tenantId}
      AND txn_type = 'vendor_credit'
      AND status = 'posted'
      AND COALESCE(balance_due, 0) > 0
  `);
  const creditCount = parseInt((creditsResult.rows as any[])[0]?.count || '0');
  const creditAmount = parseFloat((creditsResult.rows as any[])[0]?.total || '0');

  // AP balance from the system account (defensive — falls back to bill total)
  const apResult = await db.execute(sql`
    SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as balance
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id AND a.system_tag = 'accounts_payable'
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
  `);
  const apBalance = parseFloat((apResult.rows as any[])[0]?.balance || '0');

  return {
    totalOwed,
    billCount,
    overdueCount,
    overdueAmount,
    dueThisWeekCount,
    dueThisWeekAmount,
    creditCount,
    creditAmount,
    apBalance,
  };
}

export async function getActionItems(tenantId: string) {
  // Pending bank feed items
  const feedResult = await db.execute(sql`
    SELECT COUNT(*) as count FROM bank_feed_items
    WHERE tenant_id = ${tenantId} AND status = 'pending'
  `);
  const pendingFeedCount = parseInt((feedResult.rows as any[])[0]?.count || '0');

  // Overdue invoices
  const today = new Date().toISOString().split('T')[0]!;
  const overdueResult = await db.execute(sql`
    SELECT COUNT(*) as count FROM transactions
    WHERE tenant_id = ${tenantId} AND txn_type = 'invoice' AND status = 'posted'
      AND invoice_status NOT IN ('paid', 'void')
      AND due_date < ${today}
  `);
  const overdueInvoiceCount = parseInt((overdueResult.rows as any[])[0]?.count || '0');

  // Stale reconciliations — bank accounts not reconciled in 30+ days
  const staleResult = await db.execute(sql`
    SELECT a.id, a.name,
      (SELECT MAX(r.statement_date) FROM reconciliations r
       WHERE r.tenant_id = ${tenantId} AND r.account_id = a.id AND r.status = 'complete') as last_reconciled
    FROM accounts a
    WHERE a.tenant_id = ${tenantId} AND a.is_active = true AND a.detail_type = 'bank'
  `);
  const staleReconciliations = (staleResult.rows as any[]).filter((r) => {
    if (!r.last_reconciled) return true;
    const daysSince = Math.floor((Date.now() - new Date(r.last_reconciled).getTime()) / 86400000);
    return daysSince > 30;
  }).map((r) => ({ accountName: r.name, lastReconciled: r.last_reconciled }));

  // Pending deposits (payments in Payments Clearing not yet deposited)
  const pendingDepositResult = await db.execute(sql`
    SELECT COUNT(*) as count, COALESCE(SUM(jl.debit), 0) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    JOIN accounts a ON a.id = jl.account_id AND a.system_tag = 'payments_clearing'
    WHERE jl.tenant_id = ${tenantId} AND jl.debit > 0 AND t.status = 'posted'
      AND t.id NOT IN (SELECT source_transaction_id FROM deposit_lines)
  `);
  const pendingDepositCount = parseInt((pendingDepositResult.rows as any[])[0]?.count || '0');
  const pendingDepositAmount = parseFloat((pendingDepositResult.rows as any[])[0]?.total || '0');

  // Checks ready to print
  const printQueueResult = await db.execute(sql`
    SELECT COUNT(*) as count, COALESCE(SUM(CAST(total AS DECIMAL)), 0) as total
    FROM transactions
    WHERE tenant_id = ${tenantId} AND print_status = 'queue'
  `);
  const printQueueCount = parseInt((printQueueResult.rows as any[])[0]?.count || '0');
  const printQueueAmount = parseFloat((printQueueResult.rows as any[])[0]?.total || '0');

  return {
    pendingFeedCount,
    overdueInvoiceCount,
    staleReconciliations,
    pendingDepositCount,
    pendingDepositAmount,
    printQueueCount,
    printQueueAmount,
  };
}
