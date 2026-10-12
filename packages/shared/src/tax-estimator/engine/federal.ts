// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// MODULE.md "Federal calculation order (individual)" — the pure orchestrator.
// Steps 1–2, 4–8, 10–12, 14 are computed here (Phase 6); step 3 (loss limits),
// step 9 (QBI) and step 13 (Additional Medicare, NIIT) are typed extension
// points filled in Phase 7 and currently pass through / read stub inputs.
// Everything is unrounded until the result DTO is assembled.

import type { CharacterAmounts } from '../entities-api.js';
import {
  ZERO, dAdd, dCmp, dFloorZero, dIsPos, dIsZero, dMin, dRoundDollars, dSub, dSum, dec, type Dec,
} from '../decimal.js';
import { EngineContext, ageAtYearEnd } from './context.js';
import { allocateEntity, aggregatePersons, netIncome, type AllocatedEntity, type AllocatedShare, type PersonIncome } from './income.js';
import { applyLossLimitations } from './loss-limits.js';
import { computeSeTax } from './se-tax.js';
import { computeRetirementLimit, computeSehiLimit, computeHsaLimit, seEarnedIncomeBase } from './owner-deductions.js';
import { computeStandardDeduction, computeItemizedDeductions, chooseDeduction, computeSch1a, type DeductionPerson } from './deductions.js';
import { computeQbi } from './qbi.js';
import { computeRegularTax } from './bracket-tax.js';
import { TAX_ENGINE_VERSION } from './version.js';
import type {
  EngineEntity, EnginePerson, EntityResult, EntityShareResult, FederalEngineInput, FederalResult, PersonResult, OtherTaxesInput,
} from './types.js';

const STEP_AGI = 'agi';
const STEP_TAXABLE_INCOME = 'taxable_income';
const STEP_CREDITS = 'credits';
const STEP_OTHER_TAXES = 'other_taxes';
const STEP_TOTAL = 'federal_total';

const R = dRoundDollars;

function roundCharacters(c: CharacterAmounts): CharacterAmounts {
  const out = { ...c };
  for (const k of Object.keys(out) as Array<keyof CharacterAmounts>) out[k] = R(out[k]);
  return out;
}

function shareResult(s: AllocatedShare): EntityShareResult {
  return {
    linkId: s.linkId, personId: s.personId, entityType: s.entityType, activityType: s.activityType,
    profitFraction: s.profitFraction, lossFraction: s.lossFraction, share: roundCharacters(s.share),
    guaranteedPayment: R(s.guaranteedPayment), officerWages: R(s.officerWages), sehiAsW2Wages: R(s.sehiAsW2Wages), seIncome: R(s.seIncome),
  };
}

function entityResult(a: AllocatedEntity): EntityResult {
  const e: EngineEntity = a.entity;
  return {
    tenantId: e.tenantId, companyId: e.companyId, companyName: e.companyName, entityType: e.entityType,
    monthsElapsed: e.monthsElapsed, monthsRemaining: e.monthsRemaining, ytd: roundCharacters(e.ytd),
    projected: roundCharacters(a.projected), projectedProfit: R(a.projectedProfit), shares: a.shares.map(shareResult),
  };
}

/** Step 13 stubs: Additional Medicare and NIIT from input until Phase 7 computes them. */
function otherTaxes(input: OtherTaxesInput, ctx: EngineContext): { additionalMedicareTax: Dec; niit: Dec } {
  const additionalMedicareTax = input.additionalMedicareTax == null ? ZERO : dFloorZero(dec(input.additionalMedicareTax));
  const niit = input.niit == null ? ZERO : dFloorZero(dec(input.niit));
  ctx.info('TE_OTHER_TAXES_STUB', 'Additional Medicare tax and NIIT are manual inputs (zero when blank) until Phase 7 computes them.', { additionalMedicareTax, niit });
  ctx.trace.add({ step: STEP_OTHER_TAXES, id: 'additional_medicare', label: `Additional Medicare tax (${input.additionalMedicareTax == null ? 'not computed — Phase 7' : 'manual input'})`, exact: additionalMedicareTax, source: 'input' });
  ctx.trace.add({ step: STEP_OTHER_TAXES, id: 'niit', label: `Net investment income tax (${input.niit == null ? 'not computed — Phase 7' : 'manual input'})`, exact: niit, source: 'input' });
  return { additionalMedicareTax, niit };
}

