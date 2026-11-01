// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import type { CreateCustomerRefundInput } from '@kis-books/shared';
import { db, type Tx } from '../db/index.js';
import { accounts, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

/**
 * A customer refund: Dr A/R, Cr the account the money leaves. With
 * sourcePaymentId (U-133, payment-settle-v1) it refunds that payment's
 * unapplied credit: the payment is locked in the same database transaction,
 * must be a posted, unbounced payment of the same client and company, and
 * the refund must be within what is left of its credit (409
 * CREDIT_NOT_AVAILABLE). Voiding the refund gives the credit back (it is
 * computed); the payment can't be voided or bounced while the refund is live.
 */
export async function createCustomerRefund(tenantId: string, input: CreateCustomerRefundInput, userId?: string, companyId?: string) {
  const arAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')),
  });
  if (!arAccount) throw AppError.internal('AR account not found');

  const post = (tx?: Tx, debitAccountId: string = arAccount.id) => ledger.postTransaction(tenantId, {
    txnType: 'customer_refund',
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    total: input.amount,
    paymentMethod: input.paymentMethod,
    referenceNumber: input.refNo,
    ...(input.sourcePaymentId ? { sourcePaymentId: input.sourcePaymentId } : {}),
    lines: [
      // DR: AR (reduce what customer owes — they overpaid or we owe them)
      { accountId: debitAccountId, debit: input.amount, credit: '0' },
      // CR: Bank (money goes out)
      { accountId: input.refundFromAccountId, debit: '0', credit: input.amount },
    ],
  }, userId, companyId, tx);

  if (!input.sourcePaymentId) return post();

  const sourceId = input.sourcePaymentId;
  return db.transaction(async (tx) => {
    const payments = await import('./payment.service.js');
    const { round2, dec } = await import('./payment-compute.js');
    let amount;
    try { amount = dec(input.amount); } catch { throw AppError.badRequest('amount must be a decimal amount', 'VALIDATION_ERROR'); }
    if (!amount.equals(round2(amount)) || !amount.greaterThan(0)) {
      throw AppError.badRequest('amount must be an amount above 0.00 with at most 2 decimal places', 'VALIDATION_ERROR');
    }
    const [src] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, sourceId)))
      .for('update').limit(1);
    if (!src || src.txnType !== 'customer_payment' || src.status === 'deleted' || ledger.inOtherCompany(src, companyId)) {
      throw AppError.notFound('Payment not found');
    }
    if (src.contactId !== input.contactId) {
      throw AppError.badRequest('That payment belongs to another client.', 'CREDIT_NOT_FOR_CUSTOMER', { sourcePaymentId: sourceId });
    }
    await payments.assertNoBouncedPayments(tx, tenantId, [sourceId]);
    const remaining = await payments.creditRemaining(tx, tenantId, src);
    if (amount.greaterThan(remaining)) {
      throw AppError.conflict(`Only ${remaining.toFixed(2)} of that credit is left.`, 'CREDIT_NOT_AVAILABLE',
        { sourcePaymentId: sourceId, remaining: remaining.toFixed(2) });
    }
    // A held deposit's refund comes out of Customer Deposits, not A/R (U-135).
    const { getOrCreateSystemAccount } = await import('./system-accounts.service.js');
    const debit = src.holdsDeposit ? await getOrCreateSystemAccount(tenantId, 'customer_deposits', companyId) : arAccount.id;
    const refund = await post(tx, debit);
    await tx.update(transactions).set({ updatedAt: new Date() })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, sourceId)));
    return refund;
  });
}
