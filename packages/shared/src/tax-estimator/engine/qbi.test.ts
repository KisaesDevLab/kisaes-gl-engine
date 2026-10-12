// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { characters, allocateEntity, aggregatePersons } from './income.js';
import { computeQbi, type QbiContext, type QbiPersonDeductions } from './qbi.js';
import type { EngineAdjustment, EngineEntity, EngineLink, EnginePerson, ParameterMap, QbiInput } from './types.js';
import type { FilingStatus } from '../types.js';

const params: ParameterMap = Object.fromEntries(Object.entries({
  'qbi.rate': 0.2, 'qbi.threshold.mfj': 403500, 'qbi.phase_in_range.mfj': 150000, 'qbi.threshold.single': 201750, 'qbi.phase_in_range.single': 75000,
  'qbi.w2_wage_pct': 0.5, 'qbi.alt_w2_wage_pct': 0.25, 'qbi.ubia_pct': 0.025, 'qbi.taxable_income_limit_pct': 0.2,
  'qbi.min_deduction_amount': 400, 'qbi.min_deduction_active_qbi_threshold': 1000,
}).map(([key, value]) => [key, { key, value, status: 'verified' as const }]));

const P = 'p1';
const person = (): EnginePerson => ({
  personId: P, role: 'primary', displayName: 'P', dateOfBirth: null, isBlind: false, sehiEligibleMonths: Array(12).fill(true),
  w2Wages: '0', w2SocialSecurityWages: null, withholding: '0', retirementPlan: null, retirementEmployeeDeferral: null,
  hsaCoverage: 'none', hsaContribution: '0', sch1a: { qualifiedTips: '0', qualifiedOvertime: '0', carLoanInterest: '0' },
});
const link = (linkId: string, extra: Partial<EngineLink> = {}): EngineLink => ({
  linkId, personId: P, profitPct: null, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active',
  activeParticipation: false, qbiEligible: null, allowedLossOverride: null, ...extra,
});
const entity = (companyId: string, ordinary: string, extra: Partial<EngineEntity> = {}, l: Partial<EngineLink> = {}): EngineEntity => ({
  tenantId: 't', companyId, companyName: companyId, entityType: 'sch_c', monthsElapsed: 12, monthsRemaining: 0,
  ytd: characters({ ordinary }), recurringYtd: characters({ ordinary }), ownerItems: [], guaranteedPayments: [], officerWages: [],
  taxDepreciationBookYtd: '0', links: [link(`l-${companyId}`, l)], isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null,
  warnings: [], ...extra,
});
const adj = (extra: Partial<EngineAdjustment>): EngineAdjustment => ({
  id: 'a', label: 'adj', typeCode: null, kind: 'income', amount: '0', pct: null, personId: null, linkId: null,
  affectsSe: false, affectsQbi: true, isCapitalGainLt: false, isCapitalGainSt: false, isQualifiedDividend: false,
  isReitDividend: false, isPtp: false, is1231: false, isAboveTheLine: false, nonRecurring: false, ...extra,
});

interface Opts { ti: string; fs?: FilingStatus; ncg?: string; ded?: Partial<QbiPersonDeductions>; adjustments?: EngineAdjustment[]; s1231?: string; input?: QbiInput }
function run(entities: EngineEntity[], o: Opts) {
  const ctx = new EngineContext(params, 2026, o.fs ?? 'mfj');
  const persons = [person()];
  ctx.setPersons(persons);
  const adjustments = o.adjustments ?? [];
  const allocated = entities.map((e) => allocateEntity(e, adjustments, ctx));
  const income = aggregatePersons(allocated, persons, adjustments, ctx);
  const q: QbiContext = {
    taxableIncomeBeforeQbi: o.ti, netCapitalGainWithQd: o.ncg ?? '0', income, entities: allocated, adjustments,
    personDeductions: new Map([[P, { halfSeTax: '0', sehi: '0', retirement: '0', ...o.ded }]]), section1231Net: o.s1231 ?? '0',
  };
  const r = computeQbi(o.input ?? { manualDeduction: null }, q, ctx);
  return { r, ctx, comp: (id: string) => r.components.find((c) => c.linkId === id)! };
}
const warned = (ctx: EngineContext, code: string) => ctx.allWarnings().some((w) => w.code === code);

