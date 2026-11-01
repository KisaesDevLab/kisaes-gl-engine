// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * The accounts a customer payment settles an invoice to besides cash
 * (U-133 payment-settle-v1, U-134 payment-discounts-v1): the write-off
 * account (company setting writeOffAccountId, Receive Payment's
 * writeOffAccountId) and the sales discount account (company setting
 * salesDiscountAccountId, Receive Payment's discountAccountId). The
 * bill-discount-account.ts pattern; kept free of the ledger and company
 * services so both can use it.
 */

import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { accounts, companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

const FORBIDDEN_TAGS = ['accounts_receivable', 'accounts_payable', 'payments_clearing', 'customer_deposits'];

async function assertSettleAccount(
  executor: DbOrTx,
  tenantId: string,
  companyId: string | null | undefined,
  accountId: string,
  depositTo: string | undefined,
  code: 'WRITE_OFF_ACCOUNT_INVALID' | 'DISCOUNT_ACCOUNT_INVALID',
  what: string,
): Promise<void> {
  const [row] = await executor
    .select({ id: accounts.id, companyId: accounts.companyId, systemTag: accounts.systemTag, isActive: accounts.isActive, detailType: accounts.detailType })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)))
    .limit(1);
  const invalid = (message: string) => AppError.badRequest(message, code, { accountId });
  if (!row || (companyId && row.companyId !== null && row.companyId !== companyId)) {
    throw invalid(`The ${what} account is not an account of this company.`);
  }
  if (row.isActive === false) throw invalid(`The ${what} account is inactive.`);
  if (FORBIDDEN_TAGS.includes(row.systemTag ?? '') || row.detailType === 'accounts_receivable' || row.detailType === 'accounts_payable') {
    throw invalid(`The ${what} can't post to Accounts Receivable, Accounts Payable, Payments Clearing or Customer Deposits.`);
  }
  if (depositTo && row.id === depositTo) throw invalid(`The ${what} can't post to the account the payment is deposited to.`);
}

/** 400 WRITE_OFF_ACCOUNT_INVALID unless an active account of this company, not A/R, A/P, Payments Clearing, Customer Deposits or depositTo. */
export function assertWriteOffAccount(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined, accountId: string, depositTo?: string,
): Promise<void> {
  return assertSettleAccount(executor, tenantId, companyId, accountId, depositTo, 'WRITE_OFF_ACCOUNT_INVALID', 'write-off');
}

/** 400 DISCOUNT_ACCOUNT_INVALID, the same rules for the sales discount account. */
export function assertSalesDiscountAccount(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined, accountId: string, depositTo?: string,
): Promise<void> {
  return assertSettleAccount(executor, tenantId, companyId, accountId, depositTo, 'DISCOUNT_ACCOUNT_INVALID', 'discount');
}

export interface SettleSettings {
  writeOffAccountId: string | null;
  writeOffThreshold: string | null;
  salesDiscountAccountId: string | null;
}

/** The company's write-off and sales discount settings (all null without a company). */
export async function companySettleSettings(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined,
): Promise<SettleSettings> {
  if (!companyId) return { writeOffAccountId: null, writeOffThreshold: null, salesDiscountAccountId: null };
  const [row] = await executor
    .select({
      writeOffAccountId: companies.writeOffAccountId,
      writeOffThreshold: companies.writeOffThreshold,
      salesDiscountAccountId: companies.salesDiscountAccountId,
    })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  return {
    writeOffAccountId: row?.writeOffAccountId ?? null,
    writeOffThreshold: row?.writeOffThreshold ?? null,
    salesDiscountAccountId: row?.salesDiscountAccountId ?? null,
  };
}
