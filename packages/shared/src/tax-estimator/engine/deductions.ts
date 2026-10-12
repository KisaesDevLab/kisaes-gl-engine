// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 8 — deductions:
//   standard (with the 65 / blind add-ons) + the non-itemizer charitable
//   deduction when parameterised (§170(p): a zero parameter means "not this year");
//   itemized detail: SALT with the cap and its MAGI phase-down to a floor,
//   mortgage interest, charitable less the AGI floor (§170(b)(1)(I)), other, then
//   the §68 benefit cap (reduce by (top − cap)/top of the lesser of itemized or
//   taxable income over the start of the top bracket; 0.37 vs 0.37 → nothing);
//   larger wins unless forced. Schedule 1-A (senior, tips, overtime, car-loan
//   interest) on top of either, each with its MAGI phase-out, in effect only
//   between sch1a.first_year and sch1a.last_year; the senior phase-out is linear
//   (§151(d)(5)(C)(iii): 6% of the excess), tips / overtime / car-loan interest
//   step by `sch1a.phaseout_step`: tips and overtime by WHOLE steps — "$100 for
//   each $1,000" (§224(b)(2), §225(b)(2); 2025 Schedule 1-A lines 11 / 19 round the
//   quotient DOWN), car-loan interest by steps begun — "$200 for each $1,000 (or
//   portion thereof)" (§163(h)(4)(E); line 28 rounds UP). A married taxpayer must file
//   jointly for every Schedule 1-A deduction (§151(d)(5)(C)(v), §224(f), §225(e),
//   §163(h)(4)(F)): MFS gets nothing (R2-02).
// MAGI is taken as AGI (no foreign-income exclusions are modelled).

import type { FilingStatus } from '../types.js';
import type { DeductionMode } from '../years-api.js';
import {
  ZERO, ONE, dAdd, dCmp, dDiv, dFloorZero, dIsPos, dIsZero, dMax, dMin, dMul, dRound, dSub, dSum, dec, type Dec,
} from '../decimal.js';
import type { EngineContext } from './context.js';
import type { EngineItemized, EngineSch1aPerson } from './types.js';

const STEP_DEDUCTIONS = 'deductions';

export interface DeductionPerson {
  personId: string;
  role: 'primary' | 'spouse';
  label: string;
  /** Age at Dec 31 with the Jan 1 rule (null = unknown). */
  age: number | null;
  isBlind: boolean;
  sch1a: EngineSch1aPerson;
}

export interface StandardDeductionExact {
  base: Dec;
  additionalCount: number;
  additionalEach: Dec;
  nonItemizerCharitable: Dec;
  total: Dec;
}

export interface ItemizedExact {
  saltPaid: Dec;
  saltCap: Dec;
  saltAllowed: Dec;
  mortgageInterest: Dec;
  charitableGross: Dec;
  charitableFloor: Dec;
  charitableAllowed: Dec;
  other: Dec;
  beforeBenefitCap: Dec;
  benefitCapReduction: Dec;
  total: Dec;
}

export interface Sch1aExact {
  inEffect: boolean;
  senior: Dec;
  tips: Dec;
  overtime: Dec;
  carLoanInterest: Dec;
  total: Dec;
}

const MARRIED: ReadonlySet<FilingStatus> = new Set<FilingStatus>(['mfj', 'mfs', 'qss']);

/** Persons whose boxes count: the primary always; the spouse only on a joint return. */
function countedPersons(persons: DeductionPerson[], fs: FilingStatus): DeductionPerson[] {
  return persons.filter((p) => p.role === 'primary' || fs === 'mfj');
}

export function computeStandardDeduction(persons: DeductionPerson[], charitableCash: Dec, ctx: EngineContext): StandardDeductionExact {
  const { params, filingStatus: fs } = ctx;
  const base = params.moneyFs('std_deduction', fs);
  const ageThreshold = params.int('std_deduction.additional_age');
  const additionalKey = MARRIED.has(fs) ? 'std_deduction.additional_65_blind.married' : 'std_deduction.additional_65_blind.unmarried';
  const additionalEach = params.money(additionalKey);
  let count = 0;
  for (const p of countedPersons(persons, fs)) {
    if (p.age != null && p.age >= ageThreshold) count += 1;
    if (p.isBlind) count += 1;
  }
  const additional = dMul(additionalEach, String(count));
  const nonItemizerMax = params.moneyFs('charity.nonitemizer', fs);
  const nonItemizerCharitable = dIsPos(nonItemizerMax) ? dMin(dFloorZero(charitableCash), nonItemizerMax) : ZERO;
  const total = dSum([base, additional, nonItemizerCharitable]);
  ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'standard_deduction', label: 'Standard deduction', exact: dAdd(base, additional), source: 'parameter', formula: `${base} + ${count} × ${additionalEach} (65 / blind)`, parameterKeys: [`std_deduction.${fs}`, additionalKey, 'std_deduction.additional_age'] });
  if (dIsPos(nonItemizerCharitable)) {
    ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'nonitemizer_charitable', label: 'Charitable deduction for non-itemizers', exact: nonItemizerCharitable, source: 'parameter', formula: `min(cash gifts ${charitableCash}, ${nonItemizerMax})`, parameterKeys: [`charity.nonitemizer.${fs}`] });
  }
  return { base, additionalCount: count, additionalEach, nonItemizerCharitable, total };
}