describe('§199A below the threshold', () => {
  it('deducts rate × QBI with no W-2 / UBIA limit and no missing-UBIA warning', () => {
    const { r, ctx, comp } = run([entity('c', '100000')], { ti: '150000' });
    expect(r.method).toBe('computed');
    expect(r.deduction).toBe('20000');
    expect(r.computedDeduction).toBe('20000');
    expect(r.phaseInFraction).toBe('0');
    expect(comp('l-c').wageUbiaLimit).toBeNull();
    expect(comp('l-c').component).toBe('20000');
    expect(r.overallLimit).toBe('30000');
    expect(warned(ctx, 'TE_QBI_UBIA_MISSING')).toBe(false);
  });
  it('reduces QBI by the attributable ½ SE tax, SEHI and retirement deductions', () => {
    const { r, comp } = run([entity('c', '100000')], { ti: '150000', ded: { halfSeTax: '5000', sehi: '3000', retirement: '2000' } });
    expect(comp('l-c').attributableDeductions).toBe('10000');
    expect(comp('l-c').qbi).toBe('90000');
    expect(r.deduction).toBe('18000');
  });
  it('allocates ½ SE / retirement by SE income and SEHI to the business that paid it', () => {
    const second = entity('d', '50000', { ownerItems: [{ personId: null, sehi: '6000', retirement: '0', sehiAsW2Wages: '0' }] });
    const { comp } = run([entity('c', '100000'), second], { ti: '150000', ded: { halfSeTax: '6000', retirement: '3000', sehi: '6000' } });
    expect(comp('l-c').attributableDeductions).toBe('6000');
    expect(comp('l-d').attributableDeductions).toBe('9000');
  });
  it('backs out link adjustments flagged affects_qbi = false and includes a §1231 share only when the net is a loss', () => {
    const a = adj({ id: 'x', kind: 'deduction', amount: '10000', linkId: 'l-c', affectsQbi: false });
    const { comp } = run([entity('c', '100000')], { ti: '150000', adjustments: [a] });
    expect(comp('l-c').qualifiedItems).toBe('100000');
    const e = entity('c', '100000', { ytd: characters({ ordinary: '100000', section_1231: '-5000' }), recurringYtd: characters({ ordinary: '100000', section_1231: '-5000' }) });
    expect(run([e], { ti: '150000', s1231: '-5000' }).comp('l-c').qualifiedItems).toBe('95000');
    expect(run([e], { ti: '150000', s1231: '2000' }).comp('l-c').qualifiedItems).toBe('100000');
  });
});

