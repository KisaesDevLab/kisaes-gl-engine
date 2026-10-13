// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md step 12 — dependent credits (OPEN-QUESTIONS Q44). Pure.
//
//   Ages: every age is the age attained on Dec 31 of the tax year, a birthday on
//     Dec 31 counting (Rev. Rul. 2003-72 for §24: a child attains an age on the
//     anniversary of birth). A dependent born after the tax year, or outside its
//     [firstTaxYear, lastTaxYear] window, does not count.
//   Classification: a `qualifying_child` under `ctc.child_age_limit` who meets the
//     residency month test → child tax credit; every other active dependent →
//     credit for other dependents (a `qualifying_child` failing the §152(c)(3) age
//     test or the residency test is warned and treated as an other dependent —
//     the qualifying-relative tests are the CPA's to confirm).
//   Order against regular tax (Q44): (1) §21 care credit, (2) §24 CTC + ODC
//     (Schedule 8812 Credit Limit Worksheet A subtracts Form 2441 first), then the
//     manual "other" nonrefundable credits in federal.ts.
//   §24: (children × ctc.amount + others × ctc.odc_amount) − ctc.phaseout_reduction
//     per ctc.phaseout_step or fraction of MAGI (= AGI) over the threshold;
//     nonrefundable part limited by the tax left after the care credit; ACTC =
//     min(unused, children × ctc.refundable_max, rate × (earned − floor)) — the
//     Part II-B alternative for 3+ children is not modelled (warning).
//   §21: min(expenses, limit for 1 / 2+ qualifying persons, earned income — the
//     lower-earning spouse on a joint return) × the applicable percentage
//     (max rate, reduced by rate_step per AGI step or fraction above phase-1 start
//     down to the phase-1 floor; then, when the phase-2 floor is lower, further per
//     phase-2 step down to it — the 2026+ OBBBA structure).
//   Care qualifying person: a qualifying child who was under `care.qualifying_age`
//     at the start of the year (so a child turning 13 during the year counts — an
//     approximation, only the expenses before the birthday qualify) or any
//     dependent marked disabled.
//   Earned income per person: wages (box 1, incl. officer wages) + SE income −
//     ½ SE tax (Schedule 8812 / Form 2441 earned-income approximation).
//   EITC is not computed (warning); head of household is not inferred (warning).

import { ZERO, dAdd, dCmp, dFloorZero, dIsPos, dIsZero, dMax, dMin, dMul, dSub, dec, type Dec } from '../decimal.js';
import type { FilingStatus } from '../types.js';
import type { PersonRole } from '../taxpayers-api.js';
import { EngineContext, ageAtYearEnd } from './context.js';
import { dCeilDiv } from './deductions.js';
import type {
  DependentAgeGroup, DependentCreditPersonResult, EngineDependent, FixedDependentCredits,
} from './types.js';

const STEP = 'credits';

export interface EarnedIncomePerson {
  personId: string;
  role: PersonRole;
  label: string;
  earned: Dec;
}

export interface DependentCreditsInput {
  dependents: ReadonlyArray<EngineDependent>;
  filingStatus: FilingStatus;
  taxYear: number;
  agi: Dec;
  regularTax: Dec;
  persons: ReadonlyArray<EarnedIncomePerson>;
  careExpenses: Dec;
  fixed: FixedDependentCredits | null;
}

export interface DependentCreditsExact {
  method: 'computed' | 'fixed' | 'none';
  dependents: DependentCreditPersonResult[];
  ctcChildren: number;
  otherDependents: number;
  careQualifyingPersons: number;
  ctcTentative: Dec;
  odcTentative: Dec;
  phaseOutMagi: Dec;
  phaseOutThreshold: Dec;
  phaseOutReduction: Dec;
  ctcOdcAfterPhaseOut: Dec;
  ctcOdcAllowed: Dec;
  earnedIncome: Dec;
  actcByChildren: Dec;
  actcByEarnedIncome: Dec;
  actc: Dec;
  careExpenses: Dec;
  careExpenseLimit: Dec;
  careEarnedIncomeLimit: Dec;
  careAllowedExpenses: Dec;
  careRate: Dec;
  careTentative: Dec;
  careAllowed: Dec;
  /** Regular tax left for the other nonrefundable credits. */
  taxAfterDependentCredits: Dec;
}

const DOB_YEAR = /^(\d+)-/;

