// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import {
  characters, sumCharacters, projectAmount, projectCharacters, allocateEntity, aggregatePersons, netIncome,
} from './income.js';
import type { EngineAdjustment, EngineEntity, EngineLink, EnginePerson, ParameterMap } from './types.js';

const params: ParameterMap = {
  'capital_loss.limit.standard': { key: 'capital_loss.limit.standard', value: 3000, status: 'verified' },
  'capital_loss.limit.mfs': { key: 'capital_loss.limit.mfs', value: 1500, status: 'verified' },
};

const person = (id: string, role: 'primary' | 'spouse', extra: Partial<EnginePerson> = {}): EnginePerson => ({
  personId: id, role, displayName: id, dateOfBirth: null, isBlind: false, sehiEligibleMonths: Array(12).fill(true),
  w2Wages: '0', w2SocialSecurityWages: null, withholding: '0', retirementPlan: null, retirementEmployeeDeferral: null,
  hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' }, ...extra,
});

const link = (linkId: string, personId: string, extra: Partial<EngineLink> = {}): EngineLink => ({
  linkId, personId, profitPct: null, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active',
  activeParticipation: false, qbiEligible: null, allowedLossOverride: null, ...extra,
});

const entity = (extra: Partial<EngineEntity>): EngineEntity => ({
  tenantId: 't', companyId: 'c', companyName: 'Co', entityType: 'sch_c', monthsElapsed: 12, monthsRemaining: 0,
  ytd: characters({}), recurringYtd: characters({}), ownerItems: [], guaranteedPayments: [], officerWages: [],
  taxDepreciationBookYtd: '0', links: [], isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null,
  warnings: [], ...extra,
});

const adj = (extra: Partial<EngineAdjustment>): EngineAdjustment => ({
  id: 'a', label: 'adj', typeCode: null, kind: 'income', amount: '0', pct: null, personId: null, linkId: null,
  affectsSe: false, affectsQbi: false, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false,
  isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false, ...extra,
});

function ctxWith(persons: EnginePerson[]): EngineContext {
  const ctx = new EngineContext(params, 2026, 'mfj');
  ctx.setPersons(persons);
  return ctx;
}

describe('projection', () => {
  it('extrapolates the recurring run-rate and counts non-recurring once', () => {
    // 8 closed months: recurring 80,000 YTD (10,000/mo), non-recurring 5,000 once → 80,000 + 5,000 + 4 × 10,000
    expect(projectAmount('85000', '80000', 8, 4)).toBe('125000');
    expect(projectAmount('85000', '85000', 12, 0)).toBe('85000');
  });
  it('projects every character and treats zero elapsed months as YTD only', () => {
    const p = projectCharacters(characters({ ordinary: '6000', rental: '-300' }), characters({ ordinary: '6000', rental: '-300' }), 6, 6);
    expect(p.ordinary).toBe('12000');
    expect(p.rental).toBe('-600');
    expect(p.interest).toBe('0');
    expect(projectCharacters(characters({ ordinary: '5' }), characters({ ordinary: '5' }), 0, 12).ordinary).toBe('5');
  });
});

