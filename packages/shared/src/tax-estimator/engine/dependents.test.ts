// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q44: §21 care credit, §24 CTC / ODC / ACTC, age boundaries, ordering, Schedule AI fixed mode,
// EITC / head-of-household warnings. Expected figures are worked by hand from the statute /
// Schedule 8812 / Form 2441 lines (in the test names), not from the engine.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { activeDependents, careRateFor, computeDependentCredits, type DependentCreditsInput, type EarnedIncomePerson } from './dependents.js';
import type { EngineDependent, ParameterMap } from './types.js';
import type { FilingStatus } from '../types.js';
import { withFixedDependentCredits } from './sch-ai.js';

const p = (key: string, value: unknown) => ({ [key]: { key, value, status: 'unverified' as const } });
const COMMON = {
  ...p('ctc.amount', 2200), ...p('ctc.refundable_max', 1700), ...p('ctc.child_age_limit', 17), ...p('ctc.odc_amount', 500),
  ...p('ctc.phaseout_threshold.standard', 200000), ...p('ctc.phaseout_threshold.mfj', 400000), ...p('ctc.phaseout_step', 1000), ...p('ctc.phaseout_reduction', 50),
  ...p('ctc.earned_income_floor', 2500), ...p('ctc.earned_income_rate', 0.15), ...p('ctc.alt_formula_min_children', 3),
  ...p('dependents.qc_age_limit', 19), ...p('dependents.qc_student_age_limit', 24), ...p('dependents.residency_min_months', 7),
  ...p('care.expense_limit.one', 3000), ...p('care.expense_limit.two_plus', 6000), ...p('care.qualifying_age', 13), ...p('care.rate_step', 0.01),
  ...p('care.phase1.start', 15000), ...p('care.phase1.agi_step', 2000),
  ...p('care.phase2.start.standard', 75000), ...p('care.phase2.start.mfj', 150000), ...p('care.phase2.agi_step.standard', 2000), ...p('care.phase2.agi_step.mfj', 4000),
};
const P2025: ParameterMap = {
  ...COMMON, ...p('care.max_rate', 0.35), ...p('care.phase1.min_rate', 0.2), ...p('care.phase2.min_rate', 0.2),
  ...p('eitc.max_agi.standard', [50434, 57310, 61555]), ...p('eitc.max_agi.mfj', [57554, 64430, 68675]),
};
const P2026: ParameterMap = {
  ...COMMON, ...p('care.max_rate', 0.5), ...p('care.phase1.min_rate', 0.35), ...p('care.phase2.min_rate', 0.2),
  ...p('eitc.max_agi.standard', [51593, 58629, 62974]), ...p('eitc.max_agi.mfj', [58863, 65899, 70244]),
};

let n = 0;
const dep = (dateOfBirth: string, extra: Partial<EngineDependent> = {}): EngineDependent => ({
  dependentId: `d${++n}`, displayName: `Kid ${n}`, dateOfBirth, kind: 'qualifying_child', monthsLivedWith: null, isStudent: false, isDisabled: false,
  firstTaxYear: null, lastTaxYear: null, ...extra,
});
const persons = (...earned: string[]): EarnedIncomePerson[] => earned.map((e, i) => ({ personId: `p${i}`, role: i === 0 ? 'primary' : 'spouse', label: i === 0 ? 'Pat' : 'Sam', earned: e }));

function run(over: Partial<DependentCreditsInput> & { year?: number; fs?: FilingStatus } = {}) {
  const year = over.year ?? 2025;
  const fs = over.fs ?? 'mfj';
  const ctx = new EngineContext(year === 2025 ? P2025 : P2026, year, fs);
  const r = computeDependentCredits({
    dependents: [], filingStatus: fs, taxYear: year, agi: '100000', regularTax: '10000', persons: persons('60000', '40000'),
    careExpenses: '0', fixed: null, ...over,
  }, ctx);
  return { r, warnings: ctx.allWarnings(), trace: ctx.trace.rows() };
}
const codes = (w: Array<{ code: string }>) => w.map((x) => x.code);

