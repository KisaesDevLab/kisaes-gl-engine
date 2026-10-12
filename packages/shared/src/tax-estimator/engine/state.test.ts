// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 8 state engine: Rivera oracle (features/tax-estimator/docs/reference-calc/
// rivera_expected.json 'base' block: mo_gross / mo_credit / mo / ar / state_total),
// the credit-limited case, rule-driven behaviour and the DTO bridges.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeState, computeCcorpStateTax, StateContext, stateRuleMapFromRows, jurisdictionFromStateRules, federalFiguresFromResult, stateRowFromDto, sourcedEntitiesFromFederal, EMPTY_GATE_INPUTS,
} from './state.js';
import type { StateEngineInput, StateJurisdictionInput, StateEngineRow, StateRuleMap } from './state-types.js';
import type { FederalResult, ParameterMap } from './types.js';
import type { StateRulesDTO, StateRuleRowDTO } from '../state-rules-api.js';
import type { StateRowDTO } from '../years-api.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'rivera_expected.json'), 'utf8')) as Record<string, Record<string, number | string>>;
const base = expected['base']!;
const b = (k: string): string => String(base[k]);

const params: ParameterMap = {
  'safe_harbor.min_balance_due': { key: 'safe_harbor.min_balance_due', value: 1000, status: 'verified' },
};

type Status = 'verified' | 'unverified' | 'provisional';
function rules(entries: Record<string, unknown>, status: Status = 'verified', overrides: Record<string, Status> = {}): StateRuleMap {
  const out: Record<string, StateRuleMap[string]> = {};
  for (const [key, value] of Object.entries(entries)) out[key] = { key, value, status: overrides[key] ?? status };
  return out;
}

/** The MO / AR seed values the state calculation reads (all verified in the shipped seeds). */
const MO_RULES = { has_income_tax: true, estimates_required: true, required_threshold: 100, threshold_comparison: 'at_least', credit_for_other_state: true, nonresident_method: 'ratio', 'penalty.method': 'daily_simple' };
const AR_RULES = { has_income_tax: true, estimates_required: true, required_threshold: 1000, threshold_comparison: 'more_than', credit_for_other_state: true, nonresident_method: 'ratio', 'penalty.method': null };

const juris = (state: string, r: StateRuleMap, extra: Partial<StateJurisdictionInput> = {}): StateJurisdictionInput => ({ state, rules: r, usesFederalFallback: false, verifyBadge: false, estimatesRequired: true, ...extra });

const federal = { agi: b('agi'), taxableIncome: b('taxable_income'), totalIncome: b('total_income'), wages: '54000', deduction: b('std_deduction') };

const row = (partial: Partial<StateEngineRow> & Pick<StateEngineRow, 'state' | 'residency' | 'effectiveRate'>): StateEngineRow => ({
  rowId: `row-${partial.state}`, base: 'federal_agi', customBase: null, sourcedIncome: null, sourcedManual: false, creditOverride: null, gate: { ...EMPTY_GATE_INPUTS }, ...partial,
});

function riveraInput(over: Partial<StateEngineInput> = {}): StateEngineInput {
  return {
    taxYear: 2026, filingStatus: 'mfj', parameters: params, federal,
    rows: [
      row({ state: 'MO', residency: 'resident', effectiveRate: '0.04', gate: { ...EMPTY_GATE_INPUTS, withholding: '2000' } }),
      row({ state: 'AR', residency: 'nonresident', effectiveRate: '0.039', sourcedManual: true, sourcedIncome: '8000' }),
    ],
    jurisdictions: [juris('MO', rules(MO_RULES)), juris('AR', rules(AR_RULES))],
    entities: [],
    ...over,
  };
}

const byState = (r: ReturnType<typeof computeState>, s: string) => r.rows.find((x) => x.state === s)!;

