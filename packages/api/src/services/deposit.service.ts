// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import type { CreateDepositInput } from '@kis-books/shared';
import * as ledger from './ledger.service.js';

function buildDepositPayload(input: CreateDepositInput) {
  // Sum line amounts through Decimal so the debit to the deposit
  // account and the sum of credits match exactly. Float accumulation
  // drifts and ledger.postTransaction would reject the total.
  let totalAmount = new Decimal('0');
  const creditLines = input.lines.map((line) => {
    totalAmount = totalAmount.plus(line.amount);
    return {
      accountId: line.accountId,
      debit: '0',
      credit: line.amount,
      description: line.description,
    };
  });

  const totalStr = totalAmount.toFixed(4);
  return {
    txnType: 'deposit' as const,
    txnDate: input.txnDate,
    memo: input.memo,
    total: totalStr,
    lines: [
      { accountId: input.depositToAccountId, debit: totalStr, credit: '0' },
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