/**
 * @param itemizedOther  deductions from adjustments that are neither above the line nor Schedule 1-A
 * @param magi           AGI (SALT phase-down and the charitable floor)
 * @param taxableIncomeBeforeItemized  AGI − Schedule 1-A − QBI: the §68 base before itemized deductions
 */
export function computeItemizedDeductions(itemized: EngineItemized, itemizedOther: Dec, magi: Dec, taxableIncomeBeforeItemized: Dec, ctx: EngineContext): ItemizedExact {
  const { params, filingStatus: fs } = ctx;
  const variant = fs === 'mfs' ? 'mfs' : 'standard';
  const capKey = `salt.cap.${variant}`; const thresholdKey = `salt.phase_down.threshold.${variant}`; const floorKey = `salt.floor.${variant}`;
  const cap = params.money(capKey);
  const threshold = params.money(thresholdKey);
  const rate = params.rate('salt.phase_down.rate');
  const floor = params.money(floorKey);
  const excess = dFloorZero(dSub(magi, threshold));
  const saltCap = dMax(floor, dSub(cap, dMul(rate, excess)));
  if (dIsPos(excess) && dCmp(saltCap, cap) < 0) {
    ctx.warn('TE_SALT_PHASED_DOWN', `SALT cap reduced from ${cap} to ${saltCap} because MAGI exceeds ${threshold}.`, { saltCap });
  }
  const saltPaid = dFloorZero(itemized.saltPaid);
  const saltAllowed = dMin(saltPaid, saltCap);
  const mortgage = dFloorZero(itemized.mortgageInterest);
  const charitableGross = dAdd(dFloorZero(itemized.charitableCash), dFloorZero(itemized.charitableNoncash));
  const floorPct = params.rate('charity.agi_floor_pct');
  const charitableFloor = dIsPos(charitableGross) ? dMul(floorPct, dFloorZero(magi)) : ZERO;
  const charitableAllowed = dFloorZero(dSub(charitableGross, charitableFloor));
  const other = dAdd(dFloorZero(itemized.other), dFloorZero(itemizedOther));
  const before = dSum([saltAllowed, mortgage, charitableAllowed, other]);

  // §68 benefit cap: (top − cap) / top × lesser of (itemized, TI incl. itemized − top-bracket start).
  const capRate = params.rate('itemized.benefit_cap_rate');
  const brackets = params.bracketsFs('brackets', fs);
  const top = brackets[brackets.length - 1]!;
  const topStart = brackets.length > 1 ? brackets[brackets.length - 1 - 1]!.upper ?? ZERO : ZERO;
  let reduction: Dec = ZERO;
  if (dCmp(capRate, top.rate) < 0 && dIsPos(before)) {
    // taxableIncomeBeforeItemized is already TI determined without §68 and increased by the itemized amount.
    const overTop = dFloorZero(dSub(taxableIncomeBeforeItemized, topStart));
    const lesser = dMin(before, overTop);
    if (dIsPos(lesser)) {
      // Multiply before dividing so the 12-place quotient is taken on the dollar amount, not the ratio.
      reduction = dDiv(dMul(lesser, dSub(top.rate, capRate)), top.rate);
      ctx.warn('TE_ITEMIZED_BENEFIT_CAPPED', `Itemized deductions reduced by ${reduction} so their benefit does not exceed ${capRate} (§68).`, { reduction });
    }
  }
  const total = dSub(before, reduction);
  ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'itemized.salt', label: 'State and local taxes (capped)', exact: saltAllowed, source: 'parameter', formula: `min(${saltPaid}, cap ${saltCap})`, parameterKeys: [capKey, thresholdKey, 'salt.phase_down.rate', floorKey] });
  ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'itemized.mortgage', label: 'Mortgage interest', exact: mortgage, source: 'input' });
  ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'itemized.charitable', label: 'Charitable contributions (after AGI floor)', exact: charitableAllowed, source: 'parameter', formula: `${charitableGross} − ${floorPct} × AGI`, parameterKeys: ['charity.agi_floor_pct'] });
  ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'itemized.other', label: 'Other itemized deductions', exact: other, source: 'input' });
  ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'itemized.total', label: 'Itemized deductions', exact: total, source: 'parameter', formula: dIsZero(reduction) ? 'SALT + mortgage + charitable + other' : `${before} − §68 reduction ${reduction}`, parameterKeys: ['itemized.benefit_cap_rate'] });
  return { saltPaid, saltCap, saltAllowed, mortgageInterest: mortgage, charitableGross, charitableFloor, charitableAllowed, other, beforeBenefitCap: before, benefitCapReduction: reduction, total };
}

