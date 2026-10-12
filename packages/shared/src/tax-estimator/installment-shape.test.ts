// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  STATE_INSTALLMENT_PAIRS, FEDERAL_INSTALLMENT_PAIRS, installmentPairError, installmentPartnerKey, installmentPctsError,
} from './installment-shape.js';

const pair = STATE_INSTALLMENT_PAIRS[0]!;
const DATES = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];

describe('installment shape (QA D6)', () => {
  it('rejects the QA case: a one-entry list against four due dates', () => {
    expect(installmentPairError(pair, [0.25], DATES)).toMatch(/must add up to 100%/);
    expect(installmentPairError(pair, [1], DATES)).toMatch(/has 1 entry but installments.due_dates has 4 due dates/);
  });
  it('requires the percentages to total 100% and each to be at most 1', () => {
    expect(installmentPctsError('installments.pcts', [0.25, 0.25, 0.25, 0.2])).toMatch(/add up to 100% \(they add up to 95%\)/);
    expect(installmentPctsError('installments.pcts', [25, 25, 25, 25])).toMatch(/no entry may exceed 1/);
    expect(installmentPctsError('installments.pcts', [0.3, 0.2, 0.3, 0.2])).toBeNull();
    expect(installmentPctsError('installments.pcts', [0.333333, 0.333333, 0.333334])).toBeNull();
  });
  it('accepts a coherent pair and both-null (no regime), refuses one-sided null', () => {
    expect(installmentPairError(pair, [0.25, 0.25, 0.25, 0.25], DATES)).toBeNull();
    expect(installmentPairError(pair, null, null)).toBeNull();
    expect(installmentPairError(pair, null, DATES)).toMatch(/both be set or both be null/);
  });
  it('knows the partners', () => {
    expect(installmentPartnerKey(STATE_INSTALLMENT_PAIRS, 'installments.pcts')).toBe('installments.due_dates');
    expect(installmentPartnerKey(FEDERAL_INSTALLMENT_PAIRS, 'ccorp.installment_months')).toBe('ccorp.installment_pcts');
    expect(installmentPartnerKey(STATE_INSTALLMENT_PAIRS, 'penalty.rate')).toBeNull();
  });
});
