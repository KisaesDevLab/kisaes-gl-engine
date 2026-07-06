// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { reconcileGoldenRule, repairPass, findSuspectRows } from './reconcile.service.js';

describe('reconcileGoldenRule', () => {
  it('verifies when opening + Σ = closing', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 100_00n,
      closingBalanceCents: 80_00n,
      transactions: [{ amountCents: -30_00n }, { amountCents: 10_00n }],
    });
    expect(r.status).toBe('verified');
    expect(r.deltaCents).toBe(0n);
  });

  it('reports a discrepancy with the signed delta', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 100_00n,
      closingBalanceCents: 80_00n,
      transactions: [{ amountCents: -30_00n }], // expected closing 70_00, actual 80_00
    });
    expect(r.status).toBe('discrepancy');
    expect(r.deltaCents).toBe(10_00n);
  });

  it('counts period-bounds violations', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 0n,
      closingBalanceCents: 0n,
      transactions: [{ amountCents: 0n }],
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      transactionDates: ['2026-02-05'],
    });
    expect(r.periodBoundsViolations).toBe(1);
  });
});

describe('repairPass', () => {
  it('flips a single wrong-signed row that closes the delta', () => {
    // opening 0, closing 0, one row +50_00 → expected 50_00, delta -50_00.
    // Flipping +50_00 → -50_00 makes sum 0 → delta + 2*a = -50_00 + 2*(50_00)=... wait
    // delta = actual - (opening+sum) = 0 - 50_00 = -50_00; flip closes when delta+2a=0 → a=25_00.
    const txs = [{ amountCents: 25_00n, description: 'dup credit' }];
    const fix = repairPass(txs, -50_00n);
    expect(fix).not.toBeNull();
    expect(fix!.transactions[0]!.amountCents).toBe(-25_00n);
    expect(fix!.fixDescription).toContain('flipped sign');
  });

  // H2: the drop rule may only discard a row that is INDEPENDENTLY implicated
  // (suspect running balance, low row confidence, or an exact duplicate).
  // A row that merely matches the delta arithmetically is NOT dropped —
  // silently deleting clean data to force reconciliation is worse than
  // reporting the discrepancy.
  it('does NOT drop a clean row that only matches the delta arithmetically', () => {
    const txs = [{ amountCents: 5_00n, description: 'real' }, { amountCents: -12_34n, description: 'also real' }];
    expect(repairPass(txs, 12_34n)).toBeNull();
  });

  it('drops an exact duplicate row (same amount + description + date) whose amount equals the delta', () => {
    const txs = [
      { amountCents: -12_34n, description: 'ACME', postedDate: '2026-01-05' },
      { amountCents: -12_34n, description: 'ACME', postedDate: '2026-01-05' },
    ];
    const fix = repairPass(txs, 12_34n);
    expect(fix).not.toBeNull();
    expect(fix!.transactions).toHaveLength(1);
    expect(fix!.fixDescription).toContain('duplicate');
  });

  it('drops a row flagged suspect by the running-balance check', () => {
    const txs = [{ amountCents: 5_00n, description: 'real' }, { amountCents: -12_34n, description: 'phantom' }];
    const fix = repairPass(txs, 12_34n, { suspectIndexes: new Set([1]) });
    expect(fix).not.toBeNull();
    expect(fix!.transactions).toHaveLength(1);
    expect(fix!.transactions[0]!.description).toBe('real');
    expect(fix!.fixDescription).toContain('suspect');
  });

  it('drops a low-confidence phantom row that closes the delta', () => {
    const txs = [
      { amountCents: 5_00n, description: 'real', rowConfidence: 0.95 },
      { amountCents: -12_34n, description: 'phantom', rowConfidence: 0.3 },
    ];
    const fix = repairPass(txs, 12_34n);
    expect(fix).not.toBeNull();
    expect(fix!.transactions).toHaveLength(1);
    expect(fix!.transactions[0]!.description).toBe('real');
    expect(fix!.fixDescription).toContain('confidence');
  });

  it('does NOT drop a high-confidence non-duplicate row even when it matches the delta', () => {
    const txs = [
      { amountCents: 5_00n, description: 'real', rowConfidence: 0.9 },
      { amountCents: -12_34n, description: 'also real', rowConfidence: 0.9 },
    ];
    expect(repairPass(txs, 12_34n)).toBeNull();
  });

  it('returns null when no safe single-row fix exists', () => {
    const txs = [{ amountCents: 1_00n }, { amountCents: 2_00n }];
    expect(repairPass(txs, 7_77n)).toBeNull();
  });
});

describe('findSuspectRows', () => {
  it('flags a row whose printed running balance is off', () => {
    const suspects = findSuspectRows(100_00n, [
      { amountCents: -10_00n, runningBalanceCents: 90_00n }, // ok
      { amountCents: -10_00n, runningBalanceCents: 75_00n }, // expected 80_00 → off by -5_00
    ]);
    expect(suspects).toHaveLength(1);
    expect(suspects[0]!.index).toBe(1);
    expect(suspects[0]!.deltaCents).toBe(-5_00n);
  });

  it('ignores rows without a printed running balance', () => {
    const suspects = findSuspectRows(0n, [{ amountCents: -10_00n }, { amountCents: 5_00n }]);
    expect(suspects).toHaveLength(0);
  });
});
