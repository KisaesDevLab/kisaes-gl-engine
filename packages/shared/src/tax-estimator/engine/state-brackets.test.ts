// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q53 state rate schedules: MO / AR examples from the official instructions, flat and graduated
// states, filing-status mapping, standard deduction + exemptions order, starting points, the
// effective fallback, nonresident ratio vs sourced × rate vs prorated, the other-state credit
// limit, capital gains (exclusion / alternative / separate / surtax), WA excise, and the state
// estimate (safe harbor) reading the bracket tax.
//
// Rule values below are copied from packages/api/src/db/seeds/tax-estimator/state-rules/rate-schedules.ts
// (2025): MO-1040 2025 instructions tax chart; AR DFA 2025 indexed tax brackets / tax tables.

import { describe, it, expect } from 'vitest';
import { computeState, EMPTY_GATE_INPUTS } from './state.js';
import { chooseSchedule, stateScheduleTax, tieredExclusion, incomeRatio } from './state-schedule.js';
import { computeStateEstimates } from './vouchers.js';
import type { StateEngineInput, StateEngineRow, StateJurisdictionInput, StateRuleMap, FederalFiguresForState } from './state-types.js';
import type { ParameterMap } from './types.js';
import { validateStateRuleValue, getStateRuleDef } from '../stateRuleKeys.js';

const params: ParameterMap = { 'safe_harbor.min_balance_due': { key: 'safe_harbor.min_balance_due', value: 1000, status: 'verified' } };
const ALL = ['single', 'mfj', 'mfs', 'hoh', 'qss'] as const;
const same = <T,>(v: T) => Object.fromEntries(ALL.map((fs) => [fs, v])) as Record<typeof ALL[number], T>;

// MO 2025 (MO-1040 instructions p.21; married combined uses the same chart — simplified).
const MO_BRACKETS = { ...same([{ over: 0, rate: 0 }, { over: 1313, rate: 0.02 }, { over: 2626, rate: 0.025 }, { over: 3939, rate: 0.03 }, { over: 5252, rate: 0.035 }, { over: 6565, rate: 0.04 }, { over: 7878, rate: 0.045 }, { over: 9191, rate: 0.047 }]), simplified: true, note: 'single chart' };
const MO_STD = { single: 15750, mfj: 31500, mfs: 15750, hoh: 23625, qss: 31500 };
const MO_CG = { treatment: 'exclusion', applies_to: 'net_capital_gain', exclusion_tiers: [{ over: 0, pct: 1 }], includes_qualified_dividends: false };
const capMo = { single: 5000, mfj: 10000, mfs: 5000, hoh: 5000, qss: 5000 };
const MO_FTD = { tiers: [{ agi_over: 0, pct: 0.35, cap: capMo }, { agi_over: 25000, pct: 0.25, cap: capMo }, { agi_over: 50000, pct: 0.15, cap: capMo }, { agi_over: 100000, pct: 0.05, cap: capMo }, { agi_over: 125000, pct: 0, cap: capMo }] };
// AR 2025 (one table for all statuses; the bracket adjustment bands above $94,700 — two shown).
const AR_MAIN = [{ over: 0, rate: 0 }, { over: 5599, rate: 0.02 }, { over: 11199, rate: 0.03 }, { over: 16000, rate: 0.034 }, { over: 26398, rate: 0.039 }];
const AR_BRACKETS = {
  ...same(AR_MAIN),
  schedules_by_income: [
    { income_over: 94700, ...same([{ over: 0, rate: 0.02 }, { over: 21015.79, rate: 0.039 }]) },
    { income_over: 94800, ...same([{ over: 0, rate: 0.02 }, { over: 20489.47, rate: 0.039 }]) },
  ],
  simplified: true,
};
const AR_STD = { single: 2470, mfj: 4940, mfs: 2470, hoh: 2470, qss: 2470 };
const AR_CG = { treatment: 'exclusion', applies_to: 'net_ltcg', exclusion_tiers: [{ over: 0, pct: 0.5 }, { over: 10000000, pct: 1 }], includes_qualified_dividends: false };

