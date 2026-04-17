// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { CreateExpenseInput } from '@kis-books/shared';
import * as ledger from './ledger.service.js';

function buildExpensePayload(input: CreateExpenseInput) {
  const expenseLines = input.lines && input.lines.length > 0
    ? input.lines
    : [{ expenseAccountId: input.expenseAccountId!, amount: input.amount!, description: input.memo }];

  const total = expenseLines
    .reduce((sum, line) => sum + parseFloat(line.amount), 0)
    .toFixed(4);

  const journalLines = [
    ...expenseLines.map((line) => ({
      accountId: line.expenseAccountId,
      debit: parseFloat(line.amount).toFixed(4),
      credit: '0',
      description: line.description || input.memo,
    })),
    { accountId: input.payFromAccountId, debit: '0', credit: total },
  ];

  return {
    txnType: 'expense' as const,
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    total,
    lines: journalLines,
  };
}

export async function createExpense(tenantId: string, input: CreateExpenseInput, userId?: string, companyId?: string) {
  return ledger.postTransaction(tenantId, buildExpensePayload(input), userId, companyId);
}

export async function updateExpense(tenantId: string, txnId: string, input: CreateExpenseInput, userId?: string, companyId?: string) {
  return ledger.updateTransaction(tenantId, txnId, buildExpensePayload(input), userId, companyId);
}
