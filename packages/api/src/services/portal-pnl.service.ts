// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, companies, portalContactCompanies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as reportSvc from './report.service.js';

// Portal live Profit & Loss. Read-only: the P&L itself is the staff
// builder (so the numbers match to the cent) and the drill-down lists the
// lines behind one account using the SAME ledger the builder aggregates —
// the plain journal for accrual companies, the virtual cash-basis ledger
// for cash companies — so a row's transactions always sum to its amount.

const PL_ACCOUNT_TYPES = ['revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'] as const;
const INCOME_TYPES = new Set<string>(['revenue', 'other_revenue']);
const MAX_RANGE_DAYS = 3 * 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Throws unless the contact is linked to this company with profit_loss_access.
 * The innerJoin on companies scoped to the session's tenant is what blocks a
 * cross-tenant probe — do not simplify it away.
 */
export async function assertProfitLossAccess(
  tenantId: string,
  contactId: string,
  companyId: string,
): Promise<void> {
  const link = await db
    .select({ on: portalContactCompanies.profitLossAccess })
    .from(portalContactCompanies)
    .innerJoin(companies, eq(companies.id, portalContactCompanies.companyId))
    .where(and(
      eq(portalContactCompanies.contactId, contactId),
      eq(portalContactCompanies.companyId, companyId),
      eq(companies.tenantId, tenantId),
    ))
    .limit(1);
  if (link.length === 0 || !link[0]?.on) {
    throw AppError.forbidden('Profit & Loss is not enabled for your account', 'PROFIT_LOSS_NOT_ENABLED');
  }
}

export function validateRange(
  startDate: string | undefined,
  endDate: string | undefined,
): { startDate: string; endDate: string } {
  if (!startDate || !endDate || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw AppError.badRequest('start_date and end_date are required (YYYY-MM-DD)');
  }
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) throw AppError.badRequest('Invalid date');
  if (start > end) throw AppError.badRequest('start_date must be on or before end_date');
  if ((end - start) / 86_400_000 > MAX_RANGE_DAYS) throw AppError.badRequest('Date range is too long');
  return { startDate, endDate };
}

async function companyBasis(tenantId: string, companyId: string): Promise<'cash' | 'accrual'> {
  const row = await db
    .select({ method: companies.accountingMethod })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
    .limit(1);
  return row[0]?.method === 'cash' ? 'cash' : 'accrual';
}

export async function getPortalProfitAndLoss(
  tenantId: string,
  companyId: string,
  startDate: string,
  endDate: string,
) {
  const basis = await companyBasis(tenantId, companyId);
  return reportSvc.buildProfitAndLoss(tenantId, startDate, endDate, basis, companyId);
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

  const [countRes, rowsRes] = await Promise.all([
    db.execute(sql`${source} SELECT COUNT(*)::int AS total, COALESCE(SUM(${amountExpr}), 0) AS sum FROM src s`),
    db.execute(sql`${source}
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
