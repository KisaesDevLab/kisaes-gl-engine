// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { buildEstimateAssumptions, formatDollars, formatPct, STATE_PENALTY_ADDON_NOTES } from './assumptions.js';
import { ASSUMPTION_SECTION_IDS, type EstimateResultDTO } from './estimate-api.js';
import { NONRESIDENT_FLAT_RATE_LABEL } from './engine/state-types.js';
import { DEFAULT_DISCLAIMER_TEXT } from '../schemas/tax-estimator-years.js';

const chars = (over: Record<string, string> = {}) => ({
  ordinary: '0', capital_gain_st: '0', capital_gain_lt: '0', section_1231: '0', interest: '0', dividends_ordinary: '0', dividends_qualified: '0', rental: '0', ...over,
});

function harbor(over: Record<string, unknown> = {}) {
  return {
    jurisdiction: 'federal', policy: 'individual', rule: 'lesser_of', ruleSource: 'firm_default', appliedRule: 'lesser_of',
    currentYear: { tax: '35829', pct: '0.9', amount: '32246' },
    priorYear: { available: true, unavailableReason: null, unavailableDetail: null, tax: '31500', agi: '182000', pct: '1.1', highAgiApplied: true, highAgiUntested: false, amount: '34650' },
    requiredAnnualPayment: '32246', noPenaltyReason: null, verify: false, notes: [], keys: [], exact: {}, ...over,
  };
}

function jurisdiction(j: string, over: Record<string, unknown> = {}) {
  return {
    engineVersionNote: '', jurisdiction: j, taxYear: 2026, estimatesRequired: true, estimatesRequiredReason: '', usesFederalFallback: false, verify: false,
    safeHarbor: harbor({ jurisdiction: j }), scheduleAi: null, installments: [], payments: null,
    penalty: { jurisdiction: j, method: 'daily_simple', computed: true, installments: [], total: '11', totalBeforeWaiver: '11', waiver: null, verify: false, notes: [], exact: { total: '11', totalBeforeWaiver: '11' } },
    returnDueDate: '2027-04-15', lastInstallmentReliefDate: null, totals: { required: '0', withholding: '0', estimatesPaid: '0', unpaid: '0', excess: '0' },
    notes: [], trace: [], warnings: [], parametersUsed: [], rulesUsed: [], ...over,
  };
}

