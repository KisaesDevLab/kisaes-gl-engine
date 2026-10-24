// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import DecimalLib from 'decimal.js';
import { listPendingDepositItems } from './payment.service.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalT = InstanceType<typeof Decimal>;

/**
 * Options every dashboard panel takes (dashboard-exact-v1).
 *
 * - `exact`: money as decimal strings with four places (the decimal(19,4)
 *   value as text, as register-exact-v1 returns it). Without it money stays
 *   a JSON number, now summed with Decimal instead of parseFloat.
 * - `asOf`: the YYYY-MM-DD date the panels treat as "today" (month-to-date,
 *   fiscal year-to-date, trend months, overdue, due soon, stale
 *   reconciliations). Without it "today" is the database's CURRENT_DATE,
 *   the same clock the recurring catch-up uses. The desktop client sends
 *   the company's local date so buckets never follow the server's UTC day.
 */
export interface DashboardOptions {
  exact?: boolean;
  asOf?: string;
}

/** A JSON number by default; a decimal string with four places when exact. */
export type DashboardMoney = number | string;

function money(d: DecimalT, exact: boolean | undefined): DashboardMoney {
  return exact ? d.toFixed(4) : d.toNumber();
}

function dec(v: unknown): DecimalT {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return new Decimal(String(v));
}

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

/** The date the panels treat as today: `asOf`, else the database's CURRENT_DATE. */
export async function resolveToday(asOf?: string): Promise<string> {
  if (asOf) return asOf;
  const r = await db.execute(sql`SELECT CURRENT_DATE::text AS today`);
  return rowsOf<{ today: string }>(r)[0]!.today;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD of the first day of the month `offset` months from (year, month 1..12). */
function monthStart(year: number, month: number, offset = 0): { y: number; m: number; iso: string } {
  const d = new Date(Date.UTC(year, month - 1 + offset, 1));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return { y, m, iso: `${y}-${pad2(m)}-01` };
}

function monthEnd(y: number, m: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad2(m)}-${pad2(last)}`;
}

function splitIso(iso: string): { y: number; m: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) };
}

async function getFiscalYearStart(tenantId: string, today: string): Promise<string> {
  const result = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT 1`);
  const fyStartMonth = Number(rowsOf<{ fiscal_year_start_month: number | null }>(result)[0]?.fiscal_year_start_month) || 1;
  const { y, m } = splitIso(today);
  // Before the fiscal-year start month this calendar year, the fiscal year started last year.
  const year = m < fyStartMonth ? y - 1 : y;
  return `${year}-${pad2(fyStartMonth)}-01`;
}

/** Revenue and expenses posted between two dates, signed by normal balance. */
async function profitAndLoss(tenantId: string, start: string, end: string): Promise<{ revenue: DecimalT; expenses: DecimalT }> {
  const rows = await db.execute(sql`
    SELECT a.account_type,
      COALESCE(SUM(jl.debit), 0)::text as total_debit,
      COALESCE(SUM(jl.credit), 0)::text as total_credit
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${start} AND t.txn_date <= ${end}
      AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense')
    GROUP BY a.account_type
  `);

  let revenue = new Decimal(0);
  let expenses = new Decimal(0);
  for (const row of rowsOf<{ account_type: string; total_debit: string; total_credit: string }>(rows)) {
    // Signed, normal-balance convention (matches report.service): income
    // is credit - debit, costs are debit - credit. Abnormal balances
    // (refund-heavy revenue, rebated expenses) reduce their bucket
    // instead of inflating it via Math.abs.
    const isIncome = row.account_type === 'revenue' || row.account_type === 'other_revenue';
    const debit = dec(row.total_debit);
    const credit = dec(row.total_credit);
    if (isIncome) revenue = revenue.plus(credit.minus(debit));
    else expenses = expenses.plus(debit.minus(credit));
  }
  return { revenue, expenses };
}

export async function getFinancialSnapshot(tenantId: string, opts: DashboardOptions = {}) {
  const today = await resolveToday(opts.asOf);
  const { y, m } = splitIso(today);
  const mtdStart = `${y}-${pad2(m)}-01`;
  const ytdStart = await getFiscalYearStart(tenantId, today);

  const shape = (pl: { revenue: DecimalT; expenses: DecimalT }) => ({
    revenue: money(pl.revenue, opts.exact),
    expenses: money(pl.expenses, opts.exact),
    netIncome: money(pl.revenue.minus(pl.expenses), opts.exact),
  });

  const mtd = shape(await profitAndLoss(tenantId, mtdStart, today));
  const ytd = shape(await profitAndLoss(tenantId, ytdStart, today));
  return { mtd, ytd };
}

export async function getRevExpTrend(tenantId: string, months: number = 6, opts: DashboardOptions = {}) {
  const data: Array<{ month: string; startDate: string; endDate: string; revenue: DashboardMoney; expenses: DashboardMoney }> = [];
  const today = await resolveToday(opts.asOf);
  const { y: ty, m: tm } = splitIso(today);

  for (let i = months - 1; i >= 0; i--) {
    // Calendar months of the dashboard's "today" (asOf or the database
    // date), never the API container's clock.
    const { y, m, iso: start } = monthStart(ty, tm, -i);
    const end = monthEnd(y, m);
    const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    const pl = await profitAndLoss(tenantId, start, end);
    data.push({ month: label, startDate: start, endDate: end, revenue: money(pl.revenue, opts.exact), expenses: money(pl.expenses, opts.exact) });
  }

  return data;
}