describe('allocateEntity', () => {
  it('gives a single-link Sch C 100% and makes its ordinary share SE income', () => {
    const ctx = ctxWith([person('p1', 'primary')]);
    const e = entity({ ytd: characters({ ordinary: '128000', interest: '100' }), recurringYtd: characters({ ordinary: '128000', interest: '100' }), links: [link('l1', 'p1')] });
    const r = allocateEntity(e, [], ctx);
    expect(r.projectedProfit).toBe('128100');
    expect(r.shares).toHaveLength(1);
    expect(r.shares[0]!.profitFraction).toBe('1');
    expect(r.shares[0]!.share.ordinary).toBe('128000');
    expect(r.shares[0]!.share.interest).toBe('100');
    expect(r.shares[0]!.seIncome).toBe('128000');
  });

  it('allocates partnership profit by profit_pct and a net loss by loss_pct', () => {
    const ctx = ctxWith([person('p1', 'primary'), person('p2', 'spouse')]);
    const links = [link('l1', 'p1', { profitPct: 60, lossPct: 50, partnerSeStatus: 'general' }), link('l2', 'p2', { profitPct: 40, lossPct: 50, partnerSeStatus: 'limited' })];
    const profit = allocateEntity(entity({ entityType: 'partnership', ytd: characters({ ordinary: '1000' }), recurringYtd: characters({ ordinary: '1000' }), links }), [], ctx);
    expect(profit.shares.map((s) => s.share.ordinary)).toEqual(['600', '400']);
    const loss = allocateEntity(entity({ entityType: 'partnership', ytd: characters({ ordinary: '-1000' }), recurringYtd: characters({ ordinary: '-1000' }), links }), [], ctx);
    expect(loss.shares.map((s) => s.share.ordinary)).toEqual(['-500', '-500']);
  });

  it('applies partner SE status: general = ordinary + GP; limited = GP only; excludes rental/interest/gains', () => {
    const ctx = ctxWith([person('p1', 'primary'), person('p2', 'spouse')]);
    const e = entity({
      entityType: 'partnership',
      ytd: characters({ ordinary: '1000', rental: '500', interest: '200', capital_gain_lt: '300' }),
      recurringYtd: characters({ ordinary: '1000', rental: '500', interest: '200', capital_gain_lt: '300' }),
      guaranteedPayments: [{ personId: 'p1', amount: '2000' }, { personId: 'p2', amount: '700' }],
      links: [link('l1', 'p1', { profitPct: 50, partnerSeStatus: 'general' }), link('l2', 'p2', { profitPct: 50, partnerSeStatus: 'limited' })],
    });
    const r = allocateEntity(e, [], ctx);
    expect(r.shares[0]!.guaranteedPayment).toBe('2000');
    expect(r.shares[0]!.seIncome).toBe('2500');
    expect(r.shares[1]!.guaranteedPayment).toBe('700');
    expect(r.shares[1]!.seIncome).toBe('700');
    expect(r.shares[1]!.share.rental).toBe('250');
  });

  it('S corp: no SE income; officer wages and >2% health go to the officer as W-2', () => {
    const ctx = ctxWith([person('p1', 'primary'), person('p2', 'spouse')]);
    const e = entity({
      entityType: 's_corp',
      ytd: characters({ ordinary: '80000' }), recurringYtd: characters({ ordinary: '80000' }),
      officerWages: [{ personId: 'p2', amount: '54000' }],
      ownerItems: [{ personId: 'p2', sehi: '6000', retirement: '0', sehiAsW2Wages: '6000' }],
      links: [link('l1', 'p1', { profitPct: 50 }), link('l2', 'p2', { profitPct: 50, isOfficer: true })],
    });
    const r = allocateEntity(e, [], ctx);
    expect(r.shares[1]!.officerWages).toBe('54000');
    expect(r.shares[1]!.sehiAsW2Wages).toBe('6000');
    expect(r.shares[1]!.ownerSehi).toBe('6000');
    expect(r.shares[1]!.seIncome).toBe('0');
    expect(r.shares[0]!.share.ordinary).toBe('40000');
  });

  it('routes a null-person owner item to the single owner and warns on a multi-link ambiguity', () => {
    const ctx = ctxWith([person('p1', 'primary'), person('p2', 'spouse')]);
    const single = allocateEntity(entity({ ownerItems: [{ personId: null, sehi: '10800', retirement: '15000', sehiAsW2Wages: '0' }], links: [link('l1', 'p2')] }), [], ctx);
    expect(single.shares[0]!.personId).toBe('p2');
    expect(single.shares[0]!.ownerSehi).toBe('10800');
    expect(single.shares[0]!.ownerRetirement).toBe('15000');
  });

  it('warns and allocates nothing when a multi-link entity has no profit_pct', () => {
    const ctx = ctxWith([person('p1', 'primary'), person('p2', 'spouse')]);
    const r = allocateEntity(entity({ entityType: 'partnership', ytd: characters({ ordinary: '100' }), recurringYtd: characters({ ordinary: '100' }), links: [link('l1', 'p1'), link('l2', 'p2')] }), [], ctx);
    expect(r.shares.map((s) => s.share.ordinary)).toEqual(['0', '0']);
    expect(ctx.allWarnings().some((w) => w.code === 'TE_LINK_PCT_MISSING')).toBe(true);
  });

  it('applies link adjustments: meals addback × pct, §179 deduction (SE), tax-vs-book depreciation swap', () => {
    const ctx = ctxWith([person('p1', 'primary')]);
    const e = entity({ ytd: characters({ ordinary: '100000' }), recurringYtd: characters({ ordinary: '100000' }), taxDepreciationBookYtd: '-8000', links: [link('l1', 'p1')] });
    const adjustments = [
      adj({ id: 'm', typeCode: 'meals', kind: 'addback', amount: '3600', pct: 50, linkId: 'l1', affectsSe: true }),
      adj({ id: 'v', typeCode: 'vehicle_179', kind: 'deduction', amount: '60000', linkId: 'l1', affectsSe: true }),
      adj({ id: 'd', typeCode: 'depreciation_tax_vs_book', kind: 'deduction', amount: '11000', linkId: 'l1', affectsSe: true }),
    ];
    const r = allocateEntity(e, adjustments, ctx);
    // 100,000 + 1,800 − 60,000 + 8,000 (book back) − 11,000 (tax)
    expect(r.shares[0]!.share.ordinary).toBe('38800');
    expect(r.shares[0]!.seIncome).toBe('38800');
  });

  it('projects a partial year before allocating', () => {
    const ctx = ctxWith([person('p1', 'primary')]);
    const e = entity({ monthsElapsed: 8, monthsRemaining: 4, ytd: characters({ ordinary: '85333.3333' }), recurringYtd: characters({ ordinary: '85333.3333' }), links: [link('l1', 'p1')] });
    const r = allocateEntity(e, [], ctx);
    expect(r.projected.ordinary).toBe('127999.99995');
  });
});

