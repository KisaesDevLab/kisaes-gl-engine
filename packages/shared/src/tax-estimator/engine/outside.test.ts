// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q45: businesses outside MyBooks enter the engine through engineEntityFromOutside and must
// flow through every step exactly like a linked business (allocation, SE, QBI, §469, NIIT,
// state sourcing), with the entry mode (full-year / YTD) and basis (entity total / owner share).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFederal } from './federal.js';
import { characters } from './income.js';
import { engineEntityFromOutside, outsidePeriodEntity } from './bridge.js';
import { sourcedEntitiesFromFederal } from './state.js';
import type { EngineEntity, EnginePerson, FederalEngineInput, ParameterMap } from './types.js';
import type { OutsideEntityDTO, OutsideEntityYearDTO } from '../outside-entities-api.js';
import type { CharacterAmounts } from '../entities-api.js';

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

const person = (personId: string, role: 'primary' | 'spouse'): EnginePerson => ({
  personId, role, displayName: personId, dateOfBirth: '1980-01-01', isBlind: false, sehiEligibleMonths: Array(12).fill(true) as boolean[], w2Wages: '0', w2SocialSecurityWages: null,
  withholding: '0', retirementPlan: 'none', retirementEmployeeDeferral: null, hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' },
});
const def = (over: Partial<OutsideEntityDTO> = {}): OutsideEntityDTO => ({
  id: 'o1', taxpayerId: 'tp', name: 'Outside LP', entityType: 'partnership', personId: 'ana', personRole: 'primary', profitPct: 25, lossPct: null,
  partnerSeStatus: 'limited', isOfficer: false, activityType: 'passive', activeParticipation: false, qbiEligible: null, isSstb: false,
  rentalQbiTradeOrBusiness: false, stateSourcing: null, createdAt: '', updatedAt: '', years: [2026], year: null, ...over,
});
const amounts = (a: Partial<CharacterAmounts>): CharacterAmounts => characters(a);
const yr = (over: Partial<OutsideEntityYearDTO> = {}): OutsideEntityYearDTO => ({
  outsideEntityId: 'o1', taxYear: 2026, entryMode: 'full_year', amountBasis: 'owner_share', throughMonth: null, amounts: amounts({}),
  guaranteedPayments: '0', officerWages: '0', ownerSehi: '0', ownerRetirement: '0', sehiAsW2Wages: '0', w2Wages: null, ubia: null,
  includeSehiInW2Wages: false, allowedLossOverride: null, updatedAt: '', ...over,
});
function input(entities: EngineEntity[], persons: EnginePerson[] = [person('ana', 'primary'), person('ben', 'spouse')]): FederalEngineInput {
  return {
    taxYear: 2026, filingStatus: 'mfj', parameters: params, persons, dependents: [], entities, adjustments: [],
    year: { rateMode: 'brackets', effectiveRateOverride: null, deductionMode: 'auto', itemized: { saltPaid: '0', mortgageInterest: '0', charitableCash: '0', charitableNoncash: '0', other: '0' },
      creditsNonrefundable: '0', creditsRefundable: '0', careExpenses: '0', unrecaptured1250Gain: '0', collectiblesGain: '0', amtExposureFlagged: false },
    qbi: { manualDeduction: null }, otherTaxes: { additionalMedicareTax: null, niit: null },
  };
}

describe('engineEntityFromOutside (Q45 bridge)', () => {
  it('full year + owner share: closed year, a 100% link whatever the stated %, markers set', () => {
    const e = engineEntityFromOutside(def(), yr({ amounts: amounts({ ordinary: '60000' }) }));
    expect(e).toMatchObject({ tenantId: 'outside', companyId: 'o1', monthsElapsed: 12, monthsRemaining: 0, source: 'outside', amountBasis: 'owner_share', entryMode: 'full_year' });
    expect(e.links).toEqual([expect.objectContaining({ linkId: 'outside:o1', personId: 'ana', profitPct: null, lossPct: null, partnerSeStatus: 'limited', activityType: 'passive' })]);
  });

  it('YTD + entity total: months from the through month, the stated % on the link, type-specific fields dropped', () => {
    const e = engineEntityFromOutside(def({ entityType: 'sch_c', partnerSeStatus: 'general', isOfficer: true, profitPct: 40, lossPct: 60, activityType: 'active' }),
      yr({ entryMode: 'ytd', throughMonth: 6, amountBasis: 'entity_total', amounts: amounts({ ordinary: '45000' }), guaranteedPayments: '5000', officerWages: '9000', sehiAsW2Wages: '100' }));
    expect(e).toMatchObject({ monthsElapsed: 6, monthsRemaining: 6, guaranteedPayments: [], officerWages: [], ownerItems: [] });
    expect(e.links[0]).toMatchObject({ profitPct: 40, lossPct: 60, partnerSeStatus: null, isOfficer: false });
  });
});

