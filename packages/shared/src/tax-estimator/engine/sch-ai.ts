// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md "Schedule AI" (Form 2210 Schedule AI, D7). For each period end
// (`sch_ai.period_ends`: 3/31, 5/31, 8/31, 12/31) the ACTUAL tax-basis figures
// from Jan 1 are annualized by `sch_ai.annualization_factors` and run through
// the federal engine — injected as a callback so Phase 7's changes to
// federal.ts never touch this file. The 12/31 column is the projection itself.
//   Part I   annualized income and adjustments; FULL-YEAR standard deduction and
//            FULL-YEAR credits (the engine does this on its own: credits and the
//            standard deduction are not scaled); QBI figured on the annualized
//            amounts (Q13a, assumption); tax on annualized taxable income;
//            × applicable percentage (`sch_ai.applicable_pcts`) = line 22.
//   Part II  SE tax on the PERIOD net earnings against the wage base prorated
//            by `sch_ai.period_months`/12, then × factor (line 15) — rebuilt from
//            the engine's EXACT per-person SE income / Social Security wages (R2-07).
//   SEHI     a column deducts the period's premiums for the months deductible
//            WITHIN the period, annualized (Sch AI line 4): the eligible-month
//            fraction is applied here and the column sees every month as
//            deductible, so the engine does not apply the year fraction again (R2-05).
//   Column warnings (other than the D12a parameter ones) are forwarded to the
//            estimate context tagged with the period; column parameter reads are
//            unioned into the estimate's `parametersUsed` (R2-06).
//   Lines 23–27: per installment the lesser of the annualized amount or the
//            regular installment with recapture of the regular amount skipped
//            in an earlier column (line 26).
// Shown even when not used (MODULE.md).

import { ZERO, dAdd, dCmp, dDiv, dFloorZero, dIsPos, dMin, dMul, dRoundDollars, dSub, dSum, dec, type Dec } from '../decimal.js';
import { monthDayInYear } from '../dates.js';
import type { EstimateContext } from './estimate-types.js';
import type { EngineAdjustment, EngineEntity, EnginePerson, EngineYearInputs, FederalEngineInput, FederalResult } from './types.js';

const STEP = 'schedule_ai';
const MONTHS_PER_YEAR = String(12);
const FULL_YEAR_MONTHS = 12;

export type FederalCalculator = (scenario: FederalEngineInput) => FederalResult;

// ── Policy (which keys describe the periods) ─────────────────────────

export interface SchAiPolicy {
  label: string;
  periodEndsKey: string;
  factorsKey: string;
  applicablePctsKey: string;
  /** null = no SE tax in this regime (C corp): Part II is skipped. */
  periodMonthsKey: string | null;
}

export const INDIVIDUAL_SCH_AI_POLICY: SchAiPolicy = {
  label: 'individual (Form 2210 Schedule AI)',
  periodEndsKey: 'sch_ai.period_ends',
  factorsKey: 'sch_ai.annualization_factors',
  applicablePctsKey: 'sch_ai.applicable_pcts',
  periodMonthsKey: 'sch_ai.period_months',
};

/** Phase 9: C corporations (Form 2220 Schedule A). */
export const CCORP_SCH_AI_POLICY: SchAiPolicy = {
  label: 'C corporation (Form 2220 Schedule A)',
  periodEndsKey: 'ccorp.sch_ai.period_ends',
  factorsKey: 'ccorp.sch_ai.annualization_factors',
  applicablePctsKey: 'ccorp.sch_ai.applicable_pcts',
  periodMonthsKey: null,
};

// ── Annualizing a scenario ───────────────────────────────────────────

const scale = (v: string, f: Dec): string => dMul(dec(v), f);
const scaleNullable = (v: string | null, f: Dec): string | null => (v == null ? null : scale(v, f));

/** Fraction of the period's SEHI premiums that is deductible: eligible months within the period ÷ period months (null = leave to the engine). */
type SehiFractionFor = (personId: string | null, entity: EngineEntity | null) => Dec | null;

