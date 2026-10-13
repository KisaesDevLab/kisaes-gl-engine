// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q53 golden test: the engine must match features/tax-estimator/docs/reference-calc/state_brackets_expected.json,
// produced by state_brackets_fixture.py (independent Python from the 2025 Schedule D Tax Worksheet, MO-1040 /
// MO-A / MO-CR, K-40 Schedule S and AR1000NR / AR1000D, no engine code). Federal parameters are the shipped 2025
// seed file read as text; the MO / KS / AR rows use the shipped 2025 `brackets`, `standard_deduction`,
// `starting_point`, `capital_gains`, `federal_tax_deduction` and `exemptions` seed rows read the same way.
// Rows are on the rate schedule (the default rate_mode) with the nonresident ratio method (the default).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { computeState, federalFiguresFromResult, EMPTY_GATE_INPUTS } from './state.js';
import type { StateEngineRow, StateRuleMap } from './state-types.js';
import type { EngineAdjustment, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'state_brackets_expected.json'), 'utf8')) as Record<string, Oracle>;
const seedDir = join(repoRoot, 'packages', 'api', 'src', 'db', 'seeds', 'tax-estimator');

interface Oracle {
  federal: { agi: number; taxable_income: number; regular_tax: number; federal_income_tax: number; addl_medicare: number; niit: number; federal_total: number;
    worksheet: { ordinary_portion: number; at_zero: number; at_fifteen: number; at_twenty: number; at_twenty_five: number; at_twenty_eight: number } };
  MO: { capital_gain_exclusion: number; mo_agi: number; federal_tax_deduction: number; standard_deduction: number; taxable_income: number; gross_tax: number; credits: Record<string, { limit: number; allowed: number }>; credit: number; net_tax: number };
  KS?: { taxable_income: number; full_year_tax: number; ratio: number; tax: number };
  AR: { capital_gain_exclusion: number; taxable_income: number; full_year_tax: number; ratio: number; tax: number };
  state_total: number;
}

function loadSeed2025(): ParameterMap {
  const seed = readFileSync(join(seedDir, 'federal', '2025.ts'), 'utf8');
  const rowRe = /key: '([^']+)',\s*value: ([^\n]+?),\s*citation:[\s\S]*?status: '(\w+)'/g;
  const out: Record<string, ParameterMap[string]> = {};
  for (let m = rowRe.exec(seed); m; m = rowRe.exec(seed)) {
    out[m[1]!] = { key: m[1]!, value: JSON.parse(m[2]!.replace(/'/g, '"')) as unknown, status: m[3] as 'verified' | 'unverified' | 'provisional' };
  }
  return out;
}
function seedValue(file: string, state: string, year: number, key: string): unknown {
  const seed = readFileSync(join(seedDir, 'state-rules', file), 'utf8');
  const m = new RegExp(`state: '${state}', year: ${year}, key: '${key}',\\s*value: ([^\\n]*),\\n`).exec(seed);
  if (!m) throw new Error(`no ${state} ${year} ${key} seed row in ${file}`);
  return JSON.parse(m[1]!) as unknown;
}
const params = loadSeed2025();

/** The 2025 seed values the state calculation reads (credit / method rows as shipped in MO.ts, KS.ts, AR.ts). */
const rules = (state: string): StateRuleMap => {
  const sched = (key: string) => seedValue('rate-schedules.ts', state, 2025, key);
  const entries: Record<string, unknown> = {
    has_income_tax: true, estimates_required: true, required_threshold: 0, credit_for_other_state: true, nonresident_method: 'ratio',
    exemptions: seedValue('exemptions.ts', state, 2025, 'exemptions'),
    starting_point: sched('starting_point'), brackets: sched('brackets'), standard_deduction: sched('standard_deduction'), capital_gains: sched('capital_gains'),
    ...(state === 'MO' ? { federal_tax_deduction: sched('federal_tax_deduction') } : {}),
  };
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { key, value, status: 'unverified' as const }]));
};
const row = (state: string, residency: 'resident' | 'nonresident', sourced: string | null = null): StateEngineRow => ({
  rowId: state, state, residency, effectiveRate: '0', base: 'federal_agi', customBase: null, sourcedIncome: sourced, sourcedManual: sourced != null, creditOverride: null, gate: { ...EMPTY_GATE_INPUTS },
});

const person = (over: Partial<EnginePerson> & Pick<EnginePerson, 'personId' | 'role'>): EnginePerson => ({
  displayName: over.personId, dateOfBirth: '1975-05-05', isBlind: false, sehiEligibleMonths: Array(12).fill(true) as boolean[], w2Wages: '0', w2SocialSecurityWages: null,
  withholding: '0', retirementPlan: 'none', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' }, ...over,
});
const adjBase: EngineAdjustment = { id: '', label: '', typeCode: null, kind: 'income', amount: '0', pct: null, personId: 'kurt', linkId: null, affectsSe: false, affectsQbi: false, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false, isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false };

