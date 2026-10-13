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
  /**
   * NOT READ by any engine function (R7-04): vouchers credit the YEAR-level withholding
   * (YearSettingsDTO.withholding.federal). The app bridge always sends '0'; kept on the
   * type so fixtures stay source-compatible. Do not start reading it without wiring an input.
   */
  withholding: string;
  /** Plan type the person's owner retirement contributions belong to; null = SEP assumed (warning). */
  retirementPlan: RetirementPlanType | null;
  /** Elective deferral portion of the contributions (solo 401(k) / SIMPLE); null = unknown (maximum deferral assumed — upper bound). R7-01: when known, caps the deferral leg and the SIMPLE match. */
  retirementEmployeeDeferral: string | null;
  hsaCoverage: HsaCoverage;
  /**
   * HSA contributions not captured as an `hsa_contribution` adjustment (positive). Read by the
   * HSA limit; the app bridge always sends '0' (HSA contributions are entered as adjustments, R7-04).
   */
  hsaContribution: string;
  sch1a: EngineSch1aPerson;
}

// ── Dependents (Q44) ─────────────────────────────────────────────────

export type EngineDependentKind = 'qualifying_child' | 'qualifying_relative';

/** A dependent of the taxpayer. Ages are computed at Dec 31 of the tax year from `dateOfBirth`. */
export interface EngineDependent {
  dependentId: string;
  displayName: string;
  /** 'YYYY-MM-DD' (required). */
  dateOfBirth: string;
  kind: EngineDependentKind;
  /** 0–12; null = not recorded (the residency test is assumed met). */
  monthsLivedWith: number | null;
  isStudent: boolean;
  isDisabled: boolean;
  /** The dependent counts only in tax years inside [firstTaxYear, lastTaxYear] (null = open). */
  firstTaxYear: number | null;
  lastTaxYear: number | null;
}

/**
 * Full-year dependent-credit amounts BEFORE the regular-tax limit, used as-is by a
 * Schedule AI annualized column (D7 / Q13: credits are full-year). Set by computeScheduleAi,
 * never by the app.
 */
export interface FixedDependentCredits {
  /** §21 credit before the tax limit. */
  care: string;
  /** §24 child tax credit + credit for other dependents after the phase-out, before the tax limit. */
  ctcOdc: string;
  /** Additional child tax credit (refundable). */
  actc: string;
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
  /** Full-year W-2 wages for the §199A limit (D8), null = unknown. Does NOT include the >2% shareholder health add-on. */
  w2WagesEffective: string | null;
  /**
   * Q41 (CPA decision): add the projected Σ ownerItems.sehiAsW2Wages to w2WagesEffective for the
   * §199A wage limit. Absent / false = excluded (the default).
   */
  includeSehiInW2Wages?: boolean;
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
  /** Other nonrefundable credits (manual; NOT the dependent credits, which are computed). */
  creditsNonrefundable: string;
  /** Other refundable credits (manual; NOT the additional child tax credit). */
  creditsRefundable: string;
  /** Child and dependent care expenses paid in the year (Form 2441); absent = 0. */
  careExpenses?: string;
  /** Schedule AI columns only: full-year dependent credits used instead of recomputing (D7). */
  fixedDependentCredits?: FixedDependentCredits | null;
  /** Unrecaptured §1250 gain included in long-term gains (25% bucket). */
  unrecaptured1250Gain: string;
  /** Collectibles / §1202 gain included in long-term gains (28% bucket). */
  collectiblesGain: string;
  /** User flags AMT exposure → warning line only (AMT is out of scope). */
  amtExposureFlagged: boolean;
  /**
   * MFS only (§469(i)(5)): true = the spouses lived apart ALL year → the
   * `mfs_living_apart` rental-allowance parameters; false / absent = lived
   * together at some time → no §469(i) allowance (warning). Ignored otherwise.
   */
  mfsLivedApartAllYear?: boolean;
}

// ── Phase 7 extension points (typed now, implemented in Phase 7) ─────

/**
 * §199A input. The engine computes the deduction (Phase 7); `manualDeduction`
 * is the CPA override and wins when set (the computed figure stays on the
 * result as `computedDeduction` for comparison). W-2 wages and UBIA come from
 * the entities (D8).
 */
export interface QbiInput {
  manualDeduction: string | null;
}

/**
 * Additional Medicare tax and NIIT (MODULE.md step 13). Both are computed
 * (Phase 7); a non-null `additionalMedicareTax` / `niit` is a CPA override.
 * `niiAllocableDeductions` (Form 8960 Part II: investment interest, state tax
 * allocable to NII, …) reduces net investment income; blank = none.
 */
export interface OtherTaxesInput {
  additionalMedicareTax: string | null;
  niit: string | null;
  niiAllocableDeductions?: string | null;
}

// ── Engine input ─────────────────────────────────────────────────────