export function chooseDeduction(mode: DeductionMode, standard: StandardDeductionExact, itemized: ItemizedExact, ctx: EngineContext): { chosen: 'standard' | 'itemized'; deduction: Dec } {
  const larger: 'standard' | 'itemized' = dCmp(itemized.total, standard.total) > 0 ? 'itemized' : 'standard';
  const chosen: 'standard' | 'itemized' = mode === 'auto' ? larger : mode;
  if (chosen !== larger) {
    ctx.info('TE_DEDUCTION_FORCED', `The ${chosen} deduction was forced although the ${larger} deduction is larger.`, { chosen, standard: standard.total, itemized: itemized.total });
  }
  const deduction = chosen === 'standard' ? dec(standard.total) : dec(itemized.total);
  ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'deduction', label: `Deduction (${chosen}${mode === 'auto' ? ', larger' : ', forced'})`, exact: deduction, source: 'input', formula: `standard ${standard.total} vs itemized ${itemized.total}` });
  return { chosen, deduction };
}

/** How a fractional MAGI step counts: 'down' = whole steps only ("for each $1,000"), 'up' = steps begun ("or portion thereof"). */
type StepRounding = 'down' | 'up';

/**
 * min(amount, max) reduced by rate × (MAGI − threshold), floored at zero. With a
 * `step`, the excess is first rounded to a whole number of steps — DOWN for the
 * tips / overtime deductions ("$100 for each $1,000"; 2025 Schedule 1-A lines 11 and
 * 19: "decrease the result to the next lower whole number"), UP for car-loan
 * interest ("$200 for each $1,000 (or portion thereof)"; line 28: "increase the
 * result to the next higher whole number"). The reduction is rate × the rounded excess.
 */
function phasedOut(amount: Dec, max: Dec | null, magi: Dec, threshold: Dec, rate: Dec, step: Dec | null = null, stepRounding: StepRounding = 'up'): Dec {
  const capped = max == null ? dFloorZero(amount) : dMin(dFloorZero(amount), max);
  if (!dIsPos(capped)) return ZERO;
  let excess = dFloorZero(dSub(magi, threshold));
  if (step != null && dIsPos(step) && dIsPos(excess)) excess = dMul(stepRounding === 'up' ? dCeilDiv(excess, step) : dFloorDiv(excess, step), step);
  return dFloorZero(dSub(capped, dMul(rate, excess)));
}

/** ⌈a ÷ b⌉ for positive decimals: whole steps begun. */
function dCeilDiv(a: Dec, b: Dec): Dec {
  const q = dDiv(a, b);
  const whole = dRound(q, 0);
  // dRound is half-up; step up when the rounded quotient fell short of the exact one.
  return dCmp(whole, q) < 0 ? dAdd(whole, ONE) : whole;
}

/** ⌊a ÷ b⌋ for positive decimals: whole steps completed. */
function dFloorDiv(a: Dec, b: Dec): Dec {
  const q = dDiv(a, b);
  const whole = dRound(q, 0);
  // dRound is half-up; step down when the rounded quotient overshot the exact one.
  return dCmp(whole, q) > 0 ? dSub(whole, ONE) : whole;
}

