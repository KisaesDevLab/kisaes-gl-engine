// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { allocateByWeights, defaultOwnerPcts, fixedAmountTargets, pctTotal, pctTotalIs100 } from './treatment-splits.js';
import { accountTreatmentInputSchema } from '../schemas/tax-estimator-entities.js';
import { dSum } from './decimal.js';

describe('Q50 owner split helpers', () => {
  it('allocateByWeights: 4 places half-up, residual on the last row, always sums back exactly', () => {
    expect(allocateByWeights('8470.02', ['60', '40'])).toEqual(['5082.012', '3388.008']);
    expect(allocateByWeights('100', ['1', '1', '1'])).toEqual(['33.3333', '33.3333', '33.3334']);
    expect(allocateByWeights('-1000.01', ['70', '30'])).toEqual(['-700.007', '-300.003']);
    const parts = allocateByWeights('10000.01', ['33.333333', '33.333333', '33.333334']);
    expect(dSum(parts)).toBe('10000.01');
  });

  it('a single row takes the whole amount untouched (single-owner results stay byte-identical)', () => {
    expect(allocateByWeights('123.456789', ['100'])).toEqual(['123.456789']);
    expect(allocateByWeights('5', [])).toEqual([]);
  });

  it('fixed amounts are ratios: 60,000 / 30,000 share YTD 2 : 1', () => {
    expect(allocateByWeights('50820.12', ['60000', '30000'])).toEqual(['33880.08', '16940.04']);
  });

  it('pct total must be exactly 100 (decimal, no float tolerance)', () => {
    expect(pctTotalIs100(['60', '40'])).toBe(true);
    expect(pctTotalIs100(['33.333333', '33.333333', '33.333334'])).toBe(true);
    expect(pctTotalIs100(['60.000001', '40'])).toBe(false);
    expect(pctTotalIs100(['0.1', '0.2', '99.7'])).toBe(true);
    expect(pctTotal(['60', null, '', '30'])).toBe('90');
  });

  it('defaultOwnerPcts: profit % normalized to 100 across the listed owners', () => {
    expect(defaultOwnerPcts(['60', '40'])).toEqual(['60', '40']);
    expect(defaultOwnerPcts(['50', '25'])).toEqual(['66.6667', '33.3333']);
    expect(defaultOwnerPcts(['42'])).toEqual(['100']);
    expect(defaultOwnerPcts([null, null, null])).toEqual(['33.3333', '33.3333', '33.3334']);
    expect(defaultOwnerPcts(['50', null])).toEqual(['100', '0']);
    expect(defaultOwnerPcts([])).toEqual([]);
  });

  it('fixedAmountTargets: others get their fixed amount, the last the remainder; null when it would be negative', () => {
    expect(fixedAmountTargets('101640.24', ['60000', '30000'])).toEqual(['60000', '41640.24']);
    expect(fixedAmountTargets('50000', ['60000', '30000'])).toBeNull();
    expect(fixedAmountTargets('7', ['3'])).toEqual(['7']);
  });
});

describe('Q50 treatment input schema', () => {
  const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
  const base = { accountId: id(1), nonRecurring: false };
  it('accepts a % split and an amount split on person-target treatments', () => {
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'w2_wages', splits: [{ personId: id(2), pct: '60' }, { personId: id(3), pct: '40' }] }).success).toBe(true);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'guaranteed_payment', splitMode: 'amount', splits: [{ personId: id(2), amount: '1000', taxYear: 2026 }] }).success).toBe(true);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'estimated_tax_payment', paymentJurisdiction: 'federal', splits: [{ taxpayerId: id(4), pct: '100' }] }).success).toBe(true);
  });
  it('a guaranteed payment is satisfied by splits instead of a single partner', () => {
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'guaranteed_payment', splits: [{ personId: id(2), pct: '100' }] }).success).toBe(true);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'guaranteed_payment', splits: [] }).success).toBe(false);
  });
  it('rejects pct rows in amount mode, amount rows without a year, > 6 decimals, and splits on other treatments', () => {
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'w2_wages', splitMode: 'amount', splits: [{ personId: id(2), amount: '5' }] }).success).toBe(false);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'w2_wages', splits: [{ personId: id(2), pct: '50.1234567' }] }).success).toBe(false);
    expect(accountTreatmentInputSchema.safeParse({ ...base, treatment: 'nondeductible_pct', pct: '50', splits: [{ personId: id(2), pct: '100' }] }).success).toBe(false);
  });
});
