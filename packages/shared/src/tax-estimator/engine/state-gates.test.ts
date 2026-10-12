// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// D12b estimate-requirement gates, driven by the shipped seed values for
// AZ / GA / PA / ME / NM (requirement_gate), ID / UT (no regime), MO / AR
// (plain threshold, at_least vs more_than) and the federal fallback.

import { describe, it, expect } from 'vitest';
import { evaluateEstimateGate, meetsThreshold, balanceAfterWithholdingAndCredits, type GateEvaluationInput } from './state-gates.js';
import { StateContext, EMPTY_GATE_INPUTS } from './state.js';
import type { FederalFiguresForState, StateGateInputs, StateJurisdictionInput, StateRuleMap } from './state-types.js';
import type { FilingStatus } from '../types.js';
import type { ParameterMap } from './types.js';

const params: ParameterMap = { 'safe_harbor.min_balance_due': { key: 'safe_harbor.min_balance_due', value: 1000, status: 'verified' } };
const federal: FederalFiguresForState = { agi: '120000', taxableIncome: '90000', totalIncome: '130000', wages: '60000', deduction: '30000' };

function rules(entries: Record<string, unknown>, unverified: string[] = []): StateRuleMap {
  const out: Record<string, StateRuleMap[string]> = {};
  for (const [key, value] of Object.entries(entries)) out[key] = { key, value, status: unverified.includes(key) ? 'unverified' : 'verified' };
  return out;
}

const COMMON = { has_income_tax: true, estimates_required: true, 'penalty.method': null as unknown };
/** Seed values (packages/api/src/db/seeds/tax-estimator/state-rules/*.ts, TY2025). The gates are seeded 'unverified'. */
const SEEDS: Record<string, { rules: StateRuleMap; estimatesRequired?: boolean }> = {
  AZ: { rules: rules({ ...COMMON, required_threshold: 1000, threshold_comparison: null, requirement_gate: { kind: 'gross_income_both_years', threshold: 75000, threshold_mfj: 150000 } }, ['requirement_gate']) },
  GA: { rules: rules({ ...COMMON, required_threshold: 0, threshold_comparison: null, requirement_gate: { kind: 'gross_over_exemptions_deductions', non_withheld_floor: 1000 } }, ['required_threshold', 'requirement_gate']) },
  PA: { rules: rules({ ...COMMON, required_threshold: 338, threshold_comparison: null, requirement_gate: { kind: 'non_withheld_income', threshold: 11000 } }, ['requirement_gate']) },
  ME: { rules: rules({ ...COMMON, required_threshold: 1000, threshold_comparison: null, requirement_gate: { kind: 'prior_year_liability_also', threshold: 1000 }, 'penalty.method': 'monthly_compound' }, ['requirement_gate']) },
  NM: { rules: rules({ ...COMMON, required_threshold: 1000, threshold_comparison: null, requirement_gate: { kind: 'nets_withholding_only' } }, ['requirement_gate']) },
  ID: { rules: rules({ has_income_tax: true, estimates_required: false }), estimatesRequired: false },
  UT: { rules: rules({ has_income_tax: true, estimates_required: false, required_threshold: 0 }), estimatesRequired: false },
  MO: { rules: rules({ ...COMMON, required_threshold: 100, threshold_comparison: 'at_least', 'penalty.method': 'daily_simple' }) },
  AR: { rules: rules({ ...COMMON, required_threshold: 1000, threshold_comparison: 'more_than' }) },
  TX: { rules: rules({ has_income_tax: false }), estimatesRequired: false },
};

interface Run { state: string; tax: string; gate?: Partial<StateGateInputs>; filingStatus?: FilingStatus; fallback?: boolean }

function run({ state, tax, gate = {}, filingStatus = 'mfj', fallback = false }: Run) {
  const ctx = new StateContext({ parameters: params, taxYear: 2025, filingStatus });
  const seed = SEEDS[state];
  const jurisdiction: StateJurisdictionInput | null = fallback || !seed ? null : {
    state, rules: seed.rules, usesFederalFallback: false, verifyBadge: Object.values(seed.rules).some((r) => r.status !== 'verified'), estimatesRequired: seed.estimatesRequired ?? true,
  };
  const input: GateEvaluationInput = {
    state, filingStatus, jurisdiction, rules: jurisdiction ? ctx.reader(state, jurisdiction.rules) : null, stateTax: tax, gate: { ...EMPTY_GATE_INPUTS, ...gate }, federal,
  };
  const result = evaluateEstimateGate(input, ctx);
  return { result, warnings: ctx.allWarnings(), trace: ctx.trace.rows() };
}

describe('meetsThreshold', () => {
  it('at_least is ≥, more_than is >', () => {
    expect(meetsThreshold('1000', '1000', 'at_least')).toBe(true);
    expect(meetsThreshold('1000', '1000', 'more_than')).toBe(false);
    expect(meetsThreshold('1000.01', '1000', 'more_than')).toBe(true);
    expect(meetsThreshold('999.99', '1000', 'at_least')).toBe(false);
    expect(balanceAfterWithholdingAndCredits('1500', { ...EMPTY_GATE_INPUTS, withholding: '300', credits: '200' })).toBe('1000');
  });
});

