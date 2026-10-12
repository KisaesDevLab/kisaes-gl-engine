// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { formatNumbersInText, formatNumberToken } from './format-text.js';

describe('formatNumbersInText (QA D7/D19)', () => {
  it('formats the QA trace formula (no raw 25-digit decimals)', () => {
    expect(formatNumbersInText('bracket tax on 138725.7318071403638391314')).toBe('bracket tax on 138,725.73');
    expect(formatNumbersInText('100800.0000 × 0.22')).toBe('100,800 × 0.22');
  });
  it('leaves dates, years, ids and codes alone and groups large integers', () => {
    expect(formatNumbersInText('Prior-year AGI 182000 exceeds 150000 in 2026 (due 2027-01-15, id share.l1:p2)'))
      .toBe('Prior-year AGI 182,000 exceeds 150,000 in 2026 (due 2027-01-15, id share.l1:p2)');
  });
  it('trims rates to six places', () => {
    expect(formatNumberToken('0.1437634999')).toBe('0.143763');
    expect(formatNumberToken('0.2200000')).toBe('0.22');
    expect(formatNumberToken('-1234.5')).toBe('-1,234.50');
  });
});

import { presentEngineText, presentWarningMessage, recommendedHarborRule } from './format-text.js';

describe('presentation helpers (QA D8 / D19)', () => {
  it('humanizes the QA examples', () => {
    expect(presentEngineText('AR: AR: estimates are not required (threshold, threshold 1000 more_than).'))
      .toBe('AR: estimates are not required (required when the tax is more than $1,000).');
    expect(presentEngineText('Prior-year AGI 182000 exceeds 150000: the prior-year harbor is 1.1 of prior-year tax.'))
      .toBe('Prior-year AGI 182,000 exceeds 150,000: the prior-year harbor is 110% of prior-year tax.');
  });
  it('does not dump a JSON rate table for an unverified structured parameter', () => {
    const value = [{ from: '2026-01-01', to: '2026-03-31', rate: '0.07' }, { from: '2026-04-01', to: '2026-06-30', rate: '0.07' }];
    const msg = presentWarningMessage({ code: 'TE_PARAM_UNVERIFIED', message: `x ${JSON.stringify(value)}`, details: { key: 'penalty.underpayment_rate', status: 'unverified', value } });
    expect(msg).toBe("Tax parameter 'penalty.underpayment_rate' is unverified (not CPA-verified); the estimate uses its current value (a table of 2 rows; see Admin > Tax parameters).");
    expect(msg).not.toContain('{');
  });
  it('marks the lower tile under lesser_of', () => {
    const sh = (cur: string, prior: string | null) => ({ appliedRule: 'lesser_of', currentYear: { amount: cur }, priorYear: { available: prior != null, amount: prior } });
    expect(recommendedHarborRule(sh('32246', '34650'))).toBe('current_year');
    expect(recommendedHarborRule(sh('40000', '34650'))).toBe('prior_year');
    expect(recommendedHarborRule(sh('40000', null))).toBe('current_year');
    expect(recommendedHarborRule({ ...sh('1', '2'), appliedRule: 'prior_year' })).toBe('prior_year');
  });
});
