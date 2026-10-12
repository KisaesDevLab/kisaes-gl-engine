// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 9 C corp path (MODULE.md "Safe harbor ... C corp rules", PHASES.md Phase 9):
// entity-level tax at ccorp.rate, state apportionment, fiscal-year installments on
// the 15th day of the 4th / 6th / 9th / 12th months with the §7503 roll, the
// §6655(d)(2) large-corporation first-installment rule with recapture, and the
// prior-year rule's availability (never when the prior year was short or zero).

import { describe, it, expect } from 'vitest';
import { computeCcorp, ccorpInstallmentDates, type CcorpEngineInput } from './ccorp.js';
import type { ParameterMap } from './types.js';

type Status = 'verified' | 'unverified' | 'provisional';
function params(entries: Record<string, unknown>, status: Status = 'verified', overrides: Record<string, Status> = {}): ParameterMap {
  const out: Record<string, ParameterMap[string]> = {};
  for (const [key, value] of Object.entries(entries)) out[key] = { key, value, status: overrides[key] ?? status };
  return out;
}

/** The 2025 federal seed values the C corp path reads. */
const SEED_2025 = {
  'ccorp.rate': 0.21,
  'ccorp.large_corp_threshold': 1000000,
  'ccorp.installment_months': [4, 6, 9, 12],
  'ccorp.installment_pcts': [0.25, 0.25, 0.25, 0.25],
  'ccorp.safe_harbor_current_pct': 1.0,
  'ccorp.safe_harbor_prior_pct': 1.0,
  'ccorp.installment_day': 15,
  'ccorp.large_corp_lookback_years': 3,
  'ccorp.min_tax_for_estimates': 500,
  holidays: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-16', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
};

/** FYE-June fixture: fiscal year Jul 1, 2025 – Jun 30, 2026 (2025 Form 1120), $1.5M taxable income, flagged large, prior-year tax $200,000. */
function fyeJune(over: Partial<CcorpEngineInput> = {}): CcorpEngineInput {
  return {
    taxYear: 2025,
    parameters: params(SEED_2025),
    tenantId: 't1', companyId: 'c1', companyName: 'Ozark Fabrication Inc.',
    fiscalYearStartMonth: 7,
    taxableIncome: '1500000',
    largeCorporation: true,
    priorYearsTaxableIncome: null,
    priorYear: { tax: '200000', fullTwelveMonths: true },
    states: [],
    ...over,
  };
}

describe('C corp entity-level tax', () => {
  it('taxes taxable income at ccorp.rate, whole dollars, exact kept', () => {
    const r = computeCcorp(fyeJune());
    expect(r.federalTax).toBe('315000');
    expect(r.exact.federalTax).toBe('315000');
    expect(r.rate).toBe('0.21');
    expect(r.taxableIncome).toBe('1500000');
    expect(r.estimatesRequired).toBe(true);
  });

  it('floors a loss year at zero tax and drops the estimate requirement', () => {
    const r = computeCcorp(fyeJune({ taxableIncome: '-40000', priorYear: null }));
    expect(r.federalTax).toBe('0');
    expect(r.estimatesRequired).toBe(false);
    expect(r.installments.every((i) => i.required === '0')).toBe(true);
  });

  it('a tax under ccorp.min_tax_for_estimates needs no installments (§6655(f)) but the schedule is still shown', () => {
    const r = computeCcorp(fyeJune({ taxableIncome: '2000', priorYear: null }));
    expect(r.federalTax).toBe('420');
    expect(r.estimatesRequired).toBe(false);
    expect(r.installments).toHaveLength(4);
    expect(r.warnings.some((w) => w.code === 'TE_CCORP_BELOW_MIN_TAX')).toBe(true);
  });

  it('describes the fiscal year from the start month (2025 Form 1120 = year the fiscal year begins)', () => {
    const r = computeCcorp(fyeJune());
    expect(r.fiscalYearStart).toBe('2025-07-01');
    expect(r.fiscalYearEnd).toBe('2026-06-30');
    expect(r.fiscalYearStartMonth).toBe(7);
  });
});

describe('C corp state apportionment', () => {
  it('apportionment % × taxable income × rate per state, summed', () => {
    const r = computeCcorp(fyeJune({ states: [
      { state: 'MO', apportionmentPct: '0.4', effectiveRate: '0.04' },
      { state: 'AR', apportionmentPct: '0.1', effectiveRate: '0.043' },
    ] }));
    expect(r.states.map((s) => [s.state, s.apportioned, s.tax])).toEqual([['MO', '600000', '24000'], ['AR', '150000', '6450']]);
    expect(r.stateTotal).toBe('30450');
    expect(r.totalTax).toBe('345450');
    expect(r.trace.some((t) => t.id === 'state.MO.tax' && t.step === 'ccorp_state')).toBe(true);
  });

  it('a loss year apportions nothing', () => {
    const r = computeCcorp(fyeJune({ taxableIncome: '-5', states: [{ state: 'MO', apportionmentPct: '1', effectiveRate: '0.04' }] }));
    expect(r.stateTotal).toBe('0');
  });
});