type Status = 'verified' | 'unverified' | 'provisional';
function rules(entries: Record<string, unknown>, status: Status = 'unverified'): StateRuleMap {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { key, value, status }]));
}
const BASE_RULES = { has_income_tax: true, estimates_required: true, required_threshold: 100, threshold_comparison: 'at_least', credit_for_other_state: true, nonresident_method: 'ratio' };
const MO = { ...BASE_RULES, starting_point: 'federal_agi', brackets: MO_BRACKETS, standard_deduction: MO_STD, capital_gains: MO_CG, federal_tax_deduction: MO_FTD };
const AR = { ...BASE_RULES, required_threshold: 1000, threshold_comparison: 'more_than', starting_point: 'state_specific', brackets: AR_BRACKETS, standard_deduction: AR_STD, capital_gains: AR_CG };
const juris = (state: string, r: StateRuleMap, extra: Partial<StateJurisdictionInput> = {}): StateJurisdictionInput => ({ state, rules: r, usesFederalFallback: false, verifyBadge: true, estimatesRequired: true, ...extra });

const row = (p: Partial<StateEngineRow> & Pick<StateEngineRow, 'state' | 'residency'>): StateEngineRow => ({
  rowId: `row-${p.state}`, effectiveRate: '0.05', base: 'federal_agi', customBase: null, sourcedIncome: null, sourcedManual: false, creditOverride: null, gate: { ...EMPTY_GATE_INPUTS }, ...p,
});
const fed = (agi: number, extra: Partial<FederalFiguresForState> = {}): FederalFiguresForState => ({
  agi: String(agi), taxableIncome: String(Math.max(0, agi - 15750)), totalIncome: String(agi), wages: '0', deduction: '15750', federalIncomeTax: '0', ...extra,
});
function input(over: Partial<StateEngineInput>): StateEngineInput {
  return { taxYear: 2025, filingStatus: 'single', parameters: params, federal: fed(27750), rows: [], jurisdictions: [], entities: [], ...over };
}
const by = (r: ReturnType<typeof computeState>, s: string) => r.rows.find((x) => x.state === s)!;
const codes = (r: ReturnType<typeof computeState>) => r.warnings.map((w) => w.code);

describe('rule values validate', () => {
  it('the MO / AR fixtures are valid registry values', () => {
    for (const [key, v] of Object.entries({ brackets: MO_BRACKETS, standard_deduction: MO_STD, capital_gains: MO_CG, federal_tax_deduction: MO_FTD })) expect(validateStateRuleValue(getStateRuleDef(key)!, v), key).toBeNull();
    expect(validateStateRuleValue(getStateRuleDef('brackets')!, AR_BRACKETS)).toBeNull();
    expect(validateStateRuleValue(getStateRuleDef('brackets')!, { ...same([{ over: 5, rate: 0.02 }]) })).toMatch(/start at over 0/);
    expect(validateStateRuleValue(getStateRuleDef('capital_gains')!, { treatment: 'alternative_rate' })).toMatch(/max_rate/);
  });
});

describe('Missouri (MO-1040 2025)', () => {
  it('tax chart examples: taxable income 12,000 → 388 and 3,090 → 38 (instructions)', () => {
    const list = MO_BRACKETS.single;
    expect(stateScheduleTax('12000', list)).toBe('388.058');
    expect(stateScheduleTax('3090', list)).toBe('37.86');
    // AGI 27,750 − standard deduction 15,750 = 12,000 (no federal tax, no gains).
    const r = computeState(input({ rows: [row({ state: 'MO', residency: 'resident' })], jurisdictions: [juris('MO', rules(MO))] }));
    const mo = by(r, 'MO');
    expect(mo.rateMode).toBe('brackets');
    expect(mo.schedule).toMatchObject({ startingPoint: 'federal_agi', start: '27750', standardDeduction: '15750', taxableIncome: '12000', scheduleTax: '388' });
    expect(mo.netTax).toBe('388');
    expect(r.trace.filter((t) => t.id.startsWith('state.MO.schedule.bracket.')).length).toBe(8);
  });

  it('100% capital gain subtraction (HB 594), then the federal tax deduction tier by MO AGI, then the standard deduction', () => {
    // AGI 60,000 incl. 25,000 net capital gain → MO AGI 35,000 → 25% tier × federal tax 5,000 = 1,250; TI = 35,000 − 1,250 − 15,750 = 18,000.
    const r = computeState(input({ federal: fed(60000, { capitalGainNet: '25000', netLongTermGain: '20000', federalIncomeTax: '5000' }), rows: [row({ state: 'MO', residency: 'resident' })], jurisdictions: [juris('MO', rules(MO))] }));
    const mo = by(r, 'MO');
    expect(mo.schedule).toMatchObject({ capitalGainExclusion: '25000', federalTaxDeduction: '1250', taxableIncome: '18000', scheduleTax: '670' });
    expect(mo.netTax).toBe('670');
    expect(r.trace.find((t) => t.id === 'state.MO.federal_tax_deduction')!.formula).toMatch(/× 0.25/);
  });

  it('the federal tax deduction is capped ($5,000 single / $10,000 combined)', () => {
    const r = computeState(input({ filingStatus: 'mfj', federal: fed(40000, { federalIncomeTax: '40000' }), rows: [row({ state: 'MO', residency: 'resident' })], jurisdictions: [juris('MO', rules(MO))] }));
    expect(by(r, 'MO').schedule!.federalTaxDeduction).toBe('10000');
  });
});

