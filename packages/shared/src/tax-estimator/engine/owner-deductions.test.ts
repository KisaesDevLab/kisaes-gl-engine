// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { computeRetirementLimit, computeSehiLimit, computeHsaLimit, seEarnedIncomeBase } from './owner-deductions.js';
import type { ParameterMap } from './types.js';

const params: ParameterMap = {
  'retirement.sep.pct_of_comp': { key: 'retirement.sep.pct_of_comp', value: 0.25, status: 'verified' },
  'retirement.sep.dollar_limit': { key: 'retirement.sep.dollar_limit', value: 72000, status: 'verified' },
  'retirement.comp_limit': { key: 'retirement.comp_limit', value: 360000, status: 'verified' },
  'retirement.401k.deferral': { key: 'retirement.401k.deferral', value: 24500, status: 'verified' },
  'retirement.401k.catch_up_50': { key: 'retirement.401k.catch_up_50', value: 8000, status: 'verified' },
  'retirement.401k.catch_up_60_63': { key: 'retirement.401k.catch_up_60_63', value: 11250, status: 'verified' },
  'retirement.simple.deferral': { key: 'retirement.simple.deferral', value: 17000, status: 'verified' },
  'retirement.simple.catch_up': { key: 'retirement.simple.catch_up', value: 4000, status: 'verified' },
  'retirement.simple.match_pct': { key: 'retirement.simple.match_pct', value: 0.03, status: 'unverified' },
  'se.nese_factor': { key: 'se.nese_factor', value: 0.9235, status: 'verified' },
  'retirement.catch_up_age': { key: 'retirement.catch_up_age', value: 50, status: 'unverified' },
  'retirement.401k.catch_up_60_63_ages': { key: 'retirement.401k.catch_up_60_63_ages', value: [60, 63], status: 'unverified' },
  'hsa.limit.self': { key: 'hsa.limit.self', value: 4400, status: 'verified' },
  'hsa.limit.family': { key: 'hsa.limit.family', value: 8750, status: 'verified' },
  'hsa.catch_up_55': { key: 'hsa.catch_up_55', value: 1000, status: 'verified' },
  'hsa.catch_up_age': { key: 'hsa.catch_up_age', value: 55, status: 'unverified' },
};

const ctx = () => new EngineContext(params, 2026, 'mfj');

describe('seEarnedIncomeBase', () => {
  it('is SE income less ½ SE tax, floored at zero', () => {
    expect(seEarnedIncomeBase('128000', '9042.912')).toBe('118957.088');
    expect(seEarnedIncomeBase('-100', '0')).toBe('0');
  });
});

describe('computeRetirementLimit — SEP', () => {
  it('Rivera base: 20% of (128,000 − 9,042.912) = 23,791.4176, 15,000 fully deducted', () => {
    const r = computeRetirementLimit({ personId: 'p1', label: 'Carlos', planType: 'sep', contributed: '15000', employeeDeferral: null, seIncome: '128000', halfSeTax: '9042.912', age: 45 }, ctx());
    expect(r.limit).toBe('23791.4176');
    expect(r.deducted).toBe('15000');
    expect(r.capped).toBe(false);
  });
  it('Rivera truck: 20% of (68,000 − 4,804.016) = 12,639.1968 → capped with a warning', () => {
    const c = ctx();
    const r = computeRetirementLimit({ personId: 'p1', label: 'Carlos', planType: 'sep', contributed: '15000', employeeDeferral: null, seIncome: '68000', halfSeTax: '4804.016', age: 45 }, c);
    expect(r.limit).toBe('12639.1968');
    expect(r.deducted).toBe('12639.1968');
    expect(r.capped).toBe(true);
    const w = c.allWarnings().find((x) => x.code === 'TE_RETIREMENT_CAPPED');
    expect(w).toBeDefined();
    expect(w!.message).toMatch(/12,639|12639/);
  });
  it('applies the dollar limit for a high earner', () => {
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'sep', contributed: '90000', employeeDeferral: null, seIncome: '500000', halfSeTax: '0', age: 45 }, ctx());
    expect(r.limit).toBe('72000');
    expect(r.deducted).toBe('72000');
  });
  it('assumes SEP when the plan type is unknown and says so', () => {
    const c = ctx();
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: null, contributed: '1000', employeeDeferral: null, seIncome: '50000', halfSeTax: '0', age: null }, c);
    expect(r.planType).toBe('sep');
    expect(c.allWarnings().some((w) => w.code === 'TE_RETIREMENT_PLAN_ASSUMED')).toBe(true);
  });
  it('no SE earnings → limit 0 and the contribution is not deducted', () => {
    const c = ctx();
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'sep', contributed: '5000', employeeDeferral: null, seIncome: '0', halfSeTax: '0', age: 40 }, c);
    expect(r.deducted).toBe('0');
    expect(r.capped).toBe(true);
  });
  it('none plan type deducts nothing', () => {
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'none', contributed: '5000', employeeDeferral: null, seIncome: '100000', halfSeTax: '0', age: 40 }, ctx());
    expect(r.deducted).toBe('0');
    expect(r.limit).toBe('0');
  });
});