describe('computeState — Rivera (oracle base block)', () => {
  it('MO resident 7,902 gross − 312 AR credit = 7,590; AR nonresident 312; state total 7,902', () => {
    const r = computeState(riveraInput());
    const mo = byState(r, 'MO'); const ar = byState(r, 'AR');
    expect(mo.grossTax).toBe(b('mo_gross'));
    expect(mo.creditForOtherStates).toBe(b('mo_credit'));
    expect(mo.netTax).toBe(b('mo'));
    expect(ar.grossTax).toBe(b('ar'));
    expect(ar.netTax).toBe('312');
    expect(r.stateTotal).toBe(b('state_total'));
    expect(mo.creditDetails).toEqual([{ state: 'AR', otherStateTax: '312', residentRateOnSourced: '320', allowed: '312' }]);
    expect(r.warnings.filter((w) => w.severity === 'warning')).toEqual([]);
  });

  it('derives AR sourced income from the entity sourced to AR when not manual', () => {
    const r = computeState(riveraInput({
      rows: [
        row({ state: 'MO', residency: 'resident', effectiveRate: '0.04' }),
        row({ state: 'AR', residency: 'nonresident', effectiveRate: '0.039', sourcedManual: false }),
      ],
      entities: [
        { companyId: 'lp', companyName: 'Riverbend LP', state: 'AR', income: '8000' },
        { companyId: 'schc', companyName: 'Carlos Sch C', state: 'MO', income: '128000' },
        { companyId: 'none', companyName: 'Unsourced', state: null, income: '5000' },
      ],
    }));
    const ar = byState(r, 'AR');
    expect(ar.sourcedDerived).toBe(true);
    expect(ar.sourcedIncome).toBe('8000');
    expect(ar.grossTax).toBe('312');
    expect(byState(r, 'MO').netTax).toBe('7590');
    expect(r.trace.find((t) => t.id === 'state.AR.sourced.lp')!.amount).toBe('8000');
    expect(r.trace.filter((t) => t.step === 'state_sourcing' && t.entityId)).toHaveLength(1);
  });

  it('labels the nonresident row as an effective-rate estimate and records the state method', () => {
    const r = computeState(riveraInput());
    const ar = byState(r, 'AR');
    expect(ar.method).toBe('nonresident_flat');
    expect(ar.nonresidentMethod).toBe('ratio');
    const trace = r.trace.find((t) => t.id === 'state.AR.tax')!;
    expect(trace.label).toContain('effective-rate estimate; most states compute nonresident tax by ratio of the full return');
    expect(trace.label).toContain('nonresident_method = ratio');
    const info = r.warnings.find((w) => w.code === 'TE_STATE_NONRESIDENT_FLAT_RATE')!;
    expect(info.severity).toBe('info');
    expect(info.details).toMatchObject({ state: 'AR', nonresidentMethod: 'ratio' });
  });

  it('gates: MO required (5,590 after 2,000 withholding ≥ $100), AR not required (312 not more than $1,000)', () => {
    const r = computeState(riveraInput());
    const mo = byState(r, 'MO').gate; const ar = byState(r, 'AR').gate;
    // measured is unrounded: 197,557 × 0.04 = 7,902.28 − 312 credit − 2,000 withholding
    expect(mo).toMatchObject({ method: 'threshold', required: true, threshold: '100', comparison: 'at_least', measured: '5590.28' });
    expect(ar).toMatchObject({ method: 'threshold', required: false, threshold: '1000', comparison: 'more_than', measured: '312' });
    expect(r.rulesUsed.map((u) => `${u.state}:${u.key}`)).toContain('MO:required_threshold');
    expect(r.engineVersion).toBeTruthy();
  });
});

describe('computeState — credit for other-state taxes', () => {
  it('limits the credit to the resident rate on the sourced income when the other state taxes higher', () => {
    const input = riveraInput();
    input.rows[1]!.effectiveRate = '0.06';
    const r = computeState(input);
    const mo = byState(r, 'MO'); const ar = byState(r, 'AR');
    expect(ar.grossTax).toBe('480');
    expect(mo.creditForOtherStates).toBe('320');
    expect(mo.creditDetails[0]).toEqual({ state: 'AR', otherStateTax: '480', residentRateOnSourced: '320', allowed: '320' });
    expect(mo.netTax).toBe('7582');
    expect(r.stateTotal).toBe('8062');
  });

  it('sums the credit over several nonresident states, each limited separately', () => {
    const input = riveraInput();
    input.rows.push(row({ state: 'KS', residency: 'nonresident', effectiveRate: '0.02', sourcedManual: true, sourcedIncome: '10000' }));
    input.jurisdictions.push(juris('KS', rules({ ...AR_RULES, threshold_comparison: null })));
    input.rows[1]!.effectiveRate = '0.06';
    const r = computeState(input);
    // AR: min(480, 320) = 320; KS: min(200, 400) = 200
    expect(byState(r, 'MO').creditForOtherStates).toBe('520');
    expect(byState(r, 'MO').netTax).toBe('7382');
  });

  it('gives no credit when the resident state disallows it', () => {
    const input = riveraInput();
    input.jurisdictions[0] = juris('MO', rules({ ...MO_RULES, credit_for_other_state: false }));
    const r = computeState(input);
    expect(byState(r, 'MO').creditForOtherStates).toBe('0');
    expect(byState(r, 'MO').netTax).toBe('7902');
    expect(r.warnings.some((w) => w.code === 'TE_STATE_NO_OTHER_STATE_CREDIT')).toBe(true);
  });

  it('uses the entered credit override, capped at the resident tax', () => {
    const input = riveraInput();
    input.rows[0]!.creditOverride = '100';
    expect(byState(computeState(input), 'MO').netTax).toBe('7802');
    input.rows[0]!.creditOverride = '9999';
    const r = computeState(input);
    expect(byState(r, 'MO').netTax).toBe('0');
    expect(r.warnings.some((w) => w.code === 'TE_STATE_CREDIT_CAPPED')).toBe(true);
  });

  it('ignores a nonresident state with no income tax (0 tax, no credit)', () => {
    const input = riveraInput();
    input.rows.push(row({ state: 'TX', residency: 'nonresident', effectiveRate: '0.05', sourcedManual: true, sourcedIncome: '50000' }));
    input.jurisdictions.push(juris('TX', rules({ has_income_tax: false }), { estimatesRequired: false }));
    const r = computeState(input);
    const tx = byState(r, 'TX');
    expect(tx.netTax).toBe('0');
    expect(tx.hasIncomeTax).toBe(false);
    expect(tx.gate).toMatchObject({ method: 'no_income_tax', required: false });
    expect(byState(r, 'MO').creditForOtherStates).toBe('312');
  });
});

