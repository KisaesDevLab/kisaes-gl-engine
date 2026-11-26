// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import { accounts, companies, portalContactCompanies } from '../db/schema/index.js';
import type { PortalUnpostedBankFeed } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import * as reportSvc from './report.service.js';
import { eligibleAccountConditions, tenantHasSingleCompany } from './portal-banking.service.js';

// Portal live Profit & Loss. Read-only: the P&L itself is the staff
// builder (so the numbers match to the cent) and the drill-down lists the
// lines behind one account using the SAME ledger the builder aggregates —
// the plain journal for accrual companies, the virtual cash-basis ledger
// for cash companies — so a row's transactions always sum to its amount.

const Decimal = DecimalLib.default || DecimalLib;

const PL_ACCOUNT_TYPES = ['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'] as const;
const INCOME_TYPES = new Set<string>(['revenue', 'other_revenue']);
const MAX_RANGE_DAYS = 3 * 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const rangeSchema = z.object({
  startDate: z.string().regex(DATE_RE),
  endDate: z.string().regex(DATE_RE),
});

/** An id a portal request names (company, account). Null when it is missing or not a UUID. */
export function parseUuid(raw: unknown): string | null {
  const parsed = z.string().uuid().safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Throws unless the contact is linked to this company with profit_loss_access.
 * The innerJoin on companies scoped to the session's tenant is what blocks a
 * cross-tenant probe — do not simplify it away.
 *
 * Returns the contact's banking_access for the same company, read from the
 * same row: the unposted bank feed memo is bank data, so it goes only to a
 * contact the firm has also given the banking pages.
 */
export async function assertProfitLossAccess(
  tenantId: string,
  contactId: string,
  companyId: string,
): Promise<{ bankingAccess: boolean }> {
  const link = await db
    .select({ on: portalContactCompanies.profitLossAccess, bankingAccess: portalContactCompanies.bankingAccess })
    .from(portalContactCompanies)
    .innerJoin(companies, eq(companies.id, portalContactCompanies.companyId))
    .where(and(
      eq(portalContactCompanies.contactId, contactId),
      eq(portalContactCompanies.companyId, companyId),
      eq(companies.tenantId, tenantId),
    ))
    .limit(1);
  const row = link[0];
  if (!row?.on) {
    throw AppError.forbidden('Profit & Loss is not enabled for your account', 'PROFIT_LOSS_NOT_ENABLED');
  }
  return { bankingAccess: row.bankingAccess === true };
}

export function validateRange(
  startDate: string | undefined,
  endDate: string | undefined,
): { startDate: string; endDate: string } {
  const parsed = rangeSchema.safeParse({ startDate, endDate });
  if (!parsed.success) {
    throw AppError.badRequest('start_date and end_date are required (YYYY-MM-DD)');
  }
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) throw AppError.badRequest('Invalid date');
  if (start > end) throw AppError.badRequest('start_date must be on or before end_date');
  if ((end - start) / 86_400_000 > MAX_RANGE_DAYS) throw AppError.badRequest('Date range is too long');
  return parsed.data;
}

async function companyBasis(tenantId: string, companyId: string): Promise<'cash' | 'accrual'> {
  const row = await db
    .select({ method: companies.accountingMethod })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
    .limit(1);
  return row[0]?.method === 'cash' ? 'cash' : 'accrual';
}

/**
 * Bank feed activity the P&L does not yet include.
 *
 * Which items count:
 *  - pending and assigned (assigned = a category chosen but not yet
 *    approved and posted) — the staff feed's "waiting" rows;
 *  - categorizing — claimed for posting, entry not written yet;
 *  - categorized or matched rows whose posted entry was later voided
 *    (entry_voided_at set): the void took the entry out of the P&L and the
 *    item keeps its status until staff deal with it, so it is unposted again.
 * Other categorized and matched items point at posted transactions that ARE
 * in the P&L, so counting them would double up; excluded items are out on
 * purpose. Rows flagged possible_duplicate are left out too: they are
 * look-alikes of a line already in the feed, waiting for staff to keep or
 * remove them, and counting them would show the client the same money twice.
 *
 * Scoped by feed_date to the report's inclusive range, and to what the
 * contact can see on the portal's banking pages:
 *  - the item's bank connection must be on an account those pages list
 *    (eligibleAccountConditions: an active bank or card account of the
 *    company), so a retired account's leftovers do not show up here alone;
 *  - the item belongs to the company when its company_id matches. Older
 *    items were stored with no company; those take their connection's
 *    company, and failing that the tenant's only company.
 *
 * Feed amounts are signed (positive = money out). Money in and money out
 * are reported separately and `amount` is their sum, never a net: a net
 * figure could read $0 when a deposit and a payment offset, which is
 * exactly the activity this line exists to surface. None of it is profit
 * or loss yet — transfers, card payments and owner draws are in here too.
 */
