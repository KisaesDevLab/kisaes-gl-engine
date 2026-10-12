// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 9 Sch F farmer / fisherman rules (IRC §6654(i); MODULE.md "Safe harbor ...",
// PHASES.md Phase 9): the two-thirds gross-income test on the current OR prior year
// (joint gross income on a joint return), the farmer_override, the 66 2/3% rule with
// no 110% high-AGI variant, the single Jan 15 installment, the Mar 1 file-and-pay
// note, the fishermen label, and the fall-back to the regular rules.

import { describe, it, expect } from 'vitest';
import { computeFarmer, farmerGrossIncomeTest, type FarmerEngineInput } from './farmer.js';
import type { ParameterMap } from './types.js';

type Status = 'verified' | 'unverified' | 'provisional';
function params(entries: Record<string, unknown>, status: Status = 'verified', overrides: Record<string, Status> = {}): ParameterMap {
  const out: Record<string, ParameterMap[string]> = {};
  for (const [key, value] of Object.entries(entries)) out[key] = { key, value, status: overrides[key] ?? status };
  return out;
}

/** The 2025 federal seed values the farmer path reads (farmer.* and the regular-rule fallback). */
const SEED_2025 = {
  'farmer.gross_income_ratio': 0.6666666666,
  'farmer.safe_harbor_current_pct': 0.6666666667,
  'farmer.safe_harbor_prior_pct': 1.0,
  'farmer.single_due_date': '2026-01-15',
  'farmer.file_by_date': '2026-03-02',
  'safe_harbor.current_pct': 0.9,
  'safe_harbor.prior_pct': 1.0,
  'safe_harbor.prior_pct_high_agi': 1.1,
  'safe_harbor.high_agi_threshold.standard': 150000,
  'safe_harbor.high_agi_threshold.mfs': 75000,
  'installments.due_dates': ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
  'installments.pcts': [0.25, 0.25, 0.25, 0.25],
  'installments.q4_file_and_pay_date': '2026-02-02',
};

const gross = (personId: string, farming: string, fishing: string, totalGross: string) => ({ personId, farming, fishing, totalGross });

/** MFJ couple: he farms ($180k of $200k gross), she has $100k of wages — joint ratio 60% fails, prior year 75% passes. */
function couple(over: Partial<FarmerEngineInput> = {}): FarmerEngineInput {
  return {
    taxYear: 2025,
    filingStatus: 'mfj',
    parameters: params(SEED_2025),
    primaryPersonId: 'p1',
    currentYear: { byPerson: [gross('p1', '180000', '0', '200000'), gross('p2', '0', '0', '100000')] },
    priorYear: { byPerson: [gross('p1', '210000', '0', '220000'), gross('p2', '0', '0', '60000')] },
    farmerOverride: null,
    isFisherman: false,
    tax: { currentYearTax: '30000', priorYearTax: '18000', priorYearFullTwelveMonths: true, priorYearAgi: '120000' },
    ...over,
  };
}

describe('gross-income test', () => {
  it('passes at or above the two-thirds ratio and fails below it', () => {
    const ratio = '0.6666666666';
    expect(farmerGrossIncomeTest([gross('p1', '2', '0', '3')], ratio).passes).toBe(true);
    expect(farmerGrossIncomeTest([gross('p1', '66', '0', '100')], ratio).passes).toBe(false);
    expect(farmerGrossIncomeTest([gross('p1', '67', '0', '100')], ratio).passes).toBe(true);
  });

  it('counts fishing income with farming income', () => {
    const t = farmerGrossIncomeTest([gross('p1', '30000', '40000', '100000')], '0.6666666666');
    expect(t.farmingAndFishing).toBe('70000');
    expect(t.passes).toBe(true);
  });

  it('zero gross income cannot qualify (ratio undefined)', () => {
    const t = farmerGrossIncomeTest([gross('p1', '0', '0', '0')], '0.6666666666');
    expect(t.ratio).toBeNull();
    expect(t.passes).toBe(false);
  });
});

