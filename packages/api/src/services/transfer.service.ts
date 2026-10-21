// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { CreateTransferInput } from '@kis-books/shared';
import type { Tx } from '../db/index.js';
import * as ledger from './ledger.service.js';

export function buildTransferPayload(input: CreateTransferInput) {
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

/** `outerTx` (templates, U-62): post inside the caller's transaction. */
export async function createTransfer(
  tenantId: string, input: CreateTransferInput, userId?: string, companyId?: string, outerTx?: Tx,
) {
  return ledger.postTransaction(tenantId, buildTransferPayload(input), userId, companyId, outerTx);
}

export async function updateTransfer(tenantId: string, txnId: string, input: CreateTransferInput, userId?: string, companyId?: string) {
  return ledger.updateTransaction(tenantId, txnId, buildTransferPayload(input), userId, companyId);
}
