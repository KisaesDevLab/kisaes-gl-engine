// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator engine DTOs (MODULE.md "Engineering rules": typed input in,
// typed result out, line-by-line trace). The engine is PURE: every tax
// constant arrives in `parameters`, every book figure in `entities`, every
// user figure in `persons` / `year` / `adjustments`. Services build the input
// from the Phase 3–5 DTOs (see `buildEngineEntity` in income.ts for the
// TaxBasisPl bridge) and never re-implement the math.
//
// MONEY: decimal strings (see ../decimal.ts). Result amounts are WHOLE DOLLARS
// (half-up); the unrounded value of every line is on the trace row (`exact`)
// and the key totals are repeated unrounded in `exact` for later phases.
// SIGN: income positive, deductions as positive magnitudes; shares and
// character amounts are profit-positive (a loss is negative).

import type { ActivityType, EntityTaxType, FilingStatus, ParameterStatus, TraceRow } from '../types.js';
import type { CharacterAmounts, TaxEstimatorWarning } from '../entities-api.js';
import type { PartnerSeStatus, PersonRole } from '../taxpayers-api.js';
import type { AdjustmentKind, DeductionMode, HsaCoverage, RateMode } from '../years-api.js';

// ── Parameters ───────────────────────────────────────────────────────

export interface ResolvedParameter {
  key: string;
  /** JSON value as stored in tax_parameters.value. */
  value: unknown;
  status: ParameterStatus;
  /** seed | override | provisional | fallback — informational. */
  source?: string;
  citation?: string;
}

/** Concrete key → resolved value. Built from TaxParametersDTO.parameters by `parameterMapFromRows`. */
export type ParameterMap = Readonly<Record<string, ResolvedParameter>>;

export interface ParameterUse {
  key: string;
  status: ParameterStatus;
  value: unknown;
}

// ── Persons ──────────────────────────────────────────────────────────

export type RetirementPlanType = 'sep' | 'solo_401k' | 'simple' | 'none';

export interface EngineSch1aPerson {
  qualifiedTips: string;
  qualifiedOvertime: string;
  carLoanInterest: string;
}

export interface EnginePerson {
  personId: string;
  role: PersonRole;
  displayName: string;
  /** 'YYYY-MM-DD' or null (no age tests). */
  dateOfBirth: string | null;
  isBlind: boolean;
  /** 12 flags, index 0 = January; `true` = SEHI deductible that month (Phase 3 polarity). */
  sehiEligibleMonths: boolean[];
  /** Full-year W-2 box 1 wages from jobs OUTSIDE the linked entities (officer wages come from the entity). */
  w2Wages: string;
  /** Full-year Social Security wages for the SE wage-base offset; null = same as w2Wages + officer wages. */
  w2SocialSecurityWages: string | null;
  /** Full-year federal income tax withheld (Phase 10 uses it; carried for completeness). */
  withholding: string;
  /** Plan type the person's owner retirement contributions belong to; null = SEP assumed (warning). */
  retirementPlan: RetirementPlanType | null;
  /** Elective deferral portion of the contributions (solo 401(k) / SIMPLE); null = unknown (deferral filled first). */
  retirementEmployeeDeferral: string | null;
  hsaCoverage: HsaCoverage;
  /** HSA contributions for the year (positive). */
  hsaContribution: string;
  sch1a: EngineSch1aPerson;
}

// ── Entities and links ───────────────────────────────────────────────

export interface EngineLink {
  linkId: string;
  personId: string;
  /** 0–100 percent as stored (TE_LINK_PCT_OVER_100 contract). null = 100 when the entity has one link, else 0 + warning. */
  profitPct: number | null;
  /** 0–100 percent; null = profitPct. */
  lossPct: number | null;
  partnerSeStatus: PartnerSeStatus | null;
  isOfficer: boolean;
  activityType: ActivityType;
  activeParticipation: boolean;
  qbiEligible: boolean | null;
  allowedLossOverride: string | null;
}

export interface EngineOwnerItem {
  /** null = the entity's single owner (Sch C / Sch F). */
  personId: string | null;
  /** Owner health insurance removed from entity profit (or, S corp, the officer's SEHI deduction). Positive. */
  sehi: string;
  /** Owner retirement removed from entity profit (Sch C / Sch F / partnership). Positive. */
  retirement: string;
  /** S corp: >2% shareholder health added to the officer's W-2 box 1 only (not SS / Medicare wages). Positive. */
  sehiAsW2Wages: string;
}

