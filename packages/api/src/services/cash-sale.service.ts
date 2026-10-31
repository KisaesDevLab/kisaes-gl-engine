// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import type { CreateCashSaleInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import * as documentNumbers from './document-number.service.js';
import * as formsPrint from './forms-print.service.js';
import { claimIdempotency } from './idempotency.service.js';
import { getDefaultTaxRate } from './invoice.service.js';
import { computeSalesDocument } from '../utils/sales-compute.js';

async function getSystemAccount(tenantId: string, systemTag: string): Promise<string> {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, systemTag)),
  });
  if (!account) throw AppError.internal(`System account '${systemTag}' not found.`);
  return account.id;
}

/** A signed amount as a journal side: positive on `positive`, negative on the other side. */
function side(amount: string, positive: 'debit' | 'credit'): { debit: string; credit: string } {
  const d = new Decimal(amount);
  const abs = d.abs().toFixed(4);
  return (d.isNegative() ? positive === 'credit' : positive === 'debit')
    ? { debit: abs, credit: '0' } : { debit: '0', credit: abs };
}

/**
 * The cash sale's figures to the cent (U-122, sales-cents-v1): line =
 * round2(qty x rate); tax = round2(taxable base x rate) once per rate,
 * allocated to the taxable lines; the request company's default rate for a
 * taxable line that sends none. Deposit account debited the total.
 */
async function buildCashSalePayload(tenantId: string, input: CreateCashSaleInput, companyId?: string) {
  const defaultTaxRate = await getDefaultTaxRate(db, tenantId, companyId);
  const computed = computeSalesDocument(input.lines.map((l) => ({
    quantity: l.quantity, unitPrice: l.unitPrice, isTaxable: l.isTaxable !== false, taxRate: l.taxRate,
  })), defaultTaxRate);

  const revenueLines = input.lines.map((line, i) => {
    const c = computed.lines[i]!;
    return {
      accountId: line.accountId,
      ...side(c.amount, 'credit'),
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      isTaxable: c.isTaxable,
      taxRate: c.taxRate,
      taxAmount: new Decimal(c.taxAmount).toFixed(4),
      tagId: line.tagId,
    };
  });

  const journalLines: any[] = [
    { accountId: input.depositToAccountId, ...side(computed.total, 'debit') },
    ...revenueLines,
  ];

  if (!new Decimal(computed.taxTotal).isZero()) {
    const taxAccountId = await getSystemAccount(tenantId, 'sales_tax_payable');
    journalLines.push({ accountId: taxAccountId, ...side(computed.taxTotal, 'credit'), description: 'Sales Tax' });
  }

  return {
    txnType: 'cash_sale' as const,
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    subtotal: new Decimal(computed.subtotal).toFixed(4),
    taxAmount: new Decimal(computed.taxTotal).toFixed(4),
    total: new Decimal(computed.total).toFixed(4),
    lines: journalLines,
  };
}

export async function createCashSale(tenantId: string, input: CreateCashSaleInput, userId?: string, companyId?: string) {
  return (await createCashSaleWithWarnings(tenantId, input, userId, companyId)).transaction;
}

/**
 * Create a cash sale (sales receipt). U-111: it takes a document number —
 * the typed txnNumber (duplicates 409 DOCUMENT_NUMBER_IN_USE, or warnings
 * with warnOnly) or the next from the company's cash_sale counter. U-113:
 * printLater marks it for the forms print queue.
 */
export async function createCashSaleWithWarnings(
  tenantId: string, input: CreateCashSaleInput, userId?: string, companyId?: string,
) {
  const payload = await buildCashSalePayload(tenantId, input, companyId);
  // Number and posting in one transaction: a refused post takes no number.
  return await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const { txnNumber, warnings } = await documentNumbers.numberForNew(tenantId, 'cash_sale', input.txnNumber, {
      companyId, warnOnly: input.warnOnly === true, executor: tx,
    });
    const transaction = await ledger.postTransaction(tenantId, {
      ...payload, txnNumber, printLater: input.printLater === true,
    }, userId, companyId, tx);
    return { transaction, warnings };
  });
}

export async function updateCashSale(tenantId: string, txnId: string, input: CreateCashSaleInput, userId?: string, companyId?: string) {
  return (await updateCashSaleWithWarnings(tenantId, txnId, input, userId, companyId)).transaction;
}

/** Edit a cash sale; a sent txnNumber replaces the number (duplicate check as on create), absent keeps it. */
export async function updateCashSaleWithWarnings(
  tenantId: string, txnId: string, input: CreateCashSaleInput, userId?: string, companyId?: string,
) {
  const payload = await buildCashSalePayload(tenantId, input, companyId);
  const newNumber = input.txnNumber?.trim();
  // The ledger edit and the print-later mark commit together (U-113).
  return await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    let warnings: documentNumbers.DocumentNumberWarning[] = [];
    if (newNumber) {
      warnings = await documentNumbers.checkDuplicate(tenantId, 'cash_sale', newNumber, {
        companyId, excludeId: txnId, warnOnly: input.warnOnly === true, executor: tx,
      });
    }
    const transaction = await ledger.updateTransaction(tenantId, txnId, {
      ...payload, ...(newNumber ? { txnNumber: newNumber } : {}),
    }, userId, companyId, tx);
    if (input.printLater !== undefined) await formsPrint.setPrintLater(tx, tenantId, txnId, input.printLater, companyId);
    return { transaction: { ...transaction, ...(input.printLater !== undefined ? { printLater: input.printLater } : {}) }, warnings };
  });
}
