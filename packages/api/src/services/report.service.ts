// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, lte, gte, between, count, or, ne } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import {
  type PLSectionLabels,
  type BSSectionLabels,
  type CFSectionLabels,
  isDebitNormal as isDebitNormalShared,
  COST_TYPES,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, journalLines, accounts, contacts } from '../db/schema/index.js';
import {
  getPLLabels,
  getBSLabels,
  getCFLabels,
  getReportFooter,
} from './tenant-report-settings.service.js';

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

// Exported so report-comparison can build fiscal-aware year columns
// from the same source of truth.
export async function getFiscalYearStart(tenantId: string, companyId: string | null): Promise<number> {
  if (companyId) {
    const row = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE id = ${companyId}`);
    return (row.rows as any[])[0]?.fiscal_year_start_month ?? 1;
  }
  const row = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT 1`);
  return (row.rows as any[])[0]?.fiscal_year_start_month ?? 1;
}

// ─── CASH-BASIS ENGINE ───────────────────────────────────────────
//
// True cash basis via a VIRTUAL LEDGER (QBO-style payment allocation).
// The old implementation filtered to "transactions that touched cash"
// and aggregated those transactions' own P&L legs — so invoice revenue
// collected through a separate payment (Dr cash / Cr AR, no revenue
// leg) never appeared, paid bills left AP with an abnormal balance on
// the cash BS, and the cash BS could unbalance.
//
// The virtual ledger rewrites the posted journal per these rules; every
// group below is internally balanced, so any report built from it
// balances by construction:
//
//   1. AR/AP DOCUMENTS (invoice, bill, credit_memo, vendor_credit) are
//      excluded entirely — accrual-only constructs.
//   2. All other transactions pass through as-is (cash sales, direct
//      expenses, card charges, transfers, deposits, JEs …), EXCEPT that
//      a payment's AR leg (customer_payment) / AP leg (bill_payment) is
//      reduced to its UNAPPLIED remainder. The applied portion is
//      replaced by rule 3; the unapplied remainder stays on AR/AP so
//      customer pre-payments remain visible and the sheet still ties.
//   3. For each payment APPLICATION (payment → document, amount), the
//      paid document's non-AR/AP lines are emitted at the PAYMENT's
//      date, scaled by amount / document total. A $1,000 invoice
//      (Cr revenue 900 / Cr tax 100) paid $500 in December recognizes
//      Cr revenue 450 + Cr tax 50 in December.
//
// AR applications come from payment_applications plus the legacy
// single-invoice link (transactions.applied_to_invoice_id, used by
// invoice.recordPayment and Stripe). AP applications come from
// bill_payment_applications, whose amounts are the CASH portion per
// bill — vendor-credit-settled portions are correctly never recognized
// (no cash moved).
function cashBasisLinesWith(
  tenantId: string,
  startDate: string | null,
  endDate: string,
  companyId: string | null,
) {
  const dateCondT = startDate
    ? sql`t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}`
    : sql`t.txn_date <= ${endDate}`;
  const dateCondPay = startDate
    ? sql`pay.txn_date >= ${startDate} AND pay.txn_date <= ${endDate}`
    : sql`pay.txn_date <= ${endDate}`;
  const companyT = companyId ? sql`t.company_id = ${companyId}` : sql`TRUE`;
  const companyPay = companyId ? sql`pay.company_id = ${companyId}` : sql`TRUE`;

  return sql`
    ar_apps AS (
      SELECT pa.payment_id, pa.invoice_id, pa.amount::numeric AS amount
      FROM payment_applications pa
      WHERE pa.tenant_id = ${tenantId}
      UNION ALL
      SELECT tp.id, tp.applied_to_invoice_id, tp.total::numeric
      FROM transactions tp
      WHERE tp.tenant_id = ${tenantId} AND tp.txn_type = 'customer_payment'
        AND tp.applied_to_invoice_id IS NOT NULL AND tp.total IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_applications pa2
          WHERE pa2.tenant_id = ${tenantId} AND pa2.payment_id = tp.id
        )
    ),
    cb_lines AS (
      -- Rule 2: pass-through, with payment AR/AP legs reduced to the
      -- unapplied remainder.
      SELECT jl.account_id, jl.tag_id,
        CASE WHEN t.txn_type = 'bill_payment' AND a.detail_type = 'accounts_payable'
             THEN GREATEST(jl.debit::numeric - COALESCE(bp.applied, 0), 0)
             ELSE jl.debit::numeric END AS debit,
        CASE WHEN t.txn_type = 'customer_payment' AND a.detail_type = 'accounts_receivable'
             THEN GREATEST(jl.credit::numeric - COALESCE(arp.applied, 0), 0)
             ELSE jl.credit::numeric END AS credit
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = ${tenantId}
        AND jl.is_void_reversal = false
      JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
      LEFT JOIN (
        SELECT payment_id, SUM(amount) AS applied FROM ar_apps GROUP BY payment_id
      ) arp ON arp.payment_id = t.id
      LEFT JOIN (
        SELECT payment_id, SUM(amount::numeric) AS applied
        FROM bill_payment_applications WHERE tenant_id = ${tenantId} GROUP BY payment_id
      ) bp ON bp.payment_id = t.id
      WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
        AND ${dateCondT} AND ${companyT}
        AND t.txn_type NOT IN ('invoice', 'bill', 'credit_memo', 'vendor_credit')

      UNION ALL

      -- Rule 3 (AR): scaled invoice distributions at the payment date.
      SELECT il.account_id, il.tag_id,
        il.debit::numeric  * app.amount / NULLIF(inv.total::numeric, 0) AS debit,
        il.credit::numeric * app.amount / NULLIF(inv.total::numeric, 0) AS credit
      FROM ar_apps app
      JOIN transactions pay ON pay.id = app.payment_id AND pay.tenant_id = ${tenantId}
        AND pay.status = 'posted' AND ${dateCondPay} AND ${companyPay}
      JOIN transactions inv ON inv.id = app.invoice_id AND inv.tenant_id = ${tenantId}
        AND inv.status = 'posted' AND NULLIF(inv.total::numeric, 0) IS NOT NULL
      JOIN journal_lines il ON il.transaction_id = inv.id AND il.tenant_id = ${tenantId}
        AND il.is_void_reversal = false
      JOIN accounts ia ON ia.id = il.account_id AND ia.tenant_id = ${tenantId}
      WHERE ia.detail_type IS DISTINCT FROM 'accounts_receivable'

      UNION ALL

      -- Rule 3 (AP): scaled bill distributions at the payment date.
      SELECT bl.account_id, bl.tag_id,
        bl.debit::numeric  * app.amount::numeric / NULLIF(bill.total::numeric, 0) AS debit,
        bl.credit::numeric * app.amount::numeric / NULLIF(bill.total::numeric, 0) AS credit
      FROM bill_payment_applications app
      JOIN transactions pay ON pay.id = app.payment_id AND pay.tenant_id = ${tenantId}
        AND pay.status = 'posted' AND ${dateCondPay} AND ${companyPay}
      JOIN transactions bill ON bill.id = app.bill_id AND bill.tenant_id = ${tenantId}
        AND bill.status = 'posted' AND NULLIF(bill.total::numeric, 0) IS NOT NULL
      JOIN journal_lines bl ON bl.transaction_id = bill.id AND bl.tenant_id = ${tenantId}
        AND bl.is_void_reversal = false
      JOIN accounts ba ON ba.id = bl.account_id AND ba.tenant_id = ${tenantId}
      WHERE app.tenant_id = ${tenantId}
        AND ba.detail_type IS DISTINCT FROM 'accounts_payable'
    )`;
}