export interface EnginePersonAmount {
  personId: string | null;
  amount: string;
}

/**
 * One linked entity for one tax year. Book amounts are YTD through
 * `monthsElapsed` months; the engine projects the recurring part over
 * `monthsRemaining` (MODULE.md "Projection"). A fully closed year has
 * monthsRemaining = 0 and projection = YTD.
 */
export interface EngineEntity {
  tenantId: string;
  companyId: string;
  companyName: string;
  entityType: EntityTaxType;
  monthsElapsed: number;
  monthsRemaining: number;
  /** Entity tax-basis profit by character, YTD (profit-positive). */
  ytd: CharacterAmounts;
  /** Recurring portion of `ytd` (what the run-rate extrapolates). */
  recurringYtd: CharacterAmounts;
  /** Owner-level amounts YTD (routed out of entity profit by the treatment map). */
  ownerItems: EngineOwnerItem[];
  /** Partnership guaranteed payments YTD per partner (already deducted from `ytd`). */
  guaranteedPayments: EnginePersonAmount[];
  /** Officer W-2 wages YTD per officer (w2_wages accounts with a person target). */
  officerWages: EnginePersonAmount[];
  /** Σ book depreciation (profit-positive, so negative) on accounts flagged tax_depreciation_differs, YTD. */
  taxDepreciationBookYtd: string;
  links: EngineLink[];
  /** Phase 7 inputs, carried through. */
  isSstb: boolean;
  rentalQbiTradeOrBusiness: boolean;
  /** Full-year W-2 wages for the §199A limit (D8), null = unknown. */
  w2WagesEffective: string | null;
  ubia: string | null;
  /** Readiness / provider warnings to surface on the assumptions page. */
  warnings: TaxEstimatorWarning[];
}

// ── Adjustments ──────────────────────────────────────────────────────

/** One scenario adjustment, FULL-YEAR amount (the service sums the 12-month allocation). */
export interface EngineAdjustment {
  id: string;
  label: string;
  /** Shipped catalog code (owner_health_insurance, sep_solo_401k, hsa_contribution, meals, depreciation_tax_vs_book, …) or null. */
  typeCode: string | null;
  kind: AdjustmentKind;
  /** Positive magnitude. */
  amount: string;
  /** 0–100 percent applied to an addback (meals 50); null = 100. */
  pct: number | null;
  personId: string | null;
  /** Entity-level when set (applies to that link's share). */
  linkId: string | null;
  affectsSe: boolean;
  affectsQbi: boolean;
  isCapitalGainLt: boolean;
  isCapitalGainSt: boolean;
  isQualifiedDividend: boolean;
  isReitDividend: boolean;
  isPtp: boolean;
  is1231: boolean;
  isAboveTheLine: boolean;
  nonRecurring: boolean;
}

// ── Year inputs ──────────────────────────────────────────────────────

export interface EngineItemized {
  saltPaid: string;
  mortgageInterest: string;
  charitableCash: string;
  charitableNoncash: string;
  other: string;
}

export interface EngineYearInputs {
  rateMode: RateMode;
  /** Fraction 0..1 (effective_rate_override). Required when rateMode = 'effective'. */
  effectiveRateOverride: string | null;
  deductionMode: DeductionMode;
  itemized: EngineItemized;
  creditsNonrefundable: string;
  creditsRefundable: string;
  /** Unrecaptured §1250 gain included in long-term gains (25% bucket). */
  unrecaptured1250Gain: string;
  /** Collectibles / §1202 gain included in long-term gains (28% bucket). */
  collectiblesGain: string;
  /** User flags AMT exposure → warning line only (AMT is out of scope). */
  amtExposureFlagged: boolean;
}

// ── Phase 7 extension points (typed now, implemented in Phase 7) ─────

/** §199A input. Phase 6: `manualDeduction` is the stub (fixture-supplied); Phase 7 computes when null. */
export interface QbiInput {
  manualDeduction: string | null;
}

/** Additional Medicare tax and NIIT (MODULE.md step 13). Phase 6: stubs; Phase 7 computes when null. */
export interface OtherTaxesInput {
  additionalMedicareTax: string | null;
  niit: string | null;
}

// ── Engine input ─────────────────────────────────────────────────────

export interface FederalEngineInput {
  taxYear: number;
  filingStatus: FilingStatus;
  parameters: ParameterMap;
  persons: EnginePerson[];
  entities: EngineEntity[];
  adjustments: EngineAdjustment[];
  year: EngineYearInputs;
  qbi: QbiInput;
  otherTaxes: OtherTaxesInput;
}