describe('Q44 child tax credit / credit for other dependents', () => {
  it('two children under 17 and an 18-year-old student: 2 × 2,200 + 1 × 500 = 4,900 against the tax', () => {
    const { r } = run({ dependents: [dep('2015-05-01'), dep('2012-03-03'), dep('2007-06-30', { isStudent: true })] });
    expect(r.ctcChildren).toBe(2);
    expect(r.otherDependents).toBe(1);
    expect(r.ctcOdcAllowed).toBe('4900');
    expect(r.actc).toBe('0');
    expect(r.taxAfterDependentCredits).toBe('5100');
  });

  it('age boundary: born Dec 31, 2008 is 17 on Dec 31, 2025 (other dependent); born Jan 1, 2009 is 16 (child tax credit)', () => {
    const { r } = run({ dependents: [dep('2008-12-31'), dep('2009-01-01')] });
    expect(r.dependents.map((d) => [d.ageAtYearEnd, d.childTaxCredit])).toEqual([[17, false], [16, true]]);
    expect(r.ctcTentative).toBe('2200');
    expect(r.odcTentative).toBe('500');
  });

  it('phase-out: MFJ MAGI 410,500 → ⌈10,500 / 1,000⌉ = 11 × 50 = 550 off 4,400', () => {
    const { r, trace } = run({ agi: '410500', regularTax: '90000', dependents: [dep('2015-01-01'), dep('2016-01-01')] });
    expect(r.phaseOutReduction).toBe('550');
    expect(r.ctcOdcAllowed).toBe('3850');
    expect(trace.some((t) => t.id === 'credits.ctc.phaseout')).toBe(true);
  });

  it('phase-out for single uses the 200,000 threshold; an exact multiple is not rounded up', () => {
    const { r } = run({ fs: 'single', agi: '203000', regularTax: '40000', persons: persons('203000'), dependents: [dep('2015-01-01')] });
    expect(r.phaseOutReduction).toBe('150');
    expect(r.ctcOdcAllowed).toBe('2050');
  });

  it('ACTC limited by earned income: tax 1,000, earned 10,000 → min(3,400 unused, 3,400 cap, 15% × 7,500 = 1,125)', () => {
    const { r } = run({ agi: '10000', regularTax: '1000', persons: persons('10000', '0'), dependents: [dep('2015-01-01'), dep('2016-01-01')] });
    expect(r.ctcOdcAllowed).toBe('1000');
    expect(r.actc).toBe('1125');
  });

  it('ACTC limited by the per-child refundable cap; ODC is never refunded beyond the Schedule 8812 line 16a/16b limits', () => {
    const { r } = run({ agi: '60000', regularTax: '0', persons: persons('60000', '0'), dependents: [dep('2015-01-01'), dep('1960-01-01', { kind: 'qualifying_relative' })] });
    expect(r.ctcOdcAfterPhaseOut).toBe('2700');
    expect(r.actc).toBe('1700');
  });

  it('3+ children with the earned-income figure binding warns that the Part II-B alternative is not modelled', () => {
    const { r, warnings } = run({ agi: '20000', regularTax: '0', persons: persons('20000', '0'), dependents: [dep('2015-01-01'), dep('2016-01-01'), dep('2017-01-01')] });
    expect(r.actc).toBe('2625');
    expect(codes(warnings)).toContain('TE_ACTC_ALT_FORMULA_NOT_MODELLED');
  });

  it('a "qualifying child" over the age test (not a student, not disabled) is an other dependent with a warning', () => {
    const { r, warnings } = run({ dependents: [dep('2004-06-01')] });
    expect(r.ctcChildren).toBe(0);
    expect(r.otherDependents).toBe(1);
    expect(codes(warnings)).toContain('TE_DEPENDENT_QC_AGE');
  });

  it('a child who lived with the taxpayer 6 months fails the residency test (other dependent, warning)', () => {
    const { r, warnings } = run({ dependents: [dep('2015-01-01', { monthsLivedWith: 6 })] });
    expect(r.ctcChildren).toBe(0);
    expect(codes(warnings)).toContain('TE_DEPENDENT_RESIDENCY');
  });

  it('first / last tax year and a birth after the year end drop the dependent', () => {
    const deps = [dep('2015-01-01', { lastTaxYear: 2024 }), dep('2015-01-01', { firstTaxYear: 2026 }), dep('2026-02-01'), dep('2025-12-31')];
    expect(activeDependents(deps, 2025).map((d) => d.dateOfBirth)).toEqual(['2025-12-31']);
  });

  it('no dependents and no care expenses: method none, no parameter read', () => {
    const ctx = new EngineContext(P2025, 2025, 'mfj');
    const r = computeDependentCredits({ dependents: [], filingStatus: 'mfj', taxYear: 2025, agi: '1', regularTax: '5', persons: [], careExpenses: '0', fixed: null }, ctx);
    expect(r.method).toBe('none');
    expect(ctx.params.used()).toEqual([]);
  });
});