describe('computeRetirementLimit — solo 401(k)', () => {
  it('deferral + employer 20% share, under the dollar limit', () => {
    // base 100,000: deferral 24,500 + employer 20,000 = 44,500
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '50000', employeeDeferral: null, seIncome: '100000', halfSeTax: '0', age: 45 }, ctx());
    expect(r.limit).toBe('44500');
    expect(r.deducted).toBe('44500');
  });
  it('adds the age-50 catch-up and the 60–63 catch-up', () => {
    const fifty = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '60000', employeeDeferral: null, seIncome: '100000', halfSeTax: '0', age: 52 }, ctx());
    expect(fifty.limit).toBe('52500');
    const sixty = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '60000', employeeDeferral: null, seIncome: '100000', halfSeTax: '0', age: 61 }, ctx());
    expect(sixty.limit).toBe('55750');
    const sixtyFour = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '60000', employeeDeferral: null, seIncome: '100000', halfSeTax: '0', age: 64 }, ctx());
    expect(sixtyFour.limit).toBe('52500');
  });
  it('deferral cannot exceed earned income; total cannot exceed the dollar limit + catch-up', () => {
    const small = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '30000', employeeDeferral: null, seIncome: '10000', halfSeTax: '0', age: 45 }, ctx());
    expect(small.limit).toBe('12000'); // 10,000 deferral + 2,000 employer
    const big = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '100000', employeeDeferral: null, seIncome: '400000', halfSeTax: '0', age: 52 }, ctx());
    expect(big.limit).toBe('80000'); // 72,000 + 8,000
  });
});

describe('computeRetirementLimit — R7-01 recorded employee deferral', () => {
  it('solo 401(k): the deferral leg is what was actually deferred; the employer leg is the rest, capped at the 20% share', () => {
    // base 100,000: deferred 10,000 + employer 40,000 contributed; employer share cap 20,000 → 30,000 deductible (was 44,500 assuming a maximum deferral)
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '50000', employeeDeferral: '10000', seIncome: '100000', halfSeTax: '0', age: 45 }, ctx());
    expect(r.limit).toBe('30000');
    expect(r.deducted).toBe('30000');
    expect(r.capped).toBe(true);
  });
  it('solo 401(k): an excess deferral is not deductible above the §402(g) limit', () => {
    // deferred 30,000 (limit 24,500), nothing else contributed → 24,500 deductible
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '30000', employeeDeferral: '30000', seIncome: '100000', halfSeTax: '0', age: 45 }, ctx());
    expect(r.deducted).toBe('24500');
    expect(r.capped).toBe(true);
  });
  it('solo 401(k): a deferral larger than the total contributed is limited to the total', () => {
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '5000', employeeDeferral: '9000', seIncome: '100000', halfSeTax: '0', age: 45 }, ctx());
    expect(r.deducted).toBe('5000');
    expect(r.capped).toBe(false);
  });
  it('solo 401(k): a full deferral gives the same answer as the unknown-deferral upper bound', () => {
    const known = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '44500', employeeDeferral: '24500', seIncome: '100000', halfSeTax: '0', age: 45 }, ctx());
    const unknown = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'solo_401k', contributed: '44500', employeeDeferral: null, seIncome: '100000', halfSeTax: '0', age: 45 }, ctx());
    expect(known.deducted).toBe(unknown.deducted);
    expect(known.deducted).toBe('44500');
  });
  it('SIMPLE: the 3% match is dollar-for-dollar on what was actually deferred (§408(p)(2)(A)(iii))', () => {
    // NESE 92,350; deferred 1,000 → match min(2,770.5, 1,000) = 1,000; contributed 5,000 → 2,000 deductible
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'simple', contributed: '5000', employeeDeferral: '1000', seIncome: '100000', halfSeTax: '0', age: 45 }, ctx());
    expect(r.limit).toBe('2000');
    expect(r.deducted).toBe('2000');
  });
  it('SEP ignores a recorded deferral', () => {
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'sep', contributed: '15000', employeeDeferral: '5000', seIncome: '128000', halfSeTax: '9042.912', age: 45 }, ctx());
    expect(r.deducted).toBe('15000');
  });
});

