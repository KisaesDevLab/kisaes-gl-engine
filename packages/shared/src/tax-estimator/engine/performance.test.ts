// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 14 performance guard (PHASES.md Phase 14 "under 500 ms for 10 entities × 24
// months with the cache"; R7-06 asked for at least a logged measurement). This
// measures the PURE engine cost of one full estimate for a six-entity MFJ
// taxpayer — computeFederal on the full year and on the three Schedule AI
// period inputs (the estimates orchestrator runs them), computeFederalEstimates
// with Schedule AI, payments and the penalty ledger, computeState for a resident
// and two nonresident rows, and computeStateEstimates for each state. The
// database / P&L-provider cost that dominates a cold API request is outside
// this test (estimate.integration.test.ts covers the service path).
//
// The assertion is deliberately generous (a CI runner under load must not
// flake); the measured median is logged so a regression is visible in the run
// output long before the bound trips.

import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import { computeFederalEstimates, computeStateEstimates } from './vouchers.js';
import { computeState, federalFiguresFromResult, sourcedEntitiesFromFederal, EMPTY_GATE_INPUTS } from './state.js';
import type { StateEngineRow, StateJurisdictionInput, StateRuleMap } from './state-types.js';
import type { EstimatePayment } from './payments.js';
import type { EngineAdjustment, EngineEntity, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');

function loadSeed2026(): ParameterMap {
  const seed = readFileSync(join(repoRoot, 'packages', 'api', 'src', 'db', 'seeds', 'tax-estimator', 'federal', '2026.ts'), 'utf8');
  const rowRe = /key: '([^']+)',\s*value: ([^\n]+?),\s*citation:[\s\S]*?status: '(\w+)'/g;
  const out: Record<string, ParameterMap[string]> = {};
  for (let m = rowRe.exec(seed); m; m = rowRe.exec(seed)) {
    out[m[1]!] = { key: m[1]!, value: JSON.parse(m[2]!.replace(/'/g, '"')) as unknown, status: m[3] as 'verified' | 'unverified' | 'provisional' };
  }
  return out;
}
const params = loadSeed2026();

/** Whole chain must stay under this (ms). The target is 500 ms for the API request incl. the database; the pure engine is a small part of it. */
const BOUND_MS = 1500;
const RUNS = 5;

const allMonths = (): boolean[] => Array(12).fill(true) as boolean[];
const person = (over: Partial<EnginePerson> & { personId: string; role: EnginePerson['role']; dateOfBirth: string }): EnginePerson => ({
  displayName: over.personId, isBlind: false, sehiEligibleMonths: allMonths(), w2Wages: '0', w2SocialSecurityWages: null, withholding: '0', retirementPlan: 'sep', retirementEmployeeDeferral: null,
  hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' }, ...over,
});
const entityBase = (over: Partial<EngineEntity>): EngineEntity => ({
  tenantId: 't', companyId: 'c', companyName: 'Co', entityType: 'sch_c', monthsElapsed: 12, monthsRemaining: 0,
  ytd: characters({}), recurringYtd: characters({}), ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
  links: [], isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [], ...over,
});
const link = { profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active' as const, activeParticipation: false, qbiEligible: null, allowedLossOverride: null };
const adj: EngineAdjustment = { id: '', label: '', typeCode: null, kind: 'income', amount: '0', pct: null, personId: null, linkId: null, affectsSe: false, affectsQbi: false, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false, isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false };
const P1 = 'p1'; const P2 = 'p2';

/** Six linked entities with `months` of actuals (the Schedule AI columns reuse the builder with 3 / 5 / 8 months). */
function taxpayer(months: number): FederalEngineInput {
  const f = months / 12;
  const amt = (annual: number): string => String(Math.round(annual * f));
  const ent = (id: string, over: Partial<EngineEntity>): EngineEntity => entityBase({ companyId: id, companyName: id, monthsElapsed: months, monthsRemaining: 12 - months, ...over });
  return {
    taxYear: 2026, filingStatus: 'mfj', parameters: params,
    persons: [
      person({ personId: P1, role: 'primary', dateOfBirth: '1976-03-03', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '2400' } }),
      person({ personId: P2, role: 'spouse', dateOfBirth: '1978-08-08', w2Wages: amt(85000), retirementPlan: 'none' }),
    ],
    entities: [
      ent('schc-1', { entityType: 'sch_c', ytd: characters({ ordinary: amt(140000) }), recurringYtd: characters({ ordinary: amt(140000) }), w2WagesEffective: '40000', ubia: '120000', links: [{ ...link, linkId: 'l-schc-1', personId: P1 }], ownerItems: [{ personId: null, sehi: amt(9600), retirement: amt(12000), sehiAsW2Wages: '0' }] }),
      ent('schc-2', { entityType: 'sch_c', ytd: characters({ ordinary: amt(-18000) }), recurringYtd: characters({ ordinary: amt(-18000) }), links: [{ ...link, linkId: 'l-schc-2', personId: P2 }] }),
      ent('scorp', { entityType: 's_corp', ytd: characters({ ordinary: amt(95000), interest: amt(1200) }), recurringYtd: characters({ ordinary: amt(95000), interest: amt(1200) }), officerWages: [{ personId: P1, amount: amt(60000) }], w2WagesEffective: '60000', links: [{ ...link, linkId: 'l-scorp', personId: P1, isOfficer: true }] }),
      ent('ptr', { entityType: 'partnership', ytd: characters({ ordinary: amt(48000), section_1231: amt(5000) }), recurringYtd: characters({ ordinary: amt(48000), section_1231: amt(5000) }), guaranteedPayments: [{ personId: P1, amount: amt(24000) }], links: [{ ...link, linkId: 'l-ptr', personId: P1, profitPct: 50, partnerSeStatus: 'general' }] }),
      ent('rental', { entityType: 'partnership', ytd: characters({ rental: amt(-22000) }), recurringYtd: characters({ rental: amt(-22000) }), links: [{ ...link, linkId: 'l-rental', personId: P1, partnerSeStatus: 'limited', activityType: 'rental', activeParticipation: true }] }),
      ent('farm', { entityType: 'sch_f', ytd: characters({ ordinary: amt(16000) }), recurringYtd: characters({ ordinary: amt(16000) }), links: [{ ...link, linkId: 'l-farm', personId: P2 }] }),
    ],
    adjustments: [
      { ...adj, id: 'int', label: 'Interest', typeCode: 'interest_income', amount: amt(3000) },
      { ...adj, id: 'qd', label: 'Qualified dividends', amount: amt(9000), isQualifiedDividend: true },
      { ...adj, id: 'ltcg', label: 'LTCG', amount: amt(25000), isCapitalGainLt: true },
      { ...adj, id: 'meals', label: 'Meals', typeCode: 'meals', kind: 'addback', amount: amt(4000), pct: 50, linkId: 'l-schc-1' },
    ],
    year: {
      rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto',
      itemized: { saltPaid: amt(22000), mortgageInterest: amt(14000), charitableCash: amt(8000), charitableNoncash: '0', other: '0' },
      creditsNonrefundable: '2000', creditsRefundable: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false,
    },
    qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null },
  };
}

function rules(entries: Record<string, unknown>): StateRuleMap {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { key, value, status: 'verified' as const }]));
}
const DUE = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];
const COMMON = { has_income_tax: true, estimates_required: true, 'safe_harbor.current_pct': 0.9, 'safe_harbor.prior_pct': 1.0, 'safe_harbor.high_agi_rule': null, 'installments.due_dates': DUE, 'installments.pcts': [0.25, 0.25, 0.25, 0.25], 'penalty.rate_source': 'state', 'penalty.rate': 0.07, 'penalty.rate_schedule': null, 'penalty.method': 'daily_simple', 'penalty.min_balance_due': null, credit_for_other_state: true, nonresident_method: 'ratio', 'installments.q4_file_and_pay_date': '2027-02-01', return_due_date: '2027-04-15', holidays: [] };
const juris = (state: string, threshold: number): StateJurisdictionInput => ({ state, rules: rules({ ...COMMON, required_threshold: threshold, threshold_comparison: 'at_least' }), usesFederalFallback: false, verifyBadge: false, estimatesRequired: true });
const row = (state: string, residency: 'resident' | 'nonresident', rate: string): StateEngineRow => ({ rowId: `r-${state}`, state, residency, effectiveRate: rate, base: 'federal_agi', customBase: null, sourcedIncome: null, sourcedManual: false, creditOverride: null, gate: { ...EMPTY_GATE_INPUTS, withholding: residency === 'resident' ? '1800' : '0' } });
const pay = (id: string, date: string, amount: string, jurisdiction: string): EstimatePayment => ({ id, date, amount, source: 'manual', jurisdiction });

