// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { engineEntityFromTaxBasisPl, enginePersonFromDto, engineAdjustmentFromDto, engineYearFromDto } from './bridge.js';
import { characters } from './income.js';
import type { TaxBasisPl } from '../entities-api.js';
import type { LinkDTO, PersonDTO } from '../taxpayers-api.js';
import type { AdjustmentDTO, YearSettingsDTO } from '../years-api.js';

const pl: TaxBasisPl = {
  tenantId: 't1', companyId: 'c1', companyName: 'Rivera Plumbing', taxYear: 2026, periodStart: '2026-01-01', throughDate: '2026-08-31', throughMonth: '2026-08',
  throughMonthSource: 'last_closed_month', throughMonthReason: 'x', monthsElapsed: 8, monthsRemaining: 4, basis: 'cash', entityType: 'sch_c', glVersionStamp: 1,
  configVersion: 'v', cached: false, bookNetIncome: '70000.0000', taxBasisProfit: '85333.3333', byCharacter: characters({ ordinary: '85333.3333' }),
  recurring: characters({ ordinary: '85333.3333' }), nonRecurring: characters({}),
  ownerLevel: { ownerSehi: '7200.0000', ownerRetirement: '0.0000', ownerPersonalDropped: '0.0000', sehiAsW2Wages: '0.0000', byPerson: [{ personId: null, ownerSehi: '7200.0000', ownerRetirement: '0.0000', sehiAsW2Wages: '0.0000', employerRetirement: '0.0000', trace: [] }] },
  guaranteedPayments: [], nondeductibleAddBack: '1200.0000', taxDepreciationDiffers: [{ accountId: 'a', name: 'Depreciation', bookAmount: '-4000.0000' }, { accountId: 'b', name: 'Amortization', bookAmount: '-500.0000' }],
  estimatedPayments: [], months: [], farmingGrossIncome: { currentYear: '0', priorYear: '0' },
  w2Wages: { ytd: '0', recurringYtd: '0', nonRecurringYtd: '0', projectedYear: '0', override: null, overrideReason: null, effective: '0', source: 'books', byPerson: [] },
  ubia: null, accounts: [], trace: [], warnings: [{ code: 'TE_UNMAPPED_ACCOUNT', severity: 'warning', message: 'x' }],
};

const link = (over: Partial<LinkDTO>): LinkDTO => ({
  id: 'l1', taxpayerId: 'tp', personId: 'p1', personRole: 'primary', taxYear: 2026, tenantId: 't1', companyId: 'c1', tenantName: 'T', companyName: 'C', entityKind: 'sole',
  returnForm: '1040', outOfScope: false, profitPct: 100, lossPct: null, capitalPct: null, partnerSeStatus: null, partnerSeMemo: null, isOfficer: false, activityType: 'active',
  activeParticipation: false, qbiEligible: null, qbiOverrideReason: null, allowedLossOverride: null, allowedLossReason: null, ...over,
});

describe('engineEntityFromTaxBasisPl', () => {
  it('maps the provider contract, keeping only this company\'s in-scope links for the year', () => {
    const e = engineEntityFromTaxBasisPl(pl, [link({}), link({ id: 'other', companyId: 'c9' }), link({ id: 'oos', outOfScope: true }), link({ id: 'py', taxYear: 2025 })], { isSstb: false, rentalQbiTradeOrBusiness: false });
    expect(e.entityType).toBe('sch_c');
    expect(e.monthsElapsed).toBe(8);
    expect(e.ytd.ordinary).toBe('85333.3333');
    expect(e.ownerItems).toEqual([{ personId: null, sehi: '7200.0000', retirement: '0.0000', sehiAsW2Wages: '0.0000' }]);
    expect(e.taxDepreciationBookYtd).toBe('-4500');
    expect(e.links.map((l) => l.linkId)).toEqual(['l1']);
    expect(e.warnings).toHaveLength(1);
  });
  it('refuses a company without a tax entity type', () => {
    expect(() => engineEntityFromTaxBasisPl({ ...pl, entityType: null }, [], { isSstb: false, rentalQbiTradeOrBusiness: false })).toThrow(/TE_ENTITY_TYPE_MISSING/);
  });
});

