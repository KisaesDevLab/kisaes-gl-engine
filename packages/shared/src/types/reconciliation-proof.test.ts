// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  RECON_CARD_ITEM_INVESTIGATE_DAYS,
  RECON_DEPOSIT_IN_TRANSIT_INVESTIGATE_DAYS,
  RECON_OUTSTANDING_STALE_DATED_DAYS,
  RECON_OUTSTANDING_STALE_DAYS,
  reconAgeDays,
  reconItemFlag,
  reconLabels,
  reconMoney,
  reconSummaryLines,
  reconDiscrepancyComponentLines,
  type ReconProof,
} from './reconciliation-proof.js';

describe('reconItemFlag thresholds', () => {
  it('outstanding checks: stale over 90 days, stale-dated over 180', () => {
    expect(RECON_OUTSTANDING_STALE_DAYS).toBe(90);
    expect(RECON_OUTSTANDING_STALE_DATED_DAYS).toBe(180);
    expect(reconItemFlag('asset', 'decrease', 90).flag).toBeNull();
    expect(reconItemFlag('asset', 'decrease', 91).flag).toBe('stale');
    expect(reconItemFlag('asset', 'decrease', 180).flag).toBe('stale');
    const sd = reconItemFlag('asset', 'decrease', 181);
    expect(sd.flag).toBe('stale_dated');
    expect(sd.label).toBe('Stale-dated (181 days) — review / void / escheat');
  });

  it('deposits in transit: investigate after 10 days', () => {
    expect(RECON_DEPOSIT_IN_TRANSIT_INVESTIGATE_DAYS).toBe(10);
    expect(reconItemFlag('asset', 'increase', 10).flag).toBeNull();
    expect(reconItemFlag('asset', 'increase', 11).flag).toBe('investigate');
    expect(reconItemFlag('asset', 'increase', 400).flag).toBe('investigate');
  });

  it('credit cards: investigate either side after a 30-day cycle, never stale-dated', () => {
    expect(RECON_CARD_ITEM_INVESTIGATE_DAYS).toBe(30);
    expect(reconItemFlag('liability', 'increase', 30).flag).toBeNull();
    expect(reconItemFlag('liability', 'increase', 31).flag).toBe('investigate');
    expect(reconItemFlag('liability', 'decrease', 500).flag).toBe('investigate');
  });

  it("Kurt's [AP:PR] journal entries outstanding since 2025-02-10 are stale-dated at 2026-09-30", () => {
    const age = reconAgeDays('2025-02-10', '2026-09-30');
    expect(age).toBe(597);
    expect(reconItemFlag('asset', 'decrease', age).flag).toBe('stale_dated');
    expect(reconAgeDays('2025-12-29', '2026-09-30')).toBe(275);
  });
});

describe('labels and layout', () => {
  it('uses bank wording for assets and card wording for liabilities', () => {
    expect(reconLabels('asset').increases).toBe('Deposits in transit');
    expect(reconLabels('asset').decreases).toBe('Outstanding checks and payments');
    expect(reconLabels('liability').statementBalance).toContain('amount owed');
    expect(reconLabels('liability').decreases).toContain('Payments and credits');
  });

  it('formats negatives in parentheses', () => {
    expect(reconMoney(-4633.33)).toBe('(4,633.33)');
    expect(reconMoney(25526.79)).toBe('25,526.79');
    expect(reconMoney(0)).toBe('0.00');
  });

  const base = (unrecorded: ReconProof['summary']['unrecorded']): ReconProof => ({
    statementDate: '2026-09-30',
    labels: reconLabels('asset'),
    summary: {
      statementBalance: 25526.79, increases: { count: 1, total: 781.72 }, decreases: { count: 3, total: 4633.33 },
      adjustedStatementBalance: 21675.18, bookBalance: 21675.18, unrecorded, unrecordedNote: null,
      adjustedBookBalance: 21675.18, unreconciledDifference: 0, reconciledToBooks: true, explanations: [],
    },
    bookProof: { components: { changesToPriorReconciled: -10, priorReconciledNowAfterStatement: 0, clearedOutOfPeriod: 0, beginningBalanceVariance: 0.001 } },
  } as unknown as ReconProof);

  it('orders Section A statement → adjustments → adjusted bank → books → adjusted books → difference', () => {
    const lines = reconSummaryLines(base(null));
    expect(lines.map((l) => l.key)).toEqual([
      'statement', 'increases', 'decreases', 'adjusted_statement', 'books', 'adjusted_books', 'unreconciled',
    ]);
    expect(lines[0]!.label).toBe('Balance per bank statement, 09/30/2026');
    expect(lines[1]!.label).toBe('Add: Deposits in transit (1)');
    expect(lines[2]).toMatchObject({ label: 'Less: Outstanding checks and payments (3)', amount: -4633.33 });
    expect(lines[6]!.kind).toBe('result');
  });

  it('adds the unrecorded bank items line only when the data exists', () => {
    const keys = reconSummaryLines(base({ count: 2, total: -12.5 })).map((l) => l.key);
    expect(keys).toContain('unrecorded');
    expect(keys.indexOf('unrecorded')).toBe(keys.indexOf('books') + 1);
  });

  it('lists only non-zero discrepancy components', () => {
    expect(reconDiscrepancyComponentLines(base(null)).map((l) => l.key)).toEqual(['changes']);
  });
});