describe('qualification: current year, prior year, joint income, override', () => {
  it('acceptance: qualifies on the PRIOR year only when the current year fails', () => {
    const r = computeFarmer(couple());
    expect(r.qualifies).toBe(true);
    expect(r.basis).toBe('prior_year');
    expect(r.jointTest).toBe(true);
    const [cur, prior] = r.tests;
    expect(cur).toMatchObject({ year: 'current', farmingAndFishing: '180000', totalGross: '300000', passes: false, personsCounted: 2 });
    expect(cur!.ratio).toBe('0.6');
    expect(prior).toMatchObject({ year: 'prior', farmingAndFishing: '210000', totalGross: '280000', passes: true, personsCounted: 2 });
    expect(prior!.ratio).toBe('0.75');
  });

  it('qualifies on the current year (prior year not needed, still reported)', () => {
    const r = computeFarmer(couple({ currentYear: { byPerson: [gross('p1', '180000', '0', '200000'), gross('p2', '0', '0', '40000')] } }));
    expect(r.qualifies).toBe(true);
    expect(r.basis).toBe('current_year');
    expect(r.tests).toHaveLength(2);
  });

  it('joint return: the spouse\'s non-farm gross income counts against the ratio', () => {
    const r = computeFarmer(couple({ priorYear: null }));
    expect(r.qualifies).toBe(false);
    expect(r.basis).toBe('none');
  });

  it('separate return: only the filer\'s gross income is tested', () => {
    const r = computeFarmer(couple({ filingStatus: 'mfs', priorYear: null }));
    expect(r.jointTest).toBe(false);
    expect(r.tests[0]).toMatchObject({ farmingAndFishing: '180000', totalGross: '200000', passes: true, personsCounted: 1 });
    expect(r.qualifies).toBe(true);
    expect(r.warnings.some((w) => w.code === 'TE_FARMER_SPOUSE_INCOME_IGNORED')).toBe(true);
  });

  it('farmer_override = true qualifies without passing either test', () => {
    const r = computeFarmer(couple({ priorYear: null, farmerOverride: true }));
    expect(r.qualifies).toBe(true);
    expect(r.basis).toBe('override');
    expect(r.warnings.some((w) => w.code === 'TE_FARMER_OVERRIDE')).toBe(true);
  });

  it('farmer_override = false disqualifies even when the test passes', () => {
    const r = computeFarmer(couple({ farmerOverride: false }));
    expect(r.qualifies).toBe(false);
    expect(r.basis).toBe('override');
    expect(r.safeHarbor.regime).toBe('regular');
  });

  it('no gross-income data at all → not a farmer, with a warning', () => {
    const r = computeFarmer(couple({ currentYear: null, priorYear: null }));
    expect(r.qualifies).toBe(false);
    expect(r.tests).toHaveLength(0);
    expect(r.warnings.some((w) => w.code === 'TE_FARMER_NO_GROSS_INCOME')).toBe(true);
  });

  it('labels a fisherman', () => {
    expect(computeFarmer(couple({ isFisherman: true })).label).toBe('fisherman');
    expect(computeFarmer(couple()).label).toBe('farmer');
  });
});

describe('qualifying farmer: 66 2/3% rule, single installment, Mar 1 note', () => {
  it('returns the farmer safe-harbor percentages with no high-AGI variant', () => {
    const r = computeFarmer(couple());
    expect(r.safeHarbor).toMatchObject({ regime: 'farmer', currentPct: '0.6666666667', priorPct: '1', priorPctHighAgi: null, highAgiThreshold: null, priorYearRuleAvailable: true, priorYearUnavailableReason: null });
  });

  it('single installment of 100% due farmer.single_due_date; file-and-pay by farmer.file_by_date', () => {
    const r = computeFarmer(couple());
    expect(r.installments).toEqual([{ number: 1, dueDate: '2026-01-15', pct: '1' }]);
    expect(r.fileAndPayByDate).toBe('2026-03-02');
    expect(r.fileAndPayNote).toMatch(/2026-03-02/);
    expect(r.fileAndPayNote).toMatch(/no estimated tax payment is required/i);
  });

  it('required annual payment = lesser of 66 2/3% of current-year tax and 100% of prior-year tax', () => {
    const r = computeFarmer(couple());
    expect(r.requiredAnnualPayment).toMatchObject({ currentYear: '20000', priorYear: '18000', required: '18000', highAgiApplied: false });
    expect(r.exact.requiredAnnualPayment?.currentYear).toBe('20000.000001');
  });

  it('a high prior-year AGI does NOT raise the prior-year percentage for a farmer', () => {
    const r = computeFarmer(couple({ tax: { currentYearTax: '30000', priorYearTax: '18000', priorYearFullTwelveMonths: true, priorYearAgi: '500000' } }));
    expect(r.requiredAnnualPayment?.priorYear).toBe('18000');
    expect(r.requiredAnnualPayment?.highAgiApplied).toBe(false);
  });

  it('prior-year rule unavailable when the prior year was short or showed no tax', () => {
    const short = computeFarmer(couple({ tax: { currentYearTax: '30000', priorYearTax: '18000', priorYearFullTwelveMonths: false, priorYearAgi: null } }));
    expect(short.safeHarbor.priorYearRuleAvailable).toBe(false);
    expect(short.safeHarbor.priorYearUnavailableReason).toBe('short_year');
    expect(short.requiredAnnualPayment).toMatchObject({ priorYear: null, required: '20000' });
    const zero = computeFarmer(couple({ tax: { currentYearTax: '30000', priorYearTax: '0', priorYearFullTwelveMonths: true, priorYearAgi: null } }));
    expect(zero.safeHarbor.priorYearUnavailableReason).toBe('zero_liability');
    expect(zero.requiredAnnualPayment?.required).toBe('20000');
  });

  it('without tax figures the amounts are null but the rule set is complete', () => {
    const r = computeFarmer(couple({ tax: null }));
    expect(r.requiredAnnualPayment).toBeNull();
    expect(r.safeHarbor.regime).toBe('farmer');
    expect(r.installments).toHaveLength(1);
  });

  it('a qualifying farmer reads only farmer.* parameters (no regular-rule keys)', () => {
    const r = computeFarmer(couple());
    const keys = r.parametersUsed.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['farmer.gross_income_ratio', 'farmer.safe_harbor_current_pct', 'farmer.safe_harbor_prior_pct', 'farmer.single_due_date', 'farmer.file_by_date']));
    expect(keys).not.toContain('installments.due_dates');
    expect(keys).not.toContain('safe_harbor.current_pct');
  });
});

