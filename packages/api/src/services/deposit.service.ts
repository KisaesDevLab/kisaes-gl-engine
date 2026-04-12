import type { CreateDepositInput } from '@kis-books/shared';
import * as ledger from './ledger.service.js';

function buildDepositPayload(input: CreateDepositInput) {
  let totalAmount = 0;
  const creditLines = input.lines.map((line) => {
    const amt = parseFloat(line.amount);
    totalAmount += amt;
    return {
      accountId: line.accountId,
      debit: '0',
      credit: line.amount,
      description: line.description,
    };
  });

  return {
    txnType: 'deposit' as const,
    txnDate: input.txnDate,
    memo: input.memo,
    total: totalAmount.toFixed(4),
    lines: [
      { accountId: input.depositToAccountId, debit: totalAmount.toFixed(4), credit: '0' },
      ...creditLines,
    ],
  };
}

export async function createDeposit(tenantId: string, input: CreateDepositInput, userId?: string, companyId?: string) {
  return ledger.postTransaction(tenantId, buildDepositPayload(input), userId, companyId);
}

export async function updateDeposit(tenantId: string, txnId: string, input: CreateDepositInput, userId?: string, companyId?: string) {
  return ledger.updateTransaction(tenantId, txnId, buildDepositPayload(input), userId, companyId);
}
