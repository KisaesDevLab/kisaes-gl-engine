// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PORTAL_BANKING_V1 — read-only checking/credit-card book balances and
// sanitized registers for portal contacts. Everything here is scoped
// tenant → company → per-contact banking_access, and the register is a
// reduced projection of register.service's getRegister (no voids, no
// memos, no reconciliation state, no edit affordances).

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, companies, portalContactCompanies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { getRegister } from './register.service.js';
import { BANK_ACCOUNT_DETAIL_TYPES, RECONCILABLE_LIABILITY_DETAIL_TYPES } from './report.service.js';

export interface PortalBankAccount {
  id: string;
  name: string;
  accountNumber: string | null;
  kind: 'bank' | 'card';
  detailType: string | null;
  // Sign-adjusted: liabilities negated so a credit card reads as a
  // positive "balance owed". Book balance, never the live bank balance.
  balance: number;
}

export interface PortalRegisterLine {
  id: string;
  date: string;
  description: string | null;
  category: string | null;
  checkNumber: number | null;
  payment: number | null;
  deposit: number | null;
  runningBalance: number;
}

// accounts.company_id is NULL in the standard provisioning path, so a
// strict company_id match would hide every account for most tenants.
// Rule: an account belongs to the company iff company_id matches, OR
// company_id IS NULL and the tenant has exactly one company (the common
// case). In multi-company tenants NULL-company accounts stay hidden —
// their registers would leak the other companies' transactions because
// journal data has no per-line company filter.
export async function tenantHasSingleCompany(tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(companies)
    .where(eq(companies.tenantId, tenantId));
  return (rows[0]?.cnt ?? 0) === 1;
}

// Throws unless the contact is linked to this company with
// banking_access AND the company belongs to the session tenant.
// companyId comes from the query string — the tenant join here is what
// blocks cross-tenant probes.
export async function assertBankingAccess(
  tenantId: string,
  contactId: string,
  companyId: string,
): Promise<void> {
  const link = await db
    .select({ bankingAccess: portalContactCompanies.bankingAccess })
    .from(portalContactCompanies)
    .innerJoin(companies, eq(companies.id, portalContactCompanies.companyId))
    .where(
      and(
        eq(portalContactCompanies.contactId, contactId),
        eq(portalContactCompanies.companyId, companyId),
        eq(companies.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (link.length === 0 || !link[0]?.bankingAccess) {
    throw AppError.forbidden('Bank & card activity is not enabled for your account', 'BANKING_NOT_ENABLED');
  }
}

function eligibleAccountConditions(tenantId: string, companyId: string, singleCompany: boolean) {
  const bankList = sql.join(BANK_ACCOUNT_DETAIL_TYPES.map((d) => sql`${d}`), sql`, `);
  const ccList = sql.join(RECONCILABLE_LIABILITY_DETAIL_TYPES.map((d) => sql`${d}`), sql`, `);
  return sql`
    a.tenant_id = ${tenantId}
    AND a.is_active = true
    AND (
      (a.account_type = 'asset' AND a.detail_type IN (${bankList}))
      OR (a.account_type = 'liability' AND a.detail_type IN (${ccList}))
    )
    AND (a.company_id = ${companyId} OR (a.company_id IS NULL AND ${singleCompany}))
  `;
}

interface EligibleAccountRow {
  id: string;
  name: string;
  account_number: string | null;
  account_type: string;
  detail_type: string | null;
  balance: string | null;
}

export async function listPortalBankAccounts(
  tenantId: string,
  companyId: string,
): Promise<PortalBankAccount[]> {
  const singleCompany = await tenantHasSingleCompany(tenantId);
  const result = await db.execute(sql`
    SELECT a.id, a.name, a.account_number, a.account_type, a.detail_type, a.balance
    FROM accounts a
    WHERE ${eligibleAccountConditions(tenantId, companyId, singleCompany)}
    ORDER BY a.account_type ASC, a.name ASC
  `);
  return (result.rows as unknown as EligibleAccountRow[]).map((row) => {
    const raw = parseFloat(row.balance ?? '0');
    const isCard = row.account_type === 'liability';
    return {
      id: row.id,
      name: row.name,
      accountNumber: row.account_number ?? null,
      kind: isCard ? 'card' : 'bank',
      detailType: row.detail_type ?? null,
      balance: Math.round((isCard ? -raw : raw) * 100) / 100,
    };
  });
}

export async function getPortalRegister(
  tenantId: string,
  companyId: string,
  accountId: string,
  filters: { startDate?: string; endDate?: string; search?: string; page?: number; perPage?: number },
) {
  // Re-check the account against the eligibility predicate for THIS
  // company. 404 (not 403) on failure — same response as a nonexistent
  // id, so probing can't distinguish "exists elsewhere" from "doesn't
  // exist".
  const singleCompany = await tenantHasSingleCompany(tenantId);
  const eligible = await db.execute(sql`
    SELECT a.id, a.name, a.account_type, a.balance
    FROM accounts a
    WHERE a.id = ${accountId} AND ${eligibleAccountConditions(tenantId, companyId, singleCompany)}
    LIMIT 1
  `);
  const acct = (eligible.rows as unknown as Pick<EligibleAccountRow, 'id' | 'name' | 'account_type' | 'balance'>[])[0];
  if (!acct) throw AppError.notFound('Account not found');

  const perPage = Math.min(filters.perPage ?? 50, 100);
  const reg = await getRegister(tenantId, accountId, {
    startDate: filters.startDate,
    endDate: filters.endDate,
    search: filters.search,
    page: filters.page ?? 1,
    perPage,
    sortDir: 'desc',
    // Never pass includeVoid — clients never see voided transactions.
  });

  const isCard = acct.account_type === 'liability';
  const rawBalance = parseFloat(acct.balance ?? '0');

  const lines: PortalRegisterLine[] = reg.lines.map((l) => ({
    id: l.lineId,
    date: l.txnDate,
    description: l.payeeName,
    category: l.categoryName,
    checkNumber: l.checkNumber,
    payment: l.payment,
    deposit: l.deposit,
    runningBalance: l.runningBalance,
  }));

  return {
    account: {
      id: acct.id as string,
      name: acct.name as string,
      kind: (isCard ? 'card' : 'bank') as 'bank' | 'card',
    },
    currentBalance: Math.round((isCard ? -rawBalance : rawBalance) * 100) / 100,
    balanceForward: reg.balanceForward,
    endingBalance: reg.endingBalance,
    startDate: reg.filtersApplied.startDate as string,
    endDate: reg.filtersApplied.endDate as string,
    lines,
    pagination: reg.pagination,
  };
}