/** One full estimate: federal (+ 3 Schedule AI columns inside the orchestrator), payments, penalty, 3 state rows, 3 state voucher sets. */
function fullEstimate(): { federalTotal: string; stateTotal: string; penalty: string } {
  const base = taxpayer(12);
  const federal = computeFederal(base);
  const fed = computeFederalEstimates({
    taxYear: 2026, filingStatus: 'mfj', parameters: params, currentYearTax: federal.federalTotal, currentYearAgi: federal.exact.agi, withholding: '12000',
    priorYear: { tax: '54000', agi: '310000', twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default',
    payments: [pay('q1', '2026-04-15', '9000', 'federal'), pay('q2', '2026-07-01', '9000', 'federal')],
    scheduleAi: { base, baseResult: federal, periodActuals: [taxpayer(3), taxpayer(5), taxpayer(8)], calc: computeFederal },
  });
  const st = computeState({
    taxYear: 2026, filingStatus: 'mfj', parameters: params, federal: federalFiguresFromResult(federal),
    rows: [row('MO', 'resident', '0.04'), row('KS', 'nonresident', '0.05'), row('AR', 'nonresident', '0.039')],
    jurisdictions: [juris('MO', 100), juris('KS', 500), juris('AR', 1000)],
    entities: sourcedEntitiesFromFederal(federal, [{ companyId: 'schc-1', stateSourcing: 'MO' }, { companyId: 'ptr', stateSourcing: 'KS' }, { companyId: 'rental', stateSourcing: 'AR' }, { companyId: 'farm', stateSourcing: 'MO' }]),
  });
  let penalty = Number(fed.penalty?.total ?? 0);
  for (const r of st.rows) {
    const v = computeStateEstimates({
      taxYear: 2026, filingStatus: 'mfj', parameters: params, state: r.state, jurisdiction: juris(r.state, 100), stateTax: r.netTax, currentYearAgi: federal.exact.agi, gate: r.gate,
      withholding: r.residency === 'resident' ? '1800' : '0', priorYear: { tax: null, agi: null, twelveMonths: true, filed: true }, rule: 'lesser_of', ruleSource: 'firm_default',
      payments: [pay(`${r.state}-q1`, '2026-04-15', '400', r.state)],
    });
    penalty += Number(v.penalty?.total ?? 0);
  }
  return { federalTotal: federal.federalTotal, stateTotal: st.stateTotal, penalty: String(penalty) };
}

describe('engine performance (Phase 14 target: an estimate well under 500 ms)', () => {
  it(`computeFederal + Schedule AI + estimates + 3 states for a 6-entity taxpayer: median of ${RUNS} runs under ${BOUND_MS} ms (measured value logged)`, () => {
    const warm = fullEstimate();              // JIT warm-up; also proves the chain runs
    expect(Number(warm.federalTotal)).toBeGreaterThan(0);
    expect(Number(warm.stateTotal)).toBeGreaterThan(0);
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      const out = fullEstimate();
      samples.push(performance.now() - t0);
      expect(out).toEqual(warm);              // deterministic
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    // eslint-disable-next-line no-console
    console.log(`[tax-estimator perf] 6-entity full estimate: median ${median.toFixed(1)} ms, min ${samples[0]!.toFixed(1)} ms, max ${samples[samples.length - 1]!.toFixed(1)} ms over ${RUNS} runs (bound ${BOUND_MS} ms; Phase 14 target 500 ms incl. the API path)`);
    expect(median).toBeLessThan(BOUND_MS);
  });
});
