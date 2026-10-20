// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { CreateExpenseInput, JournalLineInput } from '@kis-books/shared';
import * as ledger from './ledger.service.js';
import { assertLineContacts } from './line-contacts.service.js';
import { exactAmount } from '../utils/money.js';

function buildExpensePayload(input: CreateExpenseInput) {
  const expenseLines = input.lines && input.lines.length > 0
    ? input.lines
    : [{ expenseAccountId: input.expenseAccountId!, amount: input.amount!, description: input.memo }];

  // Exact decimal arithmetic: the total is the exact sum of the line
  // amounts, so the payment-side credit always equals the debits.
  const amounts = expenseLines.map((line, i) => exactAmount(line.amount, `lines[${i}].amount`));
  const total = amounts.reduce((sum, a) => sum.plus(a), exactAmount('0', 'total')).toFixed(4);

  const journalLines: JournalLineInput[] = [
    ...expenseLines.map((line, i) => ({
      accountId: line.expenseAccountId,
      debit: amounts[i]!.toFixed(4),
      credit: '0',
      description: line.description || input.memo,
      // ADR 0XX — carry the per-line tag (3-state) through to the ledger.
      // Preserving `undefined` vs explicit `null` lets the ledger
      // resolver apply the contact default when the user hasn't set
      // a line tag (ADR 0XY §2.3).
      tagId: line.tagId,
      // Per-line customer and billable mark (U-49, U-50).
      contactId: 'contactId' in line ? line.contactId ?? null : null,
      isBillable: 'isBillable' in line ? line.isBillable === true : false,
    })),
    // Payment-side cash credit has no user-facing tag; leave null.
    { accountId: input.payFromAccountId, debit: '0', credit: total },
  ];

  return {
    txnType: 'expense' as const,
    txnDate: input.txnDate,
    txnNumber: input.txnNumber,
    contactId: input.contactId,
    memo: input.memo,
    total,
    lines: journalLines,
  };
}

export async function createExpense(tenantId: string, input: CreateExpenseInput, userId?: string, companyId?: string) {
  const payload = buildExpensePayload(input);
  await assertLineContacts(tenantId, payload.lines);
  return ledger.postTransaction(tenantId, payload, userId, companyId);
}

export async function updateExpense(tenantId: string, txnId: string, input: CreateExpenseInput, userId?: string, companyId?: string) {
  const payload = buildExpensePayload(input);
  await assertLineContacts(tenantId, payload.lines);
  return ledger.updateTransaction(tenantId, txnId, payload, userId, companyId);
}
