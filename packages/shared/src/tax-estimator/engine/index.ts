// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pure tax engine entry point (MODULE.md "Engineering rules"). Phase 6: federal
// income tax core; Phase 7: QBI, Additional Medicare / NIIT, loss limits.
// Phases 8-10 add states, C corp / Sch F, and payments / safe harbor /
// Schedule AI / penalties here.
export * from './types.js';
export * from './version.js';
export { ParameterReader, parameterMapFromRows, unverifiedWarning, type BracketRow, type RatePeriod } from './parameters.js';
export { EngineContext, TraceBuilder, ageAtYearEnd } from './context.js';
export {
  characters, sumCharacters, projectAmount, projectCharacters, allocateEntity, aggregatePersons, netIncome, seIncomeFor, adjustmentCharacter,
  type AllocatedEntity, type AllocatedShare, type PersonIncome, type AggregatedIncome, type IncomeExact,
} from './income.js';
export { priorYearTrendFor, evaluatePriorYearTrend, priorYearFullOrdinary, type PriorYearTrendOutcome, type TrendEntityFigures } from './py-trend.js';
export { computeSeTax, type SeTaxInput, type SeTaxExact } from './se-tax.js';
export {
  computeRetirementLimit, computeSehiLimit, computeHsaLimit, seEarnedIncomeBase,
  type RetirementLimitInput, type RetirementLimitExact, type SehiLimitInput, type SehiLimitExact, type HsaLimitInput, type HsaLimitExact,
} from './owner-deductions.js';
export {
  computeStandardDeduction, computeItemizedDeductions, chooseDeduction, computeSch1a,
  type DeductionPerson, type StandardDeductionExact, type ItemizedExact, type Sch1aExact,
} from './deductions.js';
export { bracketTax, marginalBracketRate, computeRegularTax, type RegularTaxInput, type RegularTaxExact, type WorksheetExact } from './bracket-tax.js';
export { computeQbi, type QbiContext, type QbiExact, type QbiPersonDeductions } from './qbi.js';
export { applyLossLimitations, addBackLoss, isPassiveActivity, type LossLimitationExact, type LossLimitationOptions } from './loss-limits.js';
export { computeOtherTaxes, type OtherTaxesContext, type OtherTaxesPerson, type OtherTaxesExact } from './other-taxes.js';
export { computeFederal } from './federal.js';
export { computeDependentCredits, activeDependents, careRateFor, type DependentCreditsInput, type DependentCreditsExact, type EarnedIncomePerson } from './dependents.js';
export {
  engineEntityFromTaxBasisPl, enginePersonFromDto, engineAdjustmentFromDto, engineYearFromDto, engineDependentFromDto,
  engineEntityFromOutside, outsidePeriodEntity, ltcgSubsetsFromPl,
  type EntitySettingsForEngine, type PersonYearInputs, type YearExtras,
} from './bridge.js';
export * from './state-types.js';
export { evaluateEstimateGate, meetsThreshold, balanceAfterWithholdingAndCredits, STATE_GATE_RULE_KEYS, STATE_GATE_FEDERAL_FALLBACK_KEY, type GateEvaluationInput, type GateContext } from './state-gates.js';
export {
  computeState, computeCcorpStateTax, StateContext, stateRuleMapFromRows, jurisdictionFromStateRules, federalFiguresFromResult, stateRowFromDto, sourcedEntitiesFromFederal, EMPTY_GATE_INPUTS,
} from './state.js';
export {
  computeScheduleTax, chooseSchedule, tieredExclusion, stateScheduleTax, bracketAdds, incomeRatio, capitalGainsExcise, gainsFromFederal, scheduleAvailable, toBracketRows,
  KEY_STARTING_POINT, KEY_BRACKETS, KEY_STANDARD_DEDUCTION, KEY_CAPITAL_GAINS, KEY_FEDERAL_TAX_DEDUCTION, KEY_CAPITAL_GAINS_EXCISE,
  type ScheduleCalc, type ScheduleArgs, type StateGains,
} from './state-schedule.js';
export {
  computeCcorp, ccorpInstallmentDates, CCORP_STEPS,
  type CcorpEngineInput, type CcorpStateRow, type CcorpPriorYear, type CcorpResult, type CcorpInstallment, type CcorpInstallmentExact, type CcorpStateResult,
  type CcorpRequiredAnnualPayment, type CcorpPriorYearRule, type CcorpPriorYearReason, type CcorpExactTotals, type CcorpTraceRow, type CcorpStep,
  type CcorpInstallmentDateInput, type CcorpInstallmentDate,
} from './ccorp.js';
export {
  computeFarmer, farmerGrossIncomeTest, FARMER_STEPS,
  type FarmerEngineInput, type FarmerPersonGross, type FarmerYearGross, type FarmerTaxFigures, type FarmerResult, type FarmerGrossTest,
  type SafeHarborRuleSet, type InstallmentScheduleEntry, type FarmerRequiredAnnualPayment, type PriorYearUnavailableReason, type FarmerTraceRow, type FarmerStep,
} from './farmer.js';
// Phase 10 — payments, safe harbor, Schedule AI, penalties, vouchers.
export {
  EstimateContext, EstimateTraceBuilder, ESTIMATE_STEPS, NO_PRIOR_YEAR,
  type EstimateStep, type EstimateTraceRow, type EstimateTraceInput, type SafeHarborRuleSource, type PriorYearInput, type InstallmentDue,
} from './estimate-types.js';
export {
  resolveSafeHarbor, computeFederalSafeHarbor, federalSafeHarborRates, balanceAfterWithholding,
  INDIVIDUAL_SAFE_HARBOR_POLICY, FARMER_SAFE_HARBOR_POLICY, CCORP_SAFE_HARBOR_POLICY,
  type SafeHarborPolicy, type SafeHarborRates, type SafeHarborCoreInput, type SafeHarborResult, type SafeHarborPriorYear, type SafeHarborExact, type FederalSafeHarborInput, type SafeHarborPriorYearReason,
} from './safe-harbor.js';
export {
  computeScheduleAi, annualizeFederalInput, INDIVIDUAL_SCH_AI_POLICY, CCORP_SCH_AI_POLICY, SCH_AI_ASSUMPTIONS,
  type FederalCalculator, type SchAiPolicy, type ScheduleAiInput, type ScheduleAiResult, type SchAiPeriodResult, type SchAiPeriodExact, type SchAiPartII,
} from './sch-ai.js';
export {
  applyPayments, dedupePayments, withholdingShares,
  type PaymentSource, type EstimatePayment, type PaymentApplicationInput, type PaymentApplicationResult, type InstallmentApplication, type AppliedPayment, type BalancePoint,
} from './payments.js';
export {
  accruePenalty, scheduleRateLookup, flatRateLookup,
  type RateLookup, type RateOnDate, type PenaltyPolicy, type PenaltyWaiver, type PenaltyResult, type InstallmentPenalty, type PenaltySegment,
} from './penalty.js';
export {
  computeFederalEstimates, computeStateEstimates, INDIVIDUAL_INSTALLMENT_POLICY, FARMER_INSTALLMENT_POLICY,
  type InstallmentPolicy, type FederalEstimatesInput, type StateEstimatesInput, type JurisdictionEstimate, type VoucherInstallment,
} from './vouchers.js';
