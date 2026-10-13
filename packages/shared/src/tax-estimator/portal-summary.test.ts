// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q51 — the portal calculation summary is an allow-list: only the taxpayer's own shares and
// whole-dollar totals; never entity totals, other owners, ownership %, adjustment detail,
// rates, traces, warnings or review markers.
import { describe, expect, it } from 'vitest';
import type { EstimateResultDTO } from './estimate-api.js';
import { buildPortalCalcSummary } from './portal-summary.js';

// Sentinel values: every one of them must stay out of the summary.
const ENTITY_TOTAL = '987654.32';
const MARGINAL = '0.3712';
const result = {
  taxpayerId: 'tp', taxYear: 2026, scenarioId: 'sc', scenarioName: 'Base', filingStatus: 'mfj',
  entities: [
    { companyId: 'c1', companyName: 'Rivera Plumbing', owners: [{ personId: 'p1', displayName: 'Secret Owner Name', profitPct: 61.5, lossPct: 61.5 }] },
  ],
  federal: {
    entities: [
      {
        companyId: 'c1', companyName: 'Rivera Plumbing', entityType: 's_corp', projectedProfit: ENTITY_TOTAL,
        ytd: { ordinary: '555111' },
        shares: [
          { linkId: 'link-secret-1', personId: 'p1', profitFraction: '0.615', lossFraction: '0.615', share: { ordinary: '60000.40', rental: '0' }, guaranteedPayment: '0' },
          { linkId: 'link-secret-2', personId: 'p2', profitFraction: '0.1', lossFraction: '0.1', share: { ordinary: '10000.20' }, guaranteedPayment: '0' },
        ],
      },
      { companyId: 'c2', companyName: 'Maria Designs', entityType: 'sch_c', projectedProfit: '20000', ytd: {}, shares: [{ linkId: 'l3', personId: 'p2', profitFraction: '1', lossFraction: '1', share: { ordinary: '19999.5' } }] },
    ],
    persons: [{ personId: 'p1', displayName: 'Secret Owner Name', seTax: '2826' }],
    income: { wages: '50000', interest: '2400.49', dividends: '0', capitalGainNet: '0', section1231: '0', otherIncome: '0', totalIncome: '142400.59' },
    adjustmentsToIncome: { halfSeTax: '1413', retirement: '15000', sehi: '0', hsa: '0', other: '0', total: '16413' },
    agi: '125987.59',
    deductions: { mode: 'auto', chosen: 'standard', deduction: '32200', standard: { total: '32200' }, itemized: { total: '9000' }, sch1a: { inEffect: true, total: '1500.5' } },
    qbi: { method: 'computed', deduction: '12000', threshold: '394600', components: [{ companyName: 'Rivera Plumbing' }] },
    taxableIncome: '80287', regularTax: { method: 'brackets', tax: '9123.4', marginalOrdinaryRate: MARGINAL, effectiveRate: '0.1111' },
    credits: { nonrefundableAllowed: '2000', refundable: '500', careCredit: '0', childTaxCredit: '2000', otherNonrefundableAllowed: '0', additionalChildTaxCredit: '500', otherRefundable: '0' },
    seTax: '2826', additionalMedicareTax: '0', niit: '91.2', federalTotal: '9540.6',
    trace: [{ step: 'regular_tax', formula: 'TRACE-FORMULA-SENTINEL' }],
    warnings: [{ code: 'TE_WARN_SENTINEL', message: 'Verify this' }],
    parametersUsed: [{ key: 'PARAM-SENTINEL' }],
  },
  state: {
    rows: [
      { rowId: 'r1', state: 'MO', residency: 'resident', netTax: '3000.4', effectiveRate: '0.0471', verify: true },
      { rowId: 'r2', state: 'AR', residency: 'nonresident', netTax: '400', effectiveRate: '0.039' },
      { rowId: 'r3', state: 'AR', residency: 'resident', netTax: '100.2' },
    ],
    stateTotal: '3500.6',
  },
  summary: { federalTotal: '9540.6', stateTotal: '3500.6', total: '13041.2', marginalRate: MARGINAL },
  adjustments: [{ label: 'SEP contribution', fullYearAmount: '15000' }],
  warnings: [{ code: 'TE_WARN_SENTINEL' }],
} as unknown as EstimateResultDTO;