describe('computeState — bases and rules', () => {
  it('uses federal taxable income or a custom base when asked', () => {
    const input = riveraInput();
    input.rows[0]!.base = 'federal_taxable';
    expect(byState(computeState(input), 'MO').baseAmount).toBe(b('taxable_income'));
    input.rows[0]!.base = 'custom'; input.rows[0]!.customBase = '100000';
    expect(byState(computeState(input), 'MO').grossTax).toBe('4000');
    input.rows[0]!.customBase = null;
    const r = computeState(input);
    expect(byState(r, 'MO').baseAmount).toBe(b('agi'));
    expect(r.warnings.some((w) => w.code === 'TE_STATE_CUSTOM_BASE_MISSING')).toBe(true);
  });

  it('falls back to the federal pattern with a verify flag when a jurisdiction has no rules', () => {
    const input = riveraInput();
    input.jurisdictions = [juris('AR', rules(AR_RULES))];
    const r = computeState(input);
    const mo = byState(r, 'MO');
    expect(mo.usesFederalFallback).toBe(true);
    expect(mo.verify).toBe(true);
    expect(mo.netTax).toBe('7590');
    expect(mo.gate).toMatchObject({ method: 'federal_fallback', required: true, threshold: '1000', measured: '5590.28', verify: true });
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['TE_STATE_RULES_MISSING', 'TE_STATE_RULES_FALLBACK', 'TE_STATE_CREDIT_ASSUMED']));
    expect(r.parametersUsed.map((p) => p.key)).toContain('safe_harbor.min_balance_due');
  });

  it('treats an incomplete rule set as the federal fallback too', () => {
    const input = riveraInput();
    input.jurisdictions[0] = juris('MO', rules({ has_income_tax: true }), { usesFederalFallback: true, verifyBadge: true });
    const r = computeState(input);
    expect(byState(r, 'MO').gate.method).toBe('federal_fallback');
    expect(byState(r, 'MO').creditForOtherStates).toBe('312');
  });

  it('warns once per non-verified rule read (D12a)', () => {
    const input = riveraInput();
    input.jurisdictions[1] = juris('AR', rules(AR_RULES, 'verified', { nonresident_method: 'unverified', required_threshold: 'provisional' }), { verifyBadge: true });
    const r = computeState(input);
    const codes = r.warnings.filter((w) => w.code === 'TE_STATE_RULE_UNVERIFIED');
    expect(codes.map((w) => w.details)).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'AR', key: 'nonresident_method', status: 'unverified' }),
      expect.objectContaining({ state: 'AR', key: 'required_threshold', status: 'provisional' }),
    ]));
    expect(codes).toHaveLength(2);
    expect(byState(r, 'AR').verify).toBe(true);
  });

  it('warns when derived sourcing finds no entity and when manual sourcing is blank', () => {
    const input = riveraInput();
    input.rows[1]!.sourcedManual = false;
    let r = computeState(input);
    expect(byState(r, 'AR').grossTax).toBe('0');
    expect(r.warnings.some((w) => w.code === 'TE_STATE_SOURCED_NONE')).toBe(true);
    input.rows[1]!.sourcedManual = true; input.rows[1]!.sourcedIncome = null;
    r = computeState(input);
    expect(r.warnings.some((w) => w.code === 'TE_STATE_SOURCED_MISSING')).toBe(true);
  });

  it('rejects duplicate state rows and two resident states', () => {
    const dup = riveraInput(); dup.rows.push(row({ state: 'AR', residency: 'nonresident', effectiveRate: '0.01' }));
    expect(() => computeState(dup)).toThrow(/TE_STATE_DUPLICATE_ROW/);
    const two = riveraInput(); two.rows[1]!.residency = 'resident';
    expect(() => computeState(two)).toThrow(/TE_STATE_MULTIPLE_RESIDENT/);
  });

  it('handles a nonresident-only scenario and an empty one', () => {
    const only = riveraInput(); only.rows = [only.rows[1]!];
    expect(computeState(only).stateTotal).toBe('312');
    const none = riveraInput(); none.rows = [];
    expect(computeState(none).stateTotal).toBe('0');
  });
});

