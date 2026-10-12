// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { computeStandardDeduction, computeItemizedDeductions, chooseDeduction, computeSch1a, type DeductionPerson } from './deductions.js';
import type { EngineItemized, ParameterMap } from './types.js';
import type { FilingStatus } from '../types.js';

const params: ParameterMap = {
  'std_deduction.single': { key: 'std_deduction.single', value: 16100, status: 'verified' },
  'std_deduction.mfj': { key: 'std_deduction.mfj', value: 32200, status: 'verified' },
  'std_deduction.mfs': { key: 'std_deduction.mfs', value: 16100, status: 'verified' },
  'std_deduction.hoh': { key: 'std_deduction.hoh', value: 24150, status: 'verified' },
  'std_deduction.qss': { key: 'std_deduction.qss', value: 32200, status: 'verified' },
  'std_deduction.additional_65_blind.unmarried': { key: 'std_deduction.additional_65_blind.unmarried', value: 2050, status: 'verified' },
  'std_deduction.additional_65_blind.married': { key: 'std_deduction.additional_65_blind.married', value: 1650, status: 'verified' },
  'std_deduction.additional_age': { key: 'std_deduction.additional_age', value: 65, status: 'unverified' },
  'salt.cap.standard': { key: 'salt.cap.standard', value: 40400, status: 'verified' },
  'salt.cap.mfs': { key: 'salt.cap.mfs', value: 20200, status: 'verified' },
  'salt.phase_down.threshold.standard': { key: 'salt.phase_down.threshold.standard', value: 505000, status: 'verified' },
  'salt.phase_down.threshold.mfs': { key: 'salt.phase_down.threshold.mfs', value: 252500, status: 'verified' },
  'salt.phase_down.rate': { key: 'salt.phase_down.rate', value: 0.3, status: 'verified' },
  'salt.floor.standard': { key: 'salt.floor.standard', value: 10000, status: 'verified' },
  'salt.floor.mfs': { key: 'salt.floor.mfs', value: 5000, status: 'verified' },
  'charity.agi_floor_pct': { key: 'charity.agi_floor_pct', value: 0.005, status: 'verified' },
  'charity.nonitemizer.single': { key: 'charity.nonitemizer.single', value: 1000, status: 'verified' },
  'charity.nonitemizer.mfj': { key: 'charity.nonitemizer.mfj', value: 2000, status: 'verified' },
  'charity.nonitemizer.mfs': { key: 'charity.nonitemizer.mfs', value: 1000, status: 'verified' },
  'charity.nonitemizer.hoh': { key: 'charity.nonitemizer.hoh', value: 1000, status: 'verified' },
  'charity.nonitemizer.qss': { key: 'charity.nonitemizer.qss', value: 1000, status: 'verified' },
  'itemized.benefit_cap_rate': { key: 'itemized.benefit_cap_rate', value: 0.35, status: 'unverified' },
  'brackets.mfj': { key: 'brackets.mfj', value: [[24800, 0.1], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [null, 0.37]], status: 'verified' },
  'brackets.single': { key: 'brackets.single', value: [[12400, 0.1], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [null, 0.37]], status: 'verified' },
  'brackets.mfs': { key: 'brackets.mfs', value: [[12400, 0.1], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [384350, 0.35], [null, 0.37]], status: 'verified' },
  'sch1a.senior.amount': { key: 'sch1a.senior.amount', value: 6000, status: 'verified' },
  'sch1a.senior.age': { key: 'sch1a.senior.age', value: 65, status: 'unverified' },
  'sch1a.senior.phaseout_threshold.mfj': { key: 'sch1a.senior.phaseout_threshold.mfj', value: 150000, status: 'verified' },
  'sch1a.senior.phaseout_threshold.single': { key: 'sch1a.senior.phaseout_threshold.single', value: 75000, status: 'verified' },
  'sch1a.senior.phaseout_rate': { key: 'sch1a.senior.phaseout_rate', value: 0.06, status: 'verified' },
  'sch1a.tips.max': { key: 'sch1a.tips.max', value: 25000, status: 'verified' },
  'sch1a.tips.phaseout_threshold.mfj': { key: 'sch1a.tips.phaseout_threshold.mfj', value: 300000, status: 'verified' },
  'sch1a.tips.phaseout_threshold.single': { key: 'sch1a.tips.phaseout_threshold.single', value: 150000, status: 'verified' },
  'sch1a.tips.phaseout_rate': { key: 'sch1a.tips.phaseout_rate', value: 0.1, status: 'verified' },
  'sch1a.overtime.max.standard': { key: 'sch1a.overtime.max.standard', value: 12500, status: 'verified' },
  'sch1a.overtime.max.mfj': { key: 'sch1a.overtime.max.mfj', value: 25000, status: 'verified' },
  'sch1a.overtime.phaseout_threshold.mfj': { key: 'sch1a.overtime.phaseout_threshold.mfj', value: 300000, status: 'verified' },
  'sch1a.overtime.phaseout_threshold.single': { key: 'sch1a.overtime.phaseout_threshold.single', value: 150000, status: 'verified' },
  'sch1a.overtime.phaseout_rate': { key: 'sch1a.overtime.phaseout_rate', value: 0.1, status: 'verified' },
  'sch1a.car_interest.max': { key: 'sch1a.car_interest.max', value: 10000, status: 'verified' },
  'sch1a.car_interest.phaseout_threshold.mfj': { key: 'sch1a.car_interest.phaseout_threshold.mfj', value: 200000, status: 'verified' },
  'sch1a.car_interest.phaseout_threshold.single': { key: 'sch1a.car_interest.phaseout_threshold.single', value: 100000, status: 'verified' },
  'sch1a.car_interest.phaseout_rate': { key: 'sch1a.car_interest.phaseout_rate', value: 0.2, status: 'verified' },
  'sch1a.first_year': { key: 'sch1a.first_year', value: 2025, status: 'verified' },
  'sch1a.last_year': { key: 'sch1a.last_year', value: 2028, status: 'verified' },
};