/** A Rivera-shaped result (oracle figures), only the fields the builder reads. */
function riveraLike(over: Partial<EstimateResultDTO> = {}): EstimateResultDTO {
  const base = {
    taxpayerId: 'tp', taxYear: 2026, scenarioId: 's', scenarioName: 'Base', filingStatus: 'mfj', engineVersion: 'x', computedAt: '', cached: false, inputsHash: 'h',
    safeHarborRule: 'lesser_of', safeHarborRuleSource: 'firm_default',
    entities: [
      { tenantId: 't1', companyId: 'c1', companyName: 'Rivera Plumbing LLC', entityType: 'sch_c', path: 'individual', skippedReason: null, throughMonth: '2026-09', throughMonthSource: 'last_closed_month', monthsElapsed: 9, monthsRemaining: 3, glVersionStamp: 1, providerCached: false,
        basis: 'cash', throughMonthReason: 'reconciled through September', nonRecurringYtd: chars({ ordinary: '4200' }),
        reclass: { ownerSehi: '8100', ownerRetirement: '0', ownerPersonalDropped: '0', sehiAsW2Wages: '0', guaranteedPayments: '0', nondeductibleAddBack: '1350', estimatedTaxPayments: '19200', taxDepreciationBook: '0' } },
      { tenantId: 't2', companyId: 'c2', companyName: 'Skipped Co', entityType: null, path: 'skipped', skippedReason: 'No tax entity type', throughMonth: null, throughMonthSource: null, monthsElapsed: 0, monthsRemaining: 0, glVersionStamp: 0, providerCached: false },
    ],
    federal: {
      regularTax: { method: 'brackets', taxableIncome: '150000', tax: '24000', marginalOrdinaryRate: '0.22', marginalCapitalGainRate: '0', effectiveRate: '0.16', worksheet: null },
      trace: [{ step: 'income', id: 'adjustment.a1', label: 'Interest income', amount: '2400', exact: '2400', source: 'adjustment' }],
    },
    state: {
      rows: [
        { rowId: 'r1', state: 'MO', residency: 'resident', method: 'resident', nonresidentMethod: null, base: 'federal_agi', baseAmount: '197550', effectiveRate: '0.04', sourcedIncome: '0', sourcedDerived: false, grossTax: '7902', creditForOtherStates: '312', creditDetails: [], netTax: '7590',
          gate: { state: 'MO', method: 'threshold', required: true, threshold: '100', comparison: 'at_least', measured: '5590', gateKind: null, gateSatisfied: null, verify: false, notes: [], ruleKeys: [] }, hasIncomeTax: true, usesFederalFallback: false, verify: false, exact: {} },
        { rowId: 'r2', state: 'AR', residency: 'nonresident', method: 'nonresident_flat', nonresidentMethod: 'ratio', base: 'federal_agi', baseAmount: '0', effectiveRate: '0.039', sourcedIncome: '8000', sourcedDerived: false, grossTax: '312', creditForOtherStates: '0', creditDetails: [], netTax: '312',
          gate: { state: 'AR', method: 'threshold', required: false, threshold: '1000', comparison: 'more_than', measured: '312', gateKind: null, gateSatisfied: null, verify: false, notes: ['Under the $1,000 threshold.'], ruleKeys: [] }, hasIncomeTax: true, usesFederalFallback: false, verify: false, exact: {} },
      ],
    },
    federalEstimates: jurisdiction('federal', { scheduleAi: { periods: [] } }),
    stateEstimates: [jurisdiction('MO'), jurisdiction('AR', { estimatesRequired: false, estimatesRequiredReason: 'AR tax is under the $1,000 threshold.' }), jurisdiction('MI')],
    farmer: null, ccorps: [], payments: [],
    scheduleAi: [{ periodIndex: 0, periodEnd: '2026-03-31', source: 'snapshot', snapshotEntities: 1, liveEntities: 0 }, { periodIndex: 1, periodEnd: '2026-05-31', source: 'live', snapshotEntities: 0, liveEntities: 1 }, { periodIndex: 2, periodEnd: '2026-08-31', source: 'live', snapshotEntities: 0, liveEntities: 1 }],
    summary: { federalTotal: '35829', stateTotal: '7902', total: '43732', federalRequiredAnnualPayment: '32246', federalUnpaid: '0', federalPenalty: '11', statePenalty: '0', marginalRate: '0.22' },
    warnings: [
      { code: 'TE_PARAM_UNVERIFIED', severity: 'info', message: 'Parameter penalty.underpayment_rate is unverified.' },
      { code: 'TE_UNRECONCILED_ACCOUNTS', severity: 'warning', message: 'Checking is not reconciled through September.' },
    ],
    parametersUsed: [
      { key: 'brackets.mfj', status: 'verified', value: [1] },
      { key: 'penalty.underpayment_rate', status: 'unverified', value: 0.07 },
      { key: 'age.senior_threshold', status: 'provisional', value: 65 },
    ],
    rulesUsed: [{ state: 'MO', key: 'required_threshold', status: 'verified', value: 100 }, { state: 'AR', key: 'holidays', status: 'unverified', value: ['2026-01-01'] }],
    adjustments: [
      { id: 'a1', label: 'Interest income', typeName: 'Interest income', typeCode: 'interest_income', kind: 'income', fullYearAmount: '2400', cadence: 'annual', glLinked: false, nonRecurring: false, personId: null, linkId: null },
      { id: 'a2', label: 'Equipment sale', typeName: 'Other income', typeCode: null, kind: 'income', fullYearAmount: '5000', cadence: 'one_time', glLinked: false, nonRecurring: true, personId: null, linkId: null },
    ],
    ...over,
  };
  return base as unknown as EstimateResultDTO;
}

