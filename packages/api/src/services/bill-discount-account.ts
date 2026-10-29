// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * The early-payment discount account (U-101, bill-discounts-v1): the
 * company setting billDiscountAccountId and Pay Bills' discountAccountId.
 * Kept free of the ledger and company services so both can use it.
 */

import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { accounts, companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

/**
 * An account of this tenant, tenant-wide or of `companyId`, active, and
 * neither Accounts Payable nor `bankAccountId` (a discount posted there
 * would settle the bill without moving A/P or would net out against the
 * payment). Otherwise 400 DISCOUNT_ACCOUNT_INVALID.
 */
export async function assertBillDiscountAccount(
  executor: DbOrTx,
  tenantId: string,
  companyId: string | null | undefined,
  accountId: string,
  bankAccountId?: string,
): Promise<void> {
  const [row] = await executor
    .select({ id: accounts.id, companyId: accounts.companyId, systemTag: accounts.systemTag, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)))
    .limit(1);
  const invalid = (message: string) => AppError.badRequest(message, 'DISCOUNT_ACCOUNT_INVALID', { accountId });
  if (!row || (companyId && row.companyId !== null && row.companyId !== companyId)) {
    throw invalid('The discount account is not an account of this company.');
  }
  if (row.isActive === false) throw invalid('The discount account is inactive.');
  if (row.systemTag === 'accounts_payable') throw invalid('Discounts cannot post to Accounts Payable.');
  if (bankAccountId && row.id === bankAccountId) throw invalid('Discounts cannot post to the account the bills are paid from.');
}

/** The company's default discount account, or null. */
export async function companyBillDiscountAccountId(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined,
): Promise<string | null> {
  if (!companyId) return null;
  const [row] = await executor
    .select({ id: companies.billDiscountAccountId })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  return row?.id ?? null;
}