describe('plain threshold states', () => {
  it('MO: at least $100 after withholding and credits', () => {
    expect(run({ state: 'MO', tax: '2100', gate: { withholding: '2000' } }).result).toMatchObject({ method: 'threshold', required: true, measured: '100', threshold: '100', comparison: 'at_least', gateKind: null, verify: false });
    expect(run({ state: 'MO', tax: '2099', gate: { withholding: '2000' } }).result.required).toBe(false);
  });
  it('AR: more than $1,000 — exactly $1,000 is not required', () => {
    expect(run({ state: 'AR', tax: '1000' }).result).toMatchObject({ required: false, comparison: 'more_than' });
    expect(run({ state: 'AR', tax: '1000.01' }).result.required).toBe(true);
  });
  it('adds the penalty add-on note and info once', () => {
    const r = run({ state: 'MO', tax: '5000' });
    expect(r.result.notes.some((n) => n.includes('estimate may differ'))).toBe(true);
    expect(r.warnings.filter((w) => w.code === 'TE_STATE_PENALTY_ADDONS_NOT_MODELLED')).toHaveLength(1);
    expect(r.trace.map((t) => t.id)).toEqual(['state.MO.gate.threshold', 'state.MO.gate']);
  });
});

describe('no regime / no income tax / fallback', () => {
  it('ID and UT: no estimates required (estimates_required = false)', () => {
    for (const state of ['ID', 'UT']) {
      const r = run({ state, tax: '50000' }).result;
      expect(r).toMatchObject({ method: 'no_estimate_regime', required: false, threshold: null });
      expect(r.notes[0]).toContain('no quarterly individual estimated-tax requirement');
    }
  });
  it('TX: no income tax', () => {
    expect(run({ state: 'TX', tax: '0' }).result).toMatchObject({ method: 'no_income_tax', required: false });
  });
  it('a state without rules follows the federal pattern ($1,000) with verify', () => {
    const r = run({ state: 'WV', tax: '1400', gate: { withholding: '300', credits: '100' } });
    expect(r.result).toMatchObject({ method: 'federal_fallback', required: true, threshold: '1000', measured: '1000', verify: true });
    expect(r.warnings.some((w) => w.code === 'TE_STATE_RULES_FALLBACK')).toBe(true);
    expect(r.trace.find((t) => t.id === 'state.WV.gate.threshold')!.parameterKeys).toEqual(['safe_harbor.min_balance_due']);
    expect(run({ state: 'WV', tax: '1399', gate: { withholding: '300', credits: '100' } }).result.required).toBe(false);
  });
  it('a verified state with no threshold is flagged', () => {
    const ctx = new StateContext({ parameters: params, taxYear: 2025, filingStatus: 'single' });
    const j: StateJurisdictionInput = { state: 'XX', rules: rules({ ...COMMON, required_threshold: null }), usesFederalFallback: false, verifyBadge: false, estimatesRequired: true };
    const r = evaluateEstimateGate({ state: 'XX', filingStatus: 'single', jurisdiction: j, rules: ctx.reader('XX', j.rules), stateTax: '5000', gate: EMPTY_GATE_INPUTS, federal }, ctx);
    expect(r).toMatchObject({ required: null, threshold: null, verify: true });
    expect(ctx.allWarnings().some((w) => w.code === 'TE_STATE_THRESHOLD_MISSING')).toBe(true);
  });
});

describe('AZ — gross income > $75,000 / $150,000 MFJ in both years', () => {
  it('MFJ under $150k in either year: not required even with $1,000+ due', () => {
    const r = run({ state: 'AZ', tax: '2500', gate: { grossIncome: '160000', priorYearGrossIncome: '140000' } }).result;
    expect(r).toMatchObject({ method: 'gross_income_both_years', gateKind: 'gross_income_both_years', required: false, gateSatisfied: false, threshold: '1000', measured: '2500' });
  });
  it('MFJ over $150k both years and $1,000+ due: required; under $1,000 due: not', () => {
    expect(run({ state: 'AZ', tax: '2500', gate: { grossIncome: '160000', priorYearGrossIncome: '155000' } }).result.required).toBe(true);
    expect(run({ state: 'AZ', tax: '900', gate: { grossIncome: '160000', priorYearGrossIncome: '155000' } }).result).toMatchObject({ required: false, gateSatisfied: true });
  });
  it('single uses the $75,000 threshold; exactly the threshold does not exceed it', () => {
    expect(run({ state: 'AZ', tax: '2500', filingStatus: 'single', gate: { grossIncome: '80000', priorYearGrossIncome: '76000' } }).result.required).toBe(true);
    expect(run({ state: 'AZ', tax: '2500', filingStatus: 'single', gate: { grossIncome: '75000', priorYearGrossIncome: '76000' } }).result.required).toBe(false);
  });
  it('missing prior-year gross income: shows the plain threshold result with verify + warning', () => {
    const r = run({ state: 'AZ', tax: '2500', gate: { grossIncome: '160000' } });
    expect(r.result).toMatchObject({ required: true, gateSatisfied: null, verify: true });
    expect(r.warnings.find((w) => w.code === 'TE_STATE_GATE_INPUT_MISSING')!.details).toMatchObject({ state: 'AZ', missing: ['priorYearGrossIncome'] });
  });
  it('warns that the gate rule is unverified (D12a) and uses federal total income when gross is blank', () => {
    const r = run({ state: 'AZ', tax: '2500', gate: { priorYearGrossIncome: '155000' } });
    // The AND-gate keeps the tax-due figure as `measured`; federal total income (130,000) fails the $150,000 MFJ gate.
    expect(r.result).toMatchObject({ measured: '2500', required: false, gateSatisfied: false });
    expect(r.result.notes.some((n) => n.includes('federal total income used'))).toBe(true);
    expect(r.warnings.find((w) => w.code === 'TE_STATE_RULE_UNVERIFIED')!.details).toMatchObject({ state: 'AZ', key: 'requirement_gate' });
  });
});

