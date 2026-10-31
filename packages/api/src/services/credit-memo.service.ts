// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { CreateCreditMemoInput } from '@kis-books/shared';
import { eq, and } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import { db } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import * as documentNumbers from './document-number.service.js';
import { claimIdempotency } from './idempotency.service.js';
import { salesLineAmount } from '../utils/sales-compute.js';

export async function createCreditMemo(tenantId: string, input: CreateCreditMemoInput, userId?: string, companyId?: string) {
  return (await createCreditMemoWithWarnings(tenantId, input, userId, companyId)).transaction;
}

/**
 * Create a credit memo. U-111: the typed txnNumber (duplicates 409
 * DOCUMENT_NUMBER_IN_USE, or warnings with warnOnly) or the next from the
 * company's credit_memo counter. U-113: printLater for the forms queue.
 */
export async function createCreditMemoWithWarnings(
  tenantId: string, input: CreateCreditMemoInput, userId?: string, companyId?: string,
) {
  const arAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')),
  });
  if (!arAccount) throw AppError.internal('AR account not found');

  // Each line to the cent (U-122, sales-cents-v1): round2(qty x rate), half
  // away from zero; the A/R credit is their exact sum. A negative line
  // credits its account.
  let subtotal = new Decimal('0');
  const revenueLines = input.lines.map((line, i) => {
    const lineTotal = new Decimal(salesLineAmount(line.quantity, line.unitPrice, `lines[${i}]`));
    subtotal = subtotal.plus(lineTotal);
    const abs = lineTotal.abs().toFixed(4);
    return {
      accountId: line.accountId,
      debit: lineTotal.isNegative() ? '0' : abs,
      credit: lineTotal.isNegative() ? abs : '0',
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      tagId: line.tagId,
    };
  });

  // Number and posting in one transaction: a refused post takes no number.
  return await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const { txnNumber, warnings } = await documentNumbers.numberForNew(tenantId, 'credit_memo', input.txnNumber, {
      companyId, warnOnly: input.warnOnly === true, executor: tx,
    });
    const transaction = await ledger.postTransaction(tenantId, {
      txnType: 'credit_memo',
      txnNumber,
      printLater: input.printLater === true,
      txnDate: input.txnDate,
      contactId: input.contactId,
      memo: input.memo,
      total: subtotal.toFixed(4),
      appliedToInvoiceId: input.appliedToInvoiceId,
      lines: [
        ...revenueLines,
        subtotal.isNegative()
          ? { accountId: arAccount.id, debit: subtotal.abs().toFixed(4), credit: '0' }
          : { accountId: arAccount.id, debit: '0', credit: subtotal.toFixed(4) },
      ],
    }, userId, companyId, tx);
    return { transaction, warnings };
  });
}