describe('§199A above the threshold (single, fully phased at 276,750)', () => {
  const biz = (w2: string | null, ubia: string | null, extra: Partial<EngineEntity> = {}) => entity('c', '200000', { w2WagesEffective: w2, ubia, ...extra });
  it('is wage-limited to 50% of W-2 wages when that exceeds the UBIA limb', () => {
    const { r, comp } = run([biz('60000', '0')], { ti: '300000', fs: 'single' });
    expect(r.phaseInFraction).toBe('1');
    expect(comp('l-c').tentative).toBe('40000');
    expect(comp('l-c').wageUbiaLimit).toBe('30000');
    expect(comp('l-c').limitApplied).toBe(true);
    expect(r.deduction).toBe('30000');
    const ample = run([biz('100000', '0')], { ti: '300000', fs: 'single' });
    expect(ample.comp('l-c').limitApplied).toBe(false);
    expect(ample.r.deduction).toBe('40000');
  });
  it('is UBIA-limited when 25% W-2 + 2.5% UBIA is the larger limb', () => {
    const { comp, r } = run([biz('20000', '1000000')], { ti: '300000', fs: 'single' });
    expect(comp('l-c').wageUbiaLimit).toBe('30000');
    expect(r.deduction).toBe('30000');
  });
  it('blank UBIA: the UBIA limb is not computed and a D8 warning is raised; blank W-2 wages warn and count as 0', () => {
    const { comp, ctx } = run([biz('60000', null)], { ti: '300000', fs: 'single' });
    expect(comp('l-c').ubia).toBeNull();
    expect(comp('l-c').wageUbiaLimit).toBe('30000');
    expect(ctx.allWarnings().find((w) => w.code === 'TE_QBI_UBIA_MISSING')!.message).toMatch(/UBIA/);
    const noWages = run([biz(null, null)], { ti: '300000', fs: 'single' });
    expect(warned(noWages.ctx, 'TE_QBI_W2_WAGES_MISSING')).toBe(true);
    expect(noWages.comp('l-c').component).toBe('0');
    // …but §199A(i) still floors the deduction at the minimum (active QBI ≥ 1,000).
    expect(noWages.r.minimumApplied).toBe(true);
    expect(noWages.r.deduction).toBe('400');
  });
  it('allocates W-2 wages and UBIA by the link profit fraction', () => {
    const s = entity('s', '400000', { entityType: 's_corp', w2WagesEffective: '120000', ubia: '0' }, { profitPct: 50 });
    const { comp } = run([s], { ti: '300000', fs: 'single' });
    expect(comp('l-s').qbi).toBe('200000');
    expect(comp('l-s').w2Wages).toBe('60000');
    expect(comp('l-s').wageUbiaLimit).toBe('30000');
  });
  it('phases the limit in across the range (non-SSTB at the midpoint)', () => {
    const { r, comp } = run([biz('60000', '0')], { ti: '239250', fs: 'single' });
    expect(r.phaseInFraction).toBe('0.5');
    expect(comp('l-c').component).toBe('35000');
    expect(r.deduction).toBe('35000');
  });
  it('SSTB: applicable percentage in the range, excluded above it, untouched below the threshold', () => {
    const mid = run([biz('60000', '0', { isSstb: true })], { ti: '239250', fs: 'single' });
    expect(mid.comp('l-c').qbi).toBe('100000');
    expect(mid.comp('l-c').w2Wages).toBe('30000');
    expect(mid.comp('l-c').component).toBe('17500');
    expect(warned(mid.ctx, 'TE_QBI_SSTB_PHASED')).toBe(true);
    const above = run([biz('60000', '0', { isSstb: true })], { ti: '300000', fs: 'single' });
    expect(above.comp('l-c').eligible).toBe(false);
    expect(above.comp('l-c').reason).toMatch(/specified service/);
    expect(above.r.deduction).toBe('0');
    expect(above.r.method).toBe('none');
    const below = run([biz('60000', '0', { isSstb: true })], { ti: '150000', fs: 'single' });
    expect(below.r.deduction).toBe('30000');
  });
});

