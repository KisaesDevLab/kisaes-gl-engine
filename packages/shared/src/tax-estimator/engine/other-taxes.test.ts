// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { computeOtherTaxes, type OtherTaxesContext } from './other-taxes.js';
import type { OtherTaxesInput, ParameterMap } from './types.js';
import type { FilingStatus } from '../types.js';

const params: ParameterMap = Object.fromEntries(Object.entries({
  'addl_medicare.rate': 0.009, 'addl_medicare.threshold.single': 200000, 'addl_medicare.threshold.mfj': 250000, 'addl_medicare.threshold.mfs': 125000,
  'niit.rate': 0.038, 'niit.threshold.single': 200000, 'niit.threshold.mfj': 250000, 'niit.threshold.mfs': 125000,
}).map(([key, value]) => [key, { key, value, status: 'verified' as const }]));

const none: OtherTaxesInput = { additionalMedicareTax: null, niit: null };
const base = (over: Partial<OtherTaxesContext> = {}): OtherTaxesContext => ({
  persons: [], interest: '0', dividends: '0', capitalGains: '0', rental: '0', passiveOrdinary: '0', agi: '0', ...over,
});
const run = (c: OtherTaxesContext, fs: FilingStatus = 'mfj', input: OtherTaxesInput = none) => {
  const ctx = new EngineContext(params, 2026, fs);
  return { r: computeOtherTaxes(input, c, ctx), ctx };
};

describe('Additional Medicare tax (Form 8959)', () => {
  it('taxes wages above the threshold', () => {
    const { r } = run(base({ persons: [{ personId: 'a', label: 'A', medicareWages: '250000', nese: '0' }] }), 'single');
    expect(r.additionalMedicare.wagesAboveThreshold).toBe('50000');
    expect(r.additionalMedicare.neseAboveThreshold).toBe('0');
    expect(r.additionalMedicare.tax).toBe('450');
  });
  it('reduces the threshold by wages first, then taxes NESE above the remainder (persons combined on the return)', () => {
    const { r, ctx } = run(base({ persons: [{ personId: 'a', label: 'A', medicareWages: '200000', nese: '0' }, { personId: 'b', label: 'B', medicareWages: '0', nese: '100000' }] }));
    expect(r.additionalMedicare.medicareWages).toBe('200000');
    expect(r.additionalMedicare.nese).toBe('100000');
    expect(r.additionalMedicare.wagesAboveThreshold).toBe('0');
    expect(r.additionalMedicare.neseAboveThreshold).toBe('50000');
    expect(r.additionalMedicare.tax).toBe('450');
    expect(ctx.trace.rows().find((t) => t.id === 'additional_medicare.se')!.amount).toBe('450');
  });
  it('is zero below the threshold and uses the MFS threshold', () => {
    expect(run(base({ persons: [{ personId: 'a', label: 'A', medicareWages: '150000', nese: '90000' }] })).r.additionalMedicare.tax).toBe('0');
    expect(run(base({ persons: [{ personId: 'a', label: 'A', medicareWages: '130000', nese: '0' }] }), 'mfs').r.additionalMedicare.tax).toBe('45');
  });
  it('a manual amount overrides the computation with a warning', () => {
    const { r, ctx } = run(base({ persons: [{ personId: 'a', label: 'A', medicareWages: '250000', nese: '0' }] }), 'single', { additionalMedicareTax: '100', niit: null });
    expect(r.additionalMedicare.method).toBe('manual');
    expect(r.additionalMedicare.tax).toBe('100');
    expect(ctx.allWarnings().find((w) => w.code === 'TE_ADDL_MEDICARE_MANUAL_OVERRIDE')!.message).toContain('450');
  });
});

describe('Net investment income tax (Form 8960)', () => {
  it('taxes the lesser of NII and MAGI over the threshold', () => {
    const { r } = run(base({ interest: '12000', dividends: '8000', agi: '300000' }));
    expect(r.niit.netInvestmentIncome).toBe('20000');
    expect(r.niit.base).toBe('20000');
    expect(r.niit.tax).toBe('760');
    const over = run(base({ interest: '80000', agi: '300000' })).r.niit;
    expect(over.base).toBe('50000');
    expect(over.tax).toBe('1900');
  });
  it('includes rental and passive K-1 income and a limited capital loss; is zero below the threshold', () => {
    const { r } = run(base({ interest: '1000', capitalGains: '-3000', rental: '8000', passiveOrdinary: '4000', agi: '400000' }));
    expect(r.niit.netInvestmentIncome).toBe('10000');
    expect(r.niit.tax).toBe('380');
    expect(run(base({ interest: '10000', agi: '240000' })).r.niit.tax).toBe('0');
  });
  it('negative items floor NII at zero; allocable deductions reduce NII', () => {
    expect(run(base({ interest: '1000', capitalGains: '-3000', agi: '400000' })).r.niit.netInvestmentIncome).toBe('0');
    const { r } = run(base({ interest: '20000', agi: '400000' }), 'mfj', { additionalMedicareTax: null, niit: null, niiAllocableDeductions: '5000' });
    expect(r.niit.allocableDeductions).toBe('5000');
    expect(r.niit.netInvestmentIncome).toBe('15000');
    expect(r.niit.tax).toBe('570');
  });
  it('a manual amount overrides the computation with a warning', () => {
    const { r, ctx } = run(base({ interest: '20000', agi: '400000' }), 'mfj', { additionalMedicareTax: null, niit: '0' });
    expect(r.niit.method).toBe('manual');
    expect(r.niit.tax).toBe('0');
    expect(ctx.allWarnings().find((w) => w.code === 'TE_NIIT_MANUAL_OVERRIDE')!.message).toContain('760');
  });
});