describe('fiscal-year installment dates', () => {
  it('fall on the 15th of the 4th, 6th, 9th and 12th fiscal months, rolled past weekends and holidays (§7503)', () => {
    const r = computeCcorp(fyeJune());
    expect(r.installments.map((i) => i.fiscalMonth)).toEqual([4, 6, 9, 12]);
    expect(r.installments.map((i) => i.statutoryDueDate)).toEqual(['2025-10-15', '2025-12-15', '2026-03-15', '2026-06-15']);
    // Mar 15, 2026 is a Sunday.
    expect(r.installments.map((i) => i.dueDate)).toEqual(['2025-10-15', '2025-12-15', '2026-03-16', '2026-06-15']);
  });

  it('a calendar-year corporation gets the April / June / September / December dates', () => {
    const d = ccorpInstallmentDates({ taxYear: 2026, fiscalYearStartMonth: 1, installmentMonths: [4, 6, 9, 12], installmentDay: 15, holidays: SEED_2025.holidays });
    expect(d.map((x) => x.dueDate)).toEqual(['2026-04-15', '2026-06-15', '2026-09-15', '2026-12-15']);
  });

  it('rolls over a listed holiday to the next business day', () => {
    const d = ccorpInstallmentDates({ taxYear: 2025, fiscalYearStartMonth: 7, installmentMonths: [4], installmentDay: 15, holidays: ['2025-10-15'] });
    expect(d[0]!.statutoryDueDate).toBe('2025-10-15');
    expect(d[0]!.dueDate).toBe('2025-10-16');
  });

  it('a fiscal year starting in December lands its 12th month in the following November', () => {
    const d = ccorpInstallmentDates({ taxYear: 2025, fiscalYearStartMonth: 12, installmentMonths: [4, 6, 9, 12], installmentDay: 15, holidays: [] });
    expect(d.map((x) => x.statutoryDueDate)).toEqual(['2026-03-15', '2026-05-15', '2026-08-15', '2026-11-15']);
  });

  it('rejects a start month outside 1..12', () => {
    expect(() => computeCcorp(fyeJune({ fiscalYearStartMonth: 0 }))).toThrow(/TE_CCORP_FISCAL_MONTH/);
    expect(() => computeCcorp(fyeJune({ fiscalYearStartMonth: 13 }))).toThrow(/TE_CCORP_FISCAL_MONTH/);
  });
});

describe('required installments: large corporation with recapture (acceptance fixture)', () => {
  it('uses the prior-year rule for the first installment only and recaptures the shortfall in the second', () => {
    const r = computeCcorp(fyeJune());
    expect(r.largeCorporation).toBe(true);
    expect(r.largeCorporationSource).toBe('flag');
    expect(r.priorYearRule).toEqual({ available: true, reason: 'ok', appliesTo: 'first_installment' });
    expect(r.requiredAnnualPayment.currentYear).toBe('315000');
    expect(r.requiredAnnualPayment.priorYear).toBe('200000');
    expect(r.requiredAnnualPayment.required).toBe('315000');
    const [i1, i2, i3, i4] = r.installments;
    expect(i1!.required).toBe('50000');
    expect(i1!.basis).toBe('prior_year');
    expect(i1!.recapture).toBe('0');
    expect(i2!.required).toBe('107500');
    expect(i2!.recapture).toBe('28750');
    expect(i2!.basis).toBe('current_year');
    expect(i3!.required).toBe('78750');
    expect(i4!.required).toBe('78750');
    expect(i4!.cumulativeRequired).toBe('315000');
    expect(r.installments.map((i) => i.number)).toEqual([1, 2, 3, 4]);
  });

  it('a large corporation whose prior-year tax exceeds the current year has nothing to recapture', () => {
    const r = computeCcorp(fyeJune({ priorYear: { tax: '400000', fullTwelveMonths: true } }));
    expect(r.installments.map((i) => i.required)).toEqual(['78750', '78750', '78750', '78750']);
    expect(r.installments[1]!.recapture).toBe('0');
    expect(r.installments[0]!.basis).toBe('current_year');
  });

  it('derives large-corporation status from the preceding years when the flag is off (any year at or above the threshold)', () => {
    const r = computeCcorp(fyeJune({ largeCorporation: false, priorYearsTaxableIncome: ['300000', '1000000', '250000'] }));
    expect(r.largeCorporation).toBe(true);
    expect(r.largeCorporationSource).toBe('derived');
    expect(r.installments[1]!.recapture).toBe('28750');
    expect(r.warnings.some((w) => w.code === 'TE_CCORP_LARGE_CORP_DERIVED')).toBe(true);
  });

  it('only the lookback years count', () => {
    const r = computeCcorp(fyeJune({ largeCorporation: false, priorYearsTaxableIncome: ['300000', '200000', '250000', '5000000'] }));
    expect(r.largeCorporation).toBe(false);
    expect(r.largeCorporationSource).toBe('not_large');
    expect(r.installments.map((i) => i.required)).toEqual(['50000', '50000', '50000', '50000']);
  });
});

