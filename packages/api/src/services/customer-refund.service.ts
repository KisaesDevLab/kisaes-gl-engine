// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import type { CreateCustomerRefundInput } from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import { accounts, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

export interface CustomerRefundOptions {
  /**
   * POST /customer-refunds (U-139): the refund account must be a bank-type
   * account of the company (checking, savings, cash), not Payments
   * Clearing, A/R or Customer Deposits (400 REFUND_ACCOUNT_INVALID,
   * Q-P22l); paymentMethod check with no number waits in the print queue.
   * The old POST /transactions path keeps its behaviour.
   */
  strictAccount?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 400 REFUND_ACCOUNT_INVALID unless the account is a bank-type asset of this company. */
async function assertRefundAccount(executor: DbOrTx, tenantId: string, accountId: string, companyId?: string) {
  const [acct] = await executor.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  const bankish = !!acct && acct.accountType === 'asset'
    && !['payments_clearing', 'accounts_receivable', 'customer_deposits'].includes(acct.systemTag ?? '')
    && ['bank', 'checking', 'savings', 'cash', 'cash_on_hand', 'money_market'].includes(acct.detailType ?? '');
  if (!acct || ledger.inOtherCompany(acct, companyId) || !bankish || acct.isActive === false) {
    throw AppError.badRequest('Choose the bank account the refund is paid from.', 'REFUND_ACCOUNT_INVALID', { accountId });
  }
}

/**
 * A customer refund: Dr A/R, Cr the account the money leaves. With
 * sourcePaymentId / sourceId (U-133, U-139) it refunds that source's
 * remaining credit: a customer payment (its unapplied credit), a held
 * deposit (Dr Customer Deposits instead of A/R) or a credit memo, locked in
 * the same database transaction, of the same client and company; within
 * what is left (409 CREDIT_NOT_AVAILABLE {remaining}); dated on or after
 * the source (400 REFUND_DATE_BEFORE_SOURCE). Voiding the refund gives the
 * credit back (it is computed); the source can't be voided while the
 * refund is live. By check (U-139, refund-checks-v1): printLater puts it in
 * the check print queue (on POST /customer-refunds, paymentMethod check
 * with no number defaults to printLater, Q-P22d); a typed checkNumber is
 * checked against the bank account (409 CHECK_NUMBER_IN_USE). Both
 * printLater true and a checkNumber is 400 VALIDATION_ERROR (the queue
 * numbers the check when it prints).
 */
export async function createCustomerRefund(
  tenantId: string, input: CreateCustomerRefundInput, userId?: string, companyId?: string, opts: CustomerRefundOptions = {},
) {
  if (input.printLater === true && input.checkNumber !== undefined) {
    throw AppError.badRequest('Either print the check later or type its number, not both.', 'VALIDATION_ERROR',
      { fields: ['printLater', 'checkNumber'] });
  }
  const sourceId = input.sourcePaymentId ?? input.sourceId;
  const byCheck = input.printLater === true || input.checkNumber !== undefined
    || (opts.strictAccount === true && input.paymentMethod === 'check');
  const printLater = input.printLater ?? (byCheck && input.checkNumber === undefined);

  return db.transaction(async (tx) => {
    const { getOrCreateSystemAccount } = await import('./system-accounts.service.js');
    const arAccountId = await getOrCreateSystemAccount(tenantId, 'accounts_receivable', companyId, userId, tx);
    if (opts.strictAccount) await assertRefundAccount(tx, tenantId, input.refundFromAccountId, companyId);
    const { round2, dec } = await import('./payment-compute.js');
    let amount;
    try { amount = dec(input.amount); } catch { throw AppError.badRequest('amount must be a decimal amount', 'VALIDATION_ERROR'); }
    if ((sourceId || opts.strictAccount) && (!amount.equals(round2(amount)) || !amount.greaterThan(0))) {
      throw AppError.badRequest('amount must be an amount above 0.00 with at most 2 decimal places', 'VALIDATION_ERROR');
    }

    let debit = arAccountId;
    if (sourceId) {
      if (!UUID_RE.test(sourceId)) throw AppError.notFound('Credit not found');
      const payments = await import('./payment.service.js');
      const [src] = await tx.select().from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, sourceId)))
        .for('update').limit(1);
      if (!src || !payments.isCreditSourceType(src.txnType) || src.status === 'deleted' || ledger.inOtherCompany(src, companyId)) {
        throw AppError.notFound(src?.txnType === 'credit_memo' ? 'Credit memo not found' : 'Payment not found');
      }
      if (src.contactId !== input.contactId) {
        throw AppError.badRequest('That credit belongs to another client.', 'CREDIT_NOT_FOR_CUSTOMER', { sourcePaymentId: sourceId, sourceId });
      }
      if (input.txnDate < src.txnDate) {
        throw AppError.badRequest(`A credit can't be refunded before its own date (${src.txnDate}).`, 'REFUND_DATE_BEFORE_SOURCE',
          { sourceId, sourceDate: src.txnDate });
      }
      if (src.txnType === 'customer_payment') await payments.assertNoBouncedPayments(tx, tenantId, [sourceId]);
      const remaining = await payments.creditRemaining(tx, tenantId, src);
      if (amount.greaterThan(remaining)) {
        throw AppError.conflict(`Only ${remaining.toFixed(2)} of that credit is left.`, 'CREDIT_NOT_AVAILABLE',
          { sourcePaymentId: sourceId, sourceId, remaining: remaining.toFixed(2) });
      }
      // A held deposit's refund comes out of Customer Deposits, not A/R (U-135).
      if (src.holdsDeposit) debit = await getOrCreateSystemAccount(tenantId, 'customer_deposits', companyId, userId, tx);
    }

