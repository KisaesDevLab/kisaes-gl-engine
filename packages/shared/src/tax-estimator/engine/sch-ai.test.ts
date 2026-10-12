// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10 Schedule AI with a stub federal calculator: annualization of the
// scenario, lines 22–27 (lesser of annualized / regular with recapture), the
// 12/31 column = projection, a missing column falls back to the regular amount,
// Part II SE tax on the prorated wage base. The real-engine column is checked in
// estimates.golden.test.ts against the oracle.

import { describe, it, expect } from 'vitest';
import { EstimateContext } from './estimate-types.js';
import { annualizeFederalInput, computeScheduleAi, type FederalCalculator } from './sch-ai.js';
import { characters } from './income.js';
import type { EngineEntity, EnginePerson, FederalEngineInput, FederalResult, ParameterMap } from './types.js';

const params: ParameterMap = Object.fromEntries(Object.entries({
  'sch_ai.period_ends': ['03-31', '05-31', '08-31', '12-31'], 'sch_ai.annualization_factors': [4, 2.4, 1.5, 1], 'sch_ai.applicable_pcts': [0.225, 0.45, 0.675, 0.9], 'sch_ai.period_months': [3, 5, 8, 12],
  'se.nese_factor': 0.9235, 'se.ss_rate': 0.124, 'se.medicare_rate': 0.029, 'se.ss_wage_base': 184500,
}).map(([key, value]) => [key, { key, value, status: 'verified' as const }]));