describe('computeRetirementLimit — SIMPLE', () => {
  it('R2-13: deferral + 3% match on §1402(a) net earnings (92.35% of profit, before ½ SE tax — §408(p)(6)(A)(ii)), with the age-50 catch-up', () => {
    // compensation = 100,000 × 0.9235 = 92,350 (the ½ SE tax passed in is ignored for SIMPLE); match 3% = 2,770.5
    const r = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'simple', contributed: '25000', employeeDeferral: null, seIncome: '100000', halfSeTax: '7000', age: 45 }, ctx());
    expect(r.limit).toBe('19770.5');
    expect(r.parameterKeys).toContain('se.nese_factor');
    const c = computeRetirementLimit({ personId: 'p1', label: 'x', planType: 'simple', contributed: '25000', employeeDeferral: null, seIncome: '100000', halfSeTax: '0', age: 55 }, ctx());
    expect(c.limit).toBe('23770.5');
  });
});

describe('computeSehiLimit', () => {
  it('Rivera: 10,800 allowed all 12 months, under the earned-income cap', () => {
    const r = computeSehiLimit({ personId: 'p1', label: 'Carlos', premiums: '10800', eligibleMonths: Array(12).fill(true), earnedIncomeCap: '103957.088' }, ctx());
    expect(r.eligibleMonths).toBe(12);
    expect(r.afterMonths).toBe('10800');
    expect(r.deducted).toBe('10800');
    expect(r.capped).toBe(false);
  });
  it('sehi_eligible_months[m] === true means deductible that month; false months are excluded pro rata', () => {
    const months = Array(12).fill(true); months[0] = false; months[1] = false; months[2] = false; // Jan–Mar employer plan available
    const c = ctx();
    const r = computeSehiLimit({ personId: 'p1', label: 'x', premiums: '12000', eligibleMonths: months, earnedIncomeCap: '999999' }, c);
    expect(r.eligibleMonths).toBe(9);
    expect(r.afterMonths).toBe('9000');
    expect(r.deducted).toBe('9000');
    expect(c.allWarnings().some((w) => w.code === 'TE_SEHI_MONTHS_EXCLUDED')).toBe(true);
  });
  it('caps at earned income with a warning', () => {
    const c = ctx();
    const r = computeSehiLimit({ personId: 'p1', label: 'x', premiums: '12000', eligibleMonths: Array(12).fill(true), earnedIncomeCap: '5000' }, c);
    expect(r.deducted).toBe('5000');
    expect(r.capped).toBe(true);
    expect(c.allWarnings().some((w) => w.code === 'TE_SEHI_CAPPED')).toBe(true);
  });
  it('a malformed flag array is treated as all eligible with a warning', () => {
    const c = ctx();
    const r = computeSehiLimit({ personId: 'p1', label: 'x', premiums: '1200', eligibleMonths: [true, false], earnedIncomeCap: '999999' }, c);
    expect(r.eligibleMonths).toBe(12);
    expect(c.allWarnings().some((w) => w.code === 'TE_SEHI_MONTHS_INVALID')).toBe(true);
  });
});

describe('computeHsaLimit', () => {
  it('self / family limits and the 55+ catch-up', () => {
    expect(computeHsaLimit({ personId: 'p1', label: 'x', coverage: 'self', contributed: '5000', age: 40 }, ctx()).limit).toBe('4400');
    expect(computeHsaLimit({ personId: 'p1', label: 'x', coverage: 'family', contributed: '5000', age: 40 }, ctx()).limit).toBe('8750');
    expect(computeHsaLimit({ personId: 'p1', label: 'x', coverage: 'family', contributed: '5000', age: 55 }, ctx()).limit).toBe('9750');
    expect(computeHsaLimit({ personId: 'p1', label: 'x', coverage: 'self', contributed: '5000', age: 54 }, ctx()).limit).toBe('4400');
  });
  it('caps with a warning and deducts nothing with no coverage', () => {
    const c = ctx();
    const r = computeHsaLimit({ personId: 'p1', label: 'x', coverage: 'self', contributed: '5000', age: 40 }, c);
    expect(r.deducted).toBe('4400');
    expect(r.capped).toBe(true);
    expect(c.allWarnings().some((w) => w.code === 'TE_HSA_CAPPED')).toBe(true);
    const none = computeHsaLimit({ personId: 'p1', label: 'x', coverage: 'none', contributed: '5000', age: 40 }, ctx());
    expect(none.deducted).toBe('0');
    expect(none.capped).toBe(true);
    expect(computeHsaLimit({ personId: 'p1', label: 'x', coverage: 'none', contributed: '0', age: 40 }, ctx()).capped).toBe(false);
  });
});
