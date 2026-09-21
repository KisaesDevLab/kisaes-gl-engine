// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { vendorAccountMemo } from './check-memo.js';
import { createContactSchema, updateContactSchema } from '../schemas/contacts.js';

describe('vendorAccountMemo', () => {
  it('is empty when the vendor has no account number', () => {
    expect(vendorAccountMemo(null)).toBe('');
    expect(vendorAccountMemo(undefined)).toBe('');
    expect(vendorAccountMemo('   ')).toBe('');
  });

  it('prints the number verbatim — it is text, never parsed', () => {
    expect(vendorAccountMemo('0012345')).toBe('Acct 0012345');
    expect(vendorAccountMemo(' 00-4471-A ')).toBe('Acct 00-4471-A');
  });
});

describe('vendorAccountNumber schema', () => {
  it('accepts letters, dashes and leading zeros, trimmed', () => {
    const parsed = createContactSchema.parse({ contactType: 'vendor', displayName: 'City Water', vendorAccountNumber: ' 00-4471-A ' });
    expect(parsed.vendorAccountNumber).toBe('00-4471-A');
    expect(updateContactSchema.parse({ vendorAccountNumber: null }).vendorAccountNumber).toBeNull();
  });

  it('caps at the column width', () => {
    expect(createContactSchema.safeParse({ contactType: 'vendor', displayName: 'X', vendorAccountNumber: 'x'.repeat(51) }).success).toBe(false);
  });
});