// ─── FINANCIAL STATEMENTS ────────────────────────────────────────

export interface PLEntry { accountId: string; name: string; accountNumber: string | null; amount: number }

export interface PLResult {
  title: string;
  startDate: string;
  endDate: string;
  basis: Basis;
  labels: PLSectionLabels;
  footer: string;
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
  // ADR 0XX §5.1 — line-level report: when tagId is provided, aggregate
  // only those journal_lines carrying that tag. Transactions appear only
  // to the extent their matching lines total nonzero.
  tagId: string | null = null,
): Promise<PLResult> {
  // Cash basis: revenue recognized when cash is received, expenses when
  // cash is paid — implemented by the virtual cash-basis ledger (see
  // cashBasisLinesWith above), which allocates payment applications
  // across the paid document's distribution lines at the payment date.
  // Accrual: every posted txn in range, straight from journal_lines.
  const companyCond = companyId ? sql`company_id = ${companyId}` : sql`TRUE`;

  // Line-level tag filter (ADR 0XX §5.1): when present, restrict the
  // aggregated lines to those tagged with the given tag_id. Virtual
  // cash-basis lines inherit the source line's tag, so the same clause
  // applies to both bases.
  const tagJoinClause = tagId ? sql` AND jl.tag_id = ${tagId}` : sql``;

  const rows = basis === 'cash'
    ? await db.execute(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId)}
        SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type,
          COALESCE(SUM(jl.debit), 0) as total_debit,
          COALESCE(SUM(jl.credit), 0) as total_credit
        FROM accounts a
        LEFT JOIN cb_lines jl ON jl.account_id = a.id${tagJoinClause}
        WHERE a.tenant_id = ${tenantId}
          AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense')
        GROUP BY a.id, a.account_number, a.name, a.account_type, a.detail_type
        ORDER BY a.account_number, a.name
      `)
    : await db.execute(sql`
        SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type,
          COALESCE(SUM(jl.debit), 0) as total_debit,
          COALESCE(SUM(jl.credit), 0) as total_credit
        FROM accounts a
        LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
          AND jl.transaction_id IN (
            SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
            AND txn_date >= ${startDate} AND txn_date <= ${endDate}
            AND ${companyCond}
          )${tagJoinClause}
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
    // SIGNED, normal-balance convention: income accounts report
    // credit − debit; cost accounts report debit − credit. An account
    // running an ABNORMAL balance (refund-heavy revenue account, an
    // expense account with net rebates) comes out negative and correctly
    // REDUCES its section. The previous per-account Math.abs() flipped
    // such balances positive, inflating net income — and since the BS/TB
    // retained-earnings rows are derived from this net income, the error
    // propagated into equity and broke A = L + E.
    const isIncome = row.account_type === 'revenue' || row.account_type === 'other_revenue';
    const amount = isIncome
      ? sub(row.total_credit, row.total_debit)
      : sub(row.total_debit, row.total_credit);
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

  const [labels, footer] = await Promise.all([
    getPLLabels(tenantId),
    getReportFooter(tenantId),
  ]);

  return {
    title: 'Profit and Loss',
    startDate, endDate, basis,
    labels,
    footer,
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

export async function buildBalanceSheet(
  tenantId: string,
  asOfDate: string,
  basis: Basis = 'accrual',
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level tag filter. Applied to the activity join
  // so only journal lines carrying the tag contribute to balances. The
  // retained-earnings injection further down uses the same filter by
  // passing tagId to buildProfitAndLoss.
  tagId: string | null = null,
) {
  const tagClause = tagId ? sql` AND jl.tag_id = ${tagId}` : sql``;
  // Cash basis balance sheet: built from the virtual cash-basis ledger
  // (cashBasisLinesWith). AR/AP documents drop out entirely, payment
  // AR/AP legs are replaced by scaled document distributions, so:
  //   - AR/AP show zero except unapplied payment remainders (customer
  //     pre-payments), which is the honest cash-basis picture;
  //   - every virtual group is balanced, so A = L + E holds by
  //     construction (the old txn-set filter could unbalance the sheet
  //     because it kept the payment's AR leg but not the invoice).
  const companyCond = companyId ? sql`company_id = ${companyId}` : sql`TRUE`;

  const rows = basis === 'cash'
    ? await db.execute(sql`
        WITH ${cashBasisLinesWith(tenantId, null, asOfDate, companyId)}
        SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type, a.system_tag,
          COALESCE(SUM(jl.debit), 0) as total_debit,
          COALESCE(SUM(jl.credit), 0) as total_credit
        FROM accounts a
        LEFT JOIN cb_lines jl ON jl.account_id = a.id${tagClause}
        WHERE a.tenant_id = ${tenantId} AND a.account_type IN ('asset', 'liability', 'equity')
        GROUP BY a.id, a.account_number, a.name, a.account_type, a.detail_type, a.system_tag
        ORDER BY a.account_number, a.name
      `)
    : await db.execute(sql`
        SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type, a.system_tag,
          COALESCE(SUM(jl.debit), 0) as total_debit,
          COALESCE(SUM(jl.credit), 0) as total_credit
        FROM accounts a
        LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
          AND jl.transaction_id IN (
            SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
            AND txn_date <= ${asOfDate}
            AND ${companyCond}
          )${tagClause}
        WHERE a.tenant_id = ${tenantId} AND a.account_type IN ('asset', 'liability', 'equity')
        GROUP BY a.id ORDER BY a.account_number, a.name
      `);

  type BSEntry = { accountId: string | null; name: string; accountNumber: string | null; balance: number };
  const assets: BSEntry[] = [];
  const liabilities: BSEntry[] = [];
  const equity: BSEntry[] = [];
  let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;

  for (const row of rows.rows as any[]) {
    // NOTE: the Retained Earnings system account is intentionally
    // INCLUDED here at its posted balance. The dynamic rows below add
    // income that hasn't been closed into it; if an operator posts a
    // textbook closing entry (Dr income / Cr Retained Earnings), the
    // income side nets out of the P&L-derived rows and the posted RE
    // balance carries it instead — the identity holds either way.
    // (Previously this row was skipped entirely, so any posting to RE
    // silently vanished from the BS while its counter-leg remained.)
    const raw = sub(row.total_debit, row.total_credit);
    if (raw === 0) continue;
    if (row.account_type === 'asset') {
      assets.push({ accountId: row.id, name: row.name, accountNumber: row.account_number, balance: raw });
      totalAssets += raw;
    } else {
      // SIGNED accumulation in natural (credit-positive) convention:
      // a normal liability/equity balance is positive; a contra balance
      // (overpaid credit card, Owner Withdraw draws) is negative and
      // correctly REDUCES the section. The previous Math.abs() added
      // contra balances as positives, unbalancing the sheet by twice
      // the contra amount.
      const balance = -raw;
      const entry: BSEntry = { accountId: row.id, name: row.name, accountNumber: row.account_number, balance };
      if (row.account_type === 'liability') { liabilities.push(entry); totalLiabilities += balance; }
      else { equity.push(entry); totalEquity += balance; }
    }
  }

  // Automatic year-end closing: split into Retained Earnings (prior years) + Current Year Net Income
  const fyStartMonth = await getFiscalYearStart(tenantId, companyId);

  // Compute current fiscal year start date. UTC getters so the
  // boundary is stable regardless of the container's local TZ — the
  // asOfDate string is a calendar day ('YYYY-MM-DD') that Postgres
  // stores TZ-naive, and we want the boundary computed against that
  // same calendar day.
  const asOf = new Date(asOfDate + 'T00:00:00Z');
  let currentFYStartYear = asOf.getUTCFullYear();
  if (asOf.getUTCMonth() + 1 < fyStartMonth) currentFYStartYear--;
  const currentFYStart = `${currentFYStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  // Retained Earnings = net income for all completed fiscal years (before current FY start)
  const retainedPL = await buildProfitAndLoss(tenantId, '1900-01-01', (() => {
    const d = new Date(currentFYStart + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0]!;
  })(), basis, companyId, tagId);
  if (retainedPL.netIncome !== 0) {
    equity.push({ accountId: null, name: 'Retained Earnings (Prior Years)', accountNumber: null, balance: retainedPL.netIncome });
    totalEquity += retainedPL.netIncome;
  }

  // Current year net income
  const currentPL = await buildProfitAndLoss(tenantId, currentFYStart, asOfDate, basis, companyId, tagId);
  if (currentPL.netIncome !== 0) {
    equity.push({ accountId: null, name: 'Net Income (Current Year)', accountNumber: null, balance: currentPL.netIncome });
    totalEquity += currentPL.netIncome;
  }

  const [labels, footer] = await Promise.all([
    getBSLabels(tenantId),
    getReportFooter(tenantId),
  ]);

  return {
    title: 'Balance Sheet', asOfDate, basis,
    labels,
    footer,
    assets, totalAssets,
    liabilities, totalLiabilities,
    equity, totalEquity,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
  };
}

export async function buildCashFlowStatement(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level tag filter flows into the P&L that
  // drives the cash-flow calc.
  tagId: string | null = null,
) {
  // DIRECT METHOD from actual cash movements. The previous version was
  // a stub (operating = accrual net income, investing/financing = 0,
  // netChange = net income) whose "net change in cash" matched real
  // cash movement only for a business with no AR/AP/loans/draws.
  //
  // Here: net change = SUM(debit − credit) over the period's journal
  // lines on CASH accounts (checking/savings/cash/petty cash/
  // undeposited funds) — exact by construction. Each cash-moving
  // transaction is classified by its counter-legs:
  //   any fixed-asset leg                  → investing
  //   any equity or long-term-debt leg     → financing
  //   everything else (P&L, AR/AP, taxes)  → operating
  // Transfers between two cash accounts net to zero and drop out.
  const companyCond = companyId ? sql`t.company_id = ${companyId}` : sql`TRUE`;
  const tagExistsClause = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jlt WHERE jlt.transaction_id = t.id AND jlt.tenant_id = ${tenantId} AND jlt.tag_id = ${tagId})`
    : sql``;

  const rows = await db.execute(sql`
    WITH cash_accounts AS (
      SELECT id FROM accounts
      WHERE tenant_id = ${tenantId} AND account_type = 'asset'
        AND detail_type IN ('checking', 'savings', 'cash', 'petty_cash', 'undeposited_funds')
    ),
    txn_cash AS (
      SELECT t.id, SUM(jl.debit - jl.credit) AS cash_delta
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = ${tenantId}
      WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
        AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
        AND ${companyCond}
        AND jl.account_id IN (SELECT id FROM cash_accounts)
        ${tagExistsClause}
      GROUP BY t.id
      HAVING SUM(jl.debit - jl.credit) <> 0
    )
    SELECT tc.id, tc.cash_delta,
      BOOL_OR(a.detail_type = 'fixed_asset') AS touches_investing,
      BOOL_OR(a.account_type = 'equity' OR a.detail_type IN ('long_term_liability', 'line_of_credit')) AS touches_financing
    FROM txn_cash tc
    JOIN journal_lines jl ON jl.transaction_id = tc.id AND jl.tenant_id = ${tenantId}
      AND jl.account_id NOT IN (SELECT id FROM cash_accounts)
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
    GROUP BY tc.id, tc.cash_delta
  `);

  let operating = new Decimal(0);
  let investing = new Decimal(0);
  let financing = new Decimal(0);
  for (const r of rows.rows as Array<{ cash_delta: string | null; touches_investing: boolean; touches_financing: boolean }>) {
    const delta = new Decimal(r.cash_delta || 0);
    if (r.touches_investing) investing = investing.plus(delta);
    else if (r.touches_financing) financing = financing.plus(delta);
    else operating = operating.plus(delta);
  }

  const pl = await buildProfitAndLoss(tenantId, startDate, endDate, 'accrual', companyId, tagId);
  const [labels, footer] = await Promise.all([
    getCFLabels(tenantId),
    getReportFooter(tenantId),
  ]);
  return {
    title: 'Cash Flow Statement', startDate, endDate,
    labels,
    footer,
    // Kept for context alongside the cash sections.
    netIncome: pl.netIncome,
    operatingActivities: Number(operating.toFixed(4)),
    investingActivities: Number(investing.toFixed(4)),
    financingActivities: Number(financing.toFixed(4)),
    netChange: Number(operating.plus(investing).plus(financing).toFixed(4)),
  };
}

// ─── RECEIVABLES ─────────────────────────────────────────────────

export async function buildARAgingSummary(
  tenantId: string,
  asOfDate: string,
  companyId: string | null = null,
  // ADR 0XX §5.2 — header-level report: keep the invoice when any of its
  // journal_lines carries the tag. Balance stays the invoice total;
  // filter is an inclusion test, not a line-level aggregation.
  tagId: string | null = null,
) {
  const tagClause = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.tag_id = ${tagId})`
    : sql``;
  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.txn_date, t.due_date, t.total, t.amount_paid, t.balance_due,
      t.contact_id, c.display_name as customer_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE t.tenant_id = ${tenantId} AND t.txn_type = 'invoice' AND t.status = 'posted'
      AND t.invoice_status NOT IN ('paid', 'void')
      AND t.txn_date <= ${asOfDate}
      AND ${companyFilter(companyId)}
      ${tagClause}
    ORDER BY t.due_date
  `);

  const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
  // Anchor both endpoints to UTC midnight so the aging-bucket math
  // doesn't shift by ±a few hours depending on the container's local TZ.
  // The DB stores due_date/txn_date as calendar dates (no TZ); appending
  // 'T00:00:00Z' parses them at UTC midnight consistently.
  const asOf = new Date(asOfDate + 'T00:00:00Z');
  const details: any[] = [];

  for (const row of rows.rows as any[]) {
    const balance = num(row.balance_due || row.total || '0');
    if (balance <= 0) continue;
    const dueStr = row.due_date || row.txn_date;
    const dueDate = new Date(typeof dueStr === 'string' ? dueStr + 'T00:00:00Z' : dueStr);
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

export async function buildARAgingDetail(
  tenantId: string,
  asOfDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  return buildARAgingSummary(tenantId, asOfDate, companyId, tagId);
}

export async function buildCustomerBalanceSummary(
  tenantId: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  // Header-level tag filter: only count invoices that touch a tagged line.
  const txnTagFilter = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.tag_id = ${tagId})`
    : sql``;
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name,
      COALESCE(SUM(CASE WHEN t.txn_type = 'invoice' AND t.status = 'posted' THEN CAST(t.balance_due AS DECIMAL) ELSE 0 END), 0) as balance
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
      AND ${companyFilter(companyId)}${txnTagFilter}
    WHERE c.tenant_id = ${tenantId} AND c.contact_type IN ('customer', 'both') AND c.is_active = true
    GROUP BY c.id ORDER BY c.display_name
  `);

  return {
    title: 'Customer Balance Summary',
    data: (rows.rows as any[]).filter(r => num(r.balance) !== 0),
  };
}