export function computeFederal(input: FederalEngineInput): FederalResult {
  const ctx = new EngineContext(input.parameters, input.taxYear, input.filingStatus);
  if (input.persons.length === 0) throw new Error('TE_NO_PERSONS: the taxpayer has no persons');
  ctx.setPersons(input.persons);
  const personById = new Map(input.persons.map((p) => [p.personId, p]));

  // Steps 1–2: entity income by character → projection → allocation → adjustments.
  const allocated = input.entities.map((e) => allocateEntity(e, input.adjustments, ctx));
  const agg = aggregatePersons(allocated, input.persons, input.adjustments, ctx);

  // Step 3: loss limitations (Phase 7 extension point).
  const lossLimits = applyLossLimitations(agg, ctx);

  const income = netIncome([...agg.byPerson.values()], ctx);

  // Steps 4–6 per person: SE tax, retirement / SEHI / HSA limits.
  const personResults: PersonResult[] = [];
  let totalSeTax: Dec = ZERO; let totalHalfSe: Dec = ZERO; let totalRetirement: Dec = ZERO; let totalSehi: Dec = ZERO; let totalHsa: Dec = ZERO;
  let otherAboveTheLine: Dec = agg.otherAboveTheLine;
  const deductionPersons: DeductionPerson[] = [];
  for (const p of input.persons) {
    const pi: PersonIncome = agg.byPerson.get(p.personId)!;
    const age = ageAtYearEnd(p.dateOfBirth, input.taxYear, false);
    const ageJan1 = ageAtYearEnd(p.dateOfBirth, input.taxYear, true);
    const se = computeSeTax({ personId: p.personId, label: p.displayName, seIncome: pi.seIncome, socialSecurityWages: pi.socialSecurityWages }, ctx);
    const retirement = computeRetirementLimit({ personId: p.personId, label: p.displayName, planType: p.retirementPlan, contributed: pi.retirementContributions, employeeDeferral: p.retirementEmployeeDeferral == null ? null : dec(p.retirementEmployeeDeferral), seIncome: pi.seIncome, halfSeTax: se.halfSeTax, age }, ctx);
    // SEHI cap: earned income from the SE businesses after ½ SE and retirement, plus S corp officer Medicare wages.
    const officerWages = dSum(pi.shares.filter((s) => s.entityType === 's_corp').map((s) => s.officerWages));
    const earnedIncomeCap = dAdd(dFloorZero(dSub(seEarnedIncomeBase(pi.seIncome, se.halfSeTax), retirement.deducted)), officerWages);
    const sehi = computeSehiLimit({ personId: p.personId, label: p.displayName, premiums: pi.sehiPremiums, eligibleMonths: p.sehiEligibleMonths, earnedIncomeCap }, ctx);
    const hsa = computeHsaLimit({ personId: p.personId, label: p.displayName, coverage: p.hsaCoverage, contributed: dAdd(pi.hsaContributions, dec(p.hsaContribution)), age }, ctx);
    totalSeTax = dAdd(totalSeTax, se.seTax); totalHalfSe = dAdd(totalHalfSe, se.halfSeTax);
    totalRetirement = dAdd(totalRetirement, retirement.deducted); totalSehi = dAdd(totalSehi, sehi.deducted); totalHsa = dAdd(totalHsa, hsa.deducted);
    otherAboveTheLine = dAdd(otherAboveTheLine, pi.otherAboveTheLine);
    deductionPersons.push({ personId: p.personId, role: p.role, label: p.displayName, age: ageJan1, isBlind: p.isBlind, sch1a: p.sch1a });
    personResults.push({
      personId: p.personId, role: p.role, displayName: p.displayName, ageAtYearEnd: age, w2Wages: R(p.w2Wages), totalWages: R(pi.wages),
      seIncome: R(pi.seIncome), nese: R(se.nese), seTaxSocialSecurity: R(se.socialSecurity), seTaxMedicare: R(se.medicare), seTax: R(se.seTax), halfSeTax: R(se.halfSeTax),
      retirement: { planType: retirement.planType, contributed: R(retirement.contributed), limit: R(retirement.limit), deducted: R(retirement.deducted), capped: retirement.capped },
      sehi: { premiums: R(sehi.premiums), eligibleMonths: sehi.eligibleMonths, afterMonths: R(sehi.afterMonths), earnedIncomeCap: R(sehi.earnedIncomeCap), deducted: R(sehi.deducted), capped: sehi.capped },
      hsa: { coverage: hsa.coverage, contributed: R(hsa.contributed), limit: R(hsa.limit), deducted: R(hsa.deducted), capped: hsa.capped },
    });
  }

  // Step 7: AGI.
  const adjustmentsTotal = dSum([totalHalfSe, totalRetirement, totalSehi, totalHsa, otherAboveTheLine]);
  const agi = dSub(income.totalIncome, adjustmentsTotal);
  ctx.trace.add({ step: STEP_AGI, id: 'agi', label: 'Adjusted gross income', exact: agi, source: 'gl_map', formula: `total income ${income.totalIncome} − ½ SE ${totalHalfSe} − retirement ${totalRetirement} − SEHI ${totalSehi} − HSA ${totalHsa} − other ${otherAboveTheLine}` });

  // Step 8: deductions and Schedule 1-A (MAGI taken as AGI).
  const standard = computeStandardDeduction(deductionPersons, dec(input.year.itemized.charitableCash), ctx);
  const sch1a = computeSch1a(deductionPersons, agi, ctx);

  // Step 9: QBI (Phase 6 stub; Phase 7 computes). Taken before the itemized §68 base so the chain is acyclic.
  const netCapitalGainWithQd = dAdd(dFloorZero(income.netLongTermGainForWorksheet), dFloorZero(income.qualifiedDividends));
  const qbi = computeQbi(input.qbi, { taxableIncomeBeforeQbi: dSub(dSub(agi, standard.total), sch1a.total), netCapitalGainWithQd, income: agg }, ctx);

  const taxableIncomeBeforeItemized = dSub(dSub(agi, sch1a.total), qbi.deduction);
  const itemized = computeItemizedDeductions(input.year.itemized, agg.itemizedOther, agi, taxableIncomeBeforeItemized, ctx);
  const choice = chooseDeduction(input.year.deductionMode, standard, itemized, ctx);

  // Step 10: taxable income.
  const taxableIncomeBeforeQbi = dSub(dSub(agi, choice.deduction), sch1a.total);
  const taxableIncome = dFloorZero(dSub(taxableIncomeBeforeQbi, qbi.deduction));
  ctx.trace.add({ step: STEP_TAXABLE_INCOME, id: 'taxable_income', label: 'Taxable income', exact: taxableIncome, source: 'gl_map', formula: `AGI ${agi} − deduction ${choice.deduction} − Schedule 1-A ${sch1a.total} − QBI ${qbi.deduction}, not below 0` });

  // Step 11: regular tax.
  const regular = computeRegularTax({
    taxableIncome, qualifiedDividends: income.qualifiedDividends, netLongTermGain: income.netLongTermGainForWorksheet,
    unrecaptured1250: dec(input.year.unrecaptured1250Gain), collectibles: dec(input.year.collectiblesGain),
    rateMode: input.year.rateMode, effectiveRateOverride: input.year.effectiveRateOverride == null ? null : dec(input.year.effectiveRateOverride),
  }, ctx);

  // Step 12: credits.
  const nonrefundableRequested = dFloorZero(dec(input.year.creditsNonrefundable));
  const nonrefundableAllowed = dMin(nonrefundableRequested, regular.tax);
  if (dCmp(nonrefundableRequested, nonrefundableAllowed) > 0) ctx.warn('TE_NONREFUNDABLE_CREDIT_CAPPED', `Nonrefundable credits ${R(nonrefundableRequested)} exceed the regular tax ${R(regular.tax)}; only ${R(nonrefundableAllowed)} is used.`, { requested: nonrefundableRequested, allowed: nonrefundableAllowed });
  const refundable = dFloorZero(dec(input.year.creditsRefundable));
  ctx.trace.add({ step: STEP_CREDITS, id: 'credits.nonrefundable', label: 'Nonrefundable credits (capped at regular tax)', exact: nonrefundableAllowed, source: 'input', formula: `min(${nonrefundableRequested}, ${regular.tax})` });
  if (dIsPos(refundable)) ctx.trace.add({ step: STEP_CREDITS, id: 'credits.refundable', label: 'Refundable credits', exact: refundable, source: 'input' });

  // Step 13: Additional Medicare / NIIT (Phase 7).
  const other = otherTaxes(input.otherTaxes, ctx);
  if (input.year.amtExposureFlagged) ctx.warn('TE_AMT_NOT_MODELLED', 'AMT exposure was flagged; the alternative minimum tax is out of scope and not included.');

  // Step 14: federal total.
  const federalTotal = dSub(dSum([dSub(regular.tax, nonrefundableAllowed), totalSeTax, other.additionalMedicareTax, other.niit]), refundable);
  ctx.trace.add({ step: STEP_TOTAL, id: 'federal_total', label: 'Federal tax (regular − nonrefundable credits + SE + Additional Medicare + NIIT − refundable)', exact: federalTotal, source: 'gl_map', formula: `${regular.tax} − ${nonrefundableAllowed} + ${totalSeTax} + ${other.additionalMedicareTax} + ${other.niit} − ${refundable}` });
  if (dIsZero(federalTotal) && dIsZero(income.totalIncome)) ctx.info('TE_NO_INCOME', 'No income was found for the year.');

  const w = regular.worksheet;
  return {
    engineVersion: TAX_ENGINE_VERSION,
    taxYear: input.taxYear,
    filingStatus: input.filingStatus,
    persons: personResults,
    entities: allocated.map(entityResult),
    lossLimitations: { applied: lossLimits.applied, suspendedPassiveLoss: R(lossLimits.suspendedPassiveLoss), excessBusinessLoss: R(lossLimits.excessBusinessLoss), notes: lossLimits.notes },
    income: {
      wages: R(income.wages), businessOrdinary: R(income.businessOrdinary), guaranteedPayments: R(income.guaranteedPayments), rental: R(income.rental),
      interest: R(income.interest), dividends: R(income.dividends), qualifiedDividends: R(income.qualifiedDividends),
      capitalGainShortTerm: R(income.capitalGainShortTerm), capitalGainLongTerm: R(income.capitalGainLongTerm), section1231: R(income.section1231),
      capitalGainNet: R(income.capitalGainNet), capitalLossDisallowed: R(income.capitalLossDisallowed), otherIncome: R(income.otherIncome), totalIncome: R(income.totalIncome),
    },
    adjustmentsToIncome: { halfSeTax: R(totalHalfSe), retirement: R(totalRetirement), sehi: R(totalSehi), hsa: R(totalHsa), other: R(otherAboveTheLine), total: R(adjustmentsTotal) },
    agi: R(agi),
    deductions: {
      mode: input.year.deductionMode, chosen: choice.chosen,
      standard: { base: R(standard.base), additionalCount: standard.additionalCount, additionalEach: R(standard.additionalEach), total: R(standard.total), nonItemizerCharitable: R(standard.nonItemizerCharitable) },
      itemized: {
        saltPaid: R(itemized.saltPaid), saltCap: R(itemized.saltCap), saltAllowed: R(itemized.saltAllowed), mortgageInterest: R(itemized.mortgageInterest),
        charitableGross: R(itemized.charitableGross), charitableFloor: R(itemized.charitableFloor), charitableAllowed: R(itemized.charitableAllowed), other: R(itemized.other),
        beforeBenefitCap: R(itemized.beforeBenefitCap), benefitCapReduction: R(itemized.benefitCapReduction), total: R(itemized.total),
      },
      deduction: R(choice.deduction),
      sch1a: { inEffect: sch1a.inEffect, senior: R(sch1a.senior), tips: R(sch1a.tips), overtime: R(sch1a.overtime), carLoanInterest: R(sch1a.carLoanInterest), total: R(sch1a.total) },
    },
    qbi: { method: qbi.method, deduction: R(qbi.deduction) },
    taxableIncomeBeforeQbi: R(taxableIncomeBeforeQbi),
    taxableIncome: R(taxableIncome),
    regularTax: {
      method: regular.method, taxableIncome: R(taxableIncome), tax: R(regular.tax), marginalOrdinaryRate: regular.marginalOrdinaryRate,
      marginalCapitalGainRate: regular.marginalCapitalGainRate, effectiveRate: regular.effectiveRate,
      worksheet: w == null ? null : {
        qualifiedDividends: R(w.qualifiedDividends), netLongTermGain: R(w.netLongTermGain), preferentialIncome: R(w.preferentialIncome), unrecaptured1250: R(w.unrecaptured1250), collectibles: R(w.collectibles),
        taxedAtZero: R(w.taxedAtZero), taxedAtFifteen: R(w.taxedAtFifteen), taxedAtTwenty: R(w.taxedAtTwenty), taxedAtTwentyFive: R(w.taxedAtTwentyFive), taxedAtTwentyEight: R(w.taxedAtTwentyEight),
        ordinaryPortion: R(w.ordinaryPortion), ordinaryTax: R(w.ordinaryTax), preferentialTax: R(w.preferentialTax), worksheetTax: R(w.worksheetTax), allOrdinaryTax: R(w.allOrdinaryTax),
      },
    },
    credits: { nonrefundableRequested: R(nonrefundableRequested), nonrefundableAllowed: R(nonrefundableAllowed), refundable: R(refundable) },
    seTax: R(totalSeTax),
    additionalMedicareTax: R(other.additionalMedicareTax),
    niit: R(other.niit),
    federalTotal: R(federalTotal),
    exact: {
      totalIncome: income.totalIncome, agi, deduction: choice.deduction, sch1a: sch1a.total, qbi: qbi.deduction, taxableIncomeBeforeQbi, taxableIncome,
      regularTax: regular.tax, nonrefundableCredits: nonrefundableAllowed, seTax: totalSeTax, additionalMedicareTax: other.additionalMedicareTax, niit: other.niit,
      refundableCredits: refundable, federalTotal,
    },
    trace: ctx.trace.rows(),
    warnings: ctx.allWarnings(),
    parametersUsed: ctx.params.used(),
  };
}

export type { EnginePerson };