export async function getCashPosition(tenantId: string, opts: DashboardOptions = {}) {
  const rows = await db.execute(sql`
    SELECT a.id, a.name, a.account_number, a.detail_type, a.balance::text AS balance
    FROM accounts a
    WHERE a.tenant_id = ${tenantId} AND a.is_active = true
      AND (
        (a.account_type = 'asset' AND a.detail_type IN ('bank', 'checking', 'savings', 'cash', 'petty_cash'))
        OR (a.account_type = 'liability' AND a.detail_type = 'credit_card')
      )
    ORDER BY a.account_type, a.account_number, a.name
  `);

  // `id` rides along so the dashboard can deep-link each row to its
  // account register (/accounts/:id/register).
  type Entry = { id: string; name: string; accountNumber: string | null; balance: DashboardMoney };
  const bankAccounts: Entry[] = [];
  const creditCards: Entry[] = [];
  let totalBank = new Decimal(0);
  let totalCC = new Decimal(0);

  for (const row of rowsOf<{ id: string; name: string; account_number: string | null; detail_type: string | null; balance: string | null }>(rows)) {
    const balance = dec(row.balance);
    const entry: Entry = { id: String(row.id), name: row.name, accountNumber: row.account_number ?? null, balance: money(balance, opts.exact) };
    if (row.detail_type === 'credit_card') {
      creditCards.push(entry);
      totalCC = totalCC.plus(balance.abs());
    } else {
      bankAccounts.push(entry);
      totalBank = totalBank.plus(balance);
    }
  }

  return {
    bankAccounts,
    creditCards,
    totalBank: money(totalBank, opts.exact),
    totalCC: money(totalCC, opts.exact),
  };
}

// ─── Overdue invoices: one rule for every dashboard panel ───────────
//
// An invoice is open when it is posted, its invoice_status is not paid or
// void, and its open amount (balance_due, else total) is above zero. An
// open invoice is overdue when its due date (txn_date when it has none) is
// before today. /receivables and /action-items both use these fragments,
// so their counts always agree.

const invoiceOpenAmount = sql`COALESCE(t.balance_due, t.total, 0)`;

function openInvoices(tenantId: string): SQL {
  return sql`t.tenant_id = ${tenantId} AND t.txn_type = 'invoice' AND t.status = 'posted'
    AND t.invoice_status NOT IN ('paid', 'void')`;
}

function invoiceOverdue(today: string): SQL {
  return sql`${invoiceOpenAmount} > 0 AND COALESCE(t.due_date, t.txn_date) < ${today}::date`;
}