interface ScenarioInputs { wagesEach: string; qd: string; stcg: string; ltcg: string; u1250: string; collectibles: string; ks: string | null; ar: string }
function input(o: ScenarioInputs): FederalEngineInput {
  const adjustments: EngineAdjustment[] = [];
  if (o.qd !== '0') adjustments.push({ ...adjBase, id: 'qd', label: 'Qualified dividends', amount: o.qd, isQualifiedDividend: true });
  if (o.stcg !== '0') adjustments.push({ ...adjBase, id: 'st', label: 'Short-term gain', amount: o.stcg, isCapitalGainSt: true });
  if (o.ltcg !== '0') adjustments.push({ ...adjBase, id: 'lt', label: 'Long-term gain', amount: o.ltcg, isCapitalGainLt: true });
  return {
    taxYear: 2025, filingStatus: 'mfj', parameters: params,
    persons: [person({ personId: 'kurt', role: 'primary', w2Wages: o.wagesEach }), person({ personId: 'jan', role: 'spouse', w2Wages: o.wagesEach })],
    entities: [], adjustments,
    year: { rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'standard', itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' },
      creditsNonrefundable: '0', creditsRefundable: '0', unrecaptured1250Gain: o.u1250, collectiblesGain: o.collectibles, amtExposureFlagged: false },
    qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null },
  };
}

const SCENARIOS: Array<[string, ScenarioInputs]> = [
  ['mo_resident_ks_ar', { wagesEach: '40000', qd: '4000', stcg: '3000', ltcg: '60000', u1250: '15000', collectibles: '5000', ks: '40000', ar: '20000' }],
  ['mo_high_buckets', { wagesEach: '300000', qd: '0', stcg: '0', ltcg: '200000', u1250: '60000', collectibles: '30000', ks: null, ar: '100000' }],
];
const n = (v: string | null | undefined) => Number(v);

describe('Q53 golden — state rate schedules + 25% / 28% buckets (state_brackets_fixture.py)', () => {
  for (const [name, o] of SCENARIOS) {
    const e = expected[name]!;
    const fed = computeFederal(input(o));

    it(`${name}: federal regular tax with the Schedule D Tax Worksheet 25% / 28% buckets`, () => {
      const w = fed.regularTax.worksheet!;
      expect({
        agi: n(fed.agi), taxable_income: n(fed.taxableIncome), regular_tax: n(fed.regularTax.tax), federal_income_tax: n(fed.regularTax.tax),
        addl_medicare: n(fed.additionalMedicareTax), niit: n(fed.niit), federal_total: n(fed.federalTotal),
        worksheet: { ordinary_portion: n(w.ordinaryPortion), at_zero: n(w.taxedAtZero), at_fifteen: n(w.taxedAtFifteen), at_twenty: n(w.taxedAtTwenty), at_twenty_five: n(w.taxedAtTwentyFive), at_twenty_eight: n(w.taxedAtTwentyEight) },
      }).toEqual(e.federal);
    });

    it(`${name}: MO resident on its schedule (capital gain subtraction, federal tax deduction, credit), KS / AR nonresident ratio method`, () => {
      const rows = [row('MO', 'resident'), ...(o.ks ? [row('KS', 'nonresident', o.ks)] : []), row('AR', 'nonresident', o.ar)];
      const states = ['MO', ...(o.ks ? ['KS'] : []), 'AR'];
      const s = computeState({
        taxYear: 2025, filingStatus: 'mfj', parameters: params, federal: federalFiguresFromResult(fed), rows,
        jurisdictions: states.map((st) => ({ state: st, rules: rules(st), usesFederalFallback: false, verifyBadge: true, estimatesRequired: true })), entities: [], household: { filers: 2, dependents: 0 },
      });
      const by = (st: string) => s.rows.find((x) => x.state === st)!;
      const mo = by('MO');
      expect({
        capital_gain_exclusion: n(mo.schedule!.capitalGainExclusion), mo_agi: n(mo.schedule!.start) - n(mo.schedule!.capitalGainExclusion), federal_tax_deduction: n(mo.schedule!.federalTaxDeduction),
        standard_deduction: n(mo.schedule!.standardDeduction), taxable_income: n(mo.schedule!.taxableIncome), gross_tax: n(mo.grossTax),
        credits: Object.fromEntries(mo.creditDetails.map((c) => [c.state, { limit: n(c.residentRateOnSourced), allowed: n(c.allowed) }])), credit: n(mo.creditForOtherStates), net_tax: n(mo.netTax),
      }).toEqual({ ...e.MO, federal_tax_deduction_pct: undefined });
      const ar = by('AR');
      expect({ capital_gain_exclusion: n(ar.schedule!.capitalGainExclusion), taxable_income: n(ar.schedule!.taxableIncome), full_year_tax: n(ar.schedule!.fullYearTax), ratio: Number(Number(ar.schedule!.ratio).toFixed(6)), tax: n(ar.netTax) }).toEqual(e.AR);
      expect(ar.method).toBe('nonresident_ratio');
      if (e.KS) {
        const ks = by('KS');
        expect({ taxable_income: n(ks.schedule!.taxableIncome), full_year_tax: n(ks.schedule!.fullYearTax), ratio: Number(Number(ks.schedule!.ratio).toFixed(6)), tax: n(ks.netTax) }).toEqual(e.KS);
      }
      expect(n(s.stateTotal)).toBe(e.state_total);
    });
  }
});
