// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 6 — limits on owner deductions, each capped with a warning:
//   SEP / solo 401(k) / SIMPLE on net SE earnings after ½ SE tax (Pub. 560:
//   the self-employed rate is plan rate ÷ (1 + plan rate), so 25% → 20%);
//   HSA by coverage type with the 55+ catch-up; SEHI only for months flagged
//   deductible, capped at earned income from the businesses the plan is under.

import {
  ZERO, ONE, dAdd, dCmp, dDiv, dFloorZero, dIsPos, dMin, dMul, dSub, dRoundDollars, dec, type Dec,
} from '../decimal.js';
import type { HsaCoverage } from '../years-api.js';
import type { EngineContext } from './context.js';
import type { RetirementPlanType } from './types.js';

const STEP_LIMITS = 'owner_limits';
const MONTHS_PER_YEAR = 12;

/** Net SE earnings after the ½ SE tax deduction, floored at zero — the compensation base for SE plan limits. */
export function seEarnedIncomeBase(seIncome: Dec, halfSeTax: Dec): Dec {
  return dFloorZero(dSub(seIncome, halfSeTax));
}

// ── Retirement ───────────────────────────────────────────────────────

export interface RetirementLimitInput {
  personId: string;
  label: string;
  planType: RetirementPlanType | null;
  /** Owner contributions from the books plus retirement adjustments (positive). */
  contributed: Dec;
  /** Elective deferral part when known (solo 401(k) / SIMPLE). */
  employeeDeferral: Dec | null;
  seIncome: Dec;
  halfSeTax: Dec;
  /** Age at Dec 31 (catch-ups); null = no catch-up. */
  age: number | null;
}

export interface RetirementLimitExact {
  personId: string;
  planType: RetirementPlanType;
  contributed: Dec;
  limit: Dec;
  deducted: Dec;
  capped: boolean;
  formula: string;
  parameterKeys: string[];
}

function fmt(d: Dec): string {
  return dRoundDollars(d);
}

