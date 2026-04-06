import { eq, and } from 'drizzle-orm';
import type { CreateCustomerRefundInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

export async function createCustomerRefund(tenantId: string, input: CreateCustomerRefundInput, userId?: string) {
  const arAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')),
  });
  if (!arAccount) throw AppError.internal('AR account not found');

  // DR: AR (reduce what customer owes — they overpaid or we owe them)
  // CR: Bank (money goes out)
  return ledger.postTransaction(tenantId, {
    txnType: 'customer_refund',
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    total: input.amount,
    lines: [
      { accountId: arAccount.id, debit: input.amount, credit: '0' },
      { accountId: input.refundFromAccountId, debit: '0', credit: input.amount },
    ],
  }, userId);
}