describe('Arkansas (AR1000F 2025)', () => {
  it('DFA table examples: 75,900–76,000 band → 2,542; 14,800–14,900 → 222; bracket adjustment row 94,701–94,801 → 3,296', () => {
    expect(stateScheduleTax('75950', AR_MAIN)).toBe('2542.09');
    expect(stateScheduleTax('14850', AR_MAIN)).toBe('221.53');
    const choice = chooseSchedule(AR_BRACKETS, 'single', '94751')!;
    expect(choice.label).toMatch(/over 94700/);
    expect(stateScheduleTax('94751', choice.list).startsWith('3295.98')).toBe(true);
    // state_specific starting point (federal AGI, info) − standard deduction 2,470.
    const r = computeState(input({ federal: fed(78420), rows: [row({ state: 'AR', residency: 'resident' })], jurisdictions: [juris('AR', rules(AR))] }));
    expect(by(r, 'AR').schedule).toMatchObject({ startingPoint: 'state_specific', taxableIncome: '75950', scheduleTax: '2542' });
    expect(codes(r)).toContain('TE_STATE_STARTING_POINT_APPROX');
    expect(codes(r)).toContain('TE_STATE_BRACKETS_SIMPLIFIED');
  });

  it('50% of net long-term gain excluded; the excess over $10M fully', () => {
    expect(tieredExclusion('20000', AR_CG.exclusion_tiers)).toBe('10000');
    expect(tieredExclusion('12000000', AR_CG.exclusion_tiers)).toBe('7000000');
    const r = computeState(input({ federal: fed(100000, { netLongTermGain: '20000', capitalGainNet: '25000' }), rows: [row({ state: 'AR', residency: 'resident' })], jurisdictions: [juris('AR', rules(AR))] }));
    expect(by(r, 'AR').schedule).toMatchObject({ capitalGainExclusion: '10000', taxableIncome: '87530', scheduleTax: '2994' });
  });
});