const year: YearSettingsDTO = {
  id: 'y', taxpayerId: 'tp', taxYear: 2026, priorYearTax: null, priorYearAgi: null, priorYearTaxPresent: false, priorYearAgiPresent: false, priorYearTwelveMonths: true, priorYearFiled: true,
  safeHarborRule: null, rateMode: 'effective', effectiveRateOverride: 0.18, deductionMode: 'auto', itemized: { saltPaid: 12000, charitableCash: 500 },
  sch1a: { primary: { qualifiedTips: 1000 }, spouse: { qualifiedOvertime: 2500 } }, creditsNonrefundable: '2200.0000', creditsRefundable: '0.0000',
  hsaCoverage: { primary: 'family' }, withholding: { federal: 6000 }, createdAt: '', updatedAt: '',
};

describe('enginePersonFromDto / engineYearFromDto', () => {
  it('maps persons with their role-specific year inputs', () => {
    const p: PersonDTO = { id: 'p1', taxpayerId: 'tp', role: 'primary', firstName: 'Carlos', lastName: 'Rivera', dateOfBirth: '1981-05-10', isBlind: false, sehiEligibleMonths: Array(12).fill(true) };
    const e = enginePersonFromDto(p, year, { retirementPlan: 'sep', w2Wages: 1000 });
    expect(e.displayName).toBe('Carlos Rivera');
    expect(e.hsaCoverage).toBe('family');
    expect(e.sch1a).toEqual({ qualifiedTips: '1000', qualifiedOvertime: '0', carLoanInterest: '0' });
    expect(e.w2Wages).toBe('1000');
    expect(e.retirementPlan).toBe('sep');
    const s = enginePersonFromDto({ ...p, id: 'p2', role: 'spouse', firstName: 'Maria' }, year);
    expect(s.hsaCoverage).toBe('none');
    expect(s.sch1a.qualifiedOvertime).toBe('2500');
    expect(s.retirementPlan).toBeNull();
  });
  it('maps year inputs to decimal strings', () => {
    const y = engineYearFromDto(year, { unrecaptured1250Gain: 300 });
    expect(y.rateMode).toBe('effective');
    expect(y.effectiveRateOverride).toBe('0.18');
    expect(y.itemized).toEqual({ saltPaid: '12000', mortgageInterest: '0', charitableCash: '500', charitableNoncash: '0', other: '0' });
    expect(y.creditsNonrefundable).toBe('2200');
    expect(y.unrecaptured1250Gain).toBe('300');
    expect(y.collectiblesGain).toBe('0');
  });
});

describe('engineAdjustmentFromDto', () => {
  it('sums the 12-month allocation to the full-year amount and copies the type flags', () => {
    const a: AdjustmentDTO = {
      id: 'a1', scenarioId: 's', adjustmentTypeId: 't', adjustmentTypeName: 'Meals (50%)', personId: null, linkId: 'l1', label: '', amount: '3600', pct: null, cadence: 'monthly',
      startMonth: 1, endMonth: 12, glLinked: false, tenantId: null, companyId: null, accountId: null, nonRecurring: false, memo: null, monthly: Array(12).fill(300), createdAt: '', updatedAt: '',
    };
    const e = engineAdjustmentFromDto(a, { code: 'meals', kind: 'addback', affectsSe: true, affectsQbi: true, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false, isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false, defaultPct: 50 });
    expect(e.amount).toBe('3600');
    expect(e.pct).toBe(50);
    expect(e.label).toBe('Meals (50%)');
    expect(e.kind).toBe('addback');
    expect(e.affectsSe).toBe(true);
    expect(e.linkId).toBe('l1');
  });
});
