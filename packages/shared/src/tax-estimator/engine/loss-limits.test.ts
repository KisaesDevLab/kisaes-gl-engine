// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { characters, allocateEntity, aggregatePersons, type AggregatedIncome } from './income.js';
import { applyLossLimitations, addBackLoss, type LossLimitationOptions } from './loss-limits.js';
import type { EngineEntity, EngineLink, EnginePerson, ParameterMap } from './types.js';
import type { FilingStatus } from '../types.js';

const params: ParameterMap = Object.fromEntries(Object.entries({
  'passive.rental_allowance.standard': 25000, 'passive.rental_allowance.mfs_living_apart': 12500,
  'passive.rental_allowance_phaseout_start.standard': 100000, 'passive.rental_allowance_phaseout_start.mfs_living_apart': 50000,
  'passive.rental_allowance_phaseout_end.standard': 150000, 'passive.rental_allowance_phaseout_end.mfs_living_apart': 75000,
  'ebl.threshold.standard': 256000, 'ebl.threshold.mfj': 512000,
}).map(([key, value]) => [key, { key, value, status: 'verified' as const }]));

const P = 'p1';
const person = (id: string, role: 'primary' | 'spouse' = 'primary'): EnginePerson => ({
  personId: id, role, displayName: id, dateOfBirth: null, isBlind: false, sehiEligibleMonths: Array(12).fill(true),
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
const rental = (companyId: string, amount: string, activeParticipation: boolean): EngineEntity =>
  entity(companyId, '0', { entityType: 'partnership', ytd: characters({ rental: amount }), recurringYtd: characters({ rental: amount }) }, { activityType: 'rental', partnerSeStatus: 'limited', activeParticipation });
const passiveK1 = (companyId: string, amount: string): EngineEntity =>
  entity(companyId, amount, { entityType: 'partnership' }, { activityType: 'passive', partnerSeStatus: 'limited' });

function build(entities: EngineEntity[], fs: FilingStatus = 'mfj'): { agg: AggregatedIncome; ctx: EngineContext } {
  const ctx = new EngineContext(params, 2026, fs);
  const persons = [person(P)];
  ctx.setPersons(persons);
  const allocated = entities.map((e) => allocateEntity(e, [], ctx));
  return { agg: aggregatePersons(allocated, persons, [], ctx), ctx };
}
const opts = (magi: string | null, extra: Partial<LossLimitationOptions> = {}): LossLimitationOptions => ({ magi, mfsLivedApartAllYear: false, ...extra });
const shareOf = (r: ReturnType<typeof applyLossLimitations>, linkId: string) => r.shares.find((s) => s.linkId === linkId)!;
const ordinaryOf = (income: AggregatedIncome) => income.byPerson.get(P)!.character.ordinary;
const rentalOf = (income: AggregatedIncome) => income.byPerson.get(P)!.character.rental;

describe('addBackLoss', () => {
  it('adds the amount back against the negative characters pro rata and leaves positive ones alone', () => {
    const out = addBackLoss(characters({ ordinary: '-80', interest: '20', rental: '-20' }), '50');
    expect(out.ordinary).toBe('-40');
    expect(out.rental).toBe('-10');
    expect(out.interest).toBe('20');
  });
  it('never flips a loss into income', () => {
    expect(addBackLoss(characters({ ordinary: '-30' }), '100').ordinary).toBe('0');
  });
});

describe('allowed_loss_override (basis / at-risk)', () => {
  it('caps the link loss at the override and reports the disallowed part without mutating the input', () => {
    const { agg, ctx } = build([entity('c', '-50000', {}, { allowedLossOverride: '30000' })]);
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(shareOf(r, 'l-c').overrideDisallowed).toBe('20000');
    expect(shareOf(r, 'l-c').allowed).toBe('-30000');
    expect(r.overrideDisallowed).toBe('20000');
    expect(ordinaryOf(r.income)).toBe('-30000');
    expect(ordinaryOf(agg)).toBe('-50000');
    expect(r.income.byPerson.get(P)!.shares[0]!.share.ordinary).toBe('-30000');
    expect(ctx.allWarnings().some((w) => w.code === 'TE_LOSS_OVERRIDE_APPLIED')).toBe(true);
    expect(r.applied).toBe(true);
  });
  it('is a no-op (with an info) on a profit or when the loss is within the override', () => {
    const { agg, ctx } = build([entity('c', '40000', {}, { allowedLossOverride: '30000' }), entity('d', '-10000', {}, { allowedLossOverride: '30000' })]);
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.overrideDisallowed).toBe('0');
    expect(ordinaryOf(r.income)).toBe('30000');
    expect(ctx.allWarnings().filter((w) => w.code === 'TE_LOSS_OVERRIDE_UNUSED')).toHaveLength(2);
  });
});

describe('passive activity netting (§469)', () => {
  it('passive losses offset only passive income; the excess is suspended and the active business is untouched', () => {
    const { agg, ctx } = build([entity('c', '100000'), passiveK1('k1', '-30000'), passiveK1('k2', '10000')]);
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.needsMagi).toBe(false);
    expect(r.passiveIncome).toBe('10000');
    expect(r.passiveLosses).toBe('30000');
    expect(r.suspendedPassiveLoss).toBe('20000');
    expect(shareOf(r, 'l-k1').passiveSuspended).toBe('20000');
    expect(shareOf(r, 'l-k1').allowed).toBe('-10000');
    expect(shareOf(r, 'l-c').allowed).toBe('100000');
    expect(ordinaryOf(r.income)).toBe('100000');
    expect(r.rentalAllowance.variant).toBe('not_needed');
    expect(ctx.allWarnings().find((w) => w.code === 'TE_PASSIVE_LOSS_SUSPENDED')!.message).toContain('20000');
    expect(r.notes[0]).toMatch(/suspended under §469: 20000/);
  });
  it('allocates the suspended amount to the loss activities pro rata', () => {
    const { agg, ctx } = build([passiveK1('a', '-30000'), passiveK1('b', '-10000'), passiveK1('c', '20000')]);
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.suspendedPassiveLoss).toBe('20000');
    expect(shareOf(r, 'l-a').passiveSuspended).toBe('15000');
    expect(shareOf(r, 'l-b').passiveSuspended).toBe('5000');
    expect(ordinaryOf(r.income)).toBe('0');
  });
  it('a rental loss with active participation needs MAGI: the probe pass suspends everything and says so', () => {
    const { agg, ctx } = build([entity('c', '100000'), rental('r', '-30000', true)]);
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.needsMagi).toBe(true);
    expect(r.suspendedPassiveLoss).toBe('30000');
    expect(rentalOf(r.income)).toBe('0');
    expect(r.rentalAllowance.eligibleLoss).toBe('30000');
    expect(ctx.allWarnings().some((w) => w.code === 'TE_PASSIVE_LOSS_SUSPENDED')).toBe(false);
  });
  it('without active participation no allowance is possible and MAGI is not needed', () => {
    const { agg, ctx } = build([rental('r', '-30000', false)]);
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.needsMagi).toBe(false);
    expect(r.suspendedPassiveLoss).toBe('30000');
  });
});

