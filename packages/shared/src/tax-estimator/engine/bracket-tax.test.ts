// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { bracketTax, marginalBracketRate, computeRegularTax } from './bracket-tax.js';
import type { ParameterMap } from './types.js';

const params: ParameterMap = {
  'brackets.mfj': { key: 'brackets.mfj', value: [[24800, 0.1], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [null, 0.37]], status: 'verified' },
  'ltcg.breakpoints.mfj': { key: 'ltcg.breakpoints.mfj', value: [98900, 613700], status: 'verified' },
  'ltcg.rates': { key: 'ltcg.rates', value: [0, 0.15, 0.2], status: 'verified' },
  'collectibles_rate': { key: 'collectibles_rate', value: 0.28, status: 'verified' },
  'unrecaptured_1250_rate': { key: 'unrecaptured_1250_rate', value: 0.25, status: 'verified' },
};
const ctx = () => new EngineContext(params, 2026, 'mfj');
const brackets = () => ctx().params.bracketsFs('brackets', 'mfj');

const base = { qualifiedDividends: '0', netLongTermGain: '0', unrecaptured1250: '0', collectibles: '0', rateMode: 'brackets' as const, effectiveRateOverride: null };

describe('bracketTax', () => {
  it('Rivera base: 138,725.6704 → 19,943.6475 at a 22% marginal rate', () => {
    expect(bracketTax('138725.6704', brackets())).toBe('19943.647488');
    expect(marginalBracketRate('138725.6704', brackets())).toBe('0.22');
  });
  it('zero or negative income → 0 tax, bottom rate', () => {
    expect(bracketTax('0', brackets())).toBe('0');
    expect(bracketTax('-500', brackets())).toBe('0');
    expect(marginalBracketRate('0', brackets())).toBe('0.1');
  });
  it('top bracket is open-ended', () => {
    expect(bracketTax('1000000', brackets())).toBe('292164.5');
    expect(marginalBracketRate('1000000', brackets())).toBe('0.37');
  });
  it('bracket boundary belongs to the lower bracket', () => {
    expect(bracketTax('24800', brackets())).toBe('2480');
    expect(marginalBracketRate('24800', brackets())).toBe('0.1');
    expect(marginalBracketRate('24800.01', brackets())).toBe('0.12');
  });
});

describe('computeRegularTax — brackets, no preferential income', () => {
  it('equals the bracket tax and reports rates', () => {
    const r = computeRegularTax({ ...base, taxableIncome: '138725.6704' }, ctx());
    expect(r.method).toBe('brackets');
    expect(r.tax).toBe('19943.647488');
    expect(r.marginalOrdinaryRate).toBe('0.22');
    expect(r.marginalCapitalGainRate).toBe('0');
    expect(r.worksheet).toBeNull();
    expect(r.effectiveRate).toBe('0.143763');
  });
  it('TI ≤ 0 → zero', () => {
    const r = computeRegularTax({ ...base, taxableIncome: '-1000', qualifiedDividends: '500' }, ctx());
    expect(r.tax).toBe('0');
    expect(r.effectiveRate).toBe('0');
  });
});