describe('flat, graduated, filing statuses, deductions and starting points', () => {
  const IL = { ...BASE_RULES, starting_point: 'federal_agi', brackets: same([{ over: 0, rate: 0.0495 }]), standard_deduction: same(0), capital_gains: { treatment: 'ordinary' } };
  it('a flat state is a one-bracket schedule', () => {
    const r = computeState(input({ federal: fed(100000), rows: [row({ state: 'IL', residency: 'resident' })], jurisdictions: [juris('IL', rules(IL))] }));
    expect(by(r, 'IL').netTax).toBe('4950');
  });

  it('each filing status reads its own schedule and deduction (KS: qss mapped to the HOH figures in the data)', () => {
    const KS = { ...BASE_RULES, starting_point: 'federal_agi', capital_gains: { treatment: 'ordinary' },
      brackets: { single: [{ over: 0, rate: 0.052 }, { over: 23000, rate: 0.0558 }], hoh: [{ over: 0, rate: 0.052 }, { over: 23000, rate: 0.0558 }], mfs: [{ over: 0, rate: 0.052 }, { over: 23000, rate: 0.0558 }], mfj: [{ over: 0, rate: 0.052 }, { over: 46000, rate: 0.0558 }], qss: [{ over: 0, rate: 0.052 }, { over: 23000, rate: 0.0558 }] },
      standard_deduction: { single: 3605, mfj: 8240, mfs: 4120, hoh: 6180, qss: 6180 } };
    const tax = (fs: 'single' | 'mfj' | 'mfs' | 'hoh' | 'qss') => by(computeState(input({ filingStatus: fs, federal: fed(60000), rows: [row({ state: 'KS', residency: 'resident' })], jurisdictions: [juris('KS', rules(KS))] })), 'KS').schedule!.scheduleTax;
    // single: TI 56,395 → 23,000 × 5.2% + 33,395 × 5.58% = 1,196 + 1,863.44 = 3,059
    expect(tax('single')).toBe('3059');
    // mfj: TI 51,760 → 46,000 × 5.2% + 5,760 × 5.58% = 2,392 + 321.41 = 2,713
    expect(tax('mfj')).toBe('2713');
    expect(tax('hoh')).toBe(tax('qss'));
  });

  it('standard deduction comes off before the exemptions; exemptions are limited to what is left', () => {
    const XX = { ...IL, standard_deduction: same(10000), exemptions: { personal_exemption: 5000, dependent_exemption: 0, personal_credit: 0, dependent_credit: 0 } };
    const r = computeState(input({ federal: fed(12000), rows: [row({ state: 'IL', residency: 'resident' })], jurisdictions: [juris('IL', rules(XX))] }));
    expect(by(r, 'IL').schedule).toMatchObject({ standardDeduction: '10000', exemptions: '2000', taxableIncome: '0' });
  });

  it('starting points: federal taxable income, taxable income before QBI (MT), custom base taken as entered', () => {
    const f = fed(100000, { taxableIncome: '70000', qbiDeduction: '5000' });
    const t = (sp: string, extra: Partial<StateEngineRow> = {}) => by(computeState(input({ federal: f, rows: [row({ state: 'IL', residency: 'resident', ...extra })], jurisdictions: [juris('IL', rules({ ...IL, starting_point: sp }))] })), 'IL').schedule!;
    expect(t('federal_taxable').start).toBe('70000');
    expect(t('federal_taxable_before_qbi').start).toBe('75000');
    expect(t('federal_agi', { base: 'custom', customBase: '42000' })).toMatchObject({ startingPoint: 'custom', taxableIncome: '42000' });
  });

  it('no schedule on file (missing or cited null) → the effective rate with a warning', () => {
    const r = computeState(input({ federal: fed(100000), rows: [row({ state: 'IL', residency: 'resident', effectiveRate: '0.03' })], jurisdictions: [juris('IL', rules({ ...IL, brackets: null }))] }));
    expect(by(r, 'IL')).toMatchObject({ rateMode: 'effective', rateModeRequested: 'brackets', netTax: '3000' });
    expect(codes(r)).toContain('TE_STATE_BRACKETS_UNAVAILABLE');
  });

  it('rate_mode effective is the override even when a schedule exists', () => {
    const r = computeState(input({ federal: fed(100000), rows: [row({ state: 'IL', residency: 'resident', effectiveRate: '0.03', rateMode: 'effective' })], jurisdictions: [juris('IL', rules(IL))] }));
    expect(by(r, 'IL')).toMatchObject({ rateMode: 'effective', rateModeRequested: 'effective', netTax: '3000' });
    expect(by(r, 'IL').schedule).toBeUndefined();
  });
});