describe('Q44 child and dependent care credit', () => {
  it('2025: one child, expenses 5,000, AGI 40,000 → 3,000 × (35% − ⌈25,000 / 2,000⌉ = 13 points → 22%) = 660', () => {
    const { r } = run({ fs: 'single', agi: '40000', regularTax: '3000', persons: persons('40000'), careExpenses: '5000', dependents: [dep('2018-01-01')] });
    expect(r.careRate).toBe('0.22');
    expect(r.careAllowed).toBe('660');
  });

  it('2025: AGI above 43,000 bottoms at 20%; the second phase does nothing in 2025 (floors equal)', () => {
    const ctx = new EngineContext(P2025, 2025, 'mfj');
    expect(careRateFor('200000', ctx, [])).toBe('0.2');
  });

  it('2026 (OBBBA): MFJ AGI 160,000, two children, expenses 8,000 → 6,000 × (50% → 35% floor, then ⌈10,000 / 4,000⌉ = 3 points → 32%) = 1,920', () => {
    const { r } = run({ year: 2026, agi: '160000', regularTax: '20000', persons: persons('80000', '80000'), careExpenses: '8000', dependents: [dep('2018-01-01'), dep('2020-01-01')] });
    expect(r.careExpenseLimit).toBe('6000');
    expect(r.careRate).toBe('0.32');
    expect(r.careAllowed).toBe('1920');
  });

  it('2026: single AGI 30,000 → 50% − ⌈15,000 / 2,000⌉ = 8 points = 42%', () => {
    const ctx = new EngineContext(P2026, 2026, 'single');
    expect(careRateFor('30000', ctx, [])).toBe('0.42');
  });

  it('expenses limited to the lower-earning spouse (MFJ)', () => {
    const { r } = run({ agi: '100000', persons: persons('98000', '2000'), careExpenses: '3000', dependents: [dep('2018-01-01')] });
    expect(r.careEarnedIncomeLimit).toBe('2000');
    expect(r.careAllowedExpenses).toBe('2000');
  });

  it('a child turning 13 during the year counts (info); born Jan 1 (13 on Jan 1) does not; a disabled 30-year-old counts', () => {
    const turns = run({ careExpenses: '1000', dependents: [dep('2012-06-01')] });
    expect(turns.r.careQualifyingPersons).toBe(1);
    expect(codes(turns.warnings)).toContain('TE_CARE_CHILD_TURNS_13');
    expect(run({ careExpenses: '1000', dependents: [dep('2012-01-01')] }).r.careQualifyingPersons).toBe(0);
    expect(run({ careExpenses: '1000', dependents: [dep('1995-01-01', { kind: 'qualifying_relative', isDisabled: true })] }).r.careQualifyingPersons).toBe(1);
  });

  it('MFS gets no care credit (warning); expenses without a qualifying person warn', () => {
    expect(codes(run({ fs: 'mfs', careExpenses: '3000', dependents: [dep('2018-01-01')] }).warnings)).toContain('TE_CARE_CREDIT_MFS');
    expect(codes(run({ careExpenses: '3000', dependents: [dep('2005-01-01', { isStudent: true })] }).warnings)).toContain('TE_CARE_NO_QUALIFYING_PERSON');
  });

  it('order: care first, then CTC / ODC, limited by the regular tax', () => {
    const { r } = run({ agi: '50000', regularTax: '2500', careExpenses: '3000', persons: persons('30000', '20000'), dependents: [dep('2018-01-01')] });
    // care 3,000 × (35 − ⌈35,000/2,000⌉ = 18 → 20% floor) = 600; CTC min(2,200, 2,500 − 600 = 1,900); ACTC min(300, 1,700, 15% × 47,500)
    expect(r.careAllowed).toBe('600');
    expect(r.ctcOdcAllowed).toBe('1900');
    expect(r.actc).toBe('300');
    expect(r.taxAfterDependentCredits).toBe('0');
  });
});

describe('Q44 warnings and Schedule AI fixed mode', () => {
  it('EITC: AGI under the 2-child MFJ ceiling with two qualifying children warns; head of household hint for single', () => {
    expect(codes(run({ agi: '50000', dependents: [dep('2015-01-01'), dep('2016-01-01')] }).warnings)).toContain('TE_EITC_NOT_COMPUTED');
    expect(codes(run({ agi: '70000', dependents: [dep('2015-01-01'), dep('2016-01-01')] }).warnings)).not.toContain('TE_EITC_NOT_COMPUTED');
    expect(codes(run({ fs: 'single', persons: persons('90000'), dependents: [dep('2015-01-01')] }).warnings)).toContain('TE_HOH_MAY_APPLY');
  });

  it('fixed (annualized column): full-year amounts, only the tax limit re-applied, nothing recomputed', () => {
    const ctx = new EngineContext(P2025, 2025, 'mfj');
    const r = computeDependentCredits({ dependents: [dep('2015-01-01')], filingStatus: 'mfj', taxYear: 2025, agi: '900000', regularTax: '1500', persons: [], careExpenses: '0', fixed: { care: '600', ctcOdc: '4400', actc: '0' } }, ctx);
    expect(r.method).toBe('fixed');
    expect(r.careAllowed).toBe('600');
    expect(r.ctcOdcAllowed).toBe('900');
    expect(ctx.params.used()).toEqual([]);
  });

  it('withFixedDependentCredits leaves a no-dependent scenario untouched', () => {
    const scenario = { year: { creditsNonrefundable: '0' } } as unknown as Parameters<typeof withFixedDependentCredits>[0];
    const none = { dependentCredits: { method: 'none' } } as unknown as Parameters<typeof withFixedDependentCredits>[1];
    expect(withFixedDependentCredits(scenario, none)).toBe(scenario);
  });
});
