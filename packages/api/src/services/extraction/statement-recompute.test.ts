// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { amountToCents, feedToSignedCents, recomputeStatementReconciliation } from './statement-recompute.js';

describe('statement-recompute helpers', () => {
  it('amountToCents parses money strings', () => {
    expect(amountToCents('1,234.56')).toBe(123456);
    expect(amountToCents('$12.5')).toBe(1250);
    expect(amountToCents('-3.00')).toBe(-300);
    expect(amountToCents('abc')).toBeNull();
    expect(amountToCents(null)).toBeNull();
  });
  it('feedToSignedCents inverts the bank / card sign conventions', () => {
    expect(feedToSignedCents('10.00', 'debit', false)).toBe(-1000);
    expect(feedToSignedCents('10.00', 'credit', false)).toBe(1000);
    expect(feedToSignedCents('10.00', 'debit', true)).toBe(1000);
    expect(feedToSignedCents('10.00', 'credit', true)).toBe(-1000);
  });
});

describe('recomputeStatementReconciliation', () => {
  const base = { openingBalance: '100.00', closingBalance: '150.00', accountTypeHint: 'CHECKING' };

  it('a misread amount breaks the Golden Rule; the corrected amount verifies it', () => {
    const wrong = recomputeStatementReconciliation({
      ...base,
      transactions: [
        { amount: '20.00', type: 'debit', balance: '80.00' },
        { amount: '700.00', type: 'credit', balance: '150.00' }, // misread: should be 70.00
      ],
    });
    expect(wrong.reconciliation.status).toBe('discrepancy');
    expect(wrong.suspectRows.map((s) => s.index)).toContain(1);

    const fixed = recomputeStatementReconciliation({
      ...base,
      transactions: [
        { amount: '20.00', type: 'debit', balance: '80.00' },
        { amount: '70.00', type: 'credit', balance: '150.00' },
      ],
    });
    expect(fixed.reconciliation.status).toBe('verified');
    expect(fixed.reconciliation.deltaCents).toBe(0);
    expect(fixed.suspectRows).toEqual([]);
  });

  it('flipping the direction is also a correction', () => {
    const out = recomputeStatementReconciliation({
      openingBalance: '0.00', closingBalance: '-25.00', accountTypeHint: 'CHECKING',
      transactions: [{ amount: '25.00', type: 'credit' }],
    });
    expect(out.reconciliation.status).toBe('discrepancy');
    const flipped = recomputeStatementReconciliation({
      openingBalance: '0.00', closingBalance: '-25.00', accountTypeHint: 'CHECKING',
      transactions: [{ amount: '25.00', type: 'debit' }],
    });
    expect(flipped.reconciliation.status).toBe('verified');
  });

  it('credit-card statements use the inverted sign', () => {
    const out = recomputeStatementReconciliation({
      openingBalance: '100.00', closingBalance: '140.00', accountTypeHint: 'CREDITCARD',
      transactions: [{ amount: '40.00', type: 'debit' }], // a charge raises the balance owed
    });
    expect(out.reconciliation.status).toBe('verified');
  });

  it('skips when a balance is missing but still reports suspect rows', () => {
    const out = recomputeStatementReconciliation({
      openingBalance: '10.00', closingBalance: null, accountTypeHint: null,
      transactions: [{ amount: '5.00', type: 'debit', balance: '99.00' }],
    });
    expect(out.reconciliation.status).toBe('skipped');
    expect(out.suspectRows.length).toBe(1);
  });
});