describe('buildPortalCalcSummary (Q51)', () => {
  it('carries the taxpayer\'s own share per business and whole-dollar totals', () => {
    const s = buildPortalCalcSummary(result);
    expect(s.businesses).toEqual([{ name: 'Rivera Plumbing', amount: '70001' }, { name: 'Maria Designs', amount: '20000' }]);
    expect(s.otherIncome).toEqual([{ label: 'Wages', amount: '50000' }, { label: 'Interest', amount: '2400' }]);
    expect(s).toMatchObject({
      totalIncome: '142401', adjustmentsTotal: '16413', agi: '125988', deduction: { kind: 'standard', amount: '32200' },
      additionalDeductions: '1501', qbiDeduction: '12000', taxableIncome: '80287', regularTax: '9123', credits: '2500',
      selfEmploymentTax: '2826', additionalMedicareTax: '0', niit: '91', federalTotal: '9541', stateTotal: '3501', total: '13041',
    });
    expect(s.states).toEqual([{ state: 'MO', label: 'Missouri', amount: '3000' }, { state: 'AR', label: 'Arkansas', amount: '500' }]);
  });

  it('exactly the allow-listed keys — nothing else', () => {
    const s = buildPortalCalcSummary(result);
    expect(Object.keys(s).sort()).toEqual([
      'additionalDeductions', 'additionalMedicareTax', 'adjustmentsTotal', 'agi', 'businesses', 'credits', 'deduction', 'federalTotal',
      'niit', 'otherIncome', 'qbiDeduction', 'regularTax', 'selfEmploymentTax', 'stateTotal', 'states', 'taxableIncome', 'total', 'totalIncome',
    ]);
    for (const b of s.businesses) expect(Object.keys(b).sort()).toEqual(['amount', 'name']);
    for (const b of s.states) expect(Object.keys(b).sort()).toEqual(['amount', 'label', 'state']);
    expect(Object.keys(s.deduction).sort()).toEqual(['amount', 'kind']);
  });

  it('no forbidden figure leaks: entity totals, other owners, %, link ids, rates, traces, warnings, adjustment detail', () => {
    const text = JSON.stringify(buildPortalCalcSummary(result));
    for (const banned of [
      ENTITY_TOTAL, '987654', '555111', 'Secret Owner Name', '61.5', '0.615', 'link-secret', MARGINAL, '0.0471', '0.1111', '394600',
      'TRACE-FORMULA-SENTINEL', 'TE_WARN_SENTINEL', 'PARAM-SENTINEL', 'Verify', 'SEP contribution', 'rate', 'trace', 'formula', 'owner', 'pct',
    ]) expect(text, banned).not.toContain(banned);
  });

  it('Q53: a rate-schedule (brackets) estimate — schedule detail, ratio and bracket traces never leak', () => {
    const SCHEDULE_LABEL = 'Missouri 2026 rate schedule (4.7% top bracket)';
    const bracketResult = {
      ...result,
      state: {
        rows: [
          {
            rowId: 'r1', state: 'MO', residency: 'resident', method: 'resident', rateMode: 'brackets', rateModeRequested: 'brackets', netTax: '4321.6', effectiveRate: '0.0399',
            schedule: { startingPoint: 'federal_agi', start: '125988', capitalGainExclusion: '7777', federalTaxDeduction: '5555', standardDeduction: '32200', exemptions: '0', taxableIncome: '80456', scheduleTax: '4321.6', scheduleLabel: SCHEDULE_LABEL, capitalGainsTreatment: 'exclusion 100%', ratio: null, fullYearTax: null },
          },
          {
            rowId: 'r2', state: 'AR', residency: 'nonresident', method: 'nonresident_ratio', rateMode: 'brackets', nonresidentMode: 'ratio', netTax: '211.4',
            schedule: { startingPoint: 'state_specific', start: '125988', capitalGainExclusion: '0', federalTaxDeduction: '0', standardDeduction: '4680', exemptions: '58', taxableIncome: '121308', scheduleTax: '3333.3', scheduleLabel: 'Arkansas 2026 brackets', capitalGainsTreatment: null, ratio: '0.063498', fullYearTax: '3329.1' },
          },
        ],
        stateTotal: '4533',
        trace: [{ id: 'state.MO.schedule.bracket.3', formula: 'BRACKET-TRACE-SENTINEL' }],
      },
      summary: { ...(result as unknown as { summary: object }).summary, stateTotal: '4533', total: '14073.6' },
    } as unknown as EstimateResultDTO;
    const s = buildPortalCalcSummary(bracketResult);
    expect(s.states).toEqual([{ state: 'MO', label: 'Missouri', amount: '4322' }, { state: 'AR', label: 'Arkansas', amount: '211' }]);
    for (const b of s.states) expect(Object.keys(b).sort()).toEqual(['amount', 'label', 'state']);
    const text = JSON.stringify(s);
    for (const banned of [
      SCHEDULE_LABEL, 'Arkansas 2026 brackets', '4.7', '0.0399', '0.063498', '3329', '3333', '7777', '5555', '80456', '121308', '4680',
      'BRACKET-TRACE-SENTINEL', 'bracket', 'schedule', 'ratio', 'rateMode', 'nonresident', 'exclusion', '%',
    ]) expect(text, banned).not.toContain(banned);
  });

  it('a result missing fields (an older snapshot) still builds, with zeros', () => {
    const s = buildPortalCalcSummary({ federal: { entities: [] }, summary: { total: '10' } } as unknown as EstimateResultDTO);
    expect(s.total).toBe('10');
    expect(s.agi).toBe('0');
    expect(s.businesses).toEqual([]);
    expect(s.states).toEqual([]);
  });
});