describe('aggregatePersons + netIncome', () => {
  it('sums wages, characters, pools and taxpayer-level adjustments per person', () => {
    const p1 = person('p1', 'primary'); const p2 = person('p2', 'spouse', { w2Wages: '54000' });
    const ctx = ctxWith([p1, p2]);
    const schc = allocateEntity(entity({ ytd: characters({ ordinary: '128000' }), recurringYtd: characters({ ordinary: '128000' }), ownerItems: [{ personId: null, sehi: '10800', retirement: '0', sehiAsW2Wages: '0' }], links: [link('l1', 'p1')] }), [], ctx);
    const lp = allocateEntity(entity({ companyId: 'lp', entityType: 'partnership', ytd: characters({ rental: '8000' }), recurringYtd: characters({ rental: '8000' }), links: [link('l2', 'p1', { partnerSeStatus: 'limited', activityType: 'rental' })] }), [], ctx);
    const adjustments = [
      adj({ id: 'i', typeCode: 'interest_income', kind: 'income', amount: '2400' }),
      adj({ id: 's', typeCode: 'sep_solo_401k', kind: 'deduction', amount: '15000', isAboveTheLine: true, personId: 'p1' }),
      adj({ id: 'h', typeCode: 'hsa_contribution', kind: 'deduction', amount: '1000', isAboveTheLine: true, personId: 'p2' }),
      adj({ id: 'o', typeCode: 'other_deduction', kind: 'deduction', amount: '500', isAboveTheLine: true }),
      adj({ id: 'x', typeCode: 'other_deduction', kind: 'deduction', amount: '250' }),
      adj({ id: 'q', typeCode: 'qualified_dividend', kind: 'income', amount: '300', isQualifiedDividend: true, personId: 'p2' }),
    ];
    const agg = aggregatePersons([schc, lp], [p1, p2], adjustments, ctx);
    const a = agg.byPerson.get('p1')!; const b = agg.byPerson.get('p2')!;
    expect(a.character.ordinary).toBe('128000');
    expect(a.character.rental).toBe('8000');
    expect(a.character.interest).toBe('2400');
    expect(a.seIncome).toBe('128000');
    expect(a.sehiPremiums).toBe('10800');
    expect(a.retirementContributions).toBe('15000');
    expect(b.wages).toBe('54000');
    expect(b.hsaContributions).toBe('1000');
    expect(b.character.dividends_qualified).toBe('300');
    expect(b.character.dividends_ordinary).toBe('0'); // R2-01: the buckets are exclusive
    expect(agg.otherAboveTheLine).toBe('500');
    expect(agg.itemizedOther).toBe('250');
    const inc = netIncome([...agg.byPerson.values()], ctx);
    expect(inc.totalIncome).toBe('192700');
    expect(inc.wages).toBe('54000');
    expect(inc.dividends).toBe('300');
    expect(inc.qualifiedDividends).toBe('300');
  });

  it('nets capital gains, treats net §1231 gain as long-term, and limits a net loss under §1211', () => {
    const p1 = person('p1', 'primary');
    const ctx = ctxWith([p1]);
    const adjustments = [
      adj({ id: 'st', kind: 'income', amount: '-9000', isCapitalGainSt: true }),
      adj({ id: 'lt', kind: 'income', amount: '2000', isCapitalGainLt: true }),
      adj({ id: '1231', kind: 'income', amount: '1500', is1231: true }),
    ];
    const agg = aggregatePersons([], [p1], adjustments, ctx);
    const inc = netIncome([...agg.byPerson.values()], ctx);
    expect(inc.capitalGainShortTerm).toBe('-9000');
    expect(inc.capitalGainLongTerm).toBe('3500');
    expect(inc.capitalGainNet).toBe('-3000');
    expect(inc.capitalLossDisallowed).toBe('2500');
    expect(inc.totalIncome).toBe('-3000');
    expect(ctx.allWarnings().some((w) => w.code === 'TE_CAPITAL_LOSS_LIMITED')).toBe(true);
    expect(inc.netLongTermGainForWorksheet).toBe('0');
  });

  it('a net §1231 loss is ordinary and a net gain feeds the worksheet', () => {
    const p1 = person('p1', 'primary');
    const ctx = ctxWith([p1]);
    const loss = netIncome([...aggregatePersons([], [p1], [adj({ id: 'a', kind: 'income', amount: '-400', is1231: true })], ctx).byPerson.values()], ctx);
    expect(loss.section1231).toBe('-400');
    expect(loss.businessOrdinary).toBe('-400');
    expect(loss.capitalGainLongTerm).toBe('0');
    const gain = netIncome([...aggregatePersons([], [p1], [adj({ id: 'a', kind: 'income', amount: '400', is1231: true }), adj({ id: 'b', kind: 'income', amount: '100', isCapitalGainSt: true })], ctx).byPerson.values()], ctx);
    expect(gain.capitalGainLongTerm).toBe('400');
    expect(gain.capitalGainNet).toBe('500');
    expect(gain.netLongTermGainForWorksheet).toBe('400');
  });

  it('R2-01: qualified dividends are counted exactly once whether they come from the books or an adjustment', () => {
    const p1 = person('p1', 'primary');
    const ctx = ctxWith([p1]);
    const books = allocateEntity(entity({ companyId: 'inv', entityType: 'partnership', ytd: characters({ ordinary: '100000', dividends_qualified: '20000' }), recurringYtd: characters({ ordinary: '100000', dividends_qualified: '20000' }), links: [link('l1', 'p1', { partnerSeStatus: 'limited', activityType: 'investment' })] }), [], ctx);
    expect(sumCharacters(books.shares[0]!.share)).toBe('120000');
    const fromBooks = netIncome([...aggregatePersons([books], [p1], [], ctx).byPerson.values()], ctx);
    const fromAdj = netIncome([...aggregatePersons([], [p1], [adj({ id: 'o', kind: 'income', amount: '100000' }), adj({ id: 'qd', kind: 'income', amount: '20000', isQualifiedDividend: true })], ctx).byPerson.values()], ctx);
    for (const inc of [fromBooks, fromAdj]) {
      expect(inc.totalIncome).toBe('120000');
      expect(inc.dividends).toBe('20000');
      expect(inc.qualifiedDividends).toBe('20000');
    }
    const aggAdj = aggregatePersons([], [p1], [adj({ id: 'qd', kind: 'income', amount: '20000', isQualifiedDividend: true })], ctx);
    expect(sumCharacters(aggAdj.byPerson.get('p1')!.character)).toBe('20000');
    expect(aggAdj.byPerson.get('p1')!.character.dividends_ordinary).toBe('0');
  });

  it('R2-12: a deduction adjustment with no link and not above the line is reported as itemized "other"', () => {
    const p1 = person('p1', 'primary');
    const ctx = ctxWith([p1]);
    const agg = aggregatePersons([], [p1], [adj({ id: 'x', label: 'Section 179', typeCode: 'vehicle_179', kind: 'deduction', amount: '250' })], ctx);
    expect(agg.itemizedOther).toBe('250');
    const w = ctx.allWarnings().find((x) => x.code === 'TE_ADJUSTMENT_UNLINKED_DEDUCTION');
    expect(w).toBeDefined();
    expect(w!.details).toMatchObject({ adjustmentId: 'x' });
  });

  it('R2-17: a net entity loss allocated by loss % notes that positive items follow the loss %', () => {
    const ctx = ctxWith([person('p1', 'primary'), person('p2', 'spouse')]);
    const links = [link('l1', 'p1', { profitPct: 50, lossPct: 90, partnerSeStatus: 'limited' }), link('l2', 'p2', { profitPct: 50, lossPct: 10, partnerSeStatus: 'limited' })];
    const r = allocateEntity(entity({ entityType: 'partnership', ytd: characters({ ordinary: '-50000', rental: '10000' }), recurringYtd: characters({ ordinary: '-50000', rental: '10000' }), links }), [], ctx);
    expect(r.shares[0]!.share.rental).toBe('9000');
    expect(ctx.allWarnings().some((w) => w.code === 'TE_LOSS_PCT_ALL_ITEMS')).toBe(true);
  });

  it('R2-23: the synthetic share for owner items without a link is not a QBI component', () => {
    const ctx = ctxWith([person('p1', 'primary'), person('p2', 'spouse')]);
    const r = allocateEntity(entity({ entityType: 'partnership', ytd: characters({ ordinary: '1000' }), recurringYtd: characters({ ordinary: '1000' }), guaranteedPayments: [{ personId: 'p2', amount: '5000' }], links: [link('l1', 'p1', { partnerSeStatus: 'general' })] }), [], ctx);
    const synthetic = r.shares.find((s) => s.personId === 'p2')!;
    expect(synthetic.qbiEligible).toBe(false);
    expect(synthetic.seIncome).toBe('5000');
    expect(ctx.allWarnings().some((w) => w.code === 'TE_OWNER_ITEM_NO_LINK')).toBe(true);
  });

  it('uses the MFS capital loss limit', () => {
    const p1 = person('p1', 'primary');
    const ctx = new EngineContext(params, 2026, 'mfs'); ctx.setPersons([p1]);
    const inc = netIncome([...aggregatePersons([], [p1], [adj({ id: 'a', kind: 'income', amount: '-5000', isCapitalGainLt: true })], ctx).byPerson.values()], ctx);
    expect(inc.capitalGainNet).toBe('-1500');
  });
});
