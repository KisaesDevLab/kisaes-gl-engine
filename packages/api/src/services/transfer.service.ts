// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { CreateTransferInput } from '@kis-books/shared';
import * as ledger from './ledger.service.js';

function buildTransferPayload(input: CreateTransferInput) {
  return {
    txnType: 'transfer' as const,
    txnDate: input.txnDate,
    memo: input.memo,
    total: input.amount,
    lines: [
      { accountId: input.toAccountId, debit: input.amount, credit: '0' },
      { accountId: input.fromAccountId, debit: '0', credit: input.amount },
    ],
  };
}

export async function createTransfer(tenantId: string, input: CreateTransferInput, userId?: string, companyId?: string) {
  return ledger.postTransaction(tenantId, buildTransferPayload(input), userId, companyId);
}

export async function updateTransfer(tenantId: string, txnId: string, input: CreateTransferInput, userId?: string, companyId?: string) {
  return ledger.updateTransaction(tenantId, txnId, buildTransferPayload(input), userId, companyId);
}