const ctx = (fs: FilingStatus = 'mfj', year = 2026) => new EngineContext(params, year, fs);
const person = (id: string, role: 'primary' | 'spouse', age: number | null, blind = false, sch1a = { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' }): DeductionPerson =>
  ({ personId: id, role, label: id, age, isBlind: blind, sch1a });
const noItemized: EngineItemized = { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' };

describe('computeStandardDeduction', () => {
  it('MFJ base with no add-ons', () => {
    const r = computeStandardDeduction([person('a', 'primary', 45), person('b', 'spouse', 44)], '0', ctx());
    expect(r.base).toBe('32200');
    expect(r.additionalCount).toBe(0);
    expect(r.total).toBe('32200');
  });
  it('adds the married amount per 65 / blind box (MFJ: both spouses count)', () => {
    const r = computeStandardDeduction([person('a', 'primary', 66, true), person('b', 'spouse', 65)], '0', ctx());
    expect(r.additionalCount).toBe(3);
    expect(r.additionalEach).toBe('1650');
    expect(r.total).toBe('37150');
  });
  it('uses the unmarried amount for single / HOH and ignores the spouse when not MFJ', () => {
    const s = computeStandardDeduction([person('a', 'primary', 70)], '0', ctx('single'));
    expect(s.total).toBe('18150');
    const mfs = computeStandardDeduction([person('a', 'primary', 70), person('b', 'spouse', 70)], '0', ctx('mfs'));
    expect(mfs.additionalCount).toBe(1);
    expect(mfs.additionalEach).toBe('1650');
  });
  it('adds the non-itemizer charitable deduction capped at the parameter', () => {
    const r = computeStandardDeduction([person('a', 'primary', 40)], '5000', ctx());
    expect(r.nonItemizerCharitable).toBe('2000');
    expect(r.total).toBe('34200');
    const small = computeStandardDeduction([person('a', 'primary', 40)], '300', ctx());
    expect(small.nonItemizerCharitable).toBe('300');
  });
});

describe('computeItemizedDeductions', () => {
  it('SALT under the cap, mortgage, charitable less the 0.5% floor, other', () => {
    const r = computeItemizedDeductions({ saltPaid: '15000', mortgageInterest: '9000', charitableCash: '5000', charitableNoncash: '1000', other: '400' }, '0', '200000', '150000', ctx());
    expect(r.saltAllowed).toBe('15000');
    expect(r.charitableFloor).toBe('1000');
    expect(r.charitableAllowed).toBe('5000');
    expect(r.beforeBenefitCap).toBe('29400');
    expect(r.benefitCapReduction).toBe('0');
    expect(r.total).toBe('29400');
  });
  it('caps SALT and phases the cap down to the floor above the MAGI threshold', () => {
    const c = ctx();
    const under = computeItemizedDeductions({ ...noItemized, saltPaid: '60000' }, '0', '400000', '300000', c);
    expect(under.saltCap).toBe('40400');
    expect(under.saltAllowed).toBe('40400');
    // MAGI 555,000: cap 40,400 − 0.3 × 50,000 = 25,400
    const mid = computeItemizedDeductions({ ...noItemized, saltPaid: '60000' }, '0', '555000', '400000', c);
    expect(mid.saltCap).toBe('25400');
    expect(c.allWarnings().some((w) => w.code === 'TE_SALT_PHASED_DOWN')).toBe(true);
    const floor = computeItemizedDeductions({ ...noItemized, saltPaid: '60000' }, '0', '900000', '700000', c);
    expect(floor.saltCap).toBe('10000');
    const mfs = computeItemizedDeductions({ ...noItemized, saltPaid: '60000' }, '0', '100000', '50000', ctx('mfs'));
    expect(mfs.saltCap).toBe('20200');
  });
  it('adds itemized "other" adjustments', () => {
    const r = computeItemizedDeductions({ ...noItemized, other: '100' }, '250', '50000', '20000', ctx());
    expect(r.other).toBe('350');
  });
  it('applies the §68 benefit cap (2/37 of the lesser of itemized or TI over the 37% bracket) only in the top bracket', () => {
    const c = ctx();
    // taxable income base 1,000,000 (before itemized), itemized 100,000: lesser of 100,000 or (1,000,000 − 768,700) = 100,000 → × 2/37
    const r = computeItemizedDeductions({ ...noItemized, mortgageInterest: '100000' }, '0', '1200000', '1000000', c);
    expect(r.benefitCapReduction).toBe('5405.405405405405');
    expect(r.total).toBe('94594.594594594595');
    expect(c.allWarnings().some((w) => w.code === 'TE_ITEMIZED_BENEFIT_CAPPED')).toBe(true);
    const low = computeItemizedDeductions({ ...noItemized, mortgageInterest: '100000' }, '0', '300000', '200000', ctx());
    expect(low.benefitCapReduction).toBe('0');
    // partial: TI base 800,000 → excess 31,300 is the lesser
    const partial = computeItemizedDeductions({ ...noItemized, mortgageInterest: '100000' }, '0', '900000', '800000', ctx());
    expect(partial.benefitCapReduction).toBe('1691.891891891892');
  });
  it('no reduction when the cap rate equals the top rate (2025 seed)', () => {
    const p2025: ParameterMap = { ...params, 'itemized.benefit_cap_rate': { key: 'itemized.benefit_cap_rate', value: 0.37, status: 'verified' } };
    const c = new EngineContext(p2025, 2025, 'mfj');
    const r = computeItemizedDeductions({ ...noItemized, mortgageInterest: '100000' }, '0', '1200000', '1000000', c);
    expect(r.benefitCapReduction).toBe('0');
  });
});

describe('chooseDeduction', () => {
  const std = { base: '32200', additionalCount: 0, additionalEach: '1650', total: '34200', nonItemizerCharitable: '2000' };
  const itemized = (total: string) => ({ saltPaid: '0', saltCap: '0', saltAllowed: '0', mortgageInterest: '0', charitableGross: '0', charitableFloor: '0', charitableAllowed: '0', other: '0', beforeBenefitCap: total, benefitCapReduction: '0', total });
  it('auto picks the larger', () => {
    expect(chooseDeduction('auto', std, itemized('40000'), ctx())).toEqual({ chosen: 'itemized', deduction: '40000' });
    expect(chooseDeduction('auto', std, itemized('30000'), ctx())).toEqual({ chosen: 'standard', deduction: '34200' });
  });
  it('forced modes win even when smaller, with a note', () => {
    const c = ctx();
    expect(chooseDeduction('itemized', std, itemized('30000'), c)).toEqual({ chosen: 'itemized', deduction: '30000' });
    expect(c.allWarnings().some((w) => w.code === 'TE_DEDUCTION_FORCED')).toBe(true);
    expect(chooseDeduction('standard', std, itemized('40000'), ctx())).toEqual({ chosen: 'standard', deduction: '34200' });
  });
});

describe('computeSch1a', () => {
  it('is not in effect outside the parameter years', () => {
    const r = computeSch1a([person('a', 'primary', 70)], '100000', ctx('mfj', 2024));
    expect(r.inEffect).toBe(false);
    expect(r.total).toBe('0');
  });
  it('senior deduction per 65+ person with MAGI phase-out', () => {
    const both = computeSch1a([person('a', 'primary', 66), person('b', 'spouse', 65)], '100000', ctx());
    expect(both.senior).toBe('12000');
    const one = computeSch1a([person('a', 'primary', 66), person('b', 'spouse', 60)], '100000', ctx());
    expect(one.senior).toBe('6000');
    // MAGI 200,000: 12,000 − 0.06 × 50,000 = 9,000
    expect(computeSch1a([person('a', 'primary', 66), person('b', 'spouse', 65)], '200000', ctx()).senior).toBe('9000');
    expect(computeSch1a([person('a', 'primary', 66), person('b', 'spouse', 65)], '400000', ctx()).senior).toBe('0');
  });
  it('tips, overtime and car-loan interest with caps and phase-outs', () => {
    const p = [person('a', 'primary', 40, false, { qualifiedTips: '30000', qualifiedOvertime: '20000', carLoanInterest: '12000' }), person('b', 'spouse', 40, false, { qualifiedTips: '0', qualifiedOvertime: '10000', carLoanInterest: '0' })];
    const low = computeSch1a(p, '100000', ctx());
    expect(low.tips).toBe('25000');
    expect(low.overtime).toBe('25000');
    expect(low.carLoanInterest).toBe('10000');
    expect(low.total).toBe('60000');
    // MAGI 350,000: tips 25,000 − 5,000; overtime 25,000 − 5,000; car 10,000 − 0.2 × 150,000 → 0
    const high = computeSch1a(p, '350000', ctx());
    expect(high.tips).toBe('20000');
    expect(high.overtime).toBe('20000');
    expect(high.carLoanInterest).toBe('0');
    const single = computeSch1a([p[0]!], '100000', ctx('single'));
    expect(single.overtime).toBe('12500');
  });
});