export async function getUnpostedBankFeed(
  tenantId: string,
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<PortalUnpostedBankFeed> {
  const singleCompany = await tenantHasSingleCompany(tenantId);
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(CASE WHEN bfi.amount < 0 THEN -bfi.amount ELSE 0 END), 0) AS money_in,
           COALESCE(SUM(CASE WHEN bfi.amount > 0 THEN bfi.amount ELSE 0 END), 0) AS money_out
    FROM bank_feed_items bfi
    JOIN bank_connections bc ON bc.id = bfi.bank_connection_id AND bc.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = bc.account_id
    WHERE bfi.tenant_id = ${tenantId}
      AND ${eligibleAccountConditions(tenantId, companyId, singleCompany)}
      AND (
        bfi.company_id = ${companyId}
        OR (bfi.company_id IS NULL AND (
          bc.company_id = ${companyId}
          OR (bc.company_id IS NULL AND ${singleCompany})
        ))
      )
      AND (
        bfi.status IN ('pending', 'assigned', 'categorizing')
        OR (bfi.status IN ('categorized', 'matched') AND bfi.entry_voided_at IS NOT NULL)
      )
      AND NOT bfi.possible_duplicate
      AND bfi.feed_date >= ${startDate}::date AND bfi.feed_date <= ${endDate}::date
  `);
  const row = (res.rows as unknown as Array<{ count: number; money_in: string; money_out: string }>)[0];
  const moneyIn = new Decimal(row?.money_in ?? 0);
  const moneyOut = new Decimal(row?.money_out ?? 0);
  return {
    count: row?.count ?? 0,
    moneyIn: moneyIn.toNumber(),
    moneyOut: moneyOut.toNumber(),
    amount: moneyIn.plus(moneyOut).toNumber(),
  };
}

export async function getPortalProfitAndLoss(
  tenantId: string,
  companyId: string,
  startDate: string,
  endDate: string,
  options: { includeUnpostedBankFeed?: boolean } = {},
) {
  const basis = await companyBasis(tenantId, companyId);
  const pl = await reportSvc.buildProfitAndLoss(tenantId, startDate, endDate, basis, companyId);
  // The memo is bank data: left off entirely (not zeroed) unless the caller
  // says this contact may see the company's bank activity.
  if (!options.includeUnpostedBankFeed) return pl;
  // Additive: the P&L itself is untouched so it still equals the staff
  // builder to the cent. The unposted line is a memo beneath it, never
  // folded into net income.
  const unpostedBankFeed = await getUnpostedBankFeed(tenantId, companyId, startDate, endDate);
  return { ...pl, unpostedBankFeed };
}

export interface PortalPlTransactionLine {
  /** Transaction id — the handle the portal uses to ask a question. */
  transactionId: string;
  date: string;
  type: string;
  number: string | null;
  payee: string | null;
  memo: string | null;
  /** Normal-balance signed, like the P&L row it drills into. */
  amount: number;
}

interface CountRow { total: number; sum: string }
interface LineRow {
  transaction_id: string;
  txn_date: string | Date;
  txn_type: string;
  txn_number: string | null;
  memo: string | null;
  payee: string | null;
  amount: string;
}

export async function getPortalAccountTransactions(
  tenantId: string,
  companyId: string,
  accountId: string,
  startDate: string,
  endDate: string,
  page: number,
  perPage: number,
) {
  const acct = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      accountNumber: accounts.accountNumber,
      accountType: accounts.accountType,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.tenantId, tenantId)))
    .limit(1);
  const account = acct[0];
  if (!account || !(PL_ACCOUNT_TYPES as readonly string[]).includes(account.accountType)) {
    throw AppError.notFound('Account not found');
  }
  const isIncome = INCOME_TYPES.has(account.accountType);
  const basis = await companyBasis(tenantId, companyId);
  const offset = (page - 1) * perPage;

  // Both branches expose the same columns: transaction_id, txn_date,
  // txn_type, txn_number, memo, txn_contact_id, debit, credit.
  const source = basis === 'cash'
    ? sql`WITH ${reportSvc.cashBasisLinesWith(tenantId, startDate, endDate, companyId)},
      src AS (
        SELECT transaction_id, txn_date, txn_type, txn_number, memo, txn_contact_id, debit, credit
        FROM cb_lines WHERE account_id = ${accountId}
      )`
    : sql`WITH src AS (
        SELECT t.id AS transaction_id, t.txn_date, t.txn_type, t.txn_number, t.memo,
          t.contact_id AS txn_contact_id, jl.debit::numeric AS debit, jl.credit::numeric AS credit
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id
        WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
          AND t.tenant_id = ${tenantId} AND t.status = 'posted'
          AND t.basis <> 'cash'
          AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
          AND t.company_id = ${companyId}
      )`;

  const amountExpr = isIncome ? sql`(s.credit - s.debit)` : sql`(s.debit - s.credit)`;

  // U-155: the cash source runs with the cash-basis planner settings.
  const run = basis === 'cash' ? reportSvc.executeCashBasis : (q: SQL) => db.execute(q);
  const [countRes, rowsRes] = await Promise.all([
    run(sql`${source} SELECT COUNT(*)::int AS total, COALESCE(SUM(${amountExpr}), 0) AS sum FROM src s`),
    run(sql`${source}
      SELECT s.transaction_id, s.txn_date, s.txn_type, s.txn_number, s.memo,
        c.display_name AS payee, ${amountExpr} AS amount
      FROM src s
      LEFT JOIN contacts c ON c.id = s.txn_contact_id AND c.tenant_id = ${tenantId}
      ORDER BY s.txn_date DESC, s.transaction_id
      LIMIT ${perPage} OFFSET ${offset}`),
  ]);

  const countRow = (countRes.rows as unknown as CountRow[])[0];
  const items: PortalPlTransactionLine[] = (rowsRes.rows as unknown as LineRow[]).map((r) => ({
    transactionId: r.transaction_id,
    date: typeof r.txn_date === 'string' ? r.txn_date.slice(0, 10) : r.txn_date.toISOString().slice(0, 10),
    type: r.txn_type,
    number: r.txn_number,
    payee: r.payee,
    memo: r.memo,
    amount: Number(r.amount),
  }));

  return {
    account: { id: account.id, name: account.name, accountNumber: account.accountNumber },
    startDate,
    endDate,
    items,
    total: countRow?.total ?? 0,
    sum: Number(countRow?.sum ?? 0),
    page,
    perPage,
  };
}