describe('required installments: non-large corporation', () => {
  it('pays the lesser of current-year and prior-year tax in equal installments', () => {
    const r = computeCcorp(fyeJune({ largeCorporation: false }));
    expect(r.priorYearRule.appliesTo).toBe('all');
    expect(r.requiredAnnualPayment.required).toBe('200000');
    expect(r.installments.map((i) => i.required)).toEqual(['50000', '50000', '50000', '50000']);
    expect(r.installments.every((i) => i.basis === 'prior_year' && i.recapture === '0')).toBe(true);
  });

  it('prior-year rule is unavailable when the prior year was short', () => {
    const r = computeCcorp(fyeJune({ largeCorporation: false, priorYear: { tax: '200000', fullTwelveMonths: false } }));
    expect(r.priorYearRule).toEqual({ available: false, reason: 'short_year', appliesTo: 'none' });
    expect(r.requiredAnnualPayment.priorYear).toBeNull();
    expect(r.installments.map((i) => i.required)).toEqual(['78750', '78750', '78750', '78750']);
  });

  it('prior-year rule is unavailable when the prior year showed no liability', () => {
    const r = computeCcorp(fyeJune({ largeCorporation: false, priorYear: { tax: '0', fullTwelveMonths: true } }));
    expect(r.priorYearRule).toEqual({ available: false, reason: 'zero_liability', appliesTo: 'none' });
    expect(r.installments.map((i) => i.required)).toEqual(['78750', '78750', '78750', '78750']);
  });

  it('prior-year rule is unavailable when no prior year is known', () => {
    const r = computeCcorp(fyeJune({ largeCorporation: true, priorYear: null }));
    expect(r.priorYearRule).toEqual({ available: false, reason: 'not_provided', appliesTo: 'none' });
    expect(r.installments.map((i) => i.required)).toEqual(['78750', '78750', '78750', '78750']);
    expect(r.installments[1]!.recapture).toBe('0');
  });

  it('uneven installment percentages are honoured', () => {
    const r = computeCcorp(fyeJune({ largeCorporation: false, priorYear: null, parameters: params({ ...SEED_2025, 'ccorp.installment_pcts': [0.1, 0.2, 0.3, 0.4] }) }));
    expect(r.installments.map((i) => i.required)).toEqual(['31500', '63000', '94500', '126000']);
  });

  it('rejects mismatched installment month / percentage lists', () => {
    expect(() => computeCcorp(fyeJune({ parameters: params({ ...SEED_2025, 'ccorp.installment_pcts': [0.5, 0.5] }) }))).toThrow(/TE_CCORP_INSTALLMENT_LISTS/);
  });
});

describe('parameter discipline', () => {
  it('records every parameter read and warns once per unverified parameter (D12a)', () => {
    const r = computeCcorp(fyeJune({ parameters: params(SEED_2025, 'verified', { 'ccorp.installment_day': 'unverified', 'ccorp.min_tax_for_estimates': 'unverified' }) }));
    const keys = r.parametersUsed.map((p) => p.key);
    for (const k of ['ccorp.rate', 'ccorp.installment_months', 'ccorp.installment_pcts', 'ccorp.installment_day', 'ccorp.safe_harbor_current_pct', 'ccorp.safe_harbor_prior_pct', 'ccorp.min_tax_for_estimates', 'holidays']) {
      expect(keys).toContain(k);
    }
    const unverified = r.warnings.filter((w) => w.code === 'TE_PARAM_UNVERIFIED').map((w) => w.details?.['key']);
    expect(unverified.sort()).toEqual(['ccorp.installment_day', 'ccorp.min_tax_for_estimates']);
  });

  it('does not read the lookback parameter when the flag already says large', () => {
    const r = computeCcorp(fyeJune());
    expect(r.parametersUsed.map((p) => p.key)).not.toContain('ccorp.large_corp_lookback_years');
  });

  it('trace rows carry whole-dollar amounts, exact values and step tags', () => {
    const r = computeCcorp(fyeJune({ states: [{ state: 'MO', apportionmentPct: '0.333333', effectiveRate: '0.04' }] }));
    const tax = r.trace.find((t) => t.id === 'ccorp.federal_tax');
    expect(tax?.step).toBe('ccorp_tax');
    expect(tax?.amount).toBe('315000');
    const mo = r.trace.find((t) => t.id === 'state.MO.tax');
    expect(mo?.exact).toBe('19999.98');
    expect(mo?.amount).toBe('20000');
    const inst2 = r.trace.find((t) => t.id === 'ccorp.installment.2');
    expect(inst2?.step).toBe('ccorp_installments');
    expect(inst2?.amount).toBe('107500');
  });
});