export async function getReceivablesSummary(tenantId: string, opts: DashboardOptions = {}) {
  const today = await resolveToday(opts.asOf);
  const overdue = invoiceOverdue(today);
  const rows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS invoice_count,
      COALESCE(SUM(${invoiceOpenAmount}) FILTER (WHERE ${invoiceOpenAmount} > 0), 0)::text AS total_outstanding,
      COUNT(*) FILTER (WHERE ${overdue})::int AS overdue_count,
      COALESCE(SUM(${invoiceOpenAmount}) FILTER (WHERE ${overdue}), 0)::text AS overdue_amount
    FROM transactions t
    WHERE ${openInvoices(tenantId)}
  `);
  const row = rowsOf<{ invoice_count: number; total_outstanding: string; overdue_count: number; overdue_amount: string }>(rows)[0]!;

  return {
    totalOutstanding: money(dec(row.total_outstanding), opts.exact),
    overdueCount: Number(row.overdue_count),
    overdueAmount: money(dec(row.overdue_amount), opts.exact),
    invoiceCount: Number(row.invoice_count),
  };
}

export interface PayablesOptions extends DashboardOptions {
  /** Window for dueThisWeekCount / dueThisWeekAmount: due today through today + N days (1..90, default 7). */
  dueWithinDays?: number;
}

export async function getPayablesSummary(tenantId: string, opts: PayablesOptions = {}) {
  const today = await resolveToday(opts.asOf);
  const dueWithinDays = Math.min(Math.max(Math.trunc(opts.dueWithinDays ?? 7), 1), 90);
  const overdue = sql`t.due_date < ${today}::date`;
  const dueSoon = sql`t.due_date >= ${today}::date AND t.due_date <= (${today}::date + ${dueWithinDays}::int)`;

  // Open bills for this tenant
  const billsResult = await db.execute(sql`
    SELECT
      COUNT(*)::int AS bill_count,
      COALESCE(SUM(t.balance_due), 0)::text AS total_owed,
      COUNT(*) FILTER (WHERE ${overdue})::int AS overdue_count,
      COALESCE(SUM(t.balance_due) FILTER (WHERE ${overdue}), 0)::text AS overdue_amount,
      COUNT(*) FILTER (WHERE ${dueSoon})::int AS due_soon_count,
      COALESCE(SUM(t.balance_due) FILTER (WHERE ${dueSoon}), 0)::text AS due_soon_amount
    FROM transactions t
    WHERE t.tenant_id = ${tenantId}
      AND t.txn_type = 'bill'
      AND t.status = 'posted'
      AND t.bill_status IN ('unpaid', 'partial', 'overdue')
      AND COALESCE(t.balance_due, 0) > 0
  `);
  const bills = rowsOf<{
    bill_count: number; total_owed: string; overdue_count: number; overdue_amount: string;
    due_soon_count: number; due_soon_amount: string;
  }>(billsResult)[0]!;

  // Available vendor credits
  const creditsResult = await db.execute(sql`
    SELECT COUNT(*)::int as count, COALESCE(SUM(balance_due), 0)::text as total
    FROM transactions
    WHERE tenant_id = ${tenantId}
      AND txn_type = 'vendor_credit'
      AND status = 'posted'
      AND COALESCE(balance_due, 0) > 0
  `);
  const credits = rowsOf<{ count: number; total: string }>(creditsResult)[0];

  // AP balance from the system account (defensive — falls back to bill total)
  const apResult = await db.execute(sql`
    SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0)::text as balance
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id AND a.system_tag = 'accounts_payable'
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
  `);
  const apBalance = rowsOf<{ balance: string }>(apResult)[0]?.balance;

  return {
    totalOwed: money(dec(bills.total_owed), opts.exact),
    billCount: Number(bills.bill_count),
    overdueCount: Number(bills.overdue_count),
    overdueAmount: money(dec(bills.overdue_amount), opts.exact),
    // Named for the historical 7-day window; covers dueWithinDays days.
    dueThisWeekCount: Number(bills.due_soon_count),
    dueThisWeekAmount: money(dec(bills.due_soon_amount), opts.exact),
    dueWithinDays,
    creditCount: Number(credits?.count ?? 0),
    creditAmount: money(dec(credits?.total), opts.exact),
    apBalance: money(dec(apBalance), opts.exact),
  };
}

export async function getActionItems(tenantId: string, companyId?: string, opts: DashboardOptions = {}) {
  const today = await resolveToday(opts.asOf);

  // Pending bank feed items
  const feedResult = await db.execute(sql`
    SELECT COUNT(*)::int as count FROM bank_feed_items
    WHERE tenant_id = ${tenantId} AND status = 'pending'
  `);
  const pendingFeedCount = Number(rowsOf<{ count: number }>(feedResult)[0]?.count ?? 0);

  // Overdue invoices: the same rule as /receivables overdueCount.
  const overdueResult = await db.execute(sql`
    SELECT COUNT(*)::int as count FROM transactions t
    WHERE ${openInvoices(tenantId)} AND ${invoiceOverdue(today)}
  `);
  const overdueInvoiceCount = Number(rowsOf<{ count: number }>(overdueResult)[0]?.count ?? 0);

  // Stale reconciliations — bank accounts not reconciled in the 30 days before today
  const staleResult = await db.execute(sql`
    SELECT s.name, s.last_reconciled FROM (
      SELECT a.name,
        (SELECT MAX(r.statement_date) FROM reconciliations r
         WHERE r.tenant_id = ${tenantId} AND r.account_id = a.id AND r.status = 'complete') as last_reconciled
      FROM accounts a
      WHERE a.tenant_id = ${tenantId} AND a.is_active = true AND a.detail_type = 'bank'
    ) s
    WHERE s.last_reconciled IS NULL OR s.last_reconciled < (${today}::date - 30)
  `);
  const staleReconciliations = rowsOf<{ name: string; last_reconciled: unknown }>(staleResult)
    .map((r) => ({ accountName: r.name, lastReconciled: r.last_reconciled }));

  // Pending deposits: the same list the Bank Deposit page shows (net
  // Payments Clearing debit per posted item, tenant-scoped, items a posted
  // deposit settles left out), so the tile and the page always agree.
  const pendingItems = await listPendingDepositItems(tenantId, companyId ? { companyId } : {});
  const pendingDepositCount = pendingItems.length;
  const pendingDepositAmount = money(
    pendingItems.reduce((s, i) => s.plus(i.amount), new Decimal(0)),
    opts.exact,
  );

  // Checks ready to print
  const printQueueResult = await db.execute(sql`
    SELECT COUNT(*)::int as count, COALESCE(SUM(total), 0)::text as total
    FROM transactions
    WHERE tenant_id = ${tenantId} AND print_status = 'queue'
  `);
  const printQueue = rowsOf<{ count: number; total: string }>(printQueueResult)[0];

  return {
    pendingFeedCount,
    overdueInvoiceCount,
    staleReconciliations,
    pendingDepositCount,
    pendingDepositAmount,
    printQueueCount: Number(printQueue?.count ?? 0),
    printQueueAmount: money(dec(printQueue?.total), opts.exact),
  };
}