const person = (over: Partial<EnginePerson> = {}): EnginePerson => ({ personId: 'p', role: 'primary', displayName: 'P', dateOfBirth: null, isBlind: false, sehiEligibleMonths: Array(12).fill(true) as boolean[], w2Wages: '0', w2SocialSecurityWages: null, withholding: '0', retirementPlan: null, retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' }, ...over });
const entity = (ordinary: string, months: number): EngineEntity => ({
  tenantId: 't', companyId: 'c', companyName: 'C', entityType: 'sch_c', monthsElapsed: months, monthsRemaining: 12 - months,
  ytd: characters({ ordinary }), recurringYtd: characters({ ordinary }), ownerItems: [{ personId: null, sehi: '1200', retirement: '0', sehiAsW2Wages: '0' }], guaranteedPayments: [], officerWages: [{ personId: 'p', amount: '600' }],
  taxDepreciationBookYtd: '-100', links: [{ linkId: 'l', personId: 'p', profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active', activeParticipation: false, qbiEligible: null, allowedLossOverride: null }],
  isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: '5000', ubia: '70000', warnings: [],
});
const input = (ordinary: string, months: number): FederalEngineInput => ({
  taxYear: 2026, filingStatus: 'mfj', parameters: params, persons: [person({ w2Wages: '2400', hsaContribution: '300' })], entities: [entity(ordinary, months)],
  adjustments: [{ id: 'a', label: 'Interest', typeCode: null, kind: 'income', amount: '120', pct: null, personId: null, linkId: null, affectsSe: false, affectsQbi: false, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false, isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false }],
  year: { rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: { saltPaid: '10', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' }, creditsNonrefundable: '500', creditsRefundable: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false },
  qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null },
});

/** Stub engine: tax = 10% of the (projected) Sch C ordinary income; no SE tax; credits ignored. */
const stub: FederalCalculator = (s) => {
  const e = s.entities[0]!;
  const income = e.monthsRemaining > 0 ? String(Number(e.ytd.ordinary) * 12 / e.monthsElapsed) : e.ytd.ordinary;
  const tax = String(Number(income) * 0.1);
  return {
    exact: { agi: income, taxableIncome: income, regularTax: tax, qbi: '0', seTax: '0', additionalMedicareTax: '0', niit: '0', nonrefundableCredits: '0', refundableCredits: '0', federalTotal: tax, totalIncome: income, deduction: '0', sch1a: '0', taxableIncomeBeforeQbi: income },
    persons: [], deductions: { chosen: 'standard', deduction: '0' }, warnings: [],
  } as unknown as FederalResult;
};

describe('annualizeFederalInput', () => {
  it('scales every money flow by the factor, closes the year, leaves credits / UBIA / flags alone', () => {
    const a = annualizeFederalInput(input('2000', 3), '4');
    const e = a.entities[0]!;
    expect(e.monthsElapsed).toBe(12); expect(e.monthsRemaining).toBe(0);
    expect(e.ytd.ordinary).toBe('8000'); expect(e.recurringYtd.ordinary).toBe('8000');
    expect(e.ownerItems[0]!.sehi).toBe('4800'); expect(e.officerWages[0]!.amount).toBe('2400'); expect(e.taxDepreciationBookYtd).toBe('-400'); expect(e.w2WagesEffective).toBe('20000');
    expect(e.ubia).toBe('70000'); expect(e.links).toEqual(input('2000', 3).entities[0]!.links);
    expect(a.persons[0]!.w2Wages).toBe('9600'); expect(a.persons[0]!.hsaContribution).toBe('1200'); expect(a.persons[0]!.sehiEligibleMonths).toHaveLength(12);
    expect(a.adjustments[0]!.amount).toBe('480');
    expect(a.year.itemized.saltPaid).toBe('40'); expect(a.year.creditsNonrefundable).toBe('500');
    expect(a.qbi).toEqual({ manualDeduction: null });
  });
});

describe('computeScheduleAi — lines 22–27 with recapture', () => {
  const ctx = () => new EstimateContext(params, 2026, 'mfj');
  const run = (periods: (FederalEngineInput | null)[], base = input('40000', 12)) =>
    computeScheduleAi({ base, periodActuals: periods, requiredAnnualPayment: '4000', installmentPcts: ['0.25', '0.25', '0.25', '0.25'], calc: stub }, ctx());

  it('seasonal income: early columns use the annualized amount, the regular amount skipped is recaptured later', () => {
    const r = run([input('2000', 3), input('6000', 5), input('30000', 8)]);
    const p = r.periods;
    expect(p.map((x) => x.exact.line22)).toEqual(['180', '648', '3037.5', '3600']);
    expect(p.map((x) => x.exact.line23)).toEqual(['0', '180', '648', '3000']);
    expect(p.map((x) => x.exact.line24)).toEqual(['180', '468', '2389.5', '600']);
    expect(p.map((x) => x.exact.line25)).toEqual(['1000', '1000', '1000', '1000']);
    expect(p.map((x) => x.exact.line26)).toEqual(['1000', '1820', '2352', '1000']);
    expect(p.map((x) => x.exact.line27)).toEqual(['180', '468', '2352', '600']);
    expect(p.map((x) => x.usedAnnualized)).toEqual([true, true, false, true]);
    expect(r.requiredInstallments).toEqual(['180', '468', '2352', '600']);
    expect(r.lowersAnyInstallment).toBe(true);
    expect(p[3]!.isProjection).toBe(true);
    expect(p.map((x) => x.periodEnd)).toEqual(['2026-03-31', '2026-05-31', '2026-08-31', '2026-12-31']);
    expect(p.map((x) => x.factor)).toEqual(['4', '2.4', '1.5', '1']);
    expect(r.assumptions.some((a) => a.startsWith('Q13a'))).toBe(true);
    expect(r.assumptions.some((a) => a.startsWith('Q13b'))).toBe(true);
  });

  it('level income reproduces the regular installments (annualized = projection every column)', () => {
    const r = run([input('10000', 3), input('16666.6666666667', 5), input('26666.6666666667', 8)]);
    // 90% × 4,000 = 3,600 total vs 4 × 1,000 regular: each column's annualized cumulative is below the regular → annualized wins.
    expect(r.periods.map((x) => x.requiredInstallment)).toEqual(['900', '900', '900', '900']);
  });

  it('a missing column falls back to the regular installment (with recapture) and warns', () => {
    const c = ctx();
    const r = computeScheduleAi({ base: input('40000', 12), periodActuals: [null, input('6000', 5), null], requiredAnnualPayment: '4000', installmentPcts: ['0.25', '0.25', '0.25', '0.25'], calc: stub }, c);
    expect(r.periods[0]!.available).toBe(false);
    expect(r.periods[0]!.requiredInstallment).toBe('1000');
    expect(r.periods[1]!.exact.line23).toBe('1000');
    expect(r.periods[2]!.available).toBe(false);
    expect(c.allWarnings().filter((w) => w.code === 'TE_SCH_AI_PERIOD_MISSING')).toHaveLength(2);
  });

  it('reuses a supplied base result for the 12/31 column and rejects mismatched parameter shapes', () => {
    let calls = 0;
    const counting: FederalCalculator = (s) => { calls++; return stub(s); };
    computeScheduleAi({ base: input('40000', 12), baseResult: stub(input('40000', 12)), periodActuals: [null, null, null], requiredAnnualPayment: '4000', installmentPcts: ['0.25', '0.25', '0.25', '0.25'], calc: counting }, ctx());
    expect(calls).toBe(0);
    expect(() => computeScheduleAi({ base: input('40000', 12), periodActuals: [], requiredAnnualPayment: '4000', installmentPcts: ['1'], calc: stub }, ctx())).toThrow(/TE_SCH_AI_SHAPE/);
  });

  it('Part II: period SE income against the prorated wage base, then × factor', () => {
    // Engine stub reports annualized SE income 300,000 for one person (period 8 months → 200,000 actual).
    const withSe: FederalCalculator = (s) => ({ ...stub(s), persons: [{ personId: 'p', seIncome: '300000', totalWages: '0' }], exact: { ...stub(s).exact, seTax: '0' } } as unknown as FederalResult);
    const c = ctx();
    const r = computeScheduleAi({ base: input('40000', 12), periodActuals: [null, null, input('30000', 8)], requiredAnnualPayment: '4000', installmentPcts: ['0.25', '0.25', '0.25', '0.25'], calc: withSe }, c);
    const pii = r.periods[2]!.partIi[0]!;
    expect(pii.periodSeIncome).toBe('200000');
    expect(pii.proratedWageBase).toBe('123000');
    // NESE 184,700 > prorated base 123,000 → SS on 123,000; Medicare on 184,700; × 1.5.
    expect(pii.periodSeTax).toBe(String(123000 * 0.124 + 184700 * 0.029));
    expect(r.periods[2]!.annualizedSeTax).toBe(String(Math.round((123000 * 0.124 + 184700 * 0.029) * 1.5)));
    expect(c.allWarnings().some((w) => w.code === 'TE_SCH_AI_SE_PART2_DIFFERS')).toBe(true);
  });
});
