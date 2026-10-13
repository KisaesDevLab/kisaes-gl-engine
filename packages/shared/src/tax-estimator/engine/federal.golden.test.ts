// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Golden test (MODULE.md "Tests"): the engine must match
// features/tax-estimator/docs/reference-calc/rivera_expected.json, produced by
// rivera_fixture.py, for every federal line through the federal total. Since
// Phase 7 the §199A deduction, Additional Medicare / NIIT (both 0 for Rivera)
// and the loss limitations are computed by the engine — no fixture-fed stubs.
// Parameters are the 2026 federal seed values; a guard below checks them
// against the seed file so the test cannot drift from what ships.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { TAX_ENGINE_VERSION } from './version.js';
import { characters } from './income.js';
import { dAdd, dDiv, dMul, dSub, dSum } from '../decimal.js';
import type { EngineAdjustment, EngineEntity, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'rivera_expected.json'), 'utf8')) as Record<string, Record<string, number | string>>;

// 2026 federal seed values the Rivera computation reads (statuses as seeded; the age keys are the Phase 6 additions, unverified).
const SEED_2026: Record<string, { value: unknown; status: 'verified' | 'unverified' | 'provisional' }> = {
  'se.nese_factor': { value: 0.9235, status: 'verified' },
  'se.min_nese': { value: 400, status: 'verified' },
  'se.ss_rate': { value: 0.124, status: 'verified' },
  'se.medicare_rate': { value: 0.029, status: 'verified' },
  'se.ss_wage_base': { value: 184500, status: 'verified' },
  'se.deduction_factor': { value: 0.5, status: 'verified' },
  'brackets.mfj': { value: [[24800, 0.1], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [null, 0.37]], status: 'verified' },
  'ltcg.breakpoints.mfj': { value: [98900, 613700], status: 'verified' },
  'ltcg.rates': { value: [0, 0.15, 0.2], status: 'verified' },
  'collectibles_rate': { value: 0.28, status: 'verified' },
  'unrecaptured_1250_rate': { value: 0.25, status: 'verified' },
  'std_deduction.mfj': { value: 32200, status: 'verified' },
  'std_deduction.additional_65_blind.married': { value: 1650, status: 'verified' },
  'std_deduction.additional_age': { value: 65, status: 'unverified' },
  'salt.cap.standard': { value: 40400, status: 'verified' },
  'salt.phase_down.threshold.standard': { value: 505000, status: 'verified' },
  'salt.phase_down.rate': { value: 0.3, status: 'verified' },
  'salt.floor.standard': { value: 10000, status: 'verified' },
  'charity.agi_floor_pct': { value: 0.005, status: 'verified' },
  'charity.nonitemizer.mfj': { value: 2000, status: 'verified' },
  'itemized.benefit_cap_rate': { value: 0.35, status: 'unverified' },
  'sch1a.senior.amount': { value: 6000, status: 'verified' },
  'sch1a.senior.age': { value: 65, status: 'unverified' },
  'sch1a.senior.phaseout_threshold.mfj': { value: 150000, status: 'verified' },
  'sch1a.senior.phaseout_rate': { value: 0.06, status: 'verified' },
  'sch1a.tips.max': { value: 25000, status: 'verified' },
  'sch1a.tips.phaseout_threshold.mfj': { value: 300000, status: 'verified' },
  'sch1a.tips.phaseout_rate': { value: 0.1, status: 'verified' },
  'sch1a.overtime.max.mfj': { value: 25000, status: 'verified' },
  'sch1a.overtime.phaseout_threshold.mfj': { value: 300000, status: 'verified' },
  'sch1a.overtime.phaseout_rate': { value: 0.1, status: 'verified' },
  'sch1a.car_interest.max': { value: 10000, status: 'verified' },
  'sch1a.car_interest.phaseout_threshold.mfj': { value: 200000, status: 'verified' },
  'sch1a.car_interest.phaseout_rate': { value: 0.2, status: 'verified' },
  'sch1a.phaseout_step': { value: 1000, status: 'unverified' },
  'sch1a.first_year': { value: 2025, status: 'verified' },
  'sch1a.last_year': { value: 2028, status: 'verified' },
  'qbi.rate': { value: 0.2, status: 'verified' },
  'qbi.threshold.mfj': { value: 403500, status: 'verified' },
  'qbi.phase_in_range.mfj': { value: 150000, status: 'verified' },
  'qbi.w2_wage_pct': { value: 0.5, status: 'verified' },
  'qbi.alt_w2_wage_pct': { value: 0.25, status: 'verified' },
  'qbi.ubia_pct': { value: 0.025, status: 'verified' },
  'qbi.taxable_income_limit_pct': { value: 0.2, status: 'verified' },
  'qbi.min_deduction_amount': { value: 400, status: 'verified' },
  'qbi.min_deduction_active_qbi_threshold': { value: 1000, status: 'verified' },
  'addl_medicare.rate': { value: 0.009, status: 'verified' },
  'addl_medicare.threshold.mfj': { value: 250000, status: 'verified' },
  'niit.rate': { value: 0.038, status: 'verified' },
  'niit.threshold.mfj': { value: 250000, status: 'verified' },
  'ebl.threshold.mfj': { value: 512000, status: 'verified' },
  'passive.rental_allowance.standard': { value: 25000, status: 'verified' },
  'passive.rental_allowance_phaseout_start.standard': { value: 100000, status: 'verified' },
  'passive.rental_allowance_phaseout_end.standard': { value: 150000, status: 'verified' },
  'retirement.sep.pct_of_comp': { value: 0.25, status: 'verified' },
  'retirement.sep.dollar_limit': { value: 72000, status: 'verified' },
  'retirement.comp_limit': { value: 360000, status: 'verified' },
  'capital_loss.limit.standard': { value: 3000, status: 'unverified' },
};
const params: ParameterMap = Object.fromEntries(Object.entries(SEED_2026).map(([key, v]) => [key, { key, value: v.value, status: v.status }]));

