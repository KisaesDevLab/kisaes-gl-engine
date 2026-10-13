// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q45 golden test: the engine must match features/tax-estimator/docs/reference-calc/outside_expected.json,
// produced by outside_fixture.py (independent Python from Schedule SE / §199A / Form 8960, no engine
// code). A linked (books) Schedule C mixed with two businesses outside MyBooks built through the app
// bridge (engineEntityFromOutside): a passive partnership K-1 entered as the owner's share (full year)
// and a Schedule C entered year to date through June as the entity total. Federal parameters are the
// shipped 2026 seed file read as text (as in the other golden tests).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import { engineEntityFromOutside } from './bridge.js';
import type { EngineEntity, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';
import type { OutsideEntityDTO, OutsideEntityYearDTO } from '../outside-entities-api.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'features', 'tax-estimator', 'docs', 'reference-calc', 'outside_expected.json'), 'utf8')) as Record<string, Oracle>;

interface Oracle {
  projected: { linked_schc: number; outside_schc: number; outside_k1_share: number };
  federal: { total_income: number; agi: number; taxable_income: number; income_tax: number; se_tax: number; qbi: number; qbi_components: number[]; addl_medicare: number; nii: number; niit: number };
  se: { maya: number; leo: number };
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
  personId, role, displayName: personId, dateOfBirth: '1982-04-04', isBlind: false, sehiEligibleMonths: Array(12).fill(true) as boolean[], w2Wages: '0', w2SocialSecurityWages: null,
  withholding: '0', retirementPlan: 'none', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' },
});

// The linked business: books YTD through September (9 closed months), all recurring.
const linked: EngineEntity = {
  tenantId: 'tenant-1', companyId: 'maya-studio', companyName: 'Maya Studio', entityType: 'sch_c', monthsElapsed: 9, monthsRemaining: 3,
  ytd: characters({ ordinary: '90000' }), recurringYtd: characters({ ordinary: '90000' }), ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
  links: [{ linkId: 'link-maya', personId: 'maya', profitPct: 100, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active', activeParticipation: false, qbiEligible: null, allowedLossOverride: null }],
  isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [],
};

const def = (over: Partial<OutsideEntityDTO>): OutsideEntityDTO => ({
  id: 'x', taxpayerId: 'tp', name: 'x', entityType: 'sch_c', personId: 'maya', personRole: 'primary', profitPct: null, lossPct: null, partnerSeStatus: null,
  isOfficer: false, activityType: 'active', activeParticipation: false, qbiEligible: null, isSstb: false, rentalQbiTradeOrBusiness: false, stateSourcing: null,
  createdAt: '', updatedAt: '', years: [2026], year: null, ...over,
});
const yr = (over: Partial<OutsideEntityYearDTO>): OutsideEntityYearDTO => ({
  outsideEntityId: 'x', taxYear: 2026, entryMode: 'full_year', amountBasis: 'owner_share', throughMonth: null, amounts: characters({}),
  guaranteedPayments: '0', officerWages: '0', ownerSehi: '0', ownerRetirement: '0', sehiAsW2Wages: '0', w2Wages: null, ubia: null,
  includeSehiInW2Wages: false, allowedLossOverride: null, updatedAt: '', ...over,
});

// Outside 1: Maya's K-1 from Lakeside Partners LP — owner's share, 25% stated (informational), full year, passive, limited partner.
const k1 = engineEntityFromOutside(
  def({ id: 'lakeside', name: 'Lakeside Partners LP', entityType: 'partnership', personId: 'maya', profitPct: 25, partnerSeStatus: 'limited', activityType: 'passive' }),
  yr({ outsideEntityId: 'lakeside', amounts: characters({ ordinary: '60000', interest: '2000', dividends_qualified: '3000', capital_gain_lt: '10000' }) }),
);
// Outside 2: Leo's Schedule C, entered year to date through June as the entity total (100%).
const leoSchC = engineEntityFromOutside(
  def({ id: 'leo-design', name: 'Leo Design', entityType: 'sch_c', personId: 'leo', personRole: 'spouse', profitPct: 100 }),
  yr({ outsideEntityId: 'leo-design', entryMode: 'ytd', throughMonth: 6, amountBasis: 'entity_total', amounts: characters({ ordinary: '45000' }) }),
);

const input: FederalEngineInput = {
  taxYear: 2026, filingStatus: 'mfj', parameters: params, persons: [person('maya', 'primary'), person('leo', 'spouse')], dependents: [],
  entities: [linked, k1, leoSchC], adjustments: [],
  year: { rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' },
    creditsNonrefundable: '0', creditsRefundable: '0', careExpenses: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false },
  qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null },
};

describe('Q45 golden — outside businesses oracle (outside_fixture.py)', () => {
  const e = expected['outside_mix']!;
  const r = computeFederal(input);

  it('projections: the linked Sch C (books, 9 months), the outside YTD Sch C (6 months) and the full-year K-1 share', () => {
    const byId = new Map(r.entities.map((x) => [x.companyId, x]));
    expect(Number(byId.get('maya-studio')!.projectedProfit)).toBe(e.projected.linked_schc);
    expect(Number(byId.get('leo-design')!.projectedProfit)).toBe(e.projected.outside_schc);
    expect(Number(byId.get('lakeside')!.projectedProfit)).toBe(e.projected.outside_k1_share);
    expect(byId.get('lakeside')).toMatchObject({ source: 'outside', amountBasis: 'owner_share', entryMode: 'full_year' });
    expect(byId.get('leo-design')).toMatchObject({ source: 'outside', amountBasis: 'entity_total', entryMode: 'ytd' });
    expect(byId.get('maya-studio')!.source).toBeUndefined();
  });

  it('federal lines (SE per spouse, §199A components, worksheet tax, NIIT on the passive K-1) and the total match the oracle', () => {
    expect({
      total_income: Number(r.income.totalIncome), agi: Number(r.agi), taxable_income: Number(r.taxableIncome), income_tax: Number(r.regularTax.tax),
      se_tax: Number(r.seTax), qbi: Number(r.qbi.deduction), qbi_components: ['link-maya', 'outside:leo-design', 'outside:lakeside'].map((id) => Number(r.qbi.components.find((c) => c.linkId === id)!.component)),
      addl_medicare: Number(r.additionalMedicareTax), nii: Number(r.otherTaxes.niit.netInvestmentIncome), niit: Number(r.niit),
    }).toEqual(e.federal);
    expect({ maya: Number(r.persons.find((p) => p.personId === 'maya')!.seTax), leo: Number(r.persons.find((p) => p.personId === 'leo')!.seTax) }).toEqual(e.se);
    expect(Number(r.federalTotal)).toBe(e.federal_total);
  });
});