/** Dependents that count in `taxYear` (window + born by year end). */
export function activeDependents(deps: ReadonlyArray<EngineDependent>, taxYear: number): EngineDependent[] {
  return deps.filter((d) => {
    if (d.firstTaxYear != null && taxYear < d.firstTaxYear) return false;
    if (d.lastTaxYear != null && taxYear > d.lastTaxYear) return false;
    const m = DOB_YEAR.exec(d.dateOfBirth);
    return !!m && Number(m[1]) <= taxYear;
  });
}

function emptyExact(regularTax: Dec, careExpenses: Dec): DependentCreditsExact {
  return {
    method: 'none', dependents: [], ctcChildren: 0, otherDependents: 0, careQualifyingPersons: 0,
    ctcTentative: ZERO, odcTentative: ZERO, phaseOutMagi: ZERO, phaseOutThreshold: ZERO, phaseOutReduction: ZERO, ctcOdcAfterPhaseOut: ZERO, ctcOdcAllowed: ZERO,
    earnedIncome: ZERO, actcByChildren: ZERO, actcByEarnedIncome: ZERO, actc: ZERO,
    careExpenses, careExpenseLimit: ZERO, careEarnedIncomeLimit: ZERO, careAllowedExpenses: ZERO, careRate: ZERO, careTentative: ZERO, careAllowed: ZERO,
    taxAfterDependentCredits: regularTax,
  };
}

function ageGroup(age: number, ctx: EngineContext): DependentAgeGroup {
  const care = ctx.params.int('care.qualifying_age');
  const ctc = ctx.params.int('ctc.child_age_limit');
  const qc = ctx.params.int('dependents.qc_age_limit');
  const student = ctx.params.int('dependents.qc_student_age_limit');
  if (age < care) return 'under_13';
  if (age < ctc) return '13_to_16';
  if (age < qc) return '17_to_18';
  if (age < student) return '19_to_23';
  return '24_plus';
}

/** Applicable §21 percentage for an AGI (exposed for tests). */
export function careRateFor(agi: Dec, ctx: EngineContext, keys: string[]): Dec {
  const { params, filingStatus } = ctx;
  const v = filingStatus === 'mfj' ? 'mfj' : 'standard';
  const max = params.rate('care.max_rate');
  const step = params.rate('care.rate_step');
  const p1Start = params.money('care.phase1.start');
  const p1Step = params.money('care.phase1.agi_step');
  const p1Min = params.rate('care.phase1.min_rate');
  const p2Min = params.rate('care.phase2.min_rate');
  keys.push('care.max_rate', 'care.rate_step', 'care.phase1.start', 'care.phase1.agi_step', 'care.phase1.min_rate', 'care.phase2.min_rate');
  let rate = max;
  const over1 = dFloorZero(dSub(agi, p1Start));
  if (dIsPos(over1)) rate = dMax(p1Min, dSub(rate, dMul(dCeilDiv(over1, p1Step), step)));
  if (dCmp(p2Min, p1Min) < 0) {
    const p2Start = params.money(`care.phase2.start.${v}`);
    const p2Step = params.money(`care.phase2.agi_step.${v}`);
    keys.push(`care.phase2.start.${v}`, `care.phase2.agi_step.${v}`);
    const over2 = dFloorZero(dSub(agi, p2Start));
    if (dIsPos(over2)) rate = dMax(p2Min, dSub(rate, dMul(dCeilDiv(over2, p2Step), step)));
  }
  return dFloorZero(rate);
}