export function computeRetirementLimit(input: RetirementLimitInput, ctx: EngineContext): RetirementLimitExact {
  const { params } = ctx;
  let planType: RetirementPlanType = input.planType ?? 'sep';
  if (input.planType == null && dIsPos(input.contributed)) {
    ctx.warn('TE_RETIREMENT_PLAN_ASSUMED', `${input.label}: no retirement plan type is recorded; the contribution limit was figured as a SEP.`, { personId: input.personId });
  }
  if (input.planType == null) planType = 'sep';
  const base = seEarnedIncomeBase(input.seIncome, input.halfSeTax);
  let limit: Dec = ZERO;
  let formula = 'no plan';
  const keys: string[] = [];

  if (planType !== 'none') {
    const planPct = params.rate('retirement.sep.pct_of_comp');
    const dollarLimit = params.money('retirement.sep.dollar_limit');
    const compLimit = params.money('retirement.comp_limit');
    // Self-employed employer rate: plan rate ÷ (1 + plan rate).
    const seRate = dDiv(planPct, dAdd(ONE, planPct));
    const employerShare = dMul(seRate, dMin(base, compLimit));
    keys.push('retirement.sep.pct_of_comp', 'retirement.sep.dollar_limit', 'retirement.comp_limit');

    const age = input.age;
    // Read lazily: a SEP has no catch-up, so it must not pull the age parameter (and its D12a warning).
    const eligibleCatchUp = (): boolean => {
      const catchUpAge = params.int('retirement.catch_up_age');
      keys.push('retirement.catch_up_age');
      return age != null && age >= catchUpAge;
    };

    if (planType === 'sep') {
      limit = dMin(dollarLimit, employerShare);
      formula = `min(${dollarLimit}, ${seRate} × (${input.seIncome} − ½ SE ${input.halfSeTax}))`;
    } else if (planType === 'solo_401k') {
      const deferralLimit = params.money('retirement.401k.deferral');
      keys.push('retirement.401k.deferral');
      let catchUp: Dec = ZERO;
      if (eligibleCatchUp()) {
        const range = params.intList('retirement.401k.catch_up_60_63_ages');
        keys.push('retirement.401k.catch_up_60_63_ages');
        const inHigherRange = range.length > 1 && age! >= range[0]! && age! <= range[1]!;
        catchUp = inHigherRange ? params.money('retirement.401k.catch_up_60_63') : params.money('retirement.401k.catch_up_50');
        keys.push(inHigherRange ? 'retirement.401k.catch_up_60_63' : 'retirement.401k.catch_up_50');
      }
      const deferral = dMin(dAdd(deferralLimit, catchUp), base);
      limit = dMin(dAdd(dollarLimit, catchUp), dAdd(deferral, employerShare));
      formula = `min(${dollarLimit} + catch-up ${catchUp}, deferral min(${deferralLimit} + ${catchUp}, ${base}) + employer ${seRate} × ${base})`;
    } else {
      const deferralLimit = params.money('retirement.simple.deferral');
      const matchPct = params.rate('retirement.simple.match_pct');
      keys.push('retirement.simple.deferral', 'retirement.simple.match_pct');
      let catchUp: Dec = ZERO;
      if (eligibleCatchUp()) { catchUp = params.money('retirement.simple.catch_up'); keys.push('retirement.simple.catch_up'); }
      const deferral = dMin(dAdd(deferralLimit, catchUp), base);
      limit = dAdd(deferral, dMul(matchPct, base));
      formula = `deferral min(${deferralLimit} + catch-up ${catchUp}, ${base}) + match ${matchPct} × ${base}`;
    }
  }

  const deducted = dMin(input.contributed, limit);
  const capped = dCmp(input.contributed, limit) > 0;
  if (capped) {
    ctx.warn('TE_RETIREMENT_CAPPED', `${input.label}: ${planType === 'none' ? 'no plan' : planType.toUpperCase().replace('_', ' ')} contribution ${fmt(input.contributed)} exceeds the deductible limit ${fmt(limit)}; only ${fmt(limit)} is deducted.`, { personId: input.personId, planType, contributed: input.contributed, limit });
  }
  ctx.trace.add({ step: STEP_LIMITS, id: `retirement.${input.personId}`, label: `${input.label} — ${planType === 'none' ? 'retirement (no plan)' : planType.replace('_', ' ')} deduction${capped ? ' (capped)' : ''}`, exact: deducted, source: 'parameter', formula: `min(contributed ${input.contributed}, limit ${limit}); limit = ${formula}`, personId: input.personId, parameterKeys: keys });
  return { personId: input.personId, planType, contributed: dec(input.contributed), limit, deducted, capped, formula, parameterKeys: keys };
}

// ── SEHI ─────────────────────────────────────────────────────────────

export interface SehiLimitInput {
  personId: string;
  label: string;
  /** Owner health premiums from the books plus owner_health_insurance adjustments (positive). */
  premiums: Dec;
  /** 12 flags, index 0 = January; `true` = deductible that month. */
  eligibleMonths: ReadonlyArray<boolean>;
  /** Earned income from the businesses the plan is under, after ½ SE tax and retirement (positive or zero). */
  earnedIncomeCap: Dec;
}

export interface SehiLimitExact {
  personId: string;
  premiums: Dec;
  eligibleMonths: number;
  afterMonths: Dec;
  earnedIncomeCap: Dec;
  deducted: Dec;
  capped: boolean;
}

