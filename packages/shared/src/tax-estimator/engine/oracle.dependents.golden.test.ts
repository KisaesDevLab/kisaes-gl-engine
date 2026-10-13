// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q44 golden test: the engine must match features/tax-estimator/docs/reference-calc/dependents_expected.json,
// produced by dependents_fixture.py (independent Python from Schedule 8812 / Form 2441 / §21 / §24, no
// engine code). Federal parameters are the shipped 2026 seed file read as text (as in the other golden
// tests); the GA / AR state rows use the shipped 2026 `exemptions` seed rows read the same way.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import { computeState, federalFiguresFromResult, EMPTY_GATE_INPUTS } from './state.js';
import { annualizeFederalInput, withFixedDependentCredits } from './sch-ai.js';
import type { StateEngineRow, StateRuleMap } from './state-types.js';
import type { EngineDependent, EngineEntity, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'dependents_expected.json'), 'utf8')) as Record<string, Oracle>;

interface Oracle {
  federal: { agi: number; taxable_income: number; income_tax: number; se_tax: number; qbi: number; addl_medicare: number; niit: number };
  dependents: Array<{ name: string; age: number; ctc: boolean; care: boolean }>;
  credits: Record<string, number>;
  federal_total: number;
  state: { GA: { exemptions: number; net_tax: number }; AR: { exemption_credits: number; net_tax: number } };
}

function loadSeed2026(): ParameterMap {
  const seed = readFileSync(join(repoRoot, 'packages', 'api', 'src', 'db', 'seeds', 'tax-estimator', 'federal', '2026.ts'), 'utf8');
  const rowRe = /key: '([^']+)',\s*value: ([^\n]+?),\s*citation:[\s\S]*?status: '(\w+)'/g;
  const out: Record<string, ParameterMap[string]> = {};
  for (let m = rowRe.exec(seed); m; m = rowRe.exec(seed)) {
    out[m[1]!] = { key: m[1]!, value: JSON.parse(m[2]!.replace(/'/g, '"')) as unknown, status: m[3] as 'verified' | 'unverified' | 'provisional' };
  }
  return out;
}
function exemptionsSeed(state: string, year: number): unknown {
  const seed = readFileSync(join(repoRoot, 'packages', 'api', 'src', 'db', 'seeds', 'tax-estimator', 'state-rules', 'exemptions.ts'), 'utf8');
  const m = new RegExp(`state: '${state}', year: ${year}, key: 'exemptions',\\s*value: (\\{[^\\n]*\\}),`).exec(seed);
  if (!m) throw new Error(`no ${state} ${year} exemptions seed row`);
  return JSON.parse(m[1]!) as unknown;
}
const params = loadSeed2026();

const person = (over: Partial<EnginePerson> & Pick<EnginePerson, 'personId' | 'role'>): EnginePerson => ({
  displayName: over.personId, dateOfBirth: '1984-05-05', isBlind: false, sehiEligibleMonths: Array(12).fill(true) as boolean[], w2Wages: '0', w2SocialSecurityWages: null,
  withholding: '0', retirementPlan: 'none', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' }, ...over,
});
const dependents: EngineDependent[] = [
  { dependentId: 'tobi', displayName: 'Tobi Okafor', dateOfBirth: '2016-03-10', kind: 'qualifying_child', monthsLivedWith: null, isStudent: false, isDisabled: false, firstTaxYear: null, lastTaxYear: null },
  { dependentId: 'zara', displayName: 'Zara Okafor', dateOfBirth: '2011-07-01', kind: 'qualifying_child', monthsLivedWith: null, isStudent: false, isDisabled: false, firstTaxYear: null, lastTaxYear: null },
  { dependentId: 'ike', displayName: 'Ike Okafor', dateOfBirth: '2008-02-20', kind: 'qualifying_child', monthsLivedWith: 12, isStudent: true, isDisabled: false, firstTaxYear: null, lastTaxYear: null },
];
function schC(profit: string): EngineEntity {
  return {
    tenantId: 't', companyId: 'okafor-consulting', companyName: 'Okafor Consulting', entityType: 'sch_c', monthsElapsed: 12, monthsRemaining: 0,
    ytd: characters({ ordinary: profit }), recurringYtd: characters({ ordinary: profit }), ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
    links: [{ linkId: 'l1', personId: 'chidi', profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active', activeParticipation: false, qbiEligible: null, allowedLossOverride: null }],
    isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [],
  };
}
function input(o: { chidiProfit: string; chidiWages: string; adaWages: string; care: string }): FederalEngineInput {
  return {
    taxYear: 2026, filingStatus: 'mfj', parameters: params,
    persons: [person({ personId: 'chidi', role: 'primary', w2Wages: o.chidiWages }), person({ personId: 'ada', role: 'spouse', w2Wages: o.adaWages })],
    dependents,
    entities: o.chidiProfit === '0' ? [] : [schC(o.chidiProfit)], adjustments: [],
    year: { rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' },
      creditsNonrefundable: '0', creditsRefundable: '0', careExpenses: o.care, unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false },
    qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null },
  };
}
const rules = (state: string): StateRuleMap => {
  const entries: Record<string, unknown> = { has_income_tax: true, estimates_required: true, required_threshold: 0, credit_for_other_state: true, nonresident_method: 'ratio', exemptions: exemptionsSeed(state, 2026) };
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { key, value, status: 'unverified' as const }]));
};
const stateRow = (state: string, rate: string): StateEngineRow => ({
  rowId: state, state, residency: 'resident', effectiveRate: rate, base: 'federal_agi', customBase: null, sourcedIncome: null, sourcedManual: false, creditOverride: null, gate: { ...EMPTY_GATE_INPUTS },
});

