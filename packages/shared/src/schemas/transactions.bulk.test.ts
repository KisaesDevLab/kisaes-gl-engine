// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { bulkUpdateTransactionsSchema } from './transactions.js';

const id = '11111111-1111-1111-1111-111111111111';

describe('bulkUpdateTransactionsSchema', () => {
  it('accepts a single change field', () => {
    expect(bulkUpdateTransactionsSchema.safeParse({ txnIds: [id], setTagId: id }).success).toBe(true);
    expect(bulkUpdateTransactionsSchema.safeParse({ txnIds: [id], setCategoryAccountId: id }).success).toBe(true);
    expect(bulkUpdateTransactionsSchema.safeParse({ txnIds: [id], setPayeeContactId: id }).success).toBe(true);
  });

  it('accepts null payee/tag as an explicit clear', () => {
    expect(bulkUpdateTransactionsSchema.safeParse({ txnIds: [id], setPayeeContactId: null }).success).toBe(true);
    expect(bulkUpdateTransactionsSchema.safeParse({ txnIds: [id], setTagId: null }).success).toBe(true);
  });

  it('rejects when no change field is supplied', () => {
    expect(bulkUpdateTransactionsSchema.safeParse({ txnIds: [id] }).success).toBe(false);
  });

  it('rejects an empty or non-uuid id list', () => {
    expect(bulkUpdateTransactionsSchema.safeParse({ txnIds: [], setTagId: id }).success).toBe(false);
    expect(bulkUpdateTransactionsSchema.safeParse({ txnIds: ['nope'], setTagId: id }).success).toBe(false);
  });
});