export interface FederalEngineInput {
  taxYear: number;
  filingStatus: FilingStatus;
  parameters: ParameterMap;
  persons: EnginePerson[];
  /** Q44: the taxpayer's dependents (all years; the engine keeps those active in taxYear). Absent = none. */
  dependents?: EngineDependent[];
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
  /** `share` after step 3 (basis / at-risk override, §469 suspension); §461(l) is a person-level add-back and is not reflected here. */
  shareAfterLossLimits: CharacterAmounts;
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
  /** Unrounded per-person figures later steps rebuild from (Schedule AI Part II, R2-07). */
  exact: { seIncome: string; socialSecurityWages: string };
}

export interface IncomeResult {
  wages: string;
  businessOrdinary: string;
  guaranteedPayments: string;
  rental: string;
  interest: string;
  /** Total dividends (Form 1040 line 3b): the exclusive ordinary + qualified buckets added. */
  dividends: string;
  /** Qualified dividends (line 3a), part of `dividends`. */
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

/** One §199A component (one link = one trade or business interest). */
export interface QbiComponentResult {
  linkId: string;
  personId: string;
  companyName: string;
  entityType: EntityTaxType;
  activityType: ActivityType;
  eligible: boolean;
  /** Why the link is excluded (null when eligible). */
  reason: string | null;
  sstb: boolean;
  /** Qualified items of the share (ordinary + rental when a §162 rental + §1231 loss share), before attributable deductions. */
  qualifiedItems: string;
  /** ½ SE tax + SEHI + retirement allocated to this business (Reg. 1.199A-3(b)(1)(vi)). */
  attributableDeductions: string;
  /** QBI after attributable deductions and the SSTB applicable percentage (a loss is negative). */
  qbi: string;
  /** QBI after the within-year loss netting (Reg. 1.199A-1(d)(2)(iii)); 0 for a loss business. */
  qbiAfterNetting: string;
  /** Allocable W-2 wages (× SSTB applicable %); null = unknown (treated as 0 above the threshold). */
  w2Wages: string | null;
  /** Allocable UBIA; null = not entered → UBIA limb not computed (D8). */
  ubia: string | null;
  /** qbi.rate × qbiAfterNetting. */
  tentative: string;
  /** max(50% W-2, 25% W-2 + 2.5% UBIA) — null below the threshold (not applied). */
  wageUbiaLimit: string | null;
  limitApplied: boolean;
  /** The component after the W-2 / UBIA limit and phase-in. */
  component: string;
}

export interface QbiResult {
  /** 'computed' = engine computation; 'manual' = `manualDeduction` override in use; 'none' = nothing qualified. */
  method: 'manual' | 'computed' | 'none';
  /** The deduction actually taken (manual override when set). */
  deduction: string;
  /** The engine's §199A computation (equals `deduction` unless overridden). */
  computedDeduction: string;
  /** Taxable income before QBI on the pre-§68 deduction (Q32). */
  taxableIncomeBeforeQbi: string;
  threshold: string;
  phaseInRange: string;
  /** 0 = at or below the threshold, 1 = at or above threshold + range, fraction in between. */
  phaseInFraction: string;
  components: QbiComponentResult[];
  /** Net QBI loss carried forward when losses exceed income (not tracked across years). */
  netLossCarryforward: string;
  reitPtpIncome: string;
  reitPtpComponent: string;
  /** Σ components + REIT/PTP component (before the overall limit). */
  combined: string;
  /** qbi.taxable_income_limit_pct × (taxable income before QBI − net capital gain incl. qualified dividends). */
  overallLimit: string;
  /** Aggregate QBI of the active (nonpassive) qualified businesses — the §199A(i) test base. */
  activeQbi: string;
  minimumApplied: boolean;
}

export interface LossLimitationShareResult {
  linkId: string;
  personId: string;
  companyName: string;
  activityType: ActivityType;
  /** passive or rental activity (subject to §469). */
  passive: boolean;
  /** Net share before limitations (a loss is negative). */
  net: string;
  /** Loss disallowed by `allowed_loss_override` (basis / at-risk), positive. */
  overrideDisallowed: string;
  /** Passive loss suspended under §469, positive. */
  passiveSuspended: string;
  /** Net share after limitations. */
  allowed: string;
}

export interface RentalAllowanceResult {
  /** 'standard' | 'mfs_living_apart' | 'none' (MFS lived together → §469(i)(5)(B)) | 'not_needed' (no active-participation rental loss). */
  variant: 'standard' | 'mfs_living_apart' | 'none' | 'not_needed';
  maximum: string;
  /** MAGI used for the phase-out (AGI without passive losses); null when not needed. */
  magi: string | null;
  afterPhaseOut: string;
  /** Net active-participation rental loss eligible for the allowance (positive). */
  eligibleLoss: string;
  used: string;
}

export interface LossLimitationResult {
  /** true once the limitations have run (Phase 7). */
  applied: boolean;
  overrideDisallowed: string;
  /** Passive income available to absorb passive losses (positive). */
  passiveIncome: string;
  /** Passive losses before netting (positive). */
  passiveLosses: string;
  rentalAllowance: RentalAllowanceResult;
  suspendedPassiveLoss: string;
  /** Aggregate trade-or-business net (after §469) tested under §461(l); a loss is negative. */
  businessNet: string;
  eblThreshold: string;
  excessBusinessLoss: string;
  shares: LossLimitationShareResult[];
  notes: string[];
}

export interface AdditionalMedicareResult {
  method: 'manual' | 'computed';
  /** Medicare wages of all persons (outside W-2 wages at the higher of box 1 / Social Security wages + officer wages). */
  medicareWages: string;
  /** Net earnings from self-employment of all persons (Form 8959 line 8). */
  nese: string;
  threshold: string;
  /** Form 8959 Part I: wages above the threshold. */
  wagesAboveThreshold: string;
  /** Form 8959 Part II: NESE above the threshold reduced by wages first. */
  neseAboveThreshold: string;
  tax: string;
}

export interface NiitResult {
  method: 'manual' | 'computed';
  interest: string;
  dividends: string;
  /** Net capital gain or limited loss (Form 8960 line 5). */
  capitalGains: string;
  /** Rental income after loss limitations. */
  rental: string;
  /** Ordinary income of passive / investment interests after loss limitations. */
  passiveOrdinary: string;
  allocableDeductions: string;
  /** max(0, items − allocable deductions). */
  netInvestmentIncome: string;
  /** AGI (no foreign earned income exclusion modelled). */
  magi: string;
  threshold: string;
  /** min(NII, MAGI − threshold), floored at 0. */
  base: string;
  tax: string;
}

export interface OtherTaxesResult {
  additionalMedicare: AdditionalMedicareResult;
  niit: NiitResult;
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
  /** Other (manual) nonrefundable credits requested. */
  nonrefundableRequested: string;
  /** ALL nonrefundable credits allowed: care + child tax credit / ODC + other (manual), limited by regular tax. */
  nonrefundableAllowed: string;
  /** ALL refundable credits: additional child tax credit + other (manual). */
  refundable: string;
  /** §21 credit allowed (Q44 ordering: first against regular tax). */
  careCredit: string;
  /** §24 child tax credit + credit for other dependents allowed (second). */
  childTaxCredit: string;
  /** Other nonrefundable credits allowed (third). */
  otherNonrefundableAllowed: string;
  /** Additional child tax credit (refundable). */
  additionalChildTaxCredit: string;
  /** Other refundable credits (manual). */
  otherRefundable: string;
}

/** Age group printed for a dependent (no date of birth leaves the engine). */
export type DependentAgeGroup = 'under_13' | '13_to_16' | '17_to_18' | '19_to_23' | '24_plus';

export interface DependentCreditPersonResult {
  dependentId: string;
  displayName: string;
  kind: EngineDependentKind;
  ageAtYearEnd: number;
  ageGroup: DependentAgeGroup;
  /** Counts for the child tax credit (qualifying child under the age limit). */
  childTaxCredit: boolean;
  /** Counts for the credit for other dependents. */
  otherDependentCredit: boolean;
  /** Qualifying person for the care credit (under 13 during the year, or disabled). */
  careQualifying: boolean;
  /** Counts as an EITC qualifying child (warning only; EITC is not computed). */
  eitcQualifying: boolean;
}

export interface DependentCreditsResult {
  /** 'computed' | 'fixed' (Schedule AI column: full-year amounts) | 'none' (no dependents and no care expenses). */
  method: 'computed' | 'fixed' | 'none';
  dependents: DependentCreditPersonResult[];
  ctcChildren: number;
  otherDependents: number;
  careQualifyingPersons: number;
  ctcTentative: string;
  odcTentative: string;
  phaseOutMagi: string;
  phaseOutThreshold: string;
  phaseOutReduction: string;
  /** CTC + ODC after the phase-out, before the tax limit. */
  ctcOdcAfterPhaseOut: string;
  ctcOdcAllowed: string;
  earnedIncome: string;
  actcByChildren: string;
  actcByEarnedIncome: string;
  actc: string;
  careExpenses: string;
  careExpenseLimit: string;
  careEarnedIncomeLimit: string;
  careAllowedExpenses: string;
  careRate: string;
  careTentative: string;
  careAllowed: string;
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
  /** Q44 dependent credits detail (§21, §24). */
  dependentCredits: DependentCreditsResult;
  seTax: string;
  additionalMedicareTax: string;
  niit: string;
  /** Step 13 detail (Form 8959 / 8960 lines). */
  otherTaxes: OtherTaxesResult;
  /** regular − nonrefundable + SE + Additional Medicare + NIIT − refundable (step 14). Negative = refund. */
  federalTotal: string;
  exact: FederalExactTotals;
  trace: EngineTraceRow[];
  warnings: TaxEstimatorWarning[];
  /** Every parameter the calculation read, with its status (D12a). */
  parametersUsed: ParameterUse[];
}