export async function buildCustomerBalanceDetail(
  tenantId: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  return buildCustomerBalanceSummary(tenantId, companyId, tagId);
}

export async function buildInvoiceList(
  tenantId: string,
  filters?: { startDate?: string; endDate?: string; status?: string; tagId?: string },
  companyId: string | null = null,
) {
  const conditions = [sql`t.tenant_id = ${tenantId}`, sql`t.txn_type = 'invoice'`, companyFilter(companyId)];
  if (filters?.startDate) conditions.push(sql`t.txn_date >= ${filters.startDate}`);
  if (filters?.endDate) conditions.push(sql`t.txn_date <= ${filters.endDate}`);
  if (filters?.status) conditions.push(sql`t.invoice_status = ${filters.status}`);
  if (filters?.tagId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.tag_id = ${filters.tagId})`);
  }

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

export async function buildExpenseByVendor(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  const tagClause = tagId ? sql`AND jl.tag_id = ${tagId}` : sql``;
  const rows = await db.execute(sql`
    SELECT c.id as contact_id,
      -- STATEMENT_CHECK_PAYEE_V1 — fall back to the payee read off the check
      -- image when no contact matched, so checks roll up under the real payee
      -- instead of "Uncategorized". Label/grouping only; SUM is unchanged.
      COALESCE(c.display_name, t.payee_name_on_check, 'Uncategorized') as vendor_name,
      SUM(jl.debit) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND jl.debit > 0
      AND ${companyFilter(companyId)}
      ${tagClause}
    GROUP BY COALESCE(c.id::text, t.payee_name_on_check), c.id, c.display_name, t.payee_name_on_check
    ORDER BY total DESC
  `);

  return { title: 'Expenses by Vendor', startDate, endDate, data: rows.rows };
}

export async function buildExpenseByCategory(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  const tagClause = tagId ? sql`AND jl.tag_id = ${tagId}` : sql``;
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
      ${tagClause}
    GROUP BY a.id ORDER BY total DESC
  `);

  return { title: 'Expenses by Category', startDate, endDate, data: rows.rows };
}