// ── Trace ────────────────────────────────────────────────────────────

/**
 * MODULE.md "Federal calculation order" steps, in order (index + 1 = the step
 * number in MODULE.md). The trace tags every row with one so the UI can group
 * and order the drill-down.
 */
export const FEDERAL_STEPS = [
  'entity_income',    // 1  entity tax-basis income by character
  'allocation',       // 2  allocate to persons
  'loss_limits',      // 3  loss limitations (Phase 7)
  'se_income',        // 4  SE income per person
  'se_tax',           // 5  SE tax
  'owner_limits',     // 6  SEP / 401(k) / SIMPLE / HSA / SEHI limits
  'agi',              // 7  AGI
  'deductions',       // 8  standard vs itemized, Schedule 1-A
  'qbi',              // 9  §199A (Phase 7)
  'taxable_income',   // 10 taxable income
  'regular_tax',      // 11 brackets + QD/LTCG worksheet, effective-rate override
  'credits',          // 12 credits
  'other_taxes',      // 13 Additional Medicare, NIIT (Phase 7)
  'federal_total',    // 14 federal total
] as const;
export type FederalStep = typeof FEDERAL_STEPS[number];

export interface EngineTraceRow extends TraceRow {
  /** MODULE.md federal step the row belongs to. */
  step: FederalStep;
  /** Stable id for drill-down (e.g. 'agi', 'se_tax.<personId>'). */
  id: string;
  /** Unrounded amount. */
  exact: string;
  personId?: string | null;
  entityId?: string | null;
  /** Parameter keys the row read. */
  parameterKeys?: string[];
  /** Marginal rate as a fraction string, on tax rows. */
  marginalRate?: string;
}

// ── Results ──────────────────────────────────────────────────────────

export interface EntityShareResult {
  linkId: string;
  personId: string;
  entityType: EntityTaxType;
  activityType: ActivityType;
  profitFraction: string;
  lossFraction: string;
  /** Allocated full-year amounts by character (profit-positive), after link adjustments. */
  share: CharacterAmounts;
  guaranteedPayment: string;
  officerWages: string;
  sehiAsW2Wages: string;
  /** Portion of `share` that is SE income (ordinary + GP for SE statuses). */
  seIncome: string;
}

export interface EntityResult {
  tenantId: string;
  companyId: string;
  companyName: string;
  entityType: EntityTaxType;
  monthsElapsed: number;
  monthsRemaining: number;
  ytd: CharacterAmounts;
  projected: CharacterAmounts;
  projectedProfit: string;
  shares: EntityShareResult[];
}

export interface RetirementLimitResult {
  planType: RetirementPlanType;
  contributed: string;
  limit: string;
  deducted: string;
  capped: boolean;
}

export interface SehiLimitResult {
  premiums: string;
  eligibleMonths: number;
  /** Premiums × eligible months ÷ 12. */
  afterMonths: string;
  /** Earned income from the businesses the plan is under, after ½ SE and retirement. */
  earnedIncomeCap: string;
  deducted: string;
  capped: boolean;
}

export interface HsaLimitResult {
  coverage: HsaCoverage;
  contributed: string;
  limit: string;
  deducted: string;
  capped: boolean;
}

export interface PersonResult {
  personId: string;
  role: PersonRole;
  displayName: string;
  ageAtYearEnd: number | null;
  w2Wages: string;
  /** Includes S corp officer wages and sehiAsW2Wages (box 1). */
  totalWages: string;
  seIncome: string;
  nese: string;
  seTaxSocialSecurity: string;
  seTaxMedicare: string;
  seTax: string;
  halfSeTax: string;
  retirement: RetirementLimitResult;
  sehi: SehiLimitResult;
  hsa: HsaLimitResult;
}

export interface IncomeResult {
  wages: string;
  businessOrdinary: string;
  guaranteedPayments: string;
  rental: string;
  interest: string;
  /** Ordinary dividends INCLUDING qualified. */
  dividends: string;
  qualifiedDividends: string;
  capitalGainShortTerm: string;
  capitalGainLongTerm: string;
  /** Net §1231 gain (treated as long-term) or loss (ordinary). */
  section1231: string;
  /** Net capital gain or the limited loss actually in total income. */
  capitalGainNet: string;
  /** Capital loss above the §1211 limit (carryforward note). */
  capitalLossDisallowed: string;
  otherIncome: string;
  totalIncome: string;
}