describe('capital gains rate rules', () => {
  const base = { ...BASE_RULES, starting_point: 'federal_agi', standard_deduction: same(0) };
  it('alternative maximum rate (HI-style): the lesser of the regular and the alternative tax', () => {
    const XX = { ...base, brackets: same([{ over: 0, rate: 0.05 }, { over: 50000, rate: 0.1 }]), capital_gains: { treatment: 'alternative_rate', applies_to: 'net_ltcg', max_rate: 0.0725 } };
    const r = computeState(input({ federal: fed(100000, { netLongTermGain: '40000', capitalGainNet: '40000' }), rows: [row({ state: 'HI', residency: 'resident' })], jurisdictions: [juris('HI', rules(XX))] }));
    // regular 2,500 + 5,000 = 7,500; alternative = schedule(60,000) 3,500 + 40,000 × 7.25% 2,900 = 6,400
    expect(by(r, 'HI').netTax).toBe('6400');
  });

  it('separate rates: long-term schedule stacked on ordinary income (MT) and a short-term rate (MA)', () => {
    const MT = { ...base, brackets: same([{ over: 0, rate: 0.047 }, { over: 21100, rate: 0.059 }]), capital_gains: { treatment: 'separate_rates', applies_to: 'net_ltcg', ltcg_brackets: same([{ over: 0, rate: 0.03 }, { over: 21100, rate: 0.041 }]) } };
    const r = computeState(input({ federal: fed(50000, { netLongTermGain: '10000', capitalGainNet: '10000' }), rows: [row({ state: 'MT', residency: 'resident' })], jurisdictions: [juris('MT', rules(MT))] }));
    // ordinary 40,000: 21,100 × 4.7% + 18,900 × 5.9% = 991.7 + 1,115.1 = 2,106.8; gains 10,000 stacked over 40,000 at 4.1% = 410
    expect(by(r, 'MT').schedule!.scheduleTax).toBe('2517');
    const MA = { ...base, brackets: same([{ over: 0, rate: 0.05 }]), capital_gains: { treatment: 'separate_rates', applies_to: 'net_ltcg', stcg_rate: 0.085 } };
    const m = computeState(input({ federal: fed(100000, { netLongTermGain: '10000', capitalGainNet: '30000' }), rows: [row({ state: 'MA', residency: 'resident' })], jurisdictions: [juris('MA', rules(MA))] }));
    // short-term 20,000 × 8.5% = 1,700 + other 80,000 × 5% = 4,000
    expect(by(m, 'MA').netTax).toBe('5700');
  });

  it('a surtax on the gain over a federal AGI threshold (MD 2%); qualifying-assets-only applies nothing', () => {
    const MD = { ...base, brackets: same([{ over: 0, rate: 0.05 }]), capital_gains: { treatment: 'ordinary', applies_to: 'net_ltcg', surtax_rate: 0.02, surtax_agi_over: 350000 } };
    const r = computeState(input({ federal: fed(400000, { netLongTermGain: '100000', capitalGainNet: '100000' }), rows: [row({ state: 'MD', residency: 'resident' })], jurisdictions: [juris('MD', rules(MD))] }));
    expect(by(r, 'MD').netTax).toBe('22000');
    const OK = { ...base, brackets: same([{ over: 0, rate: 0.05 }]), capital_gains: { treatment: 'qualifying_assets_only', note: 'Oklahoma property held 5 years' } };
    const o = computeState(input({ federal: fed(100000, { netLongTermGain: '50000', capitalGainNet: '50000' }), rows: [row({ state: 'OK', residency: 'resident' })], jurisdictions: [juris('OK', rules(OK))] }));
    expect(by(o, 'OK').netTax).toBe('5000');
    expect(codes(o)).toContain('TE_STATE_CAPITAL_GAINS_QUALIFYING_ONLY');
  });

  it('a bracket notch (`add`, OH) is added once the income passes it', () => {
    expect(stateScheduleTax('30000', [{ over: 0, rate: 0 }, { over: 26050, rate: 0.0275, add: 342 }])).toBe('450.625');
    expect(stateScheduleTax('26000', [{ over: 0, rate: 0 }, { over: 26050, rate: 0.0275, add: 342 }])).toBe('0');
  });

  it('WA capital gains excise: resident net long-term gain over the standard deduction, 7% then 9.9% over $1M', () => {
    const WA = { has_income_tax: false, capital_gains_excise: { standard_deduction: 278000, brackets: [{ over: 0, rate: 0.07 }, { over: 1000000, rate: 0.099 }], estimates_required: false } };
    const r = computeState(input({ federal: fed(1500000, { netLongTermGain: '1400000', capitalGainNet: '1400000' }), rows: [row({ state: 'WA', residency: 'resident' })], jurisdictions: [juris('WA', rules(WA))] }));
    // taxable 1,122,000: 1,000,000 × 7% + 122,000 × 9.9% = 70,000 + 12,078
    expect(by(r, 'WA').netTax).toBe('82078');
    expect(r.stateTotal).toBe('82078');
  });
});