describe('computeRegularTax — QD / LTCG worksheet', () => {
  it('all preferential income inside the 0% breakpoint', () => {
    const r = computeRegularTax({ ...base, taxableIncome: '80000', qualifiedDividends: '10000', netLongTermGain: '20000' }, ctx());
    const w = r.worksheet!;
    expect(w.preferentialIncome).toBe('30000');
    expect(w.taxedAtZero).toBe('30000');
    expect(w.taxedAtFifteen).toBe('0');
    expect(w.ordinaryPortion).toBe('50000');
    expect(w.ordinaryTax).toBe('5504');
    expect(w.allOrdinaryTax).toBe('9104');
    expect(r.tax).toBe('5504');
    expect(r.marginalCapitalGainRate).toBe('0');
    expect(r.marginalOrdinaryRate).toBe('0.12');
  });
  it('straddles the 0% / 15% breakpoint', () => {
    const r = computeRegularTax({ ...base, taxableIncome: '150000', netLongTermGain: '60000' }, ctx());
    const w = r.worksheet!;
    expect(w.taxedAtZero).toBe('8900');
    expect(w.taxedAtFifteen).toBe('51100');
    expect(w.taxedAtTwenty).toBe('0');
    expect(w.ordinaryTax).toBe('10304');
    expect(w.preferentialTax).toBe('7665');
    expect(r.tax).toBe('17969');
    expect(r.marginalCapitalGainRate).toBe('0.15');
  });
  it('straddles the 15% / 20% breakpoint', () => {
    const r = computeRegularTax({ ...base, taxableIncome: '700000', netLongTermGain: '200000' }, ctx());
    const w = r.worksheet!;
    expect(w.taxedAtZero).toBe('0');
    expect(w.taxedAtFifteen).toBe('113700');
    expect(w.taxedAtTwenty).toBe('86300');
    expect(w.ordinaryTax).toBe('112912');
    expect(r.tax).toBe('147227');
    expect(r.marginalCapitalGainRate).toBe('0.2');
    expect(r.marginalOrdinaryRate).toBe('0.32');
  });
  it('25% unrecaptured §1250 and 28% collectibles buckets', () => {
    const r = computeRegularTax({ ...base, taxableIncome: '300000', netLongTermGain: '100000', unrecaptured1250: '20000', collectibles: '10000' }, ctx());
    const w = r.worksheet!;
    expect(w.taxedAtFifteen).toBe('70000');
    expect(w.taxedAtTwentyFive).toBe('20000');
    expect(w.taxedAtTwentyEight).toBe('10000');
    expect(w.ordinaryPortion).toBe('200000');
    expect(w.ordinaryTax).toBe('33424');
    expect(r.tax).toBe('51724');
    expect(w.allOrdinaryTax).toBe('57196');
  });
  it('never exceeds the all-ordinary tax', () => {
    // Low-bracket taxpayer with 28% gain: ordinary rates are lower than 28%, worksheet must not overcharge.
    const r = computeRegularTax({ ...base, taxableIncome: '30000', netLongTermGain: '10000', collectibles: '10000' }, ctx());
    expect(r.tax).toBe(r.worksheet!.allOrdinaryTax);
  });
  it('preferential income is limited to taxable income', () => {
    const r = computeRegularTax({ ...base, taxableIncome: '5000', netLongTermGain: '20000' }, ctx());
    expect(r.worksheet!.taxedAtZero).toBe('5000');
    expect(r.tax).toBe('0');
  });
});

describe('computeRegularTax — effective-rate override', () => {
  it('multiplies taxable income by the override and labels it', () => {
    const c = ctx();
    const r = computeRegularTax({ ...base, taxableIncome: '100000', qualifiedDividends: '5000', rateMode: 'effective', effectiveRateOverride: '0.18' }, c);
    expect(r.method).toBe('effective');
    expect(r.tax).toBe('18000');
    expect(r.worksheet).toBeNull();
    expect(r.marginalOrdinaryRate).toBe('0.18');
    expect(c.allWarnings().some((w) => w.code === 'TE_EFFECTIVE_RATE_OVERRIDE')).toBe(true);
    const row = c.trace.rows().find((t) => t.id === 'regular_tax')!;
    expect(row.label).toMatch(/effective-rate override/i);
    expect(row.marginalRate).toBe('0.18');
  });
  it('falls back to brackets with a warning when the override is missing', () => {
    const c = ctx();
    const r = computeRegularTax({ ...base, taxableIncome: '100000', rateMode: 'effective', effectiveRateOverride: null }, c);
    expect(r.method).toBe('brackets');
    expect(c.allWarnings().some((w) => w.code === 'TE_EFFECTIVE_RATE_MISSING')).toBe(true);
  });
});
