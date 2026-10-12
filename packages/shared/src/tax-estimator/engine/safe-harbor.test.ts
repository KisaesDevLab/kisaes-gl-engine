// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10 safe harbor: both rules shown, lesser_of / prior_year / current_year,
// high-AGI test on the prior-year AGI, unavailable prior year (unfiled / short /
// unknown), zero prior-year tax, Rivera figures from the oracle.

import { describe, it, expect } from 'vitest';
import { EstimateContext, NO_PRIOR_YEAR, type PriorYearInput } from './estimate-types.js';
import { computeFederalSafeHarbor, resolveSafeHarbor, FARMER_SAFE_HARBOR_POLICY, type SafeHarborRates } from './safe-harbor.js';
import type { ParameterMap } from './types.js';

const params = (over: Record<string, { value: unknown; status?: 'verified' | 'unverified' }> = {}): ParameterMap => {
  const base: Record<string, { value: unknown; status: 'verified' | 'unverified' }> = {
    'safe_harbor.current_pct': { value: 0.9, status: 'verified' },
    'safe_harbor.prior_pct': { value: 1.0, status: 'verified' },
    'safe_harbor.prior_pct_high_agi': { value: 1.1, status: 'verified' },
    'safe_harbor.high_agi_threshold.standard': { value: 150000, status: 'verified' },
    'safe_harbor.high_agi_threshold.mfs': { value: 75000, status: 'verified' },
    'safe_harbor.min_balance_due': { value: 1000, status: 'verified' },
    'farmer.safe_harbor_current_pct': { value: 0.6666666667, status: 'verified' },
    'farmer.safe_harbor_prior_pct': { value: 1.0, status: 'verified' },
  };
  const merged = { ...base, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, { value: v.value, status: v.status ?? 'verified' }])) };
  return Object.fromEntries(Object.entries(merged).map(([key, v]) => [key, { key, value: v.value, status: v.status }]));
};

const RIVERA_PRIOR: PriorYearInput = { tax: '31500', agi: '182000', twelveMonths: true, filed: true };
const ctxFor = (p: ParameterMap = params(), fs: 'mfj' | 'mfs' = 'mfj') => new EstimateContext(p, 2026, fs);

