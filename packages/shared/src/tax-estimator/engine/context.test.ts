// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext, ageAtYearEnd } from './context.js';
import type { ParameterMap } from './types.js';

const params: ParameterMap = {
  'se.ss_rate': { key: 'se.ss_rate', value: 0.124, status: 'unverified' },
};

describe('EngineContext trace', () => {
  it('rounds trace amounts half-up and keeps the exact value', () => {
    const ctx = new EngineContext(params, 2026, 'mfj');
    const row = ctx.trace.add({ step: 'se_tax', id: 'se_tax', label: 'SE tax', exact: '18085.824', source: 'parameter', formula: 'x' });
    expect(row.amount).toBe('18086');
    expect(row.exact).toBe('18085.824');
    expect(ctx.trace.rows()).toHaveLength(1);
  });
  it('dedupes warnings by code + details key and collects parameter warnings last', () => {
    const ctx = new EngineContext(params, 2026, 'mfj');
    ctx.warn('TE_X', 'first', { k: 1 });
    ctx.warn('TE_X', 'again', { k: 1 });
    ctx.warn('TE_X', 'other', { k: 2 });
    ctx.params.rate('se.ss_rate');
    const w = ctx.allWarnings();
    expect(w.map((x) => x.code)).toEqual(['TE_X', 'TE_X', 'TE_PARAM_UNVERIFIED']);
  });
  it('resolves persons by id with the primary as fallback', () => {
    const ctx = new EngineContext(params, 2026, 'mfj');
    ctx.setPersons([{ personId: 'p1', role: 'primary' }, { personId: 'p2', role: 'spouse' }]);
    expect(ctx.resolvePerson('p2')).toBe('p2');
    expect(ctx.resolvePerson(null)).toBe('p1');
    expect(ctx.resolvePerson('ghost')).toBe('p1');
    expect(ctx.allWarnings().some((w) => w.code === 'TE_UNKNOWN_PERSON')).toBe(true);
  });
});

describe('ageAtYearEnd', () => {
  it('computes age at Dec 31 of the tax year', () => {
    expect(ageAtYearEnd('1961-06-15', 2026, false)).toBe(65);
    expect(ageAtYearEnd('1961-12-31', 2026, false)).toBe(65);
    expect(ageAtYearEnd('1962-01-01', 2026, false)).toBe(64);
  });
  it('applies the Jan 1 rule (65 on the day before the birthday) when asked', () => {
    expect(ageAtYearEnd('1962-01-01', 2026, true)).toBe(65);
    expect(ageAtYearEnd('1962-01-02', 2026, true)).toBe(64);
  });
  it('returns null for missing or malformed dates', () => {
    expect(ageAtYearEnd(null, 2026, true)).toBeNull();
    expect(ageAtYearEnd('junk', 2026, true)).toBeNull();
  });
});
