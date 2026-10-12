// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pure tax engine entry point (MODULE.md "Engineering rules"). Phase 6: federal
// income tax core. Phases 7-10 add QBI / NIIT / loss limits, states, C corp /
// Sch F, and payments / safe harbor / Schedule AI / penalties here.
export * from './types.js';
export * from './version.js';
export { ParameterReader, parameterMapFromRows, unverifiedWarning, type BracketRow } from './parameters.js';
export { EngineContext, TraceBuilder, ageAtYearEnd } from './context.js';
export {
  characters, sumCharacters, projectAmount, projectCharacters, allocateEntity, aggregatePersons, netIncome, seIncomeFor, adjustmentCharacter,
  type AllocatedEntity, type AllocatedShare, type PersonIncome, type AggregatedIncome, type IncomeExact,
} from './income.js';
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
export { computeQbi, type QbiContext, type QbiExact } from './qbi.js';
export { applyLossLimitations, type LossLimitationExact } from './loss-limits.js';
export { computeFederal } from './federal.js';
export {
  engineEntityFromTaxBasisPl, enginePersonFromDto, engineAdjustmentFromDto, engineYearFromDto,
  type EntitySettingsForEngine, type PersonYearInputs, type YearExtras,
} from './bridge.js';
