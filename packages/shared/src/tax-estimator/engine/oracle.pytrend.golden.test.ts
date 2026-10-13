// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q46 golden test: the engine must match features/tax-estimator/docs/reference-calc/pytrend_expected.json,
// produced by pytrend_fixture.py (independent Python, no engine code). One seasonal Schedule C (books through
// September, a non-recurring item) projected under each method from the prior year's monthly figures, plus a
// weak year whose scale factor is capped at the lower bound. Federal parameters are the shipped 2026 seed
// file read as text (as in the other golden tests).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import { priorYearTrendFor } from './py-trend.js';
import type { EngineEntity, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';
import type { PriorYearMonthlyFigures, ProjectionMethod } from '../projection-method.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'pytrend_expected.json'), 'utf8')) as Record<string, Oracle>;

interface Oracle {
  projected_ordinary: number; run_rate_ordinary: number; factor: number | null; capped: 'min' | 'max' | null; fallback: string | null;
  py: { same_months: number; remaining: number; full_year: number };
  federal: { total_income: number; agi: number; se_tax: number; qbi: number; taxable_income: number; income_tax: number };
  federal_total: number;
}

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

const person = (personId: string, role: 'primary' | 'spouse'): EnginePerson => ({
  personId, role, displayName: personId, dateOfBirth: '1980-06-06', isBlind: false, sehiEligibleMonths: Array(12).fill(true) as boolean[], w2Wages: '0', w2SocialSecurityWages: null,
  withholding: '0', retirementPlan: 'none', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' },
});

// The prior year as the P&L provider would deliver it (recurring ordinary per month; every month active).
const PY2025: PriorYearMonthlyFigures = {
  taxYear: 2025,
  recurringOrdinary: ['5000', '5000', '10000', '10000', '10000', '15000', '15000', '15000', '15000', '30000', '30000', '20000'],
  active: Array(12).fill(true) as boolean[],
};

function entityFor(method: ProjectionMethod, ytd: string, recurring: string): EngineEntity {
  return {
    tenantId: 'tenant-1', companyId: 'ana-landscaping', companyName: 'Ana Landscaping', entityType: 'sch_c', monthsElapsed: 9, monthsRemaining: 3,
    ytd: characters({ ordinary: ytd }), recurringYtd: characters({ ordinary: recurring }), ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
    links: [{ linkId: 'link-ana', personId: 'ana', profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active', activeParticipation: false, qbiEligible: null, allowedLossOverride: null }],
    isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [],
    ...(method === 'run_rate' ? {} : { priorYearTrend: priorYearTrendFor(method, PY2025, 9) }),
  };
}

const run = (e: EngineEntity) => computeFederal({
  taxYear: 2026, filingStatus: 'mfj', parameters: params, persons: [person('ana', 'primary'), person('ben', 'spouse')], dependents: [],
  entities: [e], adjustments: [],
  year: { rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' },
    creditsNonrefundable: '0', creditsRefundable: '0', careExpenses: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false },
  qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null },
} satisfies FederalEngineInput);

const federalOf = (r: ReturnType<typeof run>) => ({
  total_income: Number(r.income.totalIncome), agi: Number(r.agi), se_tax: Number(r.seTax), qbi: Number(r.qbi.deduction),
  taxable_income: Number(r.taxableIncome), income_tax: Number(r.regularTax.tax),
});

describe('Q46 golden — prior-year trend oracle (pytrend_fixture.py)', () => {
  it.each(['run_rate', 'prior_year_scaled', 'prior_year_dollar'] as const)('seasonal Sch C, %s', (method) => {
    const e = expected[`seasonal_${method}`]!;
    const r = run(entityFor(method, '140000', '130000'));
    const ent = r.entities[0]!;
    expect(Number(ent.projected.ordinary)).toBe(e.projected_ordinary);
    expect(federalOf(r)).toEqual(e.federal);
    expect(Number(r.federalTotal)).toBe(e.federal_total);
    if (method === 'run_rate') {
      expect(ent).not.toHaveProperty('projection'); // the default leaves rc.5 results byte-identical
      return;
    }
    expect(ent.projection).toMatchObject({ method, applied: method, fallbackReason: null, capped: e.capped });
    expect(ent.projection!.factor == null ? null : Number(ent.projection!.factor)).toBe(e.factor);
    expect(Number(ent.projection!.runRateOrdinary)).toBe(e.run_rate_ordinary);
    expect(ent.projection!.priorYear).toMatchObject({ taxYear: 2025, throughMonth: 9, sameMonthsOrdinary: String(e.py.same_months), remainingOrdinary: String(e.py.remaining), fullYearOrdinary: String(e.py.full_year), monthsWithActivity: 12 });
  });

  it('a weak year: the scale factor is capped at 0.25 (TE_PY_TREND_CAPPED)', () => {
    const e = expected['capped_min']!;
    const r = run(entityFor('prior_year_scaled', '20000', '20000'));
    expect(Number(r.entities[0]!.projected.ordinary)).toBe(e.projected_ordinary);
    expect(r.entities[0]!.projection).toMatchObject({ capped: 'min', factor: '0.25', rawFactor: '0.2' });
    expect(federalOf(r)).toEqual(e.federal);
    expect(Number(r.federalTotal)).toBe(e.federal_total);
    expect(r.warnings.map((w) => w.code)).toContain('TE_PY_TREND_CAPPED');
  });
});
