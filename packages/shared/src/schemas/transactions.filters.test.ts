// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { describe, it, expect } from 'vitest';
import { transactionFiltersSchema } from './transactions.js';
import { TXN_TYPE_LABELS } from '../utils/transaction-display.js';
import type { TxnType } from '../types/transactions.js';

describe('transactionFiltersSchema.txnType', () => {
  // The filter list was a hand-kept copy of TxnType that fell behind: bills,
  // vendor credits, bill payments and daily sales could not be filtered on.
  it.each(Object.keys(TXN_TYPE_LABELS) as TxnType[])('accepts %s', (txnType) => {
    expect(transactionFiltersSchema.parse({ txnType }).txnType).toBe(txnType);
  });

  it('still rejects a type that does not exist', () => {
    expect(() => transactionFiltersSchema.parse({ txnType: 'payroll' })).toThrow();
  });
});