describe('computeFederalSafeHarbor — Rivera (oracle safe_harbor block)', () => {
  it('shows 90% current = 32,246 and 110% prior = 34,650; lesser_of → 32,246', () => {
    const ctx = ctxFor();
    const r = computeFederalSafeHarbor({ currentYearTax: '35829', currentYearAgi: '197557', priorYear: RIVERA_PRIOR, rule: 'lesser_of', ruleSource: 'firm_default' }, ctx);
    expect(r.currentYear.amount).toBe('32246');
    expect(r.priorYear.amount).toBe('34650');
    expect(r.priorYear.highAgiApplied).toBe(true);
    expect(r.priorYear.pct).toBe('1.1');
    expect(r.requiredAnnualPayment).toBe('32246');
    expect(r.appliedRule).toBe('lesser_of');
    expect(r.exact.requiredAnnualPayment).toBe('32246.1');
    expect(r.noPenaltyReason).toBeNull();
    expect(r.verify).toBe(false);
    expect(ctx.trace.rows().map((t) => t.id)).toEqual(['federal.safe_harbor.current', 'federal.safe_harbor.prior', 'federal.safe_harbor.required']);
    expect(ctx.allWarnings()).toEqual([]);
  });

  it('prior_year rule → 34,650; current_year rule → 32,246 (both still shown)', () => {
    const prior = computeFederalSafeHarbor({ currentYearTax: '35829', currentYearAgi: null, priorYear: RIVERA_PRIOR, rule: 'prior_year', ruleSource: 'taxpayer' }, ctxFor());
    expect(prior.requiredAnnualPayment).toBe('34650');
    expect(prior.currentYear.amount).toBe('32246');
    const current = computeFederalSafeHarbor({ currentYearTax: '35829', currentYearAgi: null, priorYear: RIVERA_PRIOR, rule: 'current_year', ruleSource: 'year' }, ctxFor());
    expect(current.requiredAnnualPayment).toBe('32246');
    expect(current.priorYear.amount).toBe('34650');
    expect(current.ruleSource).toBe('year');
  });

  it('high-AGI test is on the PRIOR-year AGI: 150,000 exactly is not over; MFS uses the 75,000 threshold', () => {
    const at = computeFederalSafeHarbor({ currentYearTax: '50000', currentYearAgi: '900000', priorYear: { ...RIVERA_PRIOR, agi: '150000' }, rule: 'prior_year', ruleSource: 'firm_default' }, ctxFor());
    expect(at.priorYear.highAgiApplied).toBe(false);
    expect(at.priorYear.amount).toBe('31500');
    const mfs = computeFederalSafeHarbor({ currentYearTax: '50000', currentYearAgi: null, priorYear: { ...RIVERA_PRIOR, agi: '80000' }, rule: 'prior_year', ruleSource: 'firm_default' }, ctxFor(params(), 'mfs'));
    expect(mfs.priorYear.highAgiApplied).toBe(true);
    expect(mfs.keys).toContain('safe_harbor.high_agi_threshold.mfs');
  });

  it('missing prior-year AGI: base percentage used, verify flagged and warned', () => {
    const ctx = ctxFor();
    const r = computeFederalSafeHarbor({ currentYearTax: '35829', currentYearAgi: null, priorYear: { ...RIVERA_PRIOR, agi: null }, rule: 'lesser_of', ruleSource: 'firm_default' }, ctx);
    expect(r.priorYear.highAgiUntested).toBe(true);
    expect(r.priorYear.amount).toBe('31500');
    expect(r.requiredAnnualPayment).toBe('31500');
    expect(r.verify).toBe(true);
    expect(ctx.allWarnings().some((w) => w.code === 'TE_SAFE_HARBOR_PRIOR_AGI_MISSING')).toBe(true);
  });

  it.each([
    ['unfiled', { ...RIVERA_PRIOR, filed: false }, 'unfiled'],
    ['short year', { ...RIVERA_PRIOR, twelveMonths: false }, 'short_year'],
    ['tax unknown', { ...RIVERA_PRIOR, tax: null }, 'tax_unknown'],
    ['nothing known', NO_PRIOR_YEAR, 'unfiled'],
  ] as const)('prior year %s → prior harbor unavailable, lesser_of and prior_year fall back to current', (_label, py, reason) => {
    for (const rule of ['lesser_of', 'prior_year'] as const) {
      const r = computeFederalSafeHarbor({ currentYearTax: '35829', currentYearAgi: null, priorYear: py, rule, ruleSource: 'firm_default' }, ctxFor());
      expect(r.priorYear.available).toBe(false);
      expect(r.priorYear.unavailableReason).toBe(reason);
      expect(r.priorYear.amount).toBeNull();
      expect(r.appliedRule).toBe('current_year');
      expect(r.requiredAnnualPayment).toBe('32246');
    }
  });

  it('zero prior-year tax on a filed 12-month return → no penalty; lesser_of requires 0, current_year still 90%', () => {
    const zero: PriorYearInput = { tax: '0', agi: '40000', twelveMonths: true, filed: true };
    const lesser = computeFederalSafeHarbor({ currentYearTax: '35829', currentYearAgi: null, priorYear: zero, rule: 'lesser_of', ruleSource: 'firm_default' }, ctxFor());
    expect(lesser.noPenaltyReason).toBe('prior_year_zero_tax');
    expect(lesser.priorYear.amount).toBe('0');
    expect(lesser.requiredAnnualPayment).toBe('0');
    const current = computeFederalSafeHarbor({ currentYearTax: '35829', currentYearAgi: null, priorYear: zero, rule: 'current_year', ruleSource: 'year' }, ctxFor());
    expect(current.noPenaltyReason).toBe('prior_year_zero_tax');
    expect(current.requiredAnnualPayment).toBe('32246');
  });

  it('D12a: an unverified percentage read is warned once', () => {
    const ctx = ctxFor(params({ 'safe_harbor.prior_pct_high_agi': { value: 1.1, status: 'unverified' } }));
    computeFederalSafeHarbor({ currentYearTax: '35829', currentYearAgi: null, priorYear: RIVERA_PRIOR, rule: 'lesser_of', ruleSource: 'firm_default' }, ctx);
    const flagged = ctx.allWarnings().filter((w) => w.code === 'TE_PARAM_UNVERIFIED');
    expect(flagged.map((w) => w.details!['key'])).toEqual(['safe_harbor.prior_pct_high_agi']);
  });

  it('Phase 9 plug-ins: the farmer policy reads the farmer keys; explicit overrides win over keys', () => {
    const farmer = computeFederalSafeHarbor({ currentYearTax: '30000', currentYearAgi: null, priorYear: RIVERA_PRIOR, rule: 'lesser_of', ruleSource: 'firm_default', policy: FARMER_SAFE_HARBOR_POLICY }, ctxFor());
    expect(farmer.currentYear.amount).toBe('20000');
    expect(farmer.priorYear.amount).toBe('31500');
    expect(farmer.priorYear.highAgiApplied).toBe(false);
    expect(farmer.policy).toMatch(/farmer/);
    const large = computeFederalSafeHarbor({ currentYearTax: '30000', currentYearAgi: null, priorYear: RIVERA_PRIOR, rule: 'lesser_of', ruleSource: 'firm_default', pctOverrides: { currentPct: '1', priorPct: null, priorUnavailableReason: 'large corporation (§6655(d)(2))' } }, ctxFor());
    expect(large.currentYear.amount).toBe('30000');
    expect(large.priorYear.available).toBe(false);
    expect(large.priorYear.unavailableDetail).toMatch(/large corporation/);
    expect(large.verify).toBe(true);
  });
});