export function computeSch1a(persons: DeductionPerson[], magi: Dec, ctx: EngineContext): Sch1aExact {
  const { params, filingStatus: fs, taxYear } = ctx;
  const firstYear = params.int('sch1a.first_year');
  const lastYear = params.int('sch1a.last_year');
  if (taxYear < firstYear || taxYear > lastYear) {
    ctx.info('TE_SCH1A_NOT_IN_EFFECT', `Schedule 1-A deductions do not apply to tax year ${taxYear}.`);
    return { inEffect: false, senior: ZERO, tips: ZERO, overtime: ZERO, carLoanInterest: ZERO, total: ZERO };
  }
  if (fs === 'mfs') {
    ctx.info('TE_SCH1A_MFS_NOT_ALLOWED', 'Married filing separately: no Schedule 1-A deduction (senior, tips, overtime, car-loan interest) — each requires a joint return for a married taxpayer (§151(d)(5)(C)(v), §224(f), §225(e), §163(h)(4)(F)).');
    return { inEffect: true, senior: ZERO, tips: ZERO, overtime: ZERO, carLoanInterest: ZERO, total: ZERO };
  }
  const counted = countedPersons(persons, fs);
  const step = params.money('sch1a.phaseout_step');

  const seniorAge = params.int('sch1a.senior.age');
  const seniorEach = params.money('sch1a.senior.amount');
  const seniors = counted.filter((p) => p.age != null && p.age >= seniorAge).length;
  const senior = phasedOut(dMul(seniorEach, String(seniors)), null, magi, params.moneyFs('sch1a.senior.phaseout_threshold', fs), params.rate('sch1a.senior.phaseout_rate'));

  const tips = phasedOut(dSum(counted.map((p) => p.sch1a.qualifiedTips)), params.money('sch1a.tips.max'), magi, params.moneyFs('sch1a.tips.phaseout_threshold', fs), params.rate('sch1a.tips.phaseout_rate'), step, 'down');
  const overtimeMaxKey = fs === 'mfj' ? 'sch1a.overtime.max.mfj' : 'sch1a.overtime.max.standard';
  const overtime = phasedOut(dSum(counted.map((p) => p.sch1a.qualifiedOvertime)), params.money(overtimeMaxKey), magi, params.moneyFs('sch1a.overtime.phaseout_threshold', fs), params.rate('sch1a.overtime.phaseout_rate'), step, 'down');
  const car = phasedOut(dSum(counted.map((p) => p.sch1a.carLoanInterest)), params.money('sch1a.car_interest.max'), magi, params.moneyFs('sch1a.car_interest.phaseout_threshold', fs), params.rate('sch1a.car_interest.phaseout_rate'), step, 'up');
  const total = dSum([senior, tips, overtime, car]);

  const add = (id: string, label: string, exact: Dec, keys: string[], formula: string) => {
    if (dIsZero(exact)) return;
    ctx.trace.add({ step: STEP_DEDUCTIONS, id, label, exact, source: 'parameter', formula, parameterKeys: keys });
  };
  const steppedDown = `capped, less rate × MAGI excess over the threshold in whole ${step} steps (fraction dropped)`;
  const steppedUp = `capped, less rate × MAGI excess over the threshold rounded up to the next ${step} step`;
  add('sch1a.senior', `Schedule 1-A — senior deduction (${seniors} eligible)`, senior, ['sch1a.senior.amount', 'sch1a.senior.age', `sch1a.senior.phaseout_threshold.${fs}`, 'sch1a.senior.phaseout_rate'], 'less rate × MAGI excess over the threshold (linear)');
  add('sch1a.tips', 'Schedule 1-A — qualified tips', tips, ['sch1a.tips.max', `sch1a.tips.phaseout_threshold.${fs}`, 'sch1a.tips.phaseout_rate', 'sch1a.phaseout_step'], steppedDown);
  add('sch1a.overtime', 'Schedule 1-A — qualified overtime', overtime, [overtimeMaxKey, `sch1a.overtime.phaseout_threshold.${fs}`, 'sch1a.overtime.phaseout_rate', 'sch1a.phaseout_step'], steppedDown);
  add('sch1a.car_interest', 'Schedule 1-A — car-loan interest', car, ['sch1a.car_interest.max', `sch1a.car_interest.phaseout_threshold.${fs}`, 'sch1a.car_interest.phaseout_rate', 'sch1a.phaseout_step'], steppedUp);
  if (dIsPos(total)) ctx.trace.add({ step: STEP_DEDUCTIONS, id: 'sch1a.total', label: 'Schedule 1-A deductions', exact: total, source: 'parameter', parameterKeys: ['sch1a.first_year', 'sch1a.last_year'] });
  return { inEffect: true, senior, tips, overtime, carLoanInterest: car, total };
}
