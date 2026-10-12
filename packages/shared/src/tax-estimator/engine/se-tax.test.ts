// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { computeSeTax } from './se-tax.js';
import type { ParameterMap } from './types.js';

const params: ParameterMap = {
  'se.nese_factor': { key: 'se.nese_factor', value: 0.9235, status: 'verified' },
  'se.min_nese': { key: 'se.min_nese', value: 400, status: 'verified' },
  'se.ss_rate': { key: 'se.ss_rate', value: 0.124, status: 'verified' },
  'se.medicare_rate': { key: 'se.medicare_rate', value: 0.029, status: 'verified' },
  'se.ss_wage_base': { key: 'se.ss_wage_base', value: 184500, status: 'verified' },
  'se.deduction_factor': { key: 'se.deduction_factor', value: 0.5, status: 'verified' },
};

const ctx = () => new EngineContext(params, 2026, 'mfj');

describe('computeSeTax', () => {
  it('matches the Rivera base Sch C (128,000)', () => {
    const r = computeSeTax({ personId: 'p1', label: 'Carlos', seIncome: '128000', socialSecurityWages: '0' }, ctx());
    expect(r.nese).toBe('118208');
    expect(r.socialSecurity).toBe('14657.792');
    expect(r.medicare).toBe('3428.032');
    expect(r.seTax).toBe('18085.824');
    expect(r.halfSeTax).toBe('9042.912');
  });
  it('is zero below the minimum NESE and for a loss', () => {
    expect(computeSeTax({ personId: 'p1', label: 'x', seIncome: '430', socialSecurityWages: '0' }, ctx()).seTax).toBe('0');
    expect(computeSeTax({ personId: 'p1', label: 'x', seIncome: '-5000', socialSecurityWages: '0' }, ctx()).seTax).toBe('0');
    expect(computeSeTax({ personId: 'p1', label: 'x', seIncome: '0', socialSecurityWages: '0' }, ctx()).halfSeTax).toBe('0');
  });
  it('taxes exactly the minimum NESE', () => {
    // 433.13 × 0.9235 = 399.995... < 400 → no tax; 433.14 → 400.004 → taxed
    expect(computeSeTax({ personId: 'p1', label: 'x', seIncome: '433.13', socialSecurityWages: '0' }, ctx()).seTax).toBe('0');
    expect(computeSeTax({ personId: 'p1', label: 'x', seIncome: '433.14', socialSecurityWages: '0' }, ctx()).seTax).not.toBe('0');
  });
  it('reduces the Social Security base by the person\'s W-2 Social Security wages', () => {
    const r = computeSeTax({ personId: 'p1', label: 'x', seIncome: '200000', socialSecurityWages: '150000' }, ctx());
    // NESE 184,700 > remaining base 34,500 → SS on 34,500; Medicare on 184,700
    expect(r.nese).toBe('184700');
    expect(r.socialSecurity).toBe('4278');
    expect(r.medicare).toBe('5356.3');
    const capped = computeSeTax({ personId: 'p1', label: 'x', seIncome: '50000', socialSecurityWages: '190000' }, ctx());
    expect(capped.socialSecurity).toBe('0');
    expect(capped.medicare).toBe('1339.075');
  });
  it('writes trace rows with the parameter keys', () => {
    const c = ctx();
    computeSeTax({ personId: 'p1', label: 'Carlos', seIncome: '128000', socialSecurityWages: '0' }, c);
    const rows = c.trace.rows();
    expect(rows.find((r) => r.id === 'se_tax.p1')!.amount).toBe('18086');
    expect(rows.find((r) => r.id === 'half_se_tax.p1')!.amount).toBe('9043');
    expect(rows.find((r) => r.id === 'nese.p1')!.parameterKeys).toContain('se.nese_factor');
  });
});