// ─── SALES ────────────────────────────────────────────────────────

// Sales by Customer — aggregates revenue (credits to revenue-type
// accounts) grouped by the transaction's contact. Scoped to posted
// sales transactions in the given date range. Line-level tag filter:
// when tagId is supplied we narrow the aggregation to lines that
// carry the tag (project-accounting semantic, same as P&L and
// Expenses by Vendor).
export async function buildSalesByCustomer(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  const tagClause = tagId ? sql`AND jl.tag_id = ${tagId}` : sql``;
  const rows = await db.execute(sql`
    SELECT c.id as contact_id, COALESCE(c.display_name, 'Uncategorized') as customer_name,
      SUM(jl.credit) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('revenue', 'other_revenue')
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND jl.credit > 0
      AND t.txn_type IN ('invoice', 'cash_sale', 'credit_memo')
      AND ${companyFilter(companyId)}
      ${tagClause}
    GROUP BY c.id, c.display_name ORDER BY total DESC
  `);

  return { title: 'Sales by Customer', startDate, endDate, data: rows.rows };
}

// Sales by Item — aggregates revenue (credits to revenue-type
// accounts) grouped by `journal_lines.item_id`. Lines without an item
// (e.g. ad-hoc revenue entries) collapse into a single
// "Uncategorized" bucket so totals stay conserved against Sales by
// Customer / P&L. Same tag semantic as Sales by Customer.
export async function buildSalesByItem(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  const tagClause = tagId ? sql`AND jl.tag_id = ${tagId}` : sql``;
  const rows = await db.execute(sql`
    SELECT
      jl.item_id,
      COALESCE(i.name, 'Uncategorized') as item_name,
      COALESCE(i.sku, '') as item_sku,
      SUM(jl.credit) as total,
      COUNT(DISTINCT jl.transaction_id)::int as txn_count
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('revenue', 'other_revenue')
    LEFT JOIN items i ON i.id = jl.item_id AND i.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND jl.credit > 0
      AND t.txn_type IN ('invoice', 'cash_sale', 'credit_memo')
      AND ${companyFilter(companyId)}
      ${tagClause}
    GROUP BY jl.item_id, i.name, i.sku
    ORDER BY total DESC
  `);

  return { title: 'Sales by Item', startDate, endDate, data: rows.rows };
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

export async function buildCheckRegister(
  tenantId: string,
  accountId: string,
  dateRange?: DateRange,
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level tag semantic: hide lines whose tag_id
  // does not match. Account-level reports are project-accounting
  // surfaces, so this matches P&L/GL behavior.
  tagId: string | null = null,
) {
  const conditions = [
    sql`jl.tenant_id = ${tenantId}`,
    sql`jl.account_id = ${accountId}`,
    sql`t.status = 'posted'`,
    companyFilter(companyId),
  ];
  if (dateRange?.startDate) conditions.push(sql`t.txn_date >= ${dateRange.startDate}`);
  if (dateRange?.endDate) conditions.push(sql`t.txn_date <= ${dateRange.endDate}`);
  if (tagId) conditions.push(sql`jl.tag_id = ${tagId}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.memo,
      t.check_number,
      -- STATEMENT_CHECK_PAYEE_V1 — payee for the check: linked contact, else
      -- the name read off the check image.
      COALESCE(c.display_name, t.payee_name_on_check) AS payee,
      jl.debit, jl.credit
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
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

  // 1099 is CASH-basis: count actual disbursements (bill payments,
  // direct expenses, checks) — NOT 'bill' documents (that's accrual and
  // double-counts once the bill is paid). This matches the portal 1099
  // center's txn-type set so the two surfaces agree.
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name, c.tax_id,
      COALESCE(SUM(CAST(t.total AS DECIMAL)), 0) as total_paid
    FROM contacts c
    JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
      AND t.txn_type IN ('bill_payment', 'expense', 'check') AND t.status = 'posted'
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
export async function buildGeneralLedger(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level tag filter. When set, only journal lines
  // carrying that tag contribute to beginning balances and period
  // activity, so the ledger reads as the segment's standalone book.
  tagId: string | null = null,
) {
  // Evaluated as an inline conjunct. Empty sql`` is a no-op append.
  const tagClause = tagId ? sql` AND jl.tag_id = ${tagId}` : sql``;
  const fyStartMonth = await getFiscalYearStart(tenantId, companyId);
  // UTC getters — same pattern as buildBalanceSheet. Local getters on a
  // UTC-parsed 'YYYY-MM-DD' shift the day west of UTC, which flipped the
  // fiscal year for boundary dates (e.g. a July-1 report in TZ=UTC−5
  // computed the PREVIOUS fiscal year's start).
  const startDt = new Date(startDate + 'T00:00:00Z');
  let fyStartYear = startDt.getUTCFullYear();
  if (startDt.getUTCMonth() + 1 < fyStartMonth) fyStartYear--;
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
      )${tagClause}
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
      -- ADR 0XX §6.3 — per-line tag surfaced for CSV/Excel export.
      jl.tag_id AS line_tag_id,
      tag.name AS line_tag_name,
      t.id AS transaction_id,
      t.txn_date,
      t.txn_type,
      t.txn_number,
      t.memo AS txn_memo,
      -- STATEMENT_CHECK_PAYEE_V1 — show the check-image payee when no
      -- contact is linked (e.g. statement-imported checks).
      COALESCE(c.display_name, t.payee_name_on_check) AS contact_name
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN tags tag ON tag.id = jl.tag_id AND tag.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.txn_date >= ${startDate}
      AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}${tagClause}
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
    line_tag_id: string | null;
    line_tag_name: string | null;
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
          // ADR 0XX §6.3 — per-line tag flows to the GL response so
          // CSV/Excel exports can include a `line_tag` column.
          tagId: line.line_tag_id,
          tagName: line.line_tag_name,
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

export async function buildTrialBalance(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  // ADR 0XX §5.1 — Trial Balance uses the **transaction-level** tag
  // semantic (include every line of any transaction that has at least
  // one line carrying the tag) rather than the line-level filter used
  // by P&L/GL. A fundamental accounting invariant of the TB is
  // debits = credits; line-level filtering breaks that invariant for
  // mixed-tag transactions (only one side of a balanced entry would
  // survive the filter). Swapping in EXISTS preserves the invariant
  // while still narrowing the report to transactions the tag actually
  // touched.
  tagId: string | null = null,
) {
  const fyStartMonth = await getFiscalYearStart(tenantId, companyId);

  // Compute current fiscal year start based on the report end date.
  // UTC getters — see the identical note in buildGeneralLedger; local
  // getters flipped the fiscal year for boundary dates west of UTC.
  const endDt = new Date(endDate + 'T00:00:00Z');
  let fyStartYear = endDt.getUTCFullYear();
  if (endDt.getUTCMonth() + 1 < fyStartMonth) fyStartYear--;
  const fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;
  const tagExistsClause = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.transaction_id = transactions.id AND jl2.tenant_id = ${tenantId} AND jl2.tag_id = ${tagId})`
    : sql``;

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
        ${tagExistsClause}
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
  })
    // The HAVING above keeps accounts with LIFETIME activity; an income
    // account whose activity is entirely in prior fiscal years passes it
    // but nets to 0.00/0.00 after the fiscal-YTD CASE — drop those
    // cosmetic rows.
    .filter((r) => r.total_debit !== 0 || r.total_credit !== 0);
  // Kept mutable because the Retained Earnings injection below still
  // needs to add reDebit/reCredit to the running totals.
  let totalDebits = Number(td.toFixed(4));
  let totalCredits = Number(tc.toFixed(4));

  // Add Retained Earnings row for prior-year net income (virtual closing).
  //
  // Caveat: this injection delegates to buildProfitAndLoss, which uses
  // the LINE-LEVEL tag filter even though TB itself uses the EXISTS
  // filter. For pure-uniform-tag tenants the two semantics agree, so
  // the common case stays correct. A mixed-tag tenant running prior-
  // year data through a tag-filtered TB will see RE computed on the
  // line-level subset, which can reintroduce a small debits-vs-credits
  // drift limited to the prior-year RE row. Revisit in Phase 10 if any
  // tenant trips this; the fix is an EXISTS-semantic prior-year P&L
  // variant. Captured in tags-v2 followups.
  if (fyStart > '1900-01-02') {
    // UTC arithmetic so the day-before subtraction can't drift across a
    // month boundary in a non-UTC container.
    const priorEndDate = new Date(fyStart + 'T00:00:00Z');
    priorEndDate.setUTCDate(priorEndDate.getUTCDate() - 1);
    const priorEnd = priorEndDate.toISOString().split('T')[0]!;
    const retainedPL = await buildProfitAndLoss(tenantId, '1900-01-01', priorEnd, 'accrual', companyId, tagId);
    if (retainedPL.netIncome !== 0) {
      // Retained earnings is a credit-balance equity account. Numbered
      // 30120 to sort beside the posted Retained Earnings account (the
      // seeds use 30120; the old '3900' sorted it away from equity), and
      // labeled "(Prior Years)" so the virtual row is distinguishable
      // from the real account when closing entries have been posted.
      const reDebit = retainedPL.netIncome < 0 ? Math.abs(retainedPL.netIncome) : 0;
      const reCredit = retainedPL.netIncome > 0 ? retainedPL.netIncome : 0;
      data.push({
        id: null, account_number: '30120', name: 'Retained Earnings (Prior Years)', account_type: 'equity',
        total_debit: reDebit, total_credit: reCredit,
      });
      totalDebits = Number(new Decimal(totalDebits).plus(reDebit).toFixed(4));
      totalCredits = Number(new Decimal(totalCredits).plus(reCredit).toFixed(4));
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
  // ADR 0XX §5.2 — header-level tag filter: keep the transaction when
  // any of its journal_lines carries this tag.
  tagId?: string;
}, companyId: string | null = null) {
  const conditions = [sql`t.tenant_id = ${tenantId}`, sql`t.status = 'posted'`, companyFilter(companyId)];
  if (filters?.startDate) conditions.push(sql`t.txn_date >= ${filters.startDate}`);
  if (filters?.endDate) conditions.push(sql`t.txn_date <= ${filters.endDate}`);
  if (filters?.txnType) conditions.push(sql`t.txn_type = ${filters.txnType}`);
  if (filters?.tagId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.tag_id = ${filters.tagId})`);
  }

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.total, t.memo, t.status,
      -- STATEMENT_CHECK_PAYEE_V1 — fall back to the check-image payee.
      COALESCE(c.display_name, t.payee_name_on_check) as contact_name,
      -- ADR 0XX 6.3 — comma-separated list of tag names on the txns
      -- journal lines, exported as the line_tag column. Distinct so
      -- multi-tag headers show "Project A, Project B" once each.
      (
        SELECT string_agg(DISTINCT tg.name, ', ' ORDER BY tg.name)
        FROM journal_lines jl
        JOIN tags tg ON tg.id = jl.tag_id AND tg.tenant_id = ${tenantId}
        WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId}
      ) AS line_tag
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC, t.created_at DESC
  `);

  return { title: 'Transaction List', data: rows.rows };
}

export async function buildJournalEntryReport(
  tenantId: string,
  dateRange?: DateRange,
  companyId: string | null = null,
  // ADR 0XX §5.2 — Journal Entry / Transaction Detail report uses the
  // header semantic: keep the journal entry if any of its lines carry
  // the tag. Line-level fidelity is still available in the GL / Account
  // Detail views, which filter line-by-line.
  tagId: string | null = null,
) {
  return buildTransactionList(
    tenantId,
    { ...dateRange, txnType: 'journal_entry', ...(tagId ? { tagId } : {}) },
    companyId,
  );
}

export async function buildAccountReport(
  tenantId: string,
  accountId: string,
  dateRange?: DateRange,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  return buildCheckRegister(tenantId, accountId, dateRange, companyId, tagId);
}