const CARLOS = 'carlos'; const MARIA = 'maria';
const allMonths = (): boolean[] => Array(12).fill(true);
const persons = (): EnginePerson[] => [
  { personId: CARLOS, role: 'primary', displayName: 'Carlos Rivera', dateOfBirth: '1981-05-10', isBlind: false, sehiEligibleMonths: allMonths(), w2Wages: '0', w2SocialSecurityWages: null, withholding: '0', retirementPlan: 'sep', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' } },
  { personId: MARIA, role: 'spouse', displayName: 'Maria Rivera', dateOfBirth: '1983-09-22', isBlind: false, sehiEligibleMonths: allMonths(), w2Wages: '0', w2SocialSecurityWages: null, withholding: '6000', retirementPlan: 'none', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' } },
];

interface Scenario { schcTaxProfit: string; scorpOrdinary: string; mariaWages: string; lpRental: string; interest: string; sep: string; sehi: string }
// Maria owns 50% of the S corp: the oracle's K-1 of 40,000 is half of an 80,000 entity profit, and the raise
// scenario reduces her K-1 by half of (raise + employer FICA).
const BASE: Scenario = { schcTaxProfit: '128000', scorpOrdinary: '80000', mariaWages: '54000', lpRental: '8000', interest: '2400', sep: '15000', sehi: '10800' };
const MARIA_SCORP_PCT = 50;

const entityBase = (over: Partial<EngineEntity>): EngineEntity => ({
  tenantId: 'tenant-rivera', companyId: 'c', companyName: 'Co', entityType: 'sch_c', monthsElapsed: 12, monthsRemaining: 0,
  ytd: characters({}), recurringYtd: characters({}), ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
  links: [], isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [], ...over,
});
const linkBase = { profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active' as const, activeParticipation: false, qbiEligible: null, allowedLossOverride: null };
const adjBase: EngineAdjustment = { id: '', label: '', typeCode: null, kind: 'income', amount: '0', pct: null, personId: null, linkId: null, affectsSe: false, affectsQbi: false, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false, isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false };

/** Rivera books after the treatment map (Phase 4 reproduces 115,400 → 128,000 for the Sch C). */
function riveraInput(s: Scenario, qbiManual: string | null = null): FederalEngineInput {
  return {
    taxYear: 2026,
    filingStatus: 'mfj',
    parameters: params,
    persons: persons(),
    entities: [
      entityBase({ companyId: 'schc', companyName: 'Rivera Plumbing (Sch C)', entityType: 'sch_c', ytd: characters({ ordinary: s.schcTaxProfit }), recurringYtd: characters({ ordinary: s.schcTaxProfit }),
        ownerItems: [{ personId: null, sehi: s.sehi, retirement: '0', sehiAsW2Wages: '0' }], links: [{ ...linkBase, linkId: 'l-schc', personId: CARLOS }] }),
      entityBase({ companyId: 'scorp', companyName: 'Maria Designs Inc (S corp)', entityType: 's_corp', ytd: characters({ ordinary: s.scorpOrdinary }), recurringYtd: characters({ ordinary: s.scorpOrdinary }),
        officerWages: [{ personId: MARIA, amount: s.mariaWages }], links: [{ ...linkBase, linkId: 'l-scorp', personId: MARIA, isOfficer: true, profitPct: MARIA_SCORP_PCT }] }),
      entityBase({ companyId: 'lp', companyName: 'Oak Street Rentals LP', entityType: 'partnership', ytd: characters({ rental: s.lpRental }), recurringYtd: characters({ rental: s.lpRental }),
        links: [{ ...linkBase, linkId: 'l-lp', personId: CARLOS, partnerSeStatus: 'limited', activityType: 'rental' }] }),
    ],
    adjustments: [
      { ...adjBase, id: 'interest', label: 'Interest income', typeCode: 'interest_income', kind: 'income', amount: s.interest },
      { ...adjBase, id: 'sep', label: 'SEP contribution', typeCode: 'sep_solo_401k', kind: 'deduction', amount: s.sep, isAboveTheLine: true, personId: CARLOS },
    ],
    year: {
      rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto',
      itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' },
      creditsNonrefundable: '2200', creditsRefundable: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false,
    },
    qbi: { manualDeduction: qbiManual },
    otherTaxes: { additionalMedicareTax: null, niit: null },
  };
}

function run(s: Scenario) {
  return computeFederal(riveraInput(s));
}

function expectFederalLines(r: ReturnType<typeof computeFederal>, e: Record<string, number | string>) {
  const carlos = r.persons.find((p) => p.personId === CARLOS)!;
  const got = {
    sch_c_tax_profit: Number(r.entities[0]!.projectedProfit), total_income: Number(r.income.totalIncome), se_tax: Number(r.seTax), half_se: Number(r.adjustmentsToIncome.halfSeTax),
    sep_deducted: Number(carlos.retirement.deducted), sep_limit: Number(carlos.retirement.limit), sehi: Number(r.adjustmentsToIncome.sehi), agi: Number(r.agi),
    std_deduction: Number(r.deductions.deduction), qbi: Number(r.qbi.deduction), taxable_income: Number(r.taxableIncome), income_tax_brackets: Number(r.regularTax.tax),
    credits_nonrefundable: Number(r.credits.nonrefundableAllowed), addl_medicare: Number(r.additionalMedicareTax), niit: Number(r.niit), federal_total: Number(r.federalTotal),
  };
  const want = Object.fromEntries(Object.keys(got).map((k) => [k, e[k]]));
  expect(got).toEqual(want);
}

describe('Rivera golden (rivera_expected.json)', () => {
  it('base scenario matches every federal line through the federal total', () => {
    const r = run(BASE);
    expectFederalLines(r, expected['base']!);
    expect(r.deductions.chosen).toBe('standard');
    expect(r.regularTax.method).toBe('brackets');
    expect(r.regularTax.marginalOrdinaryRate).toBe('0.22');
    expect(r.regularTax.worksheet).toBeNull();
    expect(r.persons.find((p) => p.personId === MARIA)!.totalWages).toBe('54000');
    expect(r.persons.find((p) => p.personId === MARIA)!.seIncome).toBe('0');
    expect(r.income.rental).toBe('8000');
    // §199A computed by the engine: Sch C after ½ SE / SEHI / SEP + Maria's S corp K-1; LP rental is not a trade or business.
    expect(r.qbi.method).toBe('computed');
    expect(r.qbi.taxableIncomeBeforeQbi).toBe('165357');
    expect(r.qbi.phaseInFraction).toBe('0');
    const schc = r.qbi.components.find((c) => c.linkId === 'l-schc')!;
    expect(schc.attributableDeductions).toBe(String(Number(r.adjustmentsToIncome.halfSeTax) + 10800 + 15000));
    expect(schc.component).toBe('18631');
    expect(r.qbi.components.find((c) => c.linkId === 'l-scorp')!.component).toBe('8000');
    const lp = r.qbi.components.find((c) => c.linkId === 'l-lp')!;
    expect(lp.eligible).toBe(false);
    expect(lp.reason).toMatch(/rental/);
    expect(r.qbi.overallLimit).toBe('33071');
    expect(r.qbi.minimumApplied).toBe(false);
    expect(r.warnings.some((w) => w.code === 'TE_QBI_UBIA_MISSING')).toBe(false);
  });

  it('truck scenario: SEP capped at 12,639 with a warning', () => {
    const r = run({ ...BASE, schcTaxProfit: '68000' });
    expectFederalLines(r, expected['truck']!);
    const carlos = r.persons.find((p) => p.personId === CARLOS)!;
    expect(carlos.retirement.capped).toBe(true);
    expect(carlos.retirement.limit).toBe('12639');
    expect(carlos.retirement.deducted).toBe('12639');
    const w = r.warnings.find((x) => x.code === 'TE_RETIREMENT_CAPPED')!;
    expect(w).toBeDefined();
    expect(w.message).toContain('12639');
    expect(r.trace.find((t) => t.id === `retirement.${CARLOS}`)!.label).toMatch(/capped/);
  });

  it("raise scenario (Maria's wages 72,000; S corp profit down by the raise + employer FICA)", () => {
    const extra = '18000'; const fica = dMul(extra, '0.0765');
    const r = run({ ...BASE, mariaWages: '72000', scorpOrdinary: dSub(BASE.scorpOrdinary, dAdd(extra, fica)) });
    expectFederalLines(r, expected['raise']!);
    expect(r.income.wages).toBe('72000');
  });

  it('total = base − truck delta and raise delta as in the oracle', () => {
    const base = run(BASE); const truck = run({ ...BASE, schcTaxProfit: '68000' });
    // Oracle deltas are on the grand total incl. states (Phase 8); the federal part of the delta is checked here.
    expect(Number(base.federalTotal) - Number(truck.federalTotal)).toBe(Number(expected['base']!['federal_total']) - Number(expected['truck']!['federal_total']));
  });

  it('D12a: every unverified parameter the calc read is warned once, and nothing else is flagged', () => {
    const r = run(BASE);
    const flagged = r.warnings.filter((w) => w.code === 'TE_PARAM_UNVERIFIED').map((w) => w.details!['key']);
    const expectedUnverified = r.parametersUsed.filter((u) => u.status !== 'verified').map((u) => u.key);
    expect(flagged.sort()).toEqual([...expectedUnverified].sort());
    expect(expectedUnverified).toEqual(expect.arrayContaining(['std_deduction.additional_age', 'sch1a.senior.age']));
    expect(flagged).not.toContain('retirement.catch_up_age');
  });

  it('trace carries a row for every federal step computed in Phase 6 with rounded amounts', () => {
    const r = run(BASE);
    const steps = new Set(r.trace.map((t) => t.step));
    for (const s of ['entity_income', 'allocation', 'se_tax', 'owner_limits', 'agi', 'deductions', 'qbi', 'taxable_income', 'regular_tax', 'credits', 'other_taxes', 'federal_total'] as const) expect(steps.has(s)).toBe(true);
    for (const t of r.trace) expect(t.amount).toMatch(/^-?\d+$/);
    expect(r.trace.find((t) => t.id === 'regular_tax')!.marginalRate).toBe('0.22');
    expect(r.trace.find((t) => t.id === 'federal_total')!.amount).toBe(String(expected['base']!['federal_total']));
  });

  it('QA D7: regular tax carries one trace-only row per bracket reached; they add up to the regular tax exactly', () => {
    const r = run(BASE);
    const rows = r.trace.filter((t) => t.id.startsWith('regular_tax.bracket.'));
    expect(rows.map((t) => t.id)).toEqual(['regular_tax.bracket.1', 'regular_tax.bracket.2', 'regular_tax.bracket.3']);
    expect(rows.map((t) => t.marginalRate)).toEqual(['0.1', '0.12', '0.22']);
    for (const t of rows) expect(t).toMatchObject({ step: 'regular_tax', source: 'parameter' });
    expect(dSum(rows.map((t) => t.exact))).toBe(r.trace.find((t) => t.id === 'regular_tax')!.exact);
    // Trace only: the federal total is still the oracle's.
    expect(r.trace.find((t) => t.id === 'federal_total')!.amount).toBe(String(expected['base']!['federal_total']));
  });

  it('Phase 7: Additional Medicare and NIIT are computed (0 for Rivera), loss limits applied, no stub warnings', () => {
    const r = run(BASE);
    expect(r.additionalMedicareTax).toBe('0');
    expect(r.niit).toBe('0');
    expect(r.otherTaxes.additionalMedicare.method).toBe('computed');
    expect(r.otherTaxes.additionalMedicare.medicareWages).toBe('54000');
    expect(r.otherTaxes.additionalMedicare.nese).toBe('118208');
    // NII = interest + the LP rental (passive K-1); MAGI is under the threshold.
    expect(r.otherTaxes.niit.interest).toBe('2400');
    expect(r.otherTaxes.niit.rental).toBe('8000');
    expect(r.otherTaxes.niit.netInvestmentIncome).toBe('10400');
    expect(r.otherTaxes.niit.base).toBe('0');
    expect(r.lossLimitations.applied).toBe(true);
    expect(r.lossLimitations.suspendedPassiveLoss).toBe('0');
    expect(r.lossLimitations.excessBusinessLoss).toBe('0');
    expect(r.lossLimitations.shares).toHaveLength(3);
    for (const code of ['TE_OTHER_TAXES_STUB', 'TE_QBI_STUB', 'TE_LOSS_LIMITS_NOT_APPLIED']) expect(r.warnings.some((w) => w.code === code)).toBe(false);
  });

  it('Phase 7: Additional Medicare and NIIT apply when Maria earns 280,000 (threshold used by wages first; NII = interest + LP rental)', () => {
    const r = run({ ...BASE, mariaWages: '280000' });
    const nese = r.trace.find((t) => t.id === `nese.${CARLOS}`)!.exact;
    expect(r.additionalMedicareTax).toBe(String(Math.round(0.009 * (280000 + Number(nese) - 250000))));
    expect(r.otherTaxes.additionalMedicare.wagesAboveThreshold).toBe('30000');
    expect(r.otherTaxes.additionalMedicare.neseAboveThreshold).toBe(nese);
    expect(r.niit).toBe(String(Math.round(0.038 * 10400)));
    expect(r.otherTaxes.niit.base).toBe('10400');
    expect(Number(r.federalTotal)).toBe(Number(r.regularTax.tax) - Number(r.credits.nonrefundableAllowed) + Number(r.seTax) + Number(r.additionalMedicareTax) + Number(r.niit));
  });

  it('Phase 7: an LP rental loss with active participation — MAGI is probed without the passive loss (§469(i), D10)', () => {
    const lossy = (s: Scenario): FederalEngineInput => {
      const input = riveraInput(s);
      const lp = input.entities[2]!;
      lp.ytd = characters({ rental: '-30000' }); lp.recurringYtd = characters({ rental: '-30000' });
      lp.links[0]!.activeParticipation = true;
      return input;
    };
    // Base books: MAGI without the passive loss ≈ 189,557 ≥ 150,000 → allowance fully phased out, whole loss suspended.
    const high = computeFederal(lossy(BASE));
    expect(high.lossLimitations.rentalAllowance.variant).toBe('standard');
    expect(high.lossLimitations.rentalAllowance.magi).toBe(String(Number(expected['base']!['agi']) - 8000));
    expect(high.lossLimitations.rentalAllowance.afterPhaseOut).toBe('0');
    expect(high.lossLimitations.suspendedPassiveLoss).toBe('30000');
    expect(high.income.rental).toBe('0');
    expect(high.agi).toBe(high.lossLimitations.rentalAllowance.magi);
    expect(high.warnings.some((w) => w.code === 'TE_PASSIVE_LOSS_SUSPENDED')).toBe(true);
    expect(high.trace.filter((t) => t.id === 'agi')).toHaveLength(1);
    // Truck books and no wages for Maria: MAGI ≈ 82,157 < 100,000 → the full 25,000 is allowed, 5,000 suspended.
    const low = computeFederal(lossy({ ...BASE, schcTaxProfit: '68000', mariaWages: '0' }));
    expect(Number(low.lossLimitations.rentalAllowance.magi)).toBeLessThan(100000);
    expect(low.lossLimitations.rentalAllowance.used).toBe('25000');
    expect(low.lossLimitations.suspendedPassiveLoss).toBe('5000');
    expect(low.income.rental).toBe('-25000');
    expect(Number(low.agi)).toBe(Number(low.lossLimitations.rentalAllowance.magi) - 25000);
    expect(low.otherTaxes.niit.rental).toBe('-25000');
    expect(low.lossLimitations.shares.find((s) => s.linkId === 'l-lp')!.passiveSuspended).toBe('5000');
  });

  it('Phase 7: a manual §199A override wins and keeps the computed figure for comparison', () => {
    const r = computeFederal(riveraInput(BASE, '20000'));
    expect(r.qbi.method).toBe('manual');
    expect(r.qbi.deduction).toBe('20000');
    expect(r.qbi.computedDeduction).toBe(String(expected['base']!['qbi']));
    expect(r.warnings.some((w) => w.code === 'TE_QBI_MANUAL_OVERRIDE')).toBe(true);
  });

  it('effective-rate override replaces the brackets and is labelled', () => {
    const input = riveraInput(BASE);
    input.year = { ...input.year, rateMode: 'effective', effectiveRateOverride: '0.15' };
    const r = computeFederal(input);
    expect(r.regularTax.method).toBe('effective');
    expect(r.regularTax.tax).toBe(String(Math.round(Number(r.exact.taxableIncome) * 0.15)));
    expect(r.warnings.some((w) => w.code === 'TE_EFFECTIVE_RATE_OVERRIDE')).toBe(true);
    expect(r.trace.find((t) => t.id === 'regular_tax')!.label).toMatch(/EFFECTIVE-RATE OVERRIDE/);
  });

  it('SEHI eligibility: months flagged false are excluded (true = deductible)', () => {
    const input = riveraInput(BASE);
    const months = allMonths(); months[0] = false; months[1] = false; months[2] = false;
    input.persons[0]!.sehiEligibleMonths = months;
    const r = computeFederal(input);
    const carlos = r.persons.find((p) => p.personId === CARLOS)!;
    expect(carlos.sehi.eligibleMonths).toBe(9);
    expect(carlos.sehi.deducted).toBe('8100');
    expect(r.adjustmentsToIncome.sehi).toBe('8100');
    expect(Number(r.agi)).toBe(Number(expected['base']!['agi']) + 2700);
  });

  it('a partial year projects to the same full-year figures when income is level (8 closed months) and reproduces the oracle Schedule AI period-3 column', () => {
    const input = riveraInput(BASE);
    for (const e of input.entities) {
      e.monthsElapsed = 8; e.monthsRemaining = 4;
      const scale = (v: string) => dDiv(dMul(v, '8'), '12');
      e.ytd = { ...e.ytd, ordinary: scale(e.ytd.ordinary), rental: scale(e.ytd.rental) };
      e.recurringYtd = { ...e.ytd };
      e.ownerItems = e.ownerItems.map((o) => ({ ...o, sehi: scale(o.sehi) }));
      e.officerWages = e.officerWages.map((w) => ({ ...w, amount: scale(w.amount) }));
    }
    const r = computeFederal(input);
    expectFederalLines(r, expected['base']!);
    // Oracle's fourth scenario: with level income the Schedule AI period-3 (Jan–Aug, ×1.5) column equals the full-year
    // figures. The engine's 8-month run-rate projection is the same arithmetic; the true Schedule AI (Phase 10) differs
    // only in the prorated SE wage base, which Rivera does not reach.
    const ai = expected['schedule_ai_period3']!;
    expect(Number(r.agi)).toBe(ai['annualized_agi']);
    expect(Number(r.qbi.deduction)).toBe(ai['annualized_qbi']);
    expect(Number(r.taxableIncome)).toBe(ai['annualized_taxable_income']);
    expect(Number(r.regularTax.tax)).toBe(ai['annualized_income_tax']);
    expect(Number(r.seTax)).toBe(ai['annualized_se_tax']);
    expect(Number(r.federalTotal)).toBe(ai['annualized_total_tax']);
  });

  it('R2-04: the result carries the engine version, which was bumped past the Phase 6 string', () => {
    const r = run(BASE);
    expect(r.engineVersion).toBe(TAX_ENGINE_VERSION);
    expect(TAX_ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    expect(TAX_ENGINE_VERSION).not.toBe('0.6.0');
    expect(TAX_ENGINE_VERSION).toBe('1.0.0-rc.4');
  });

  it('R2-11: a standard-deduction return with no itemized inputs does not read the itemized parameters', () => {
    const r = run(BASE);
    const keys = r.parametersUsed.map((u) => u.key);
    expect(keys).not.toContain('itemized.benefit_cap_rate');
    expect(keys).not.toContain('salt.cap.standard');
    expect(r.deductions.itemized.total).toBe('0');
    expect(r.deductions.chosen).toBe('standard');
  });

  it('R2-22: outside W-2 wages without Social Security wages default to box 1 with an info when the person has SE income', () => {
    const input = riveraInput(BASE);
    input.persons[0]!.w2Wages = '30000';
    const r = computeFederal(input);
    expect(r.warnings.some((w) => w.code === 'TE_SS_WAGES_DEFAULTED' && w.details?.['personId'] === CARLOS)).toBe(true);
    expect(run(BASE).warnings.some((w) => w.code === 'TE_SS_WAGES_DEFAULTED')).toBe(false);
  });

  it('the embedded parameter values equal the shipped 2026 seed file', () => {
    const seed = readFileSync(join(repoRoot, 'packages', 'api', 'src', 'db', 'seeds', 'tax-estimator', 'federal', '2026.ts'), 'utf8');
    const rowRe = /key: '([^']+)',\s*value: ([^\n]+?),\s*citation:[\s\S]*?status: '(\w+)'/g;
    const fromSeed = new Map<string, { value: unknown; status: string }>();
    for (let m = rowRe.exec(seed); m; m = rowRe.exec(seed)) {
      if (!(m[1]! in SEED_2026)) continue;
      fromSeed.set(m[1]!, { value: JSON.parse(m[2]!.replace(/'/g, '"')), status: m[3]! });
    }
    const mismatches = Object.entries(SEED_2026).filter(([k, v]) => JSON.stringify(fromSeed.get(k)) !== JSON.stringify({ value: v.value, status: v.status })).map(([k]) => k);
    expect(mismatches).toEqual([]);
    expect(dSum(['1', '1'])).toBe('2');
  });
});