const sectionOf = (a: ReturnType<typeof buildEstimateAssumptions>, id: string) => a.sections.find((s) => s.id === id)!;
const text = (a: ReturnType<typeof buildEstimateAssumptions>, id: string) => sectionOf(a, id).items.map((i) => `${i.label}: ${i.detail}`).join('\n');

describe('buildEstimateAssumptions', () => {
  it('always returns every section, in order, with the firm disclaimer', () => {
    const a = buildEstimateAssumptions(riveraLike(), { disclaimerText: '  Firm text: not a return.  ' });
    expect(a.sections.map((s) => s.id)).toEqual([...ASSUMPTION_SECTION_IDS]);
    expect(a.sections.every((s) => s.items.length > 0)).toBe(true);
    expect(a.disclaimerText).toBe('Firm text: not a return.');
    expect(text(a, 'disclaimer')).toContain('Firm text: not a return.');
  });

  it('falls back to the shipped disclaimer when the firm has none', () => {
    expect(buildEstimateAssumptions(riveraLike(), { disclaimerText: '   ' }).disclaimerText).toBe(DEFAULT_DISCLAIMER_TEXT);
    expect(buildEstimateAssumptions(riveraLike()).disclaimerText).toBe(DEFAULT_DISCLAIMER_TEXT);
  });

  it('rate mode, projection months, non-recurring, reclass and adjustments come from the result', () => {
    const a = buildEstimateAssumptions(riveraLike());
    expect(text(a, 'rate_mode')).toMatch(/2026 brackets for MFJ.*marginal ordinary rate 22%/);
    expect(text(a, 'rate_mode')).toContain('MO (resident): User-entered effective rate 4%');
    expect(text(a, 'projection')).toContain('books through 2026-09 (last closed month: reconciled through September); 9 months actual + 3 projected');
    expect(text(a, 'projection')).toContain('cash basis');
    expect(sectionOf(a, 'projection').items.find((i) => i.label === 'Skipped Co')!.badge).toBe('verify');
    expect(text(a, 'non_recurring')).toContain('ordinary $4,200');
    expect(text(a, 'non_recurring')).toContain('Equipment sale: Adjustment flagged non-recurring: $5,000');
    expect(text(a, 'reclass')).toContain('Owner health insurance moved to the owner (SEHI): $8,100 year to date');
    expect(text(a, 'reclass')).toContain('Estimated tax payments removed from expenses: $19,200');
    expect(text(a, 'reclass')).not.toContain('Owner retirement');
    expect(text(a, 'adjustments')).toContain('Interest income: income $2,400 for the year; annual');
  });

  it('effective-rate mode is labelled and flagged verify', () => {
    const r = riveraLike();
    const a = buildEstimateAssumptions({ ...r, federal: { ...r.federal, regularTax: { ...r.federal.regularTax, method: 'effective', effectiveRate: '0.185' } } });
    const item = sectionOf(a, 'rate_mode').items[0]!;
    expect(item.detail).toContain('Effective-rate override: 18.5%');
    expect(item.badge).toBe('verify');
  });

  it('safe harbor: rule, source and why; Schedule AI sources; state harbors and "not required" reasons', () => {
    const a = buildEstimateAssumptions(riveraLike());
    const t = text(a, 'safe_harbor');
    expect(t).toContain('lesser of current-year and prior-year rule (the firm default)');
    expect(t).toContain('prior-year 110% = $34,650 (high-AGI rate)');
    expect(t).toContain('Required annual payment $32,246');
    expect(t).toContain('2026-03-31: snapshot; 2026-05-31: live');
    expect(t).toContain('AR estimates: Not required: AR tax is under the $1,000 threshold.');

    const r = riveraLike();
    const fallback = buildEstimateAssumptions({ ...r, federalEstimates: { ...r.federalEstimates, safeHarbor: { ...r.federalEstimates.safeHarbor, rule: 'prior_year', appliedRule: 'current_year', ruleSource: 'taxpayer', priorYear: { ...r.federalEstimates.safeHarbor.priorYear, available: false, unavailableDetail: 'No prior-year return was filed; the prior-year safe harbor is unavailable.', amount: null } } }, safeHarborRuleSource: 'taxpayer' });
    expect(text(fallback, 'safe_harbor')).toContain("prior-year rule (the taxpayer's override); current-year applied because No prior-year return was filed");
  });

  it('state methods carry the nonresident flat-rate label and the D12b penalty add-on notes', () => {
    const a = buildEstimateAssumptions(riveraLike());
    const s = sectionOf(a, 'state_methods');
    const ar = s.items.find((i) => i.label === 'AR nonresident')!;
    expect(ar.detail).toContain(NONRESIDENT_FLAT_RATE_LABEL);
    expect(ar.detail).toContain("the state's method: ratio");
    expect(ar.badge).toBe('estimate_may_differ');
    const mi = s.items.find((i) => i.label === 'MI penalty')!;
    expect(mi.detail).toBe(STATE_PENALTY_ADDON_NOTES['MI']);
    expect(mi.badge).toBe('estimate_may_differ');
    expect(s.items.some((i) => i.label === 'MO penalty')).toBe(false);
    expect(text(a, 'state_methods')).toContain('MO resident: Base "federal_agi" $197,550 × 4%; credit for tax paid to other states $312');
  });

  it('lists only unverified / provisional parameters and rules, and every readiness warning (warnings first)', () => {
    const a = buildEstimateAssumptions(riveraLike());
    const p = sectionOf(a, 'parameters').items;
    expect(p.map((i) => i.code)).toEqual(['penalty.underpayment_rate', 'age.senior_threshold', 'AR.holidays']);
    expect(p.map((i) => i.badge)).toEqual(['unverified', 'provisional', 'unverified']);
    const rd = sectionOf(a, 'readiness').items;
    expect(rd.map((i) => i.code)).toEqual(['TE_UNRECONCILED_ACCOUNTS', 'TE_PARAM_UNVERIFIED']);
  });

  it('engine notes include Q29-Q34 always and Q28 / C corp notes only when they apply', () => {
    const plain = sectionOf(buildEstimateAssumptions(riveraLike()), 'engine_notes').items.map((i) => i.code);
    expect(plain).toEqual(expect.arrayContaining(['Q29', 'Q30', 'Q33', 'Q34']));
    expect(plain).not.toContain('Q28');
    const r = riveraLike();
    const withBoth = buildEstimateAssumptions({ ...r, warnings: [...r.warnings, { code: 'TE_RETIREMENT_PLAN_ASSUMED', severity: 'warning', message: 'x' }], ccorps: [{} as EstimateResultDTO['ccorps'][number]] });
    const items = sectionOf(withBoth, 'engine_notes').items;
    expect(items.map((i) => i.code)).toContain('Q28');
    expect(items.some((i) => i.label === 'C corporations')).toBe(true);
  });

  it('says "None" rather than leaving a section empty', () => {
    const r = riveraLike({ warnings: [], parametersUsed: [], rulesUsed: [], adjustments: [], state: null, stateEstimates: [] });
    const a = buildEstimateAssumptions({ ...r, entities: r.entities.map((e) => ({ ...e, nonRecurringYtd: null, reclass: null })) });
    for (const id of ['non_recurring', 'reclass', 'adjustments', 'state_methods', 'parameters', 'readiness']) {
      expect(sectionOf(a, id).items[0]!.label).toBe('None');
    }
  });

  it('formats dollars and percents without float noise', () => {
    expect(formatDollars('1234567.4999')).toBe('$1,234,567');
    expect(formatDollars('-1200')).toBe('−$1,200');
    expect(formatDollars(null)).toBe('—');
    expect(formatPct('0.0725')).toBe('7.25%');
    expect(formatPct('1.1')).toBe('110%');
  });
});
