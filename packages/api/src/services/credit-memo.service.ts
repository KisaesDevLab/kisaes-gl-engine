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

  let subtotal = new Decimal('0');
  const revenueLines = input.lines.map((line) => {
    // Rounded to the ledger's 4 places first; the A/R credit adds up the
    // rounded values, so it equals the stored debits exactly (U-65).
    const lineTotal = ledger.round4(new Decimal(line.quantity).times(line.unitPrice));
    subtotal = subtotal.plus(lineTotal);
    return {
      accountId: line.accountId,
      debit: lineTotal.toFixed(4),
      credit: '0',
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      tagId: line.tagId,
    };
  });

  const { txnNumber, warnings } = await documentNumbers.numberForNew(tenantId, 'credit_memo', input.txnNumber, {
    companyId, warnOnly: input.warnOnly === true,
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
      { accountId: arAccount.id, debit: '0', credit: subtotal.toFixed(4) },
    ],
  }, userId, companyId);
  return { transaction, warnings };
}