describe('non-qualifying farmer falls back to the regular rules (acceptance)', () => {
  const nonFarmer = () => couple({ priorYear: { byPerson: [gross('p1', '100000', '0', '220000'), gross('p2', '0', '0', '60000')] } });

  it('regular safe-harbor percentages, four installments, Jan 31 file-and-pay', () => {
    const r = computeFarmer(nonFarmer());
    expect(r.qualifies).toBe(false);
    expect(r.basis).toBe('none');
    expect(r.safeHarbor).toMatchObject({ regime: 'regular', currentPct: '0.9', priorPct: '1', priorPctHighAgi: '1.1', highAgiThreshold: '150000', priorYearRuleAvailable: true });
    expect(r.installments).toEqual([
      { number: 1, dueDate: '2025-04-15', pct: '0.25' },
      { number: 2, dueDate: '2025-06-16', pct: '0.25' },
      { number: 3, dueDate: '2025-09-15', pct: '0.25' },
      { number: 4, dueDate: '2026-01-15', pct: '0.25' },
    ]);
    expect(r.fileAndPayByDate).toBe('2026-02-02');
    expect(r.requiredAnnualPayment).toMatchObject({ currentYear: '27000', priorYear: '18000', required: '18000', highAgiApplied: false });
  });

  it('applies the 110% rule when prior-year AGI exceeds the threshold (MFS uses the MFS threshold)', () => {
    const r = computeFarmer({ ...nonFarmer(), tax: { currentYearTax: '30000', priorYearTax: '18000', priorYearFullTwelveMonths: true, priorYearAgi: '150001' } });
    expect(r.requiredAnnualPayment).toMatchObject({ priorYear: '19800', required: '19800', highAgiApplied: true });
    const atThreshold = computeFarmer({ ...nonFarmer(), tax: { currentYearTax: '30000', priorYearTax: '18000', priorYearFullTwelveMonths: true, priorYearAgi: '150000' } });
    expect(atThreshold.requiredAnnualPayment?.highAgiApplied).toBe(false);
    const mfs = computeFarmer({ ...nonFarmer(), filingStatus: 'mfs', farmerOverride: false, tax: { currentYearTax: '30000', priorYearTax: '18000', priorYearFullTwelveMonths: true, priorYearAgi: '80000' } });
    expect(mfs.safeHarbor.highAgiThreshold).toBe('75000');
    expect(mfs.requiredAnnualPayment?.highAgiApplied).toBe(true);
  });

  it('rejects mismatched installment date / percentage lists', () => {
    expect(() => computeFarmer({ ...nonFarmer(), parameters: params({ ...SEED_2025, 'installments.pcts': [0.5, 0.5] }) })).toThrow(/TE_INSTALLMENT_LISTS/);
  });

  it('warns once per unverified parameter read (D12a)', () => {
    const r = computeFarmer({ ...nonFarmer(), parameters: params(SEED_2025, 'verified', { 'installments.due_dates': 'unverified' }) });
    expect(r.warnings.filter((w) => w.code === 'TE_PARAM_UNVERIFIED').map((w) => w.details?.['key'])).toEqual(['installments.due_dates']);
  });
});