function annualizeEntity(e: EngineEntity, f: Dec, sehiFraction: SehiFractionFor): EngineEntity {
  const chars = (c: EngineEntity['ytd']): EngineEntity['ytd'] => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, scale(v, f)])) as EngineEntity['ytd'];
  const sehi = (o: EngineEntity['ownerItems'][number]): string => {
    const fraction = sehiFraction(o.personId, e);
    return fraction == null ? scale(o.sehi, f) : scale(o.sehi, dMul(f, fraction));
  };
  return {
    ...e,
    monthsElapsed: FULL_YEAR_MONTHS,
    monthsRemaining: 0,
    ytd: chars(e.ytd),
    recurringYtd: chars(e.recurringYtd),
    ownerItems: e.ownerItems.map((o) => ({ ...o, sehi: sehi(o), retirement: scale(o.retirement, f), sehiAsW2Wages: scale(o.sehiAsW2Wages, f) })),
    guaranteedPayments: e.guaranteedPayments.map((g) => ({ ...g, amount: scale(g.amount, f) })),
    officerWages: e.officerWages.map((w) => ({ ...w, amount: scale(w.amount, f) })),
    taxDepreciationBookYtd: scale(e.taxDepreciationBookYtd, f),
    w2WagesEffective: scaleNullable(e.w2WagesEffective, f),
  };
}

function annualizePerson(p: EnginePerson, f: Dec, sehiFraction: Dec | null): EnginePerson {
  return {
    ...p,
    // With a period month count the column's SEHI months are all deductible (the period fraction is pre-applied to the premiums).
    sehiEligibleMonths: sehiFraction == null ? p.sehiEligibleMonths : new Array<boolean>(FULL_YEAR_MONTHS).fill(true),
    w2Wages: scale(p.w2Wages, f),
    w2SocialSecurityWages: scaleNullable(p.w2SocialSecurityWages, f),
    retirementEmployeeDeferral: scaleNullable(p.retirementEmployeeDeferral, f),
    hsaContribution: scale(p.hsaContribution, f),
    sch1a: { qualifiedTips: scale(p.sch1a.qualifiedTips, f), qualifiedOvertime: scale(p.sch1a.qualifiedOvertime, f), carLoanInterest: scale(p.sch1a.carLoanInterest, f) },
  };
}

const SEHI_ADJUSTMENT_CODE = 'owner_health_insurance';

function annualizeAdjustment(a: EngineAdjustment, f: Dec, sehiFraction: SehiFractionFor): EngineAdjustment {
  const fraction = a.kind === 'deduction' && a.typeCode === SEHI_ADJUSTMENT_CODE ? sehiFraction(a.personId, null) : null;
  return { ...a, amount: scale(a.amount, fraction == null ? f : dMul(f, fraction)) };
}

/**
 * Per-person deductible fraction of the period's SEHI premiums (R2-05): eligible
 * months among the first `periodMonths` ÷ `periodMonths`. A null-person owner item
 * resolves like the engine's ownerPerson (single link → that person, else primary);
 * an unknown person resolves to the primary. null when no period month count is
 * known (C corp policy) or the flags are malformed (the engine warns about those).
 */
function sehiFractionResolver(actuals: FederalEngineInput, periodMonths: number | null | undefined): SehiFractionFor {
  if (periodMonths == null || periodMonths <= 0 || periodMonths >= FULL_YEAR_MONTHS) return () => null;
  const primary = actuals.persons.find((p) => p.role === 'primary') ?? actuals.persons[0];
  const fractions = new Map<string, Dec | null>();
  for (const p of actuals.persons) {
    if (p.sehiEligibleMonths.length !== FULL_YEAR_MONTHS) { fractions.set(p.personId, null); continue; }
    const eligible = p.sehiEligibleMonths.slice(0, periodMonths).filter((m) => m === true).length;
    fractions.set(p.personId, dDiv(String(eligible), String(periodMonths)));
  }
  return (personId, entity) => {
    let pid = personId;
    if (pid == null && entity && entity.links.length === 1) pid = entity.links[0]!.personId;
    if (pid == null || !fractions.has(pid)) pid = primary?.personId ?? null;
    return pid == null ? null : (fractions.get(pid) ?? null);
  };
}

/** Credits stay full-year (Q13b); itemized deductions and preferential-gain splits are annualized (Sch AI line 4). */
function annualizeYear(y: EngineYearInputs, f: Dec): EngineYearInputs {
  return {
    ...y,
    itemized: { saltPaid: scale(y.itemized.saltPaid, f), mortgageInterest: scale(y.itemized.mortgageInterest, f), charitableCash: scale(y.itemized.charitableCash, f), charitableNoncash: scale(y.itemized.charitableNoncash, f), other: scale(y.itemized.other, f) },
    unrecaptured1250Gain: scale(y.unrecaptured1250Gain, f),
    collectiblesGain: scale(y.collectiblesGain, f),
  };
}