export interface AdjustmentsToIncomeResult {
  halfSeTax: string;
  retirement: string;
  sehi: string;
  hsa: string;
  other: string;
  total: string;
}

export interface StandardDeductionResult {
  base: string;
  additionalCount: number;
  additionalEach: string;
  total: string;
  nonItemizerCharitable: string;
}

export interface ItemizedDeductionResult {
  saltPaid: string;
  saltCap: string;
  saltAllowed: string;
  mortgageInterest: string;
  charitableGross: string;
  charitableFloor: string;
  charitableAllowed: string;
  other: string;
  beforeBenefitCap: string;
  benefitCapReduction: string;
  total: string;
}

export interface Sch1aResult {
  inEffect: boolean;
  senior: string;
  tips: string;
  overtime: string;
  carLoanInterest: string;
  total: string;
}

export interface DeductionsResult {
  mode: DeductionMode;
  chosen: 'standard' | 'itemized';
  standard: StandardDeductionResult;
  itemized: ItemizedDeductionResult;
  /** Standard (incl. non-itemizer charitable) or itemized total actually deducted. */
  deduction: string;
  sch1a: Sch1aResult;
}

export interface QbiResult {
  /** 'manual' = Phase 6 stub from input; 'computed' once Phase 7 lands; 'none' = no input. */
  method: 'manual' | 'computed' | 'none';
  deduction: string;
}

export interface LossLimitationResult {
  /** false until Phase 7 implements §469 / §461(l) / basis. */
  applied: boolean;
  suspendedPassiveLoss: string;
  excessBusinessLoss: string;
  notes: string[];
}

export interface CapitalGainWorksheetResult {
  qualifiedDividends: string;
  netLongTermGain: string;
  /** QD + net LTCG limited by the overall net gain (worksheet line 10). */
  preferentialIncome: string;
  unrecaptured1250: string;
  collectibles: string;
  taxedAtZero: string;
  taxedAtFifteen: string;
  taxedAtTwenty: string;
  taxedAtTwentyFive: string;
  taxedAtTwentyEight: string;
  ordinaryPortion: string;
  ordinaryTax: string;
  preferentialTax: string;
  worksheetTax: string;
  allOrdinaryTax: string;
}

export interface RegularTaxResult {
  method: RateMode;
  taxableIncome: string;
  tax: string;
  /** Rate of the ordinary bracket the last ordinary dollar falls in (fraction string). */
  marginalOrdinaryRate: string;
  /** 0 / 15 / 20 rate applying to the last preferential dollar (fraction string; '0' when none). */
  marginalCapitalGainRate: string;
  /** tax ÷ taxable income (fraction string, 6 places; '0' when TI ≤ 0). */
  effectiveRate: string;
  /** Present in brackets mode when there is preferential income. */
  worksheet: CapitalGainWorksheetResult | null;
}

export interface CreditsResult {
  nonrefundableRequested: string;
  nonrefundableAllowed: string;
  refundable: string;
}

export interface FederalExactTotals {
  totalIncome: string;
  agi: string;
  deduction: string;
  sch1a: string;
  qbi: string;
  taxableIncomeBeforeQbi: string;
  taxableIncome: string;
  regularTax: string;
  nonrefundableCredits: string;
  seTax: string;
  additionalMedicareTax: string;
  niit: string;
  refundableCredits: string;
  federalTotal: string;
}

export interface FederalResult {
  engineVersion: string;
  taxYear: number;
  filingStatus: FilingStatus;
  persons: PersonResult[];
  entities: EntityResult[];
  lossLimitations: LossLimitationResult;
  income: IncomeResult;
  adjustmentsToIncome: AdjustmentsToIncomeResult;
  agi: string;
  deductions: DeductionsResult;
  qbi: QbiResult;
  taxableIncomeBeforeQbi: string;
  taxableIncome: string;
  regularTax: RegularTaxResult;
  credits: CreditsResult;
  seTax: string;
  additionalMedicareTax: string;
  niit: string;
  /** regular − nonrefundable + SE + Additional Medicare + NIIT − refundable (step 14). Negative = refund. */
  federalTotal: string;
  exact: FederalExactTotals;
  trace: EngineTraceRow[];
  warnings: TaxEstimatorWarning[];
  /** Every parameter the calculation read, with its status (D12a). */
  parametersUsed: ParameterUse[];
}
