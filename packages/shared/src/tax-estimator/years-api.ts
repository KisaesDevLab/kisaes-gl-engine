// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 5 API DTOs — annual settings, scenarios, adjustments, state rows,
// firm settings. Dollar amounts that came from numeric(19,4) columns are decimal strings;
// jsonb inputs (itemized, Schedule 1-A, withholding) are plain numbers; monthly strips are
// dollar numbers (exact to the cent). Prior-year tax / AGI (D9) appear ONLY on the
// single-year GET and never in a list/summary row.
import type { SafeHarborOverride, PortalShows } from './taxpayers-api.js';

export type RateMode = 'brackets' | 'effective';
export type DeductionMode = 'auto' | 'standard' | 'itemized';
export type HsaCoverage = 'self' | 'family' | 'none';
export type AdjustmentCadenceDTO = 'monthly' | 'quarterly' | 'annual' | 'one_time';
export type AdjustmentKind = 'income' | 'deduction' | 'addback';
export type StateResidency = 'resident' | 'nonresident';
export type StateBase = 'federal_agi' | 'federal_taxable' | 'custom';
/** Q53: state row rate mode — the state's rate schedule (default) or the effective-rate override. */
export type StateRowRateMode = 'brackets' | 'effective';
/** Q53: nonresident computation — the state's method on the schedule (default) or sourced income × effective rate. */
export type StateRowNonresidentMode = 'ratio' | 'sourced_rate';

export interface ItemizedDTO {
  saltPaid?: number; mortgageInterest?: number; charitableCash?: number; charitableNoncash?: number; other?: number;
}
export interface Sch1aPersonDTO { qualifiedTips?: number; qualifiedOvertime?: number; carLoanInterest?: number }
export interface Sch1aDTO { primary?: Sch1aPersonDTO; spouse?: Sch1aPersonDTO }
export interface HsaCoverageDTO { primary?: HsaCoverage; spouse?: HsaCoverage }
export interface WithholdingDTO { federal?: number; states?: Record<string, number> }
export type RetirementPlanTypeDTO = 'sep' | 'solo_401k' | 'simple' | 'none';
/** Phase 10b (Q28): per-person year inputs. */
export interface PersonYearInputDTO {
  retirementPlanType?: RetirementPlanTypeDTO | null;
  employeeDeferral?: number | null;
  /** Outside W-2 box 1 wages. */
  w2Wages?: number | null;
  w2SocialSecurityWages?: number | null;
}
export interface PersonInputsDTO { primary?: PersonYearInputDTO; spouse?: PersonYearInputDTO }
export interface FarmerGrossPersonDTO { farming?: number; fishing?: number; totalGross?: number }
export interface FarmerGrossYearDTO { primary?: FarmerGrossPersonDTO; spouse?: FarmerGrossPersonDTO }
/** Phase 10b (Q34): manual farmer gross-income figures; a year present wins over the books. */
export interface FarmerGrossDTO { current?: FarmerGrossYearDTO; prior?: FarmerGrossYearDTO }