/**
 * Period actuals (Jan 1 – period end) → the annualized full-year scenario the
 * federal engine prices: every book / owner / wage / adjustment flow × factor,
 * months set to a closed year so nothing is projected again; the standard
 * deduction, credits, UBIA and rate mode are untouched. With `periodMonths`
 * the SEHI premiums are first reduced to the period's deductible fraction and
 * the column's eligibility flags set to all-deductible (R2-05); without it (C corp
 * policy, legacy callers) the flags pass through unchanged.
 * Add a field here when a new money flow joins the engine input.
 */
export function annualizeFederalInput(actuals: FederalEngineInput, factor: Dec, periodMonths?: number | null): FederalEngineInput {
  const f = dec(factor);
  const sehiFraction = sehiFractionResolver(actuals, periodMonths);
  const flagsHandled = periodMonths != null && periodMonths > 0 && periodMonths < FULL_YEAR_MONTHS;
  return {
    ...actuals,
    persons: actuals.persons.map((p) => annualizePerson(p, f, flagsHandled && p.sehiEligibleMonths.length === FULL_YEAR_MONTHS ? sehiFraction(p.personId, null) : null)),
    entities: actuals.entities.map((e) => annualizeEntity(e, f, sehiFraction)),
    adjustments: actuals.adjustments.map((a) => annualizeAdjustment(a, f, sehiFraction)),
    year: annualizeYear(actuals.year, f),
  };
}

// ── Inputs and results ───────────────────────────────────────────────

export interface ScheduleAiInput {
  /** The full-year projected scenario (the last column). */
  base: FederalEngineInput;
  /** Its result when already computed (saves one engine call). */
  baseResult?: FederalResult;
  /**
   * Actual figures Jan 1 – period end for the columns BEFORE the last one, index
   * aligned with `sch_ai.period_ends`. null = not available (the column is
   * skipped: that installment falls back to the regular amount, with a warning).
   */
  periodActuals: ReadonlyArray<FederalEngineInput | null>;
  /** Required annual payment (safe harbor) — line 9 of Form 2210. */
  requiredAnnualPayment: Dec;
  /** Regular installment percentages (`installments.pcts`), one per column. */
  installmentPcts: ReadonlyArray<Dec>;
  calc: FederalCalculator;
  policy?: SchAiPolicy;
}

export interface SchAiPartII {
  personId: string;
  periodSeIncome: Dec;
  periodNese: Dec;
  proratedWageBase: Dec;
  periodSocialSecurityWages: Dec;
  periodSeTax: Dec;
  annualizedSeTax: Dec;
}

export interface SchAiPeriodExact {
  annualizedAgi: Dec;
  annualizedTaxableIncome: Dec;
  annualizedIncomeTax: Dec;
  annualizedQbi: Dec;
  engineSeTax: Dec;
  partIiSeTax: Dec;
  annualizedOtherTaxes: Dec;
  creditsFullYear: Dec;
  annualizedTotalTax: Dec;
  line22: Dec;
  line23: Dec;
  line24: Dec;
  line25: Dec;
  line26: Dec;
  line27: Dec;
}

export interface SchAiPeriodResult {
  period: number;
  periodEnd: string;
  months: number | null;
  factor: Dec;
  applicablePct: Dec;
  /** false = no actuals for the column (regular installment used). */
  available: boolean;
  /** The column is the full-year projection (last period). */
  isProjection: boolean;
  annualizedAgi: Dec;
  standardDeductionFullYear: Dec | null;
  annualizedQbi: Dec;
  annualizedTaxableIncome: Dec;
  annualizedIncomeTax: Dec;
  /** Part II (period net earnings against the prorated wage base, × factor). */
  annualizedSeTax: Dec;
  /** SE tax the engine computed on the annualized inputs (equal when factor = 12 ÷ months). */
  engineSeTax: Dec;
  annualizedOtherTaxes: Dec;
  creditsFullYear: Dec;
  annualizedTotalTax: Dec;
  /** line 22 — annualized tax × applicable %, cumulative requirement through the period. */
  requiredCumulative: Dec;
  /** line 24 — this column's annualized installment (22 − Σ earlier line 27). */
  annualizedInstallment: Dec;
  /** line 25 — the regular installment. */
  regularInstallment: Dec;
  /** line 26 — regular installment + regular amount skipped in earlier columns (recapture). */
  regularWithRecapture: Dec;
  /** line 27 — the required installment: lesser of 24 and 26. */
  requiredInstallment: Dec;
  usedAnnualized: boolean;
  partIi: SchAiPartII[];
  exact: SchAiPeriodExact;
}