const SCENARIOS: Array<[string, Parameters<typeof input>[0]]> = [
  ['dependents_phaseout', { chidiProfit: '380000', chidiWages: '0', adaWages: '60000', care: '7000' }],
  ['dependents_low_income', { chidiProfit: '0', chidiWages: '17000', adaWages: '17000', care: '4000' }],
];

describe('Q44 golden — dependents oracle (dependents_fixture.py)', () => {
  for (const [name, inputs] of SCENARIOS) {
    const e = expected[name]!;
    it(`${name}: federal lines, Schedule 8812 / Form 2441 lines and the federal total match the oracle`, () => {
      const r = computeFederal(input(inputs));
      const d = r.dependentCredits;
      expect({ agi: Number(r.agi), taxable_income: Number(r.taxableIncome), income_tax: Number(r.regularTax.tax), se_tax: Number(r.seTax), qbi: Number(r.qbi.deduction), addl_medicare: Number(r.additionalMedicareTax), niit: Number(r.niit) }).toEqual(e.federal);
      expect(d.dependents.map((x) => ({ name: x.displayName.split(' ')[0], age: x.ageAtYearEnd, ctc: x.childTaxCredit, care: x.careQualifying }))).toEqual(e.dependents);
      const c = e.credits;
      expect({
        ctc_children: d.ctcChildren, other_dependents: d.otherDependents, ctc_tentative: Number(d.ctcTentative), odc_tentative: Number(d.odcTentative),
        phaseout_reduction: Number(d.phaseOutReduction), ctc_odc_after_phaseout: Number(d.ctcOdcAfterPhaseOut), care_qualifying: d.careQualifyingPersons,
        care_expense_limit: Number(d.careExpenseLimit), care_allowed_expenses: Number(d.careAllowedExpenses), care_rate: Number(d.careRate),
        care_credit: Number(r.credits.careCredit), ctc_odc_allowed: Number(r.credits.childTaxCredit), earned_income: Number(d.earnedIncome),
        actc_by_children: Number(d.actcByChildren), actc_by_earned_income: Number(d.actcByEarnedIncome), actc: Number(r.credits.additionalChildTaxCredit),
      }).toEqual(c);
      expect(Number(r.federalTotal)).toBe(e.federal_total);
    });

    it(`${name}: GA dependent exemptions and AR exemption credits from the 2026 seed rows match the oracle`, () => {
      const fed = computeFederal(input(inputs));
      const s = computeState({
        taxYear: 2026, filingStatus: 'mfj', parameters: params, federal: federalFiguresFromResult(fed), rows: [stateRow('GA', '0.05')],
        jurisdictions: [{ state: 'GA', rules: rules('GA'), usesFederalFallback: false, verifyBadge: true, estimatesRequired: true }], entities: [], household: { filers: 2, dependents: 3 },
      });
      expect({ exemptions: Number(s.rows[0]!.exemptions), net_tax: Number(s.rows[0]!.netTax) }).toEqual(e.state.GA);
      const a = computeState({
        taxYear: 2026, filingStatus: 'mfj', parameters: params, federal: federalFiguresFromResult(fed), rows: [stateRow('AR', '0.039')],
        jurisdictions: [{ state: 'AR', rules: rules('AR'), usesFederalFallback: false, verifyBadge: true, estimatesRequired: true }], entities: [], household: { filers: 2, dependents: 3 },
      });
      expect({ exemption_credits: Number(a.rows[0]!.exemptionCredits), net_tax: Number(a.rows[0]!.netTax) }).toEqual(e.state.AR);
    });
  }

  it('Schedule AI column (D7 / Q13): the annualized column keeps the FULL-YEAR dependent credits, only the tax limit is re-applied', () => {
    const full = computeFederal(input(SCENARIOS[0]![1]));
    // Q1 column: a quarter of the year's income × 4 = the same income, but with a much lower phase-out MAGI if recomputed —
    // here the column is built from half the profit so a recompute would change the phase-out; the fixed credits must not.
    const half = input({ ...SCENARIOS[0]![1], chidiProfit: '190000', adaWages: '30000' });
    const column = computeFederal(withFixedDependentCredits(annualizeFederalInput(half, '1'), full));
    expect(column.dependentCredits.method).toBe('fixed');
    expect(column.credits.careCredit).toBe(full.credits.careCredit);
    expect(column.dependentCredits.ctcOdcAfterPhaseOut).toBe(full.dependentCredits.ctcOdcAfterPhaseOut);
    const recomputed = computeFederal(half);
    expect(recomputed.dependentCredits.ctcOdcAfterPhaseOut).not.toBe(full.dependentCredits.ctcOdcAfterPhaseOut);
  });
});