export function computeSehiLimit(input: SehiLimitInput, ctx: EngineContext): SehiLimitExact {
  let flags = input.eligibleMonths;
  if (flags.length !== MONTHS_PER_YEAR) {
    ctx.warn('TE_SEHI_MONTHS_INVALID', `${input.label}: SEHI eligibility has ${flags.length} months instead of ${MONTHS_PER_YEAR}; all months were treated as deductible.`, { personId: input.personId });
    flags = new Array<boolean>(MONTHS_PER_YEAR).fill(true);
  }
  const eligible = flags.filter((f) => f === true).length;
  const afterMonths = eligible === MONTHS_PER_YEAR ? dec(input.premiums) : dDiv(dMul(input.premiums, String(eligible)), String(MONTHS_PER_YEAR));
  if (eligible < MONTHS_PER_YEAR && dIsPos(input.premiums)) {
    ctx.warn('TE_SEHI_MONTHS_EXCLUDED', `${input.label}: self-employed health insurance is deductible for ${eligible} of ${MONTHS_PER_YEAR} months (an employer-subsidized plan was available in the others); ${fmt(dSub(input.premiums, afterMonths))} excluded.`, { personId: input.personId, eligibleMonths: eligible });
  }
  const cap = dFloorZero(input.earnedIncomeCap);
  const deducted = dMin(afterMonths, cap);
  const capped = dCmp(afterMonths, cap) > 0;
  if (capped) {
    ctx.warn('TE_SEHI_CAPPED', `${input.label}: self-employed health insurance ${fmt(afterMonths)} exceeds earned income from the business ${fmt(cap)}; only ${fmt(cap)} is deducted.`, { personId: input.personId, premiums: afterMonths, cap });
  }
  ctx.trace.add({ step: STEP_LIMITS, id: `sehi.${input.personId}`, label: `${input.label} — self-employed health insurance${capped ? ' (capped at earned income)' : ''}`, exact: deducted, source: 'gl_map', formula: `min(${input.premiums} × ${eligible}/${MONTHS_PER_YEAR} eligible months, earned income ${cap})`, personId: input.personId });
  return { personId: input.personId, premiums: dec(input.premiums), eligibleMonths: eligible, afterMonths, earnedIncomeCap: cap, deducted, capped };
}

// ── HSA ──────────────────────────────────────────────────────────────

export interface HsaLimitInput {
  personId: string;
  label: string;
  coverage: HsaCoverage;
  contributed: Dec;
  age: number | null;
}

export interface HsaLimitExact {
  personId: string;
  coverage: HsaCoverage;
  contributed: Dec;
  limit: Dec;
  deducted: Dec;
  capped: boolean;
}

export function computeHsaLimit(input: HsaLimitInput, ctx: EngineContext): HsaLimitExact {
  const { params } = ctx;
  let limit: Dec = ZERO;
  const keys: string[] = [];
  if (input.coverage !== 'none') {
    const key = input.coverage === 'family' ? 'hsa.limit.family' : 'hsa.limit.self';
    limit = params.money(key);
    keys.push(key);
    const catchUpAge = params.int('hsa.catch_up_age');
    keys.push('hsa.catch_up_age');
    if (input.age != null && input.age >= catchUpAge) {
      limit = dAdd(limit, params.money('hsa.catch_up_55'));
      keys.push('hsa.catch_up_55');
    }
  }
  const deducted = dMin(input.contributed, limit);
  const capped = dCmp(input.contributed, limit) > 0;
  if (capped) {
    ctx.warn('TE_HSA_CAPPED', input.coverage === 'none'
      ? `${input.label}: HSA contribution ${fmt(input.contributed)} recorded but no HDHP coverage type is set; nothing is deducted.`
      : `${input.label}: HSA contribution ${fmt(input.contributed)} exceeds the ${input.coverage} coverage limit ${fmt(limit)}; only ${fmt(limit)} is deducted.`, { personId: input.personId, coverage: input.coverage, contributed: input.contributed, limit });
  }
  if (dIsPos(input.contributed) || dIsPos(deducted)) {
    ctx.trace.add({ step: STEP_LIMITS, id: `hsa.${input.personId}`, label: `${input.label} — HSA deduction${capped ? ' (capped)' : ''}`, exact: deducted, source: 'parameter', formula: `min(${input.contributed}, ${input.coverage} limit ${limit})`, personId: input.personId, parameterKeys: keys });
  }
  return { personId: input.personId, coverage: input.coverage, contributed: dec(input.contributed), limit, deducted, capped };
}