export interface ScheduleAiResult {
  policy: string;
  periods: SchAiPeriodResult[];
  /** line 27 per column (whole dollars). */
  requiredInstallments: Dec[];
  /** true when any column's annualized amount is below the regular installment. */
  lowersAnyInstallment: boolean;
  /** Q13a / Q13b and other assumptions for the trace / assumptions page. */
  assumptions: string[];
  keys: string[];
  exact: { requiredInstallments: Dec[] };
}

export const SCH_AI_ASSUMPTIONS = {
  qbi: 'Q13a: the §199A deduction in each Schedule AI column is figured on the annualized amounts (Schedule AI line 9).',
  credits: 'Q13b: credits in each column are the FULL-YEAR credits, not annualized (Schedule AI line 19); the standard deduction is the full-year amount (line 7).',
  seDeduction: 'The deductible part of SE tax in each column follows the engine\'s SE tax on the annualized inputs; it equals Part II when the factor is 12 ÷ months.',
  itemized: 'Itemized deductions, HSA, retirement deferrals and Schedule 1-A amounts are annualized with the income (Schedule AI line 4); UBIA is not. Self-employed health insurance in a column is the period\'s premiums for the months deductible within the period, annualized.',
} as const;

const R = dRoundDollars;

/** Part II for one person from the annualized result: period figures = annualized ÷ factor. */
function partIi(result: FederalResult, factor: Dec, months: number, ctx: EstimateContext): SchAiPartII[] {
  const p = ctx.params;
  const neseFactor = p.rate('se.nese_factor');
  const ssRate = p.rate('se.ss_rate');
  const medicareRate = p.rate('se.medicare_rate');
  const wageBase = p.money('se.ss_wage_base');
  const prorated = dDiv(dMul(wageBase, String(months)), MONTHS_PER_YEAR);
  return result.persons.map((person) => {
    // Exact per-person figures (R2-07): rounding the annualized SE income first would drift line 15 by ±$1, and
    // box-1 wages overstate the wage-base offset (the >2% health add-on is not Social Security wages).
    const seIncomeA = dec(person.exact.seIncome);
    const periodSeIncome = dDiv(seIncomeA, factor);
    const periodNese = dIsPos(periodSeIncome) ? dMul(periodSeIncome, neseFactor) : ZERO;
    const periodSsWages = dDiv(dec(person.exact.socialSecurityWages), factor);
    const remainingBase = dFloorZero(dSub(prorated, periodSsWages));
    const periodSeTax = dAdd(dMul(ssRate, dMin(periodNese, remainingBase)), dMul(medicareRate, periodNese));
    return { personId: person.personId, periodSeIncome, periodNese, proratedWageBase: prorated, periodSocialSecurityWages: periodSsWages, periodSeTax, annualizedSeTax: dMul(periodSeTax, factor) };
  });
}

/** Q44: pin an annualized column's dependent credits to the full-year amounts (D7: credits are full-year). */
export function withFixedDependentCredits(scenario: FederalEngineInput, full: FederalResult): FederalEngineInput {
  const d = full.dependentCredits;
  if (!d || d.method === 'none') return scenario;
  return {
    ...scenario,
    year: { ...scenario.year, fixedDependentCredits: { care: d.careTentative, ctcOdc: d.ctcOdcAfterPhaseOut, actc: d.actc } },
  };
}

/**
 * Compute Schedule AI. Reads the period parameters through the context, prices
 * each annualized column with `input.calc`, and runs lines 22–27.
 */
