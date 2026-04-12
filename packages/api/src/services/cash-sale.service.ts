import { eq, and } from 'drizzle-orm';
import type { CreateCashSaleInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

async function getSystemAccount(tenantId: string, systemTag: string): Promise<string> {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, systemTag)),
  });
  if (!account) throw AppError.internal(`System account '${systemTag}' not found.`);
  return account.id;
}

async function buildCashSalePayload(tenantId: string, input: CreateCashSaleInput) {
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  const defaultTaxRate = parseFloat(company?.defaultSalesTaxRate || '0');

  let subtotal = 0;
  let totalTax = 0;

  const revenueLines = input.lines.map((line) => {
    const qty = parseFloat(line.quantity);
    const price = parseFloat(line.unitPrice);
    const lineTotal = qty * price;
    subtotal += lineTotal;

    const taxable = line.isTaxable !== false;
    const rate = taxable ? parseFloat(line.taxRate || String(defaultTaxRate)) : 0;
    const lineTax = taxable && rate > 0 ? lineTotal * rate : 0;
    totalTax += lineTax;

    return {
      accountId: line.accountId,
      debit: '0',
      credit: lineTotal.toFixed(4),
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      isTaxable: taxable,
      taxRate: rate > 0 ? rate.toString() : '0',
      taxAmount: lineTax.toFixed(4),
    };
  });

  const total = subtotal + totalTax;

  const journalLines: any[] = [
    { accountId: input.depositToAccountId, debit: total.toFixed(4), credit: '0' },
    ...revenueLines,
  ];

  if (totalTax > 0) {
    const taxAccountId = await getSystemAccount(tenantId, 'sales_tax_payable');
    journalLines.push({ accountId: taxAccountId, debit: '0', credit: totalTax.toFixed(4), description: 'Sales Tax' });
  }

  return {
    txnType: 'cash_sale' as const,
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    subtotal: subtotal.toFixed(4),
    taxAmount: totalTax.toFixed(4),
    total: total.toFixed(4),
    lines: journalLines,
  };
}

export async function createCashSale(tenantId: string, input: CreateCashSaleInput, userId?: string, companyId?: string) {
  const payload = await buildCashSalePayload(tenantId, input);
  return ledger.postTransaction(tenantId, payload, userId, companyId);
}

export async function updateCashSale(tenantId: string, txnId: string, input: CreateCashSaleInput, userId?: string, companyId?: string) {
  const payload = await buildCashSalePayload(tenantId, input);
  return ledger.updateTransaction(tenantId, txnId, payload, userId, companyId);
}