describe('GA — gross income > exemptions + deductions + $1,000', () => {
  it('replaces the (zero) tax-due test', () => {
    const r = run({ state: 'GA', tax: '0', gate: { grossIncome: '50000', exemptions: '8000', deductions: '12000' } }).result;
    expect(r).toMatchObject({ method: 'gross_over_exemptions_deductions', required: true, measured: '50000', threshold: '21000' });
    expect(run({ state: 'GA', tax: '5000', gate: { grossIncome: '21000', exemptions: '8000', deductions: '12000' } }).result.required).toBe(false);
  });
  it('uses the federal deduction when state deductions are blank, and cannot decide without exemptions', () => {
    const r = run({ state: 'GA', tax: '0', gate: { grossIncome: '40000', exemptions: '8000' } }).result;
    expect(r.threshold).toBe('39000');
    expect(r.required).toBe(true);
    const missing = run({ state: 'GA', tax: '0', gate: { grossIncome: '40000' } });
    expect(missing.result).toMatchObject({ gateSatisfied: null, verify: true, required: true });
    expect(missing.warnings.find((w) => w.code === 'TE_STATE_GATE_INPUT_MISSING')!.details).toMatchObject({ missing: ['exemptions'] });
  });
});

describe('PA — income not subject to withholding > $11,000', () => {
  it('required on non-withheld income even when nothing is due after credits; not required under it even when tax is due', () => {
    expect(run({ state: 'PA', tax: '338', gate: { credits: '338', nonWithheldIncome: '12000' } }).result).toMatchObject({ method: 'non_withheld_income', required: true, measured: '12000', threshold: '11000' });
    expect(run({ state: 'PA', tax: '400', gate: { nonWithheldIncome: '11000' } }).result.required).toBe(false);
  });
  it('derives non-withheld income as federal total income less wages when blank', () => {
    const r = run({ state: 'PA', tax: '400' }).result;
    expect(r.measured).toBe('70000');
    expect(r.required).toBe(true);
    expect(r.notes.some((n) => n.includes('federal total income less wages'))).toBe(true);
  });
});

describe('ME — current AND prior-year liability at least $1,000', () => {
  it('prior-year liability under $1,000: not required; at or over: required', () => {
    expect(run({ state: 'ME', tax: '1500', gate: { priorYearLiability: '999' } }).result).toMatchObject({ method: 'prior_year_liability_also', required: false, gateSatisfied: false, measured: '1500', threshold: '1000' });
    expect(run({ state: 'ME', tax: '1500', gate: { priorYearLiability: '1000' } }).result.required).toBe(true);
    expect(run({ state: 'ME', tax: '999', gate: { priorYearLiability: '5000' } }).result.required).toBe(false);
  });
  it('unknown prior-year liability: the current-year result with verify + warning; monthly compounding is noted', () => {
    const r = run({ state: 'ME', tax: '1500' });
    expect(r.result).toMatchObject({ required: true, gateSatisfied: null, verify: true });
    expect(r.warnings.find((w) => w.code === 'TE_STATE_GATE_INPUT_MISSING')!.details).toMatchObject({ missing: ['priorYearLiability'] });
    expect(r.result.notes.some((n) => n.includes('monthly_compound'))).toBe(true);
  });
});

describe('NM — threshold nets withholding only', () => {
  it('credits other than withholding do not reduce the measured amount', () => {
    const r = run({ state: 'NM', tax: '1500', gate: { withholding: '300', credits: '400' } }).result;
    expect(r).toMatchObject({ method: 'nets_withholding_only', required: true, measured: '1200', threshold: '1000' });
    expect(run({ state: 'NM', tax: '1500', gate: { withholding: '600', credits: '0' } }).result.required).toBe(false);
  });
});
