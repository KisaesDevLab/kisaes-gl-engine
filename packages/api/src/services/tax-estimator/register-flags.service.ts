// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Register / transaction-detail surface for the per-transaction non-recurring flag
// (R7-07 #2; MODULE.md "Tax-treatment map": individual transactions can carry their own
// non_recurring flag in tax_est_transaction_flags). The flag rows, their audit trail and
// the P&L provider's read are the existing ones (treatments.service.ts); this file only
// answers "may this caller flag THIS transaction from the books screens".
//
// Contracts:
// - tenantId is the caller's ACTIVE tenant and must be inside the D1 scope (the router
//   resolves the scope from the tenant's managing firm, like the Report Pack section);
// - the transaction is loaded strictly by (tenant_id, id) and must belong to the active
//   company (a NULL-company transaction is readable but never linked);
// - a flag can only be SET on a company linked to one of the firm's active taxpayers
//   (409 TE_COMPANY_NOT_LINKED); removing goes through the same write path.

import { and, eq } from 'drizzle-orm';
import type { RegisterCompanyFlagsDTO, RegisterTransactionFlagDTO } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxEstTransactionFlags, transactions } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { isTenantInScope, type FirmScope } from './firm-scope.service.js';
import { isCompanyLinkedInFirm, listPackTaxpayers } from './estimate-documents.service.js';
import * as treatmentsService from './treatments.service.js';

const COMPANY_FLAGS_LIMIT = 500;

const canEdit = (scope: FirmScope) => scope.firmRole === 'firm_admin' || scope.firmRole === 'firm_staff';
const notFound = () => new AppError(404, 'Transaction not found', 'TE_TRANSACTION_NOT_FOUND');

async function loadTransaction(scope: FirmScope, tenantId: string, activeCompanyId: string, transactionId: string) {
  if (!isTenantInScope(scope, tenantId)) throw AppError.notFound('Feature not available');
  const [txn] = await db.select({ id: transactions.id, companyId: transactions.companyId }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)))
    .limit(1);
  if (!txn || (txn.companyId != null && txn.companyId !== activeCompanyId)) throw notFound();
  return txn;
}

export async function getTransactionFlag(
  scope: FirmScope, tenantId: string, activeCompanyId: string, transactionId: string,
): Promise<RegisterTransactionFlagDTO> {
  const txn = await loadTransaction(scope, tenantId, activeCompanyId, transactionId);
  // D17: `taxpayers` lists only those the caller may see; `linked` is firm-wide (the flag is entity data).
  const taxpayers = txn.companyId ? await listPackTaxpayers(scope, tenantId, txn.companyId) : [];
  const linked = txn.companyId ? await isCompanyLinkedInFirm(scope, tenantId, txn.companyId) : false;
  const [flag] = await db.select({ nonRecurring: taxEstTransactionFlags.nonRecurring, updatedAt: taxEstTransactionFlags.updatedAt })
    .from(taxEstTransactionFlags)
    .where(and(eq(taxEstTransactionFlags.tenantId, tenantId), eq(taxEstTransactionFlags.transactionId, txn.id)))
    .limit(1);
  return {
    transactionId: txn.id,
    companyId: txn.companyId ?? null,
    linked,
    taxpayers,
    nonRecurring: flag?.nonRecurring === true,
    canEdit: canEdit(scope),
    updatedAt: flag ? flag.updatedAt.toISOString() : null,
  };
}

export async function setTransactionFlag(
  scope: FirmScope, tenantId: string, activeCompanyId: string, transactionId: string, nonRecurring: boolean, userId?: string,
): Promise<RegisterTransactionFlagDTO> {
  const current = await getTransactionFlag(scope, tenantId, activeCompanyId, transactionId);
  if (!current.linked || !current.companyId) {
    throw AppError.conflict('This company is not linked to a taxpayer in the Tax Estimator', 'TE_COMPANY_NOT_LINKED');
  }
  if (current.nonRecurring !== nonRecurring) {
    // The existing write path: scope + company re-check, one audited row per change.
    await treatmentsService.putTransactionFlags(scope, tenantId, current.companyId, { flags: [{ transactionId, nonRecurring }] }, userId);
  }
  return getTransactionFlag(scope, tenantId, activeCompanyId, transactionId);
}

/** Flagged transactions of the active company, for the register badges. Empty when the company is not linked. */
export async function listCompanyFlags(scope: FirmScope, tenantId: string, companyId: string): Promise<RegisterCompanyFlagsDTO> {
  if (!isTenantInScope(scope, tenantId)) throw AppError.notFound('Feature not available');
  const linked = await isCompanyLinkedInFirm(scope, tenantId, companyId);
  if (!linked) return { companyId, linked, canEdit: canEdit(scope), transactionIds: [], total: 0, limit: COMPANY_FLAGS_LIMIT };
  const page = await treatmentsService.listTransactionFlags(scope, tenantId, companyId, { limit: COMPANY_FLAGS_LIMIT, offset: 0 });
  return {
    companyId, linked, canEdit: canEdit(scope),
    transactionIds: page.items.filter((f) => f.nonRecurring).map((f) => f.transactionId),
    total: page.total,
    limit: COMPANY_FLAGS_LIMIT,
  };
}
