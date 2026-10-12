// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { ParameterReader, parameterMapFromRows } from './parameters.js';
import type { ParameterMap } from './types.js';

const params: ParameterMap = {
  'se.ss_rate': { key: 'se.ss_rate', value: 0.124, status: 'verified' },
  'se.ss_wage_base': { key: 'se.ss_wage_base', value: 184500, status: 'verified' },
  'std_deduction.mfj': { key: 'std_deduction.mfj', value: 32200, status: 'verified' },
  'std_deduction.additional_age': { key: 'std_deduction.additional_age', value: 65, status: 'unverified' },
  'ltcg.rates': { key: 'ltcg.rates', value: [0, 0.15, 0.2], status: 'provisional' },
  'retirement.401k.catch_up_60_63_ages': { key: 'retirement.401k.catch_up_60_63_ages', value: [60, 63], status: 'verified' },
  'brackets.mfj': { key: 'brackets.mfj', value: [[24800, 0.1], [100800, 0.12], [null, 0.22]], status: 'verified' },
  'bad.money': { key: 'bad.money', value: 'oops', status: 'verified' },
};

describe('ParameterReader', () => {
  it('reads typed values as decimal strings', () => {
    const r = new ParameterReader(params);
    expect(r.rate('se.ss_rate')).toBe('0.124');
    expect(r.money('se.ss_wage_base')).toBe('184500');
    expect(r.int('std_deduction.additional_age')).toBe(65);
    expect(r.rateList('ltcg.rates')).toEqual(['0', '0.15', '0.2']);
    expect(r.intList('retirement.401k.catch_up_60_63_ages')).toEqual([60, 63]);
    expect(r.brackets('brackets.mfj')).toEqual([
      { upper: '24800', rate: '0.1' }, { upper: '100800', rate: '0.12' }, { upper: null, rate: '0.22' },
    ]);
  });

  it('resolves filing-status variants', () => {
    const r = new ParameterReader(params);
    expect(r.moneyFs('std_deduction', 'mfj')).toBe('32200');
  });

  it('throws TE_PARAM_MISSING for a missing key and TE_PARAM_INVALID for a bad value', () => {
    const r = new ParameterReader(params);
    expect(() => r.money('nope.key')).toThrow(/TE_PARAM_MISSING/);
    expect(() => r.money('bad.money')).toThrow(/TE_PARAM_INVALID/);
  });

  it('records every key read and warns once per non-verified parameter (D12a)', () => {
    const r = new ParameterReader(params);
    r.rate('se.ss_rate');
    r.rate('se.ss_rate');
    r.int('std_deduction.additional_age');
    r.rateList('ltcg.rates');
    expect(r.used().map((u) => u.key)).toEqual(['se.ss_rate', 'std_deduction.additional_age', 'ltcg.rates']);
    const w = r.warnings();
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ code: 'TE_PARAM_UNVERIFIED', severity: 'warning', details: { key: 'std_deduction.additional_age', status: 'unverified' } });
    expect(w[1]!.details).toMatchObject({ key: 'ltcg.rates', status: 'provisional' });
    expect(w[0]!.message).toMatch(/unverified/);
  });

  it('builds a map from API rows', () => {
    const m = parameterMapFromRows([
      { key: 'a', value: 1, status: 'verified', source: 'seed', citation: 'x' },
      { key: 'b', value: 2, status: 'provisional', source: 'fallback', citation: 'y' },
    ]);
    expect(Object.keys(m)).toEqual(['a', 'b']);
    expect(m['b']).toMatchObject({ value: 2, status: 'provisional', source: 'fallback' });
  });
});
