// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q44: state personal / dependent exemptions (`exemptions` state rule) in computeState.
// The rule values below are the shipped 2025 seed values for MO, AR, GA and CA
// (packages/api/src/db/seeds/tax-estimator/state-rules/exemptions.ts).

import { describe, it, expect } from 'vitest';
import { computeState, EMPTY_GATE_INPUTS } from './state.js';
import type { StateEngineInput, StateEngineRow, StateRuleMap } from './state-types.js';
import type { ParameterMap } from './types.js';

const params: ParameterMap = { 'safe_harbor.min_balance_due': { key: 'safe_harbor.min_balance_due', value: 1000, status: 'verified' } };
const BASE_RULES = { has_income_tax: true, estimates_required: true, required_threshold: 100, threshold_comparison: 'at_least', credit_for_other_state: true, nonresident_method: 'ratio' };
const MO_EX = { personal_exemption: 0, personal_exemption_by_status: { single: 0, mfj: 0, mfs: 0, hoh: 1400, qss: 1400 }, dependent_exemption: 0, personal_credit: 0, dependent_credit: 0, simplified: false };
const AR_EX = { personal_exemption: 0, dependent_exemption: 0, personal_credit: 29, personal_credit_by_status: { single: 29, mfj: 58, mfs: 29, hoh: 58, qss: 58 }, dependent_credit: 29, simplified: false };
const GA_EX = { personal_exemption: 0, dependent_exemption: 4000, personal_credit: 0, dependent_credit: 0, simplified: false };
const CA_EX = { personal_exemption: 0, dependent_exemption: 0, personal_credit: 153, personal_credit_by_status: { single: 153, mfj: 306, mfs: 153, hoh: 153, qss: 306 }, dependent_credit: 475, simplified: true, note: 'phase-out above high AGI' };

function rules(entries: Record<string, unknown>): StateRuleMap {
  const out: Record<string, StateRuleMap[string]> = {};
  for (const [key, value] of Object.entries(entries)) out[key] = { key, value, status: 'unverified' };
  return out;
}
const row = (state: string, extra: Partial<StateEngineRow> = {}): StateEngineRow => ({
  rowId: `r-${state}`, state, residency: 'resident', effectiveRate: '0.04', base: 'federal_agi', customBase: null, sourcedIncome: null, sourcedManual: false, creditOverride: null,
  gate: { ...EMPTY_GATE_INPUTS }, rateMode: 'effective', ...extra, // Q53: the Q44 cases test the effective-rate formula.
});
function input(state: string, ex: unknown, over: Partial<StateEngineInput> = {}, extraRules: Record<string, unknown> = {}): StateEngineInput {
  return {
    taxYear: 2025, filingStatus: 'mfj', parameters: params,
    federal: { agi: '100000', taxableIncome: '70000', totalIncome: '100000', wages: '100000', deduction: '30000' },
    rows: [row(state)], jurisdictions: [{ state, rules: rules({ ...BASE_RULES, ...(ex === undefined ? {} : { exemptions: ex }), ...extraRules }), usesFederalFallback: false, verifyBadge: true, estimatesRequired: true }],
    entities: [], household: { filers: 2, dependents: 3 }, ...over,
  };
}
const codes = (r: ReturnType<typeof computeState>) => r.warnings.map((w) => w.code);

describe('Q44 state exemptions', () => {
  it('MO MFJ: no personal or dependent exemption (2018 law, federal exemption 0) — 100,000 × 4% = 4,000', () => {
    const r = computeState(input('MO', MO_EX));
    expect(r.rows[0]!.exemptions).toBe('0');
    expect(r.rows[0]!.netTax).toBe('4000');
  });

  it('MO head of household: the 1,400 additional exemption comes off the base', () => {
    const r = computeState(input('MO', MO_EX, { filingStatus: 'hoh', household: { filers: 1, dependents: 2 } }));
    expect(r.rows[0]!.exemptions).toBe('1400');
    expect(r.rows[0]!.netTax).toBe('3944');
  });

  it('AR MFJ, 3 dependents: credits 58 + 3 × 29 = 145 off the tax', () => {
    const r = computeState(input('AR', AR_EX));
    expect(r.rows[0]!.exemptionCredits).toBe('145');
    expect(r.rows[0]!.netTax).toBe('3855');
  });

  it('GA, 3 dependents: 3 × 4,000 off the base, and the gross-income gate reads the computed exemptions', () => {
    const r = computeState(input('GA', GA_EX, {}, { requirement_gate: { kind: 'gross_over_exemptions_deductions', non_withheld_floor: 1000 } }));
    expect(r.rows[0]!.exemptions).toBe('12000');
    expect(r.rows[0]!.netTax).toBe('3520');
    expect(codes(r)).toContain('TE_STATE_GATE_EXEMPTIONS_COMPUTED');
    expect(r.rows[0]!.gate.gateKind).toBe('gross_over_exemptions_deductions');
  });

  it('an entered GA gate exemption wins over the computed one', () => {
    const inp = input('GA', GA_EX, {}, { requirement_gate: { kind: 'gross_over_exemptions_deductions', non_withheld_floor: 1000 } });
    inp.rows[0]!.gate.exemptions = '5000';
    expect(codes(computeState(inp))).not.toContain('TE_STATE_GATE_EXEMPTIONS_COMPUTED');
  });

  it('CA credit-style state: 306 + 3 × 475 = 1,731 credits, simplified → info', () => {
    const r = computeState(input('CA', CA_EX));
    expect(r.rows[0]!.exemptionCredits).toBe('1731');
    expect(r.rows[0]!.netTax).toBe('2269');
    expect(codes(r)).toContain('TE_STATE_EXEMPTIONS_SIMPLIFIED');
  });

  it('a custom base keeps the exemptions out (info) but still takes the exemption credits', () => {
    const inp = input('GA', GA_EX);
    inp.rows[0] = row('GA', { base: 'custom', customBase: '50000' });
    const r = computeState(inp);
    expect(r.rows[0]!.exemptions).toBe('0');
    expect(r.rows[0]!.netTax).toBe('2000');
    expect(codes(r)).toContain('TE_STATE_EXEMPTIONS_CUSTOM_BASE');
  });

  it('missing rule = info, nothing applied; cited null = warning; null component with dependents = warning', () => {
    const missing = computeState(input('MO', undefined));
    expect(missing.rows[0]!.netTax).toBe('4000');
    expect(missing.warnings.find((w) => w.code === 'TE_STATE_EXEMPTIONS_MISSING')?.severity).toBe('info');
    expect(computeState(input('MO', null)).warnings.find((w) => w.code === 'TE_STATE_EXEMPTIONS_UNSOURCED')?.severity).toBe('warning');
    expect(codes(computeState(input('UT', { personal_exemption: 0, dependent_exemption: 0, personal_credit: null, dependent_credit: null })))).toContain('TE_STATE_EXEMPTIONS_COMPONENT_UNSOURCED');
  });

  it('nonresident rows take no exemptions', () => {
    const inp = input('GA', GA_EX);
    inp.rows[0] = row('GA', { residency: 'nonresident', sourcedManual: true, sourcedIncome: '10000' });
    expect(computeState(inp).rows[0]!.netTax).toBe('400');
  });
});