describe('§469(i) allowance allocation (Form 8582 Worksheets 4–5, R2-03)', () => {
  it('the allowance is applied to active-participation rental losses before any other passive loss is allowed', () => {
    const { agg, ctx } = build([entity('w', '80000'), rental('r', '-20000', true), passiveK1('biz', '-20000')], 'single');
    const r = applyLossLimitations(agg, opts('80000'), ctx);
    expect(r.rentalAllowance.used).toBe('20000');
    expect(r.suspendedPassiveLoss).toBe('20000');
    expect(shareOf(r, 'l-r').allowed).toBe('-20000');   // fully allowed by the $25,000 allowance
    expect(shareOf(r, 'l-r').passiveSuspended).toBe('0');
    expect(shareOf(r, 'l-biz').allowed).toBe('0');      // no passive income → fully suspended
    expect(shareOf(r, 'l-biz').passiveSuspended).toBe('20000');
    expect(rentalOf(r.income)).toBe('-20000');
    expect(ordinaryOf(r.income)).toBe('80000');
    // invariant: Σ allowed = −(min(passive losses, passive income) + allowance used)
    const allowedPassive = r.shares.filter((s) => s.passive).reduce((a, s) => a + Number(s.allowed), 0);
    expect(allowedPassive).toBe(-(Math.min(40000, 0) + 20000));
  });
  it('a partly covered rental loss: Worksheet 4 nets the allowance against the rental first, Worksheet 5 spreads the unallowed rest over the remaining losses', () => {
    // rental −30,000 (active), passive business −20,000, passive income +10,000: PAL 40,000; allowance min(30,000, 25,000) = 25,000; unallowed 15,000.
    // Wks 4: rental 30,000 − 25,000 = 5,000 remaining. Wks 5 ratios 5,000 : 20,000 → rental 3,000 / business 12,000 unallowed.
    const { agg, ctx } = build([rental('r', '-30000', true), passiveK1('biz', '-20000'), passiveK1('inc', '10000')], 'single');
    const r = applyLossLimitations(agg, opts('90000'), ctx);
    expect(r.rentalAllowance.used).toBe('25000');
    expect(r.suspendedPassiveLoss).toBe('15000');
    expect(shareOf(r, 'l-r').passiveSuspended).toBe('3000');
    expect(shareOf(r, 'l-r').allowed).toBe('-27000');
    expect(shareOf(r, 'l-biz').passiveSuspended).toBe('12000');
    expect(shareOf(r, 'l-biz').allowed).toBe('-8000');
    // net passive result = +10,000 income − 35,000 losses allowed (10,000 against income + 25,000 allowance) = −25,000
    expect(Number(rentalOf(r.income)) + Number(ordinaryOf(r.income))).toBe(10000 - (10000 + 25000));
  });
  it('the per-activity carryforwards sum to the suspended total with several rental and non-rental losers', () => {
    const { agg, ctx } = build([rental('r1', '-10000', true), rental('r2', '-30000', true), passiveK1('b1', '-15000'), passiveK1('b2', '-5000')], 'mfj');
    const r = applyLossLimitations(agg, opts('120000'), ctx); // allowance 15,000 after phase-out
    expect(r.rentalAllowance.used).toBe('15000');
    expect(r.suspendedPassiveLoss).toBe('45000');
    // Wks 4: 15,000 × 10/40 = 3,750 to r1, 11,250 to r2 → remaining 6,250 / 18,750; Wks 5 over 6,250 + 18,750 + 15,000 + 5,000 = 45,000 → everything remaining is unallowed.
    expect(shareOf(r, 'l-r1').passiveSuspended).toBe('6250');
    expect(shareOf(r, 'l-r2').passiveSuspended).toBe('18750');
    expect(shareOf(r, 'l-b1').passiveSuspended).toBe('15000');
    expect(shareOf(r, 'l-b2').passiveSuspended).toBe('5000');
    expect(r.shares.reduce((a, s) => a + Number(s.passiveSuspended), 0)).toBe(45000);
  });
});