describe('Q45 outside businesses through the federal engine', () => {
  it('owner share (K-1): the whole entered amount is the share although 25% is stated; passive ordinary is not SE, is QBI and is NII', () => {
    const r = computeFederal(input([engineEntityFromOutside(def(), yr({ amounts: amounts({ ordinary: '300000', interest: '2000' }) }))]));
    const e = r.entities[0]!;
    expect(e).toMatchObject({ source: 'outside', amountBasis: 'owner_share', entryMode: 'full_year', projectedProfit: '302000' });
    expect(e.shares[0]).toMatchObject({ profitFraction: '1', seIncome: '0' });
    expect(r.income.totalIncome).toBe('302000');
    expect(r.seTax).toBe('0');
    expect(r.qbi.components[0]).toMatchObject({ linkId: 'outside:o1', eligible: true, qualifiedItems: '300000' });
    // NII = interest 2,000 + passive K-1 ordinary 300,000; MAGI 302,000 − 250,000 = 52,000 → 3.8%.
    expect(r.otherTaxes.niit.passiveOrdinary).toBe('300000');
    expect(r.niit).toBe('1976');
  });

  it('entity total: the profit % allocates a profit, the loss % a loss', () => {
    const d = def({ entityType: 's_corp', partnerSeStatus: null, profitPct: 40, lossPct: 60, activityType: 'active' });
    const profit = computeFederal(input([engineEntityFromOutside(d, yr({ amountBasis: 'entity_total', amounts: amounts({ ordinary: '100000' }) }))]));
    expect(profit.entities[0]!.shares[0]!.share.ordinary).toBe('40000');
    expect(profit.entities[0]!.projectedProfit).toBe('100000');
    const loss = computeFederal(input([engineEntityFromOutside(d, yr({ amountBasis: 'entity_total', amounts: amounts({ ordinary: '-50000' }) }))]));
    expect(loss.entities[0]!.shares[0]!.share.ordinary).toBe('-30000');
  });

  it('YTD mode projects like a linked business: an outside Sch C through June equals the same book entity', () => {
    const outside = engineEntityFromOutside(def({ id: 'o2', name: 'Ben Design', entityType: 'sch_c', personId: 'ben', personRole: 'spouse', partnerSeStatus: null, profitPct: 100, activityType: 'active' }),
      yr({ outsideEntityId: 'o2', entryMode: 'ytd', throughMonth: 6, amountBasis: 'entity_total', amounts: amounts({ ordinary: '45000' }) }));
    const book: EngineEntity = { ...outside, tenantId: 't', companyId: 'c', source: undefined, amountBasis: undefined, entryMode: undefined, links: [{ ...outside.links[0]!, linkId: 'l' }] };
    const a = computeFederal(input([outside]));
    const b = computeFederal(input([book]));
    expect(a.entities[0]!.projectedProfit).toBe('90000');
    expect(a.federalTotal).toBe(b.federalTotal);
    expect(a.seTax).toBe(b.seTax);
    expect(a.qbi.deduction).toBe(b.qbi.deduction);
    expect(Number(a.seTax)).toBeGreaterThan(0);
    expect(b.entities[0]!.source).toBeUndefined(); // book results carry no marker (rc.4 shape)
  });

  it('a passive K-1 loss with no passive income is suspended under §469; an active one is allowed', () => {
    const passive = computeFederal(input([engineEntityFromOutside(def(), yr({ amounts: amounts({ ordinary: '-20000' }) }))]));
    expect(passive.lossLimitations.suspendedPassiveLoss).toBe('20000');
    expect(passive.income.totalIncome).toBe('0');
    const active = computeFederal(input([engineEntityFromOutside(def({ activityType: 'active', partnerSeStatus: 'general' }), yr({ amounts: amounts({ ordinary: '-20000' }) }))]));
    expect(active.lossLimitations.suspendedPassiveLoss).toBe('0');
    expect(active.income.totalIncome).toBe('-20000');
  });

  it('guaranteed payments, officer wages and owner items are the owner\'s own (never × the entity %)', () => {
    const gp = computeFederal(input([engineEntityFromOutside(def({ partnerSeStatus: 'general', activityType: 'active', profitPct: 50 }),
      yr({ amountBasis: 'entity_total', amounts: amounts({ ordinary: '100000' }), guaranteedPayments: '30000' }))]));
    expect(gp.income.guaranteedPayments).toBe('30000');
    expect(gp.persons.find((p) => p.personId === 'ana')!.seIncome).toBe('80000'); // 50% × 100,000 + GP 30,000
    const sc = computeFederal(input([engineEntityFromOutside(def({ entityType: 's_corp', partnerSeStatus: null, isOfficer: true, activityType: 'active' }),
      yr({ amounts: amounts({ ordinary: '50000' }), officerWages: '60000', w2Wages: '60000' }))]));
    expect(sc.income.wages).toBe('60000');
    expect(sc.seTax).toBe('0');
  });

  it('state sourcing maps by the outside id like a company id', () => {
    const r = computeFederal(input([engineEntityFromOutside(def({ activityType: 'active' }), yr({ amounts: amounts({ ordinary: '10000' }) }))]));
    const sourced = sourcedEntitiesFromFederal(r, [{ companyId: 'o1', stateSourcing: 'KS' }]);
    expect(sourced).toEqual([expect.objectContaining({ companyId: 'o1', state: 'KS', income: '10000' })]);
  });
});

describe('outsidePeriodEntity (Schedule AI period figures)', () => {
  it('full year: spread evenly by month; W-2 wages prorated, UBIA kept', () => {
    const e = engineEntityFromOutside(def(), yr({ amounts: amounts({ ordinary: '120000' }), w2Wages: '24000', ubia: '50000' }));
    const p = outsidePeriodEntity(e, 3)!;
    expect(Number(p.ytd.ordinary)).toBe(30000);
    expect(Number(p.w2WagesEffective)).toBe(6000);
    expect(p.ubia).toBe(e.ubia);
    expect(p).toMatchObject({ monthsElapsed: 3, monthsRemaining: 9 });
  });

  it('YTD through June: periods ending by June prorate the YTD; later periods are unavailable', () => {
    const e = engineEntityFromOutside(def(), yr({ entryMode: 'ytd', throughMonth: 6, amounts: amounts({ ordinary: '60000' }) }));
    expect(Number(outsidePeriodEntity(e, 3)!.ytd.ordinary)).toBe(30000);
    expect(Number(outsidePeriodEntity(e, 5)!.ytd.ordinary)).toBe(50000);
    expect(outsidePeriodEntity(e, 8)).toBeNull();
  });
});