export function computeDependentCredits(input: DependentCreditsInput, ctx: EngineContext): DependentCreditsExact {
  const regularTax = dFloorZero(input.regularTax);
  const careExpenses = dFloorZero(input.careExpenses);

  // Schedule AI column: full-year amounts, only the tax limit re-applied (D7 / Q13).
  if (input.fixed) {
    const care = dFloorZero(dec(input.fixed.care));
    const ctcOdc = dFloorZero(dec(input.fixed.ctcOdc));
    const actc = dFloorZero(dec(input.fixed.actc));
    const careAllowed = dMin(care, regularTax);
    const left = dSub(regularTax, careAllowed);
    const ctcOdcAllowed = dMin(ctcOdc, left);
    if (dIsPos(care) || dIsPos(ctcOdc) || dIsPos(actc)) {
      ctx.trace.add({ step: STEP, id: 'credits.dependents.fixed', label: 'Dependent credits (full-year amounts, Schedule AI column)', exact: dAdd(dAdd(careAllowed, ctcOdcAllowed), actc), source: 'input', formula: `care min(${care}, ${regularTax}) + CTC/ODC min(${ctcOdc}, ${left}) + ACTC ${actc}` });
    }
    return {
      ...emptyExact(regularTax, careExpenses), method: 'fixed', ctcOdcAfterPhaseOut: ctcOdc, ctcOdcAllowed, actc, careTentative: care, careAllowed,
      taxAfterDependentCredits: dSub(left, ctcOdcAllowed),
    };
  }

  const deps = activeDependents(input.dependents, input.taxYear);
  if (deps.length === 0 && dIsZero(careExpenses)) return emptyExact(regularTax, careExpenses);
  const { params } = ctx;

  // ── Classification ──
  const ctcAge = params.int('ctc.child_age_limit');
  const qcAge = params.int('dependents.qc_age_limit');
  const qcStudentAge = params.int('dependents.qc_student_age_limit');
  const minMonths = params.int('dependents.residency_min_months');
  const careAge = params.int('care.qualifying_age');
  const people: DependentCreditPersonResult[] = [];
  for (const d of deps) {
    const age = ageAtYearEnd(d.dateOfBirth, input.taxYear, false) ?? 0;
    const ageAtStart = (ageAtYearEnd(d.dateOfBirth, input.taxYear, true) ?? 0) - 1;
    const residencyOk = d.monthsLivedWith == null || d.monthsLivedWith >= minMonths;
    const qcAgeOk = age < qcAge || (d.isStudent && age < qcStudentAge) || d.isDisabled;
    const isQc = d.kind === 'qualifying_child' && qcAgeOk && residencyOk;
    if (d.kind === 'qualifying_child' && !qcAgeOk) {
      ctx.warn('TE_DEPENDENT_QC_AGE', `${d.displayName} (age ${age} at year end) does not meet the qualifying-child age test (under ${qcAge}, or a student under ${qcStudentAge}, or disabled); counted for the $${params.money('ctc.odc_amount')} credit for other dependents. Confirm the qualifying-relative tests (gross income, support).`, { dependentId: d.dependentId, age });
    }
    if (d.kind === 'qualifying_child' && !residencyOk) {
      ctx.warn('TE_DEPENDENT_RESIDENCY', `${d.displayName} lived with the taxpayer ${d.monthsLivedWith} month(s); a qualifying child must live with the taxpayer more than half the year (exceptions for temporary absences, birth, divorced parents not modelled). Counted as an other dependent.`, { dependentId: d.dependentId });
    }
    const childTaxCredit = isQc && age < ctcAge;
    const careQualifying = (d.kind === 'qualifying_child' && ageAtStart < careAge && residencyOk) || (d.isDisabled && residencyOk);
    if (careQualifying && !d.isDisabled && age >= careAge) {
      ctx.info('TE_CARE_CHILD_TURNS_13', `${d.displayName} turns ${careAge} during the year and is counted as a care-credit qualifying person; only expenses paid for care before the birthday qualify — enter those only.`, { dependentId: d.dependentId });
    }
    people.push({
      dependentId: d.dependentId, displayName: d.displayName, kind: d.kind, ageAtYearEnd: age, ageGroup: ageGroup(age, ctx),
      childTaxCredit, otherDependentCredit: !childTaxCredit, careQualifying,
      eitcQualifying: isQc,
    });
  }
  const ctcChildren = people.filter((p) => p.childTaxCredit).length;
  const otherDependents = people.length - ctcChildren;
  const careQualifyingPersons = people.filter((p) => p.careQualifying).length;
  const earnedIncome = dFloorZero(input.persons.reduce<Dec>((s, p) => dAdd(s, p.earned), ZERO));

  // ── §21 care credit (first) ──
  let careExpenseLimit: Dec = ZERO; let careEarnedLimit: Dec = ZERO; let careAllowedExpenses: Dec = ZERO; let careRate: Dec = ZERO; let careTentative: Dec = ZERO;
  const careKeys: string[] = [];
  if (dIsPos(careExpenses)) {
    if (careQualifyingPersons === 0) {
      ctx.warn('TE_CARE_NO_QUALIFYING_PERSON', `Child and dependent care expenses of ${careExpenses} were entered but no dependent is a qualifying person (a qualifying child under ${careAge}, or a disabled dependent); no care credit was computed.`, { careExpenses });
    } else if (input.filingStatus === 'mfs') {
      ctx.warn('TE_CARE_CREDIT_MFS', 'Married filing separately generally cannot take the child and dependent care credit (the legally-separated / lived-apart exception is not modelled); no care credit was computed.');
    } else {
      careExpenseLimit = params.money(`care.expense_limit.${careQualifyingPersons === 1 ? 'one' : 'two_plus'}`);
      careKeys.push(`care.expense_limit.${careQualifyingPersons === 1 ? 'one' : 'two_plus'}`);
      if (input.filingStatus === 'mfj') {
        if (input.persons.length <= 1) {
          ctx.warn('TE_CARE_SPOUSE_MISSING', 'Joint return with only one person on file: the care credit earned-income limit used that person\'s earned income alone. Add the spouse.');
          careEarnedLimit = dFloorZero(input.persons[0]?.earned ?? ZERO);
        } else {
          careEarnedLimit = dFloorZero(dMin(...input.persons.map((p) => p.earned) as [Dec, ...Dec[]]));
          const zero = input.persons.find((p) => !dIsPos(p.earned));
          if (zero) ctx.warn('TE_CARE_SPOUSE_NO_EARNED_INCOME', `${zero.label} has no earned income, so the care credit is 0 (the deemed income of a full-time-student or disabled spouse, $250 / $500 a month, is not modelled).`, { personId: zero.personId });
        }
      } else {
        careEarnedLimit = dFloorZero(input.persons.find((p) => p.role === 'primary')?.earned ?? input.persons[0]?.earned ?? ZERO);
      }
      careAllowedExpenses = dMin(careExpenses, careExpenseLimit, careEarnedLimit);
      careRate = careRateFor(input.agi, ctx, careKeys);
      careTentative = dMul(careAllowedExpenses, careRate);
      ctx.info('TE_CARE_EMPLOYER_BENEFITS_NOT_MODELLED', 'Care credit: employer-provided dependent care benefits (Form 2441 Part III) are not modelled; enter expenses net of any excluded benefits.');
    }
  }
  const careAllowed = dMin(careTentative, regularTax);
  if (dIsPos(careExpenses)) {
    ctx.trace.add({ step: STEP, id: 'credits.care.expenses', label: `Care expenses allowed (${careQualifyingPersons} qualifying person${careQualifyingPersons === 1 ? '' : 's'})`, exact: careAllowedExpenses, source: 'parameter', formula: `min(expenses ${careExpenses}, limit ${careExpenseLimit}, earned income ${careEarnedLimit})`, parameterKeys: careKeys.filter((k) => k.startsWith('care.expense_limit')) });
    ctx.trace.add({ step: STEP, id: 'credits.care', label: `Child and dependent care credit (§21, ${careRate} of expenses; first against regular tax)`, exact: careAllowed, source: 'parameter', formula: `min(${careAllowedExpenses} × ${careRate} = ${careTentative}, regular tax ${regularTax})`, parameterKeys: careKeys });
  }
  const afterCare = dSub(regularTax, careAllowed);

  // ── §24 CTC + ODC (second) ──
  let ctcTentative: Dec = ZERO; let odcTentative: Dec = ZERO; let threshold: Dec = ZERO; let reduction: Dec = ZERO;
  let afterPhaseOut: Dec = ZERO; let ctcOdcAllowed: Dec = ZERO;
  let actcByChildren: Dec = ZERO; let actcByEarned: Dec = ZERO; let actc: Dec = ZERO;
  if (people.length > 0) {
    const tv = input.filingStatus === 'mfj' ? 'mfj' : 'standard';
    const ctcKeys = ['ctc.amount', 'ctc.odc_amount', `ctc.phaseout_threshold.${tv}`, 'ctc.phaseout_step', 'ctc.phaseout_reduction'];
    ctcTentative = dMul(String(ctcChildren), params.money('ctc.amount'));
    odcTentative = dMul(String(otherDependents), params.money('ctc.odc_amount'));
    threshold = params.money(`ctc.phaseout_threshold.${tv}`);
    const over = dFloorZero(dSub(input.agi, threshold));
    reduction = dIsPos(over) ? dMul(dCeilDiv(over, params.money('ctc.phaseout_step')), params.money('ctc.phaseout_reduction')) : ZERO;
    afterPhaseOut = dFloorZero(dSub(dAdd(ctcTentative, odcTentative), reduction));
    ctcOdcAllowed = dMin(afterPhaseOut, afterCare);
    ctx.trace.add({ step: STEP, id: 'credits.ctc.tentative', label: `Child tax credit (${ctcChildren} child${ctcChildren === 1 ? '' : 'ren'}) + credit for other dependents (${otherDependents})`, exact: dAdd(ctcTentative, odcTentative), source: 'parameter', formula: `${ctcChildren} × ${params.money('ctc.amount')} + ${otherDependents} × ${params.money('ctc.odc_amount')}`, parameterKeys: ['ctc.amount', 'ctc.odc_amount', 'ctc.child_age_limit'] });
    if (dIsPos(reduction)) {
      ctx.trace.add({ step: STEP, id: 'credits.ctc.phaseout', label: 'Child tax credit phase-out', exact: reduction, source: 'parameter', formula: `⌈(MAGI ${input.agi} − ${threshold}) ÷ ${params.money('ctc.phaseout_step')}⌉ × ${params.money('ctc.phaseout_reduction')}`, parameterKeys: ctcKeys.filter((k) => k.startsWith('ctc.phaseout')) });
    }
    ctx.trace.add({ step: STEP, id: 'credits.ctc', label: 'Child tax credit + credit for other dependents allowed (after the care credit)', exact: ctcOdcAllowed, source: 'parameter', formula: `min(${afterPhaseOut}, regular tax ${regularTax} − care ${careAllowed})`, parameterKeys: ctcKeys });

    if (ctcChildren > 0) {
      const unused = dSub(afterPhaseOut, ctcOdcAllowed);
      actcByChildren = dMul(String(ctcChildren), params.money('ctc.refundable_max'));
      actcByEarned = dMul(dFloorZero(dSub(earnedIncome, params.money('ctc.earned_income_floor'))), params.rate('ctc.earned_income_rate'));
      actc = dIsPos(unused) ? dMin(unused, actcByChildren, actcByEarned) : ZERO;
      if (dIsPos(unused)) {
        ctx.trace.add({ step: STEP, id: 'credits.actc', label: 'Additional child tax credit (refundable)', exact: actc, source: 'parameter', formula: `min(unused ${unused}, ${ctcChildren} × ${params.money('ctc.refundable_max')} = ${actcByChildren}, ${params.rate('ctc.earned_income_rate')} × (earned ${earnedIncome} − ${params.money('ctc.earned_income_floor')}) = ${actcByEarned})`, parameterKeys: ['ctc.refundable_max', 'ctc.earned_income_floor', 'ctc.earned_income_rate'] });
        if (ctcChildren >= params.int('ctc.alt_formula_min_children') && dCmp(actcByEarned, dMin(unused, actcByChildren)) < 0) {
          ctx.warn('TE_ACTC_ALT_FORMULA_NOT_MODELLED', `With ${ctcChildren} qualifying children the Schedule 8812 Part II-B alternative (Social Security / Medicare taxes withheld less EIC) may give a larger additional child tax credit; it is not modelled.`, { children: ctcChildren });
        }
      }
    }
    ctx.info('TE_CTC_SSN_ASSUMED', 'Child tax credit: every child and the taxpayer (one spouse on a joint return) are assumed to have a Social Security number valid for employment issued by the return due date.');
  }

  // ── Warnings that need no amount ──
  const eitcChildren = people.filter((p) => p.eitcQualifying).length;
  if (eitcChildren > 0 && input.filingStatus !== 'mfs') {
    const list = params.moneyList(`eitc.max_agi.${input.filingStatus === 'mfj' ? 'mfj' : 'standard'}`);
    const limit = list[Math.min(eitcChildren, list.length) - 1] ?? ZERO;
    if (dCmp(input.agi, limit) < 0) {
      ctx.warn('TE_EITC_NOT_COMPUTED', `AGI ${input.agi} is under the earned income credit limit for ${eitcChildren} qualifying child${eitcChildren === 1 ? '' : 'ren'} (${limit}); the EITC is not computed and may reduce the tax. Check eligibility (investment-income limit, earned income).`, { agi: input.agi, limit, children: eitcChildren });
    }
  }
  if (input.filingStatus === 'single' && people.some((p) => p.kind === 'qualifying_child' && p.eitcQualifying)) {
    ctx.warn('TE_HOH_MAY_APPLY', 'Filing status is single and there is a qualifying child: head of household may apply (unmarried, paid more than half the cost of keeping up the home). The filing status was not changed.');
  }

  return {
    method: 'computed', dependents: people, ctcChildren, otherDependents, careQualifyingPersons,
    ctcTentative, odcTentative, phaseOutMagi: input.agi, phaseOutThreshold: threshold, phaseOutReduction: reduction,
    ctcOdcAfterPhaseOut: afterPhaseOut, ctcOdcAllowed, earnedIncome, actcByChildren, actcByEarnedIncome: actcByEarned, actc,
    careExpenses, careExpenseLimit, careEarnedIncomeLimit: careEarnedLimit, careAllowedExpenses, careRate, careTentative, careAllowed,
    taxAfterDependentCredits: dSub(afterCare, ctcOdcAllowed),
  };
}