export function computeScheduleAi(input: ScheduleAiInput, ctx: EstimateContext): ScheduleAiResult {
  const policy = input.policy ?? INDIVIDUAL_SCH_AI_POLICY;
  const periodEnds = ctx.params.monthDayList(policy.periodEndsKey);
  const factors = ctx.params.rateList(policy.factorsKey);
  const pcts = ctx.params.rateList(policy.applicablePctsKey);
  const monthsList = policy.periodMonthsKey ? ctx.params.intList(policy.periodMonthsKey) : null;
  const keys = [policy.periodEndsKey, policy.factorsKey, policy.applicablePctsKey, ...(policy.periodMonthsKey ? [policy.periodMonthsKey] : [])];
  const n = periodEnds.length;
  if (factors.length !== n || pcts.length !== n || (monthsList && monthsList.length !== n) || input.installmentPcts.length !== n) {
    throw new Error(`TE_SCH_AI_SHAPE: ${policy.label} period parameters and installment percentages must have the same length`);
  }
  const partIiKeys = ['se.nese_factor', 'se.ss_rate', 'se.medicare_rate', 'se.ss_wage_base'];
  const required = dec(input.requiredAnnualPayment);
  const assumptions = [SCH_AI_ASSUMPTIONS.qbi, SCH_AI_ASSUMPTIONS.credits, SCH_AI_ASSUMPTIONS.seDeduction, SCH_AI_ASSUMPTIONS.itemized];

  let fullYearResult: FederalResult | null = input.baseResult ?? null;
  const fullYear = (): FederalResult => (fullYearResult ??= input.calc(input.base));

  const periods: SchAiPeriodResult[] = [];
  let cumulativeLine27 = ZERO; // line 23 of the next column
  let priorLine26 = ZERO;      // line 26 of the previous column (recapture base)
  let priorLine27 = ZERO;      // line 27 of the previous column
  let lowersAny = false;
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const factor = factors[i] as Dec;
    const pct = pcts[i] as Dec;
    const months = monthsList ? (monthsList[i] as number) : null;
    const periodEnd = monthDayInYear(periodEnds[i] as string, ctx.taxYear);
    const line25 = dMul(required, dec(input.installmentPcts[i] as Dec));
    const line26 = i === 0 ? line25 : dAdd(line25, dSub(priorLine26, priorLine27));

    const actuals = isLast ? input.base : (input.periodActuals[i] ?? null);
    if (!actuals) {
      ctx.warn('TE_SCH_AI_PERIOD_MISSING', `Schedule AI period ${i + 1} (through ${periodEnd}) has no actual figures; the regular installment ${R(line26)} was used for that column.`, { period: i + 1, periodEnd });
      const exact: SchAiPeriodExact = { annualizedAgi: ZERO, annualizedTaxableIncome: ZERO, annualizedIncomeTax: ZERO, annualizedQbi: ZERO, engineSeTax: ZERO, partIiSeTax: ZERO, annualizedOtherTaxes: ZERO, creditsFullYear: ZERO, annualizedTotalTax: ZERO, line22: ZERO, line23: cumulativeLine27, line24: line26, line25, line26, line27: line26 };
      periods.push({ period: i + 1, periodEnd, months, factor, applicablePct: pct, available: false, isProjection: false, annualizedAgi: ZERO, standardDeductionFullYear: null, annualizedQbi: ZERO, annualizedTaxableIncome: ZERO, annualizedIncomeTax: ZERO, annualizedSeTax: ZERO, engineSeTax: ZERO, annualizedOtherTaxes: ZERO, creditsFullYear: ZERO, annualizedTotalTax: ZERO, requiredCumulative: ZERO, annualizedInstallment: R(line26), regularInstallment: R(line25), regularWithRecapture: R(line26), requiredInstallment: R(line26), usedAnnualized: false, partIi: [], exact });
      cumulativeLine27 = dAdd(cumulativeLine27, line26);
      priorLine26 = line26;
      priorLine27 = line26;
      continue;
    }

    // Q44 / D7: an annualized column uses the FULL-YEAR dependent credits (only the regular-tax limit is re-applied).
    const scenario = isLast ? actuals : withFixedDependentCredits(annualizeFederalInput(actuals, factor, months), fullYear());
    const result = isLast && input.baseResult ? input.baseResult : input.calc(scenario);
    if (!isLast) {
      // R2-06: a condition that exists only in this column (SEHI capped, SALT phased down, W-2 missing above the
      // threshold …) must reach the assumptions page; the full-year column's warnings belong to the federal result.
      for (const w of result.warnings ?? []) {
        if (w.code === 'TE_PARAM_UNVERIFIED') continue; // covered by the parameter union below, once per key
        ctx.warn(w.code, `Schedule AI period ${i + 1} (through ${periodEnd}): ${w.message}`, { ...(w.details ?? {}), period: i + 1 }, w.severity);
      }
      ctx.params.noteUsed(result.parametersUsed ?? []);
    }
    const engineSeTax = dec(result.exact.seTax);
    const pii = months != null ? partIi(result, factor, months, ctx) : [];
    const partIiSeTax = months != null ? dSum(pii.map((x) => x.annualizedSeTax)) : engineSeTax;
    if (months != null && dCmp(R(partIiSeTax), R(engineSeTax)) !== 0) {
      ctx.info('TE_SCH_AI_SE_PART2_DIFFERS', `Schedule AI period ${i + 1}: Part II SE tax ${R(partIiSeTax)} differs from the engine's SE tax on the annualized inputs ${R(engineSeTax)}; Part II is used for line 15.`, { period: i + 1 });
    }
    const otherTaxes = dAdd(dec(result.exact.additionalMedicareTax), dec(result.exact.niit));
    const credits = dAdd(dec(result.exact.nonrefundableCredits), dec(result.exact.refundableCredits));
    // line 21 = regular tax − credits + Part II SE + other taxes (the engine's total with its SE tax swapped for Part II).
    const totalTax = dAdd(dSub(dec(result.exact.federalTotal), engineSeTax), partIiSeTax);
    const line22 = dMul(totalTax, pct);
    const line23 = cumulativeLine27;
    const line24 = dFloorZero(dSub(line22, line23));
    const line27 = dMin(line24, line26);
    const usedAnnualized = dCmp(line24, line26) < 0;
    if (usedAnnualized) lowersAny = true;

    const exact: SchAiPeriodExact = {
      annualizedAgi: dec(result.exact.agi), annualizedTaxableIncome: dec(result.exact.taxableIncome), annualizedIncomeTax: dec(result.exact.regularTax), annualizedQbi: dec(result.exact.qbi),
      engineSeTax, partIiSeTax, annualizedOtherTaxes: otherTaxes, creditsFullYear: credits, annualizedTotalTax: totalTax, line22, line23, line24, line25, line26, line27,
    };
    ctx.trace.add({ step: STEP, id: `federal.sch_ai.${i + 1}.total_tax`, jurisdiction: 'federal', label: `Schedule AI period ${i + 1} (through ${periodEnd}, × ${factor}) — annualized total tax`, exact: totalTax, source: 'parameter', formula: `regular ${result.exact.regularTax} − credits ${credits} + SE (Part II) ${partIiSeTax} + other ${otherTaxes}`, parameterKeys: [...keys, ...partIiKeys] });
    ctx.trace.add({ step: STEP, id: `federal.sch_ai.${i + 1}.line22`, jurisdiction: 'federal', label: `Schedule AI period ${i + 1} — required through period (× ${pct})`, exact: line22, source: 'parameter', formula: `${totalTax} × ${pct}`, parameterKeys: [policy.applicablePctsKey] });
    ctx.trace.add({ step: STEP, id: `federal.sch_ai.${i + 1}.line27`, jurisdiction: 'federal', label: `Schedule AI period ${i + 1} — required installment (lesser of annualized ${R(line24)} / regular ${R(line26)})`, exact: line27, source: 'parameter', formula: `min(${line22} − ${line23}, ${line25} + recapture ${dSub(line26, line25)})` });

    periods.push({
      period: i + 1, periodEnd, months, factor, applicablePct: pct, available: true, isProjection: isLast,
      annualizedAgi: R(exact.annualizedAgi), standardDeductionFullYear: result.deductions.chosen === 'standard' ? dec(result.deductions.deduction) : null,
      annualizedQbi: R(exact.annualizedQbi), annualizedTaxableIncome: R(exact.annualizedTaxableIncome), annualizedIncomeTax: R(exact.annualizedIncomeTax),
      annualizedSeTax: R(partIiSeTax), engineSeTax: R(engineSeTax), annualizedOtherTaxes: R(otherTaxes), creditsFullYear: R(credits), annualizedTotalTax: R(totalTax),
      requiredCumulative: R(line22), annualizedInstallment: R(line24), regularInstallment: R(line25), regularWithRecapture: R(line26), requiredInstallment: R(line27), usedAnnualized,
      partIi: pii, exact,
    });
    cumulativeLine27 = dAdd(cumulativeLine27, line27);
    priorLine26 = line26;
    priorLine27 = line27;
  }

  assumptions.forEach((a, i) => ctx.info('TE_SCH_AI_ASSUMPTION', a, { assumption: i + 1 }));
  return {
    policy: policy.label, periods,
    requiredInstallments: periods.map((p) => p.requiredInstallment),
    lowersAnyInstallment: lowersAny,
    assumptions, keys: [...keys, ...partIiKeys],
    exact: { requiredInstallments: periods.map((p) => p.exact.line27) },
  };
}