describe('resolveSafeHarbor (parameter-free core, used by the state path)', () => {
  const rates = (over: Partial<SafeHarborRates> = {}): SafeHarborRates => ({ currentPct: '0.9', priorPct: '1', priorPctHighAgi: null, highAgiThreshold: null, priorHarborCurrentAgiCutoff: null, keys: ['safe_harbor.current_pct', 'safe_harbor.prior_pct'], priorUnavailableReason: null, ...over });

  it('Missouri: 90% of 7,590 = 6,831 vs 100% prior 7,050 → 6,831 (oracle missouri block)', () => {
    const r = resolveSafeHarbor({ jurisdiction: 'MO', currentYearTax: '7590', currentYearAgi: null, priorYear: { tax: '7050', agi: null, twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default', rates: rates() });
    expect(r.currentYear.amount).toBe('6831');
    expect(r.priorYear.amount).toBe('7050');
    expect(r.requiredAnnualPayment).toBe('6831');
    expect(r.verify).toBe(false);
  });

  it('no prior-year rule (priorPct null) → current only; CA-style current-AGI cutoff removes the prior harbor', () => {
    const none = resolveSafeHarbor({ jurisdiction: 'XX', currentYearTax: '1000', currentYearAgi: null, priorYear: RIVERA_PRIOR, rule: 'lesser_of', ruleSource: 'firm_default', rates: rates({ priorPct: null }) });
    expect(none.priorYear.unavailableReason).toBe('no_prior_year_rule');
    expect(none.requiredAnnualPayment).toBe('900');
    const ca = resolveSafeHarbor({ jurisdiction: 'CA', currentYearTax: '100000', currentYearAgi: '1000000', priorYear: RIVERA_PRIOR, rule: 'lesser_of', ruleSource: 'firm_default', rates: rates({ priorHarborCurrentAgiCutoff: '1000000' }) });
    expect(ca.priorYear.unavailableReason).toBe('current_agi_cutoff');
    expect(ca.requiredAnnualPayment).toBe('90000');
    expect(ca.verify).toBe(true);
  });
});