    let checkNumber: number | null = null;
    if (input.checkNumber !== undefined && !printLater) {
      const checks = await import('./check.service.js');
      await checks.lockCheckCounter(tx, tenantId, companyId);
      await checks.assertCheckNumberRangeFree(tx, tenantId, input.refundFromAccountId, input.checkNumber, input.checkNumber);
      await checks.advanceCheckCounterPast(tx, tenantId, input.refundFromAccountId, input.checkNumber, companyId);
      checkNumber = input.checkNumber;
    }

    const refund = await ledger.postTransaction(tenantId, {
      txnType: 'customer_refund',
      txnDate: input.txnDate,
      contactId: input.contactId,
      memo: input.memo,
      total: input.amount,
      paymentMethod: input.paymentMethod,
      referenceNumber: input.refNo,
      ...(sourceId ? { sourcePaymentId: sourceId } : {}),
      lines: [
        // DR: A/R (or Customer Deposits for a held deposit): the client's credit goes down.
        { accountId: debit, debit: input.amount, credit: '0' },
        // CR: Bank (money goes out)
        { accountId: input.refundFromAccountId, debit: '0', credit: input.amount },
      ],
    } as ledger.PostTransactionInput, userId, companyId, tx);
    if (byCheck) {
      // As createCheck stores them (check.service.ts): the print queue reads these columns.
      await tx.update(transactions).set({ isCheck: true, printStatus: printLater ? 'queue' : 'hand_written', checkNumber })
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, refund.id)));
      Object.assign(refund, { isCheck: true, printStatus: printLater ? 'queue' : 'hand_written', checkNumber });
    }
    if (sourceId) {
      await tx.update(transactions).set({ updatedAt: new Date() })
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, sourceId)));
    }
    return refund;
  });
}

export interface RefundRecord {
  id: string; date: string; customerId: string | null; amount: string; method: string | null; refNo: string | null;
  checkNumber: number | null; printStatus: string | null; refundFromAccountId: string | null;
  source: { id: string; kind: 'payment' | 'credit_memo' | 'deposit'; number: string | null } | null;
  updatedAt: string | null; status: string;
}

/** GET /customer-refunds/:id (U-139). Another company's refund is 404. */
export async function getRefundRecord(tenantId: string, id: string, companyId?: string): Promise<RefundRecord> {
  if (!UUID_RE.test(id)) throw AppError.notFound('Refund not found');
  const [r] = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).limit(1);
  if (!r || r.txnType !== 'customer_refund' || r.status === 'deleted' || ledger.inOtherCompany(r, companyId)) {
    throw AppError.notFound('Refund not found');
  }
  let source: RefundRecord['source'] = null;
  if (r.sourcePaymentId) {
    const [s] = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, r.sourcePaymentId))).limit(1);
    if (s) {
      source = {
        id: s.id,
        kind: s.txnType === 'credit_memo' ? 'credit_memo' : s.holdsDeposit ? 'deposit' : 'payment',
        number: s.txnType === 'credit_memo' ? s.txnNumber : (s.referenceNumber ?? s.txnNumber),
      };
    }
  }
  const bank = await db.execute(sql`
    SELECT account_id FROM journal_lines WHERE tenant_id = ${tenantId} AND transaction_id = ${id} AND is_void_reversal = false
      AND credit > 0 ORDER BY line_order LIMIT 1`);
  const { round2, money2 } = await import('./payment-compute.js');
  return {
    id: r.id, date: r.txnDate, customerId: r.contactId, amount: money2(round2(r.total ?? '0')),
    method: r.paymentMethod ?? null, refNo: r.referenceNumber ?? null, checkNumber: r.checkNumber ?? null,
    printStatus: r.printStatus ?? null,
    refundFromAccountId: (bank.rows as Array<{ account_id: string }>)[0]?.account_id ?? null,
    source, updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null, status: r.status,
  };
}