describe('§469(i) rental real estate allowance (D10)', () => {
  it('allows up to the parameter allowance against nonpassive income below the phase-out start', () => {
    const { agg, ctx } = build([entity('c', '100000'), rental('r', '-30000', true)]);
    const r = applyLossLimitations(agg, opts('80000'), ctx);
    expect(r.rentalAllowance).toEqual({ variant: 'standard', maximum: '25000', magi: '80000', afterPhaseOut: '25000', eligibleLoss: '30000', used: '25000' });
    expect(r.suspendedPassiveLoss).toBe('5000');
    expect(rentalOf(r.income)).toBe('-25000');
    expect(shareOf(r, 'l-r').allowed).toBe('-25000');
    expect(ctx.trace.rows().find((t) => t.id === 'passive.rental_allowance')!.amount).toBe('25000');
  });
  it('phases out linearly between the MAGI start and end parameters', () => {
    const { agg, ctx } = build([rental('r', '-30000', true), passiveK1('k', '4000')]);
    const r = applyLossLimitations(agg, opts('120000'), ctx);
    expect(r.rentalAllowance.afterPhaseOut).toBe('15000');
    expect(r.rentalAllowance.eligibleLoss).toBe('26000');
    expect(r.rentalAllowance.used).toBe('15000');
    expect(r.suspendedPassiveLoss).toBe('11000');
    expect(ctx.allWarnings().some((w) => w.code === 'TE_PASSIVE_ALLOWANCE_PHASED_OUT')).toBe(true);
  });
  it('is fully phased out at or above the end parameter', () => {
    const { agg } = build([rental('r', '-30000', true)]);
    const r = applyLossLimitations(agg, opts('150000'), new EngineContext(params, 2026, 'mfj'));
    expect(r.rentalAllowance.afterPhaseOut).toBe('0');
    expect(r.suspendedPassiveLoss).toBe('30000');
  });
  it('MFS living together: no allowance (§469(i)(5)(B)) with a warning', () => {
    const { agg, ctx } = build([rental('r', '-30000', true)], 'mfs');
    const r = applyLossLimitations(agg, opts('40000'), ctx);
    expect(r.rentalAllowance.variant).toBe('none');
    expect(r.rentalAllowance.used).toBe('0');
    expect(r.suspendedPassiveLoss).toBe('30000');
    expect(ctx.allWarnings().some((w) => w.code === 'TE_PASSIVE_MFS_NO_ALLOWANCE')).toBe(true);
  });
  it('MFS living apart all year: the mfs_living_apart parameters (12,500 phased out 50,000–75,000)', () => {
    const { agg, ctx } = build([rental('r', '-30000', true)], 'mfs');
    const r = applyLossLimitations(agg, opts('60000', { mfsLivedApartAllYear: true }), ctx);
    expect(r.rentalAllowance.variant).toBe('mfs_living_apart');
    expect(r.rentalAllowance.maximum).toBe('12500');
    expect(r.rentalAllowance.afterPhaseOut).toBe('7500');
    expect(r.rentalAllowance.used).toBe('7500');
    expect(r.suspendedPassiveLoss).toBe('22500');
    expect(ctx.trace.rows().find((t) => t.id === 'passive.rental_allowance')!.parameterKeys).toContain('passive.rental_allowance.mfs_living_apart');
  });
});