describe('computeCcorpStateTax', () => {
  it('apportionment % × taxable income × rate, with trace rows when a context is given', () => {
    const ctx = new StateContext({ parameters: params, taxYear: 2026, filingStatus: 'mfj' });
    const r = computeCcorpStateTax({ state: 'MO', taxableIncome: '500000', apportionmentPct: '0.25', effectiveRate: '0.04' }, ctx);
    expect(r.apportioned).toBe('125000');
    expect(r.tax).toBe('5000');
    expect(ctx.trace.rows().map((t) => t.id)).toEqual(['state.MO.apportioned', 'state.MO.tax']);
    expect(computeCcorpStateTax({ state: 'MO', taxableIncome: '-5000', apportionmentPct: '0.5', effectiveRate: '0.04' }).tax).toBe('0');
  });
});

describe('DTO bridges', () => {
  const dtoRow = (over: Partial<StateRuleRowDTO>): StateRuleRowDTO => ({ state: 'MO', key: 'x', label: 'x', type: 'bool', value: true, status: 'verified', source: 'seed', citation: 'c', ...over });

  it('stateRuleMapFromRows keeps statuses; jurisdictionFromStateRules mirrors the engine view', () => {
    const rows = [dtoRow({ key: 'has_income_tax' }), dtoRow({ key: 'estimates_required', value: false, status: 'unverified' })];
    const map = stateRuleMapFromRows(rows);
    expect(map['estimates_required']).toMatchObject({ value: false, status: 'unverified' });
    const dto: StateRulesDTO = { year: 2026, state: 'MO', hasIncomeTax: true, isFallback: false, fallbackYear: null, complete: true, missing: [], rules: rows };
    expect(jurisdictionFromStateRules(dto)).toMatchObject({ state: 'MO', usesFederalFallback: false, verifyBadge: true, estimatesRequired: false });
    expect(jurisdictionFromStateRules({ ...dto, complete: false, missing: ['holidays'] })).toMatchObject({ usesFederalFallback: true, verifyBadge: true });
    expect(jurisdictionFromStateRules({ ...dto, hasIncomeTax: false, rules: [dtoRow({ key: 'has_income_tax', value: false })] })).toMatchObject({ usesFederalFallback: false, verifyBadge: false, estimatesRequired: false });
  });

  it('stateRowFromDto and federalFiguresFromResult map the API shapes', () => {
    const dto: StateRowDTO = { id: 'r1', scenarioId: 's', residency: 'nonresident', state: 'AR', effectiveRate: 0.039, base: 'federal_agi', customBase: null, sourcedIncome: '8000.0000', sourcedManual: true, creditOverride: null, memo: null };
    const r = stateRowFromDto(dto, { withholding: '100' });
    expect(r).toMatchObject({ rowId: 'r1', state: 'AR', effectiveRate: '0.039', sourcedIncome: '8000', sourcedManual: true });
    expect(r.gate).toMatchObject({ withholding: '100', credits: '0', priorYearLiability: null });
    const fed = { exact: { agi: '197556.7', taxableIncome: '138726.1', totalIncome: '232400', deduction: '32200' }, income: { wages: '54000' } } as unknown as FederalResult;
    expect(federalFiguresFromResult(fed)).toEqual({ agi: '197556.7', taxableIncome: '138726.1', totalIncome: '232400', wages: '54000', deduction: '32200' });
  });

  it('sourcedEntitiesFromFederal sums the taxpayer shares per entity with its sourcing state', () => {
    const share = (ordinary: string, rental: string, gp: string) => ({
      share: { ordinary, rental, interest: '0', dividends_ordinary: '0', dividends_qualified: '0', capital_gain_st: '0', capital_gain_lt: '0', section_1231: '0' },
      guaranteedPayment: gp,
    });
    const fed = { entities: [
      { companyId: 'lp', companyName: 'LP', shares: [share('0', '8000', '0')] },
      { companyId: 'ps', companyName: 'PS', shares: [share('30000', '0', '12000'), share('30000', '0', '0')] },
    ] } as unknown as FederalResult;
    const out = sourcedEntitiesFromFederal(fed, [{ companyId: 'lp', stateSourcing: 'AR' }]);
    expect(out).toEqual([
      { companyId: 'lp', companyName: 'LP', state: 'AR', income: '8000' },
      { companyId: 'ps', companyName: 'PS', state: null, income: '72000' },
    ]);
  });
});
