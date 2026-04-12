import type { CreateCreditMemoInput } from '@kis-books/shared';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

export async function createCreditMemo(tenantId: string, input: CreateCreditMemoInput, userId?: string, companyId?: string) {
  const arAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')),
  });
  if (!arAccount) throw AppError.internal('AR account not found');

  let subtotal = 0;
  const revenueLines = input.lines.map((line) => {
    const lineTotal = parseFloat(line.quantity) * parseFloat(line.unitPrice);
    subtotal += lineTotal;
    return {
      accountId: line.accountId,
      debit: lineTotal.toFixed(4),
      credit: '0',
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    };
  });

  return ledger.postTransaction(tenantId, {
    txnType: 'credit_memo',
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    total: subtotal.toFixed(4),
    appliedToInvoiceId: input.appliedToInvoiceId,
    lines: [
      ...revenueLines,
      { accountId: arAccount.id, debit: '0', credit: subtotal.toFixed(4) },
    ],
  }, userId, companyId);
}