describe('excess business loss (§461(l))', () => {
  it('disallows the aggregate business loss above the threshold and notes the NOL', () => {
    const { agg, ctx } = build([entity('c', '-400000')], 'single');
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.businessNet).toBe('-400000');
    expect(r.eblThreshold).toBe('256000');
    expect(r.excessBusinessLoss).toBe('144000');
    expect(ordinaryOf(r.income)).toBe('-256000');
    expect(shareOf(r, 'l-c').allowed).toBe('-400000');
    expect(ctx.allWarnings().find((w) => w.code === 'TE_EXCESS_BUSINESS_LOSS')!.message).toMatch(/net operating loss/);
    expect(r.notes.some((n) => n.includes('§461(l)'))).toBe(true);
    // R2-20: the disallowed loss still reduced QBI this year; the assumptions page says so.
    expect(r.notes.some((n) => n.includes('1.199A-3(b)(1)(iv)'))).toBe(true);
    expect(ctx.allWarnings().some((w) => w.code === 'TE_EBL_QBI_TIMING')).toBe(true);
  });
  it('uses the joint threshold for MFJ and nets business income first', () => {
    const { agg, ctx } = build([entity('c', '-400000'), entity('d', '50000')], 'mfj');
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.businessNet).toBe('-350000');
    expect(r.excessBusinessLoss).toBe('0');
    expect(ordinaryOf(r.income)).toBe('-350000');
  });
  it('is measured after the passive limitation and ignores investment interests', () => {
    const { agg, ctx } = build([entity('c', '-300000'), passiveK1('k', '-100000'), entity('i', '-50000', { entityType: 'partnership' }, { activityType: 'investment', partnerSeStatus: 'limited' })], 'single');
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.suspendedPassiveLoss).toBe('100000');
    expect(r.businessNet).toBe('-300000');
    expect(r.excessBusinessLoss).toBe('44000');
  });
});

describe('no losses', () => {
  it('applies with nothing suspended, no warnings and no notes', () => {
    const { agg, ctx } = build([entity('c', '100000'), rental('r', '8000', false)]);
    const r = applyLossLimitations(agg, opts(null), ctx);
    expect(r.applied).toBe(true);
    expect(r.suspendedPassiveLoss).toBe('0');
    expect(r.excessBusinessLoss).toBe('0');
    expect(r.notes).toEqual([]);
    expect(ctx.allWarnings()).toEqual([]);
    expect(rentalOf(r.income)).toBe('8000');
  });
});