describe('§199A loss netting, REIT / PTP, overall limit, minimum deduction', () => {
  it('nets a loss business against the others pro rata and disregards its W-2 wages', () => {
    const loss = entity('b', '-40000', { entityType: 'partnership', w2WagesEffective: '500000', ubia: '0' }, { partnerSeStatus: 'general' });
    const { r, comp, ctx } = run([entity('a', '100000', { w2WagesEffective: '0', ubia: '0' }), loss], { ti: '300000', fs: 'single' });
    expect(comp('l-a').qbiAfterNetting).toBe('60000');
    expect(comp('l-b').qbiAfterNetting).toBe('0');
    expect(comp('l-b').w2Wages).toBe('0');
    expect(comp('l-a').component).toBe('0');
    expect(r.netLossCarryforward).toBe('0');
    expect(ctx.trace.rows().find((t) => t.id === 'qbi.loss_netting')!.amount).toBe('-40000');
    const below = run([entity('a', '100000'), entity('b', '-40000')], { ti: '150000' });
    expect(below.r.deduction).toBe('12000');
  });
  it('a net QBI loss carries forward (noted, not tracked) and yields no deduction', () => {
    const { r, ctx } = run([entity('a', '30000'), entity('b', '-40000')], { ti: '150000' });
    expect(r.netLossCarryforward).toBe('10000');
    expect(r.deduction).toBe('0');
    expect(warned(ctx, 'TE_QBI_NET_LOSS_CARRYFORWARD')).toBe(true);
  });
  it('adds a REIT / PTP component without a wage limit; a net REIT / PTP loss gives none', () => {
    const reit = adj({ id: 'reit', amount: '10000', isReitDividend: true });
    const ptp = adj({ id: 'ptp', kind: 'deduction', amount: '3000', isPtp: true, isAboveTheLine: false });
    const { r } = run([entity('c', '100000', { w2WagesEffective: '0', ubia: '0' })], { ti: '300000', fs: 'single', adjustments: [reit] });
    expect(r.reitPtpIncome).toBe('10000');
    expect(r.reitPtpComponent).toBe('2000');
    expect(r.deduction).toBe('2000');
    const neg = run([entity('c', '100000')], { ti: '150000', adjustments: [adj({ id: 'ptp2', amount: '4000', isPtp: true }), ptp] });
    expect(neg.r.reitPtpIncome).toBe('4000');
    const lossOnly = run([entity('c', '100000')], { ti: '150000', adjustments: [adj({ id: 'ptpl', kind: 'addback', amount: '0', isPtp: true })] });
    expect(lossOnly.r.reitPtpComponent).toBe('0');
  });
  it('caps the deduction at rate × (taxable income before QBI − net capital gain incl. qualified dividends)', () => {
    const { r } = run([entity('c', '100000')], { ti: '150000', ncg: '120000' });
    expect(r.overallLimit).toBe('6000');
    expect(r.deduction).toBe('6000');
    expect(run([entity('c', '100000')], { ti: '-5000' }).r.deduction).toBe('0');
  });
  it('§199A(i) minimum deduction when active QBI reaches the parameter threshold', () => {
    const tiny = run([entity('c', '1500')], { ti: '50000' });
    expect(tiny.r.activeQbi).toBe('1500');
    expect(tiny.r.minimumApplied).toBe(true);
    expect(tiny.r.deduction).toBe('400');
    expect(warned(tiny.ctx, 'TE_QBI_MINIMUM_APPLIED')).toBe(true);
    const under = run([entity('c', '800')], { ti: '50000' });
    expect(under.r.minimumApplied).toBe(false);
    expect(under.r.deduction).toBe('160');
    const passive = run([entity('k', '1500', { entityType: 'partnership' }, { activityType: 'passive', partnerSeStatus: 'limited' })], { ti: '50000' });
    expect(passive.r.activeQbi).toBe('0');
    expect(passive.r.deduction).toBe('300');
  });
});

describe('§199A eligibility and override', () => {
  it('excludes rental unless the entity is a §162 rental, investment interests, C corporations and link opt-outs; honours the link opt-in', () => {
    const rentalE = (flag: boolean, l: Partial<EngineLink> = {}) => entity('r', '0', { entityType: 'partnership', rentalQbiTradeOrBusiness: flag, ytd: characters({ rental: '20000' }), recurringYtd: characters({ rental: '20000' }) }, { activityType: 'rental', partnerSeStatus: 'limited', ...l });
    const off = run([rentalE(false)], { ti: '150000' });
    expect(off.comp('l-r').eligible).toBe(false);
    expect(off.comp('l-r').reason).toMatch(/rental_qbi_trade_or_business/);
    expect(off.r.deduction).toBe('0');
    expect(off.r.method).toBe('none');
    expect(warned(off.ctx, 'TE_QBI_LINK_EXCLUDED')).toBe(true);
    expect(run([rentalE(true)], { ti: '150000' }).r.deduction).toBe('4000');
    expect(run([rentalE(false, { qbiEligible: true })], { ti: '150000' }).r.deduction).toBe('4000');
    expect(run([entity('i', '5000', { entityType: 'partnership' }, { activityType: 'investment', partnerSeStatus: 'limited' })], { ti: '150000' }).comp('l-i').reason).toMatch(/investment/);
    expect(run([entity('cc', '5000', { entityType: 'c_corp' })], { ti: '150000' }).comp('l-cc').reason).toMatch(/C corporation/);
    expect(run([entity('c', '5000', {}, { qbiEligible: false })], { ti: '150000' }).comp('l-c').reason).toMatch(/link/);
  });
  it('a manual deduction overrides the computation and keeps the computed figure', () => {
    const { r, ctx } = run([entity('c', '100000')], { ti: '150000', input: { manualDeduction: '5000' } });
    expect(r.method).toBe('manual');
    expect(r.deduction).toBe('5000');
    expect(r.computedDeduction).toBe('20000');
    expect(ctx.allWarnings().find((w) => w.code === 'TE_QBI_MANUAL_OVERRIDE')!.message).toContain('20000');
    expect(ctx.trace.rows().find((t) => t.id === 'qbi')!.label).toMatch(/MANUAL OVERRIDE/);
  });
});