export interface YearSettingsDTO {
  id: string;
  taxpayerId: string;
  taxYear: number;
  /** Decrypted; present on the single-year GET only. Never in list responses. */
  priorYearTax: string | null;
  priorYearAgi: string | null;
  priorYearTaxPresent: boolean;
  priorYearAgiPresent: boolean;
  priorYearTwelveMonths: boolean;
  priorYearFiled: boolean;
  /** null = taxpayer/firm default. */
  safeHarborRule: SafeHarborOverride | null;
  rateMode: RateMode;
  effectiveRateOverride: number | null;
  deductionMode: DeductionMode;
  itemized: ItemizedDTO;
  sch1a: Sch1aDTO;
  /** Other nonrefundable credits (manual; the dependent credits are computed — Q44). */
  creditsNonrefundable: string;
  /** Other refundable credits (manual; the additional child tax credit is computed — Q44). */
  creditsRefundable: string;
  /** Q44: child and dependent care expenses paid in the year (Form 2441). */
  careExpenses?: string;
  /** Q53 / Q39: unrecaptured §1250 gain and collectibles gain entered for the year (part of long-term gains). */
  unrecaptured1250Gain?: string;
  collectiblesGain?: string;
  hsaCoverage: HsaCoverageDTO;
  withholding: WithholdingDTO;
  // Phase 10b inputs — always present in API responses; optional for older fixtures.
  personInputs?: PersonInputsDTO;
  mfsLivedApartAllYear?: boolean;
  /** Form 8960 Part II allocable deductions; null = none. */
  niiAllocableDeductions?: string | null;
  farmerGross?: FarmerGrossDTO;
  isFisherman?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Year inputs plus how the safe-harbor rule resolves, so the UI can show "firm default: lesser of". */
export interface YearDetailDTO {
  /** false until the first save creates the year row (and its Base scenario). */
  exists: boolean;
  year: YearSettingsDTO;
  /** Taxpayer override, else the firm default. */
  taxpayerSafeHarborOverride: SafeHarborOverride | null;
  firmSafeHarborDefault: SafeHarborOverride;
  effectiveSafeHarborRule: SafeHarborOverride;
  scenarios: ScenarioDTO[];
}

/** Summary row with NO return information. */
export interface YearSummaryDTO {
  taxYear: number;
  priorYearTaxPresent: boolean;
  priorYearAgiPresent: boolean;
  scenarioCount: number;
}

export interface ScenarioDTO {
  id: string;
  taxpayerId: string;
  taxYear: number;
  name: string;
  isBase: boolean;
  /**
   * Q51: shared in the client portal (contacts get a scenario picker). Always true in
   * effect for Base, which the portal shows whenever it is on; the stored value is kept.
   */
  showInPortal: boolean;
  sortOrder: number;
  sourceScenarioId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdjustmentTypeDTO {
  id: string;
  /** null = shipped catalog row (read-only). */
  firmId: string | null;
  code: string | null;
  name: string;
  kind: AdjustmentKind;
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
  defaultPct: number | null;
  isActive: boolean;
  isShipped: boolean;
}

/**
 * QA D1: shipped deduction types that are a business's own expense. They reduce
 * that entity's profit, SE income, QBI and §461(l) business income, so they are
 * only meaningful attached to an entity link; unlinked, the engine would treat
 * them as an itemized "other" deduction.
 */
export const LINK_REQUIRED_ADJUSTMENT_CODES: readonly string[] = ['vehicle_179', 'depreciation_tax_vs_book'];
/**
 * Owner-level deductions the engine routes per PERSON with their own limits
 * (SEHI limited to SE earnings, retirement and HSA limits). Linked to an entity
 * they would be applied as an entity expense instead, so a link is refused.
 */
export const PERSON_LEVEL_ADJUSTMENT_CODES: readonly string[] = ['owner_health_insurance', 'sep_solo_401k', 'hsa_contribution', 'retirement_catch_up'];
export type AdjustmentLinkRule = 'required' | 'optional' | 'not_allowed';
export const ADJUSTMENT_LINK_REQUIRED_MESSAGE = 'Choose the business this deduction belongs to. Without an entity it would be treated as an itemized deduction, not a business expense.';
export const ADJUSTMENT_LINK_NOT_ALLOWED_MESSAGE = 'This owner-level deduction is figured per person and cannot be attached to an entity.';

/** Whether an adjustment of this type needs, may have, or must not have an entity link (QA D1). */
export function adjustmentLinkRule(t: Pick<AdjustmentTypeDTO, 'code' | 'kind' | 'affectsSe' | 'affectsQbi' | 'isAboveTheLine'>): AdjustmentLinkRule {
  if (t.code && PERSON_LEVEL_ADJUSTMENT_CODES.includes(t.code)) return 'not_allowed';
  if (t.code && LINK_REQUIRED_ADJUSTMENT_CODES.includes(t.code)) return 'required';
  // Firm-defined business deductions (they affect SE income or QBI and are not above the line).
  if (t.kind === 'deduction' && !t.isAboveTheLine && (t.affectsSe || t.affectsQbi)) return 'required';
  return 'optional';
}

export interface AdjustmentDTO {
  id: string;
  scenarioId: string;
  adjustmentTypeId: string;
  adjustmentTypeName: string;
  personId: string | null;
  linkId: string | null;
  label: string;
  /** null = GL-linked run-rate. */
  amount: string | null;
  pct: number | null;
  cadence: AdjustmentCadenceDTO;
  startMonth: number;
  endMonth: number;
  glLinked: boolean;
  tenantId: string | null;
  companyId: string | null;
  accountId: string | null;
  nonRecurring: boolean;
  memo: string | null;
  /** Planned allocation, 12 dollar values Jan..Dec (sums exactly to the planned total). */
  monthly: number[];
  createdAt: string;
  updatedAt: string;
}

export interface StateRowDTO {
  id: string;
  scenarioId: string;
  residency: StateResidency;
  state: string;
  effectiveRate: number;
  base: StateBase;
  /** Q53: absent in older fixtures = 'brackets' / 'ratio'. */
  rateMode?: StateRowRateMode;
  nonresidentMode?: StateRowNonresidentMode;
  customBase: string | null;
  sourcedIncome: string | null;
  sourcedManual: boolean;
  creditOverride: string | null;
  memo: string | null;
  // Phase 10b gate inputs (D12b) — always present in API responses; optional for older fixtures.
  /** null = the year's withholding.states[state]. */
  withholding?: string | null;
  otherCredits?: string | null;
  grossIncome?: string | null;
  priorYearGrossIncome?: string | null;
  nonWithheldIncome?: string | null;
  exemptions?: string | null;
  stateDeductions?: string | null;
  /** Prior-year state tax / AGI are never returned (D9); only whether they are on file. */
  priorYearTaxPresent?: boolean;
  priorYearAgiPresent?: boolean;
}

export interface AdjustmentListDTO {
  data: AdjustmentDTO[];
  total: number;
  limit: number;
  offset: number;
}

export interface FirmSettingsDTO {
  firmId: string;
  safeHarborDefault: SafeHarborOverride;
  /** null = the shipped default text. */
  disclaimerText: string | null;
  /** The text actually used (custom, else the shipped default). */
  effectiveDisclaimerText: string;
  portalShows: PortalShows;
  /**
   * D17: ON (default) = a staff member who is not a firm admin sees a taxpayer only when
   * they can reach at least one tenant it is linked to (an unlinked taxpayer: its creator
   * only). OFF = every firm taxpayer is visible (subject to a per-taxpayer staff list).
   */
  restrictTaxpayersToLinkedTenants: boolean;
  updatedAt: string | null;
}