describe('nonresident rows and the other-state credit', () => {
  const KS = { ...BASE_RULES, starting_point: 'federal_agi', brackets: same([{ over: 0, rate: 0.052 }, { over: 23000, rate: 0.0558 }]), standard_deduction: same(3605), capital_gains: { treatment: 'ordinary' } };
  const GA = { ...BASE_RULES, nonresident_method: 'sourced_flat', starting_point: 'federal_agi', brackets: same([{ over: 0, rate: 0.0519 }]), standard_deduction: same(12000), capital_gains: { treatment: 'ordinary' } };
  const rows = (nr: Partial<StateEngineRow> = {}) => [
    row({ state: 'MO', residency: 'resident' }),
    row({ state: 'KS', residency: 'nonresident', sourcedManual: true, sourcedIncome: '40000', ...nr }),
  ];
  const j = [juris('MO', rules(MO)), juris('KS', rules(KS)), juris('GA', rules(GA))];

  it('ratio method: as-if-resident schedule tax × sourced ÷ federal AGI', () => {
    const r = computeState(input({ federal: fed(100000), rows: rows(), jurisdictions: j }));
    const ks = by(r, 'KS');
    // full TI 96,395 → 23,000 × 5.2% + 73,395 × 5.58% = 1,196 + 4,095.441 = 5,291.441; × 0.4 = 2,116.58
    expect(ks).toMatchObject({ method: 'nonresident_ratio', netTax: '2117' });
    expect(ks.schedule).toMatchObject({ ratio: '0.4', fullYearTax: '5291' });
  });

  it('sourced × rate when chosen on the row (the v1 flat estimate)', () => {
    const r = computeState(input({ federal: fed(100000), rows: rows({ nonresidentMode: 'sourced_rate', effectiveRate: '0.05' }), jurisdictions: j }));
    expect(by(r, 'KS')).toMatchObject({ method: 'nonresident_flat', rateMode: 'effective', netTax: '2000' });
  });

  it('sourced_flat states: schedule on sourced income less deductions × the ratio', () => {
    const r = computeState(input({ federal: fed(100000), rows: [row({ state: 'MO', residency: 'resident' }), row({ state: 'GA', residency: 'nonresident', sourcedManual: true, sourcedIncome: '40000' })], jurisdictions: j }));
    // 40,000 − 12,000 × 0.4 = 35,200 × 5.19% = 1,826.88
    expect(by(r, 'GA')).toMatchObject({ method: 'nonresident_prorated', netTax: '1827' });
  });

  it('resident credit = min(other-state tax, resident tax × sourced ÷ resident state AGI)', () => {
    const r = computeState(input({ federal: fed(100000, { federalIncomeTax: '0' }), rows: rows(), jurisdictions: j }));
    const mo = by(r, 'MO');
    // MO: TI 84,250 → schedule 256.035 + (84,250 − 9,191) × 4.7% = 3,783.808; limit × 40,000 ÷ 100,000 = 1,513.52; KS tax 2,116.58 → credit 1,513.52
    expect(mo.grossTax).toBe('3784');
    expect(mo.creditDetails[0]).toMatchObject({ state: 'KS', otherStateTax: '2117', residentRateOnSourced: '1514', allowed: '1514' });
    expect(mo.netTax).toBe('2270');
    expect(incomeRatio('40000', '100000')).toBe('0.4');
  });
});

describe('state estimates read the bracket tax (safe harbor; no state Schedule AI)', () => {
  it('the current-year required payment is 90% of the schedule tax', () => {
    const MO_EST = {
      ...MO, 'safe_harbor.current_pct': 0.9, 'safe_harbor.prior_pct': 1.0, 'safe_harbor.high_agi_rule': null,
      'installments.due_dates': ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'], 'installments.pcts': [0.25, 0.25, 0.25, 0.25], 'installments.q4_file_and_pay_date': '2026-02-02', return_due_date: '2026-04-15',
      'penalty.rate_source': 'state', 'penalty.rate': 0.08, 'penalty.rate_schedule': null, 'penalty.method': 'daily_simple', 'penalty.min_balance_due': 500,
      'farmer.rule': null, holidays: [],
    };
    const st = computeState(input({ federal: fed(100000), rows: [row({ state: 'MO', residency: 'resident' })], jurisdictions: [juris('MO', rules(MO_EST))] }));
    const mo = by(st, 'MO');
    const est = computeStateEstimates({
      taxYear: 2025, filingStatus: 'single', parameters: params, state: 'MO', jurisdiction: juris('MO', rules(MO_EST)), stateTax: mo.netTax, currentYearAgi: '100000', gate: mo.gate, withholding: '0',
      priorYear: { tax: null, agi: null, twelveMonths: false, filed: false }, rule: 'current_year', ruleSource: 'taxpayer', payments: [],
    });
    expect(est.scheduleAi).toBeNull();
    expect(est.safeHarbor.currentYear.tax).toBe(mo.netTax);
    expect(Number(est.safeHarbor.requiredAnnualPayment)).toBe(Math.round(Number(mo.netTax) * 0.9));
  });
});
