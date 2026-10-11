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

export interface ItemizedDTO {
  saltPaid?: number; mortgageInterest?: number; charitableCash?: number; charitableNoncash?: number; other?: number;
}
export interface Sch1aPersonDTO { qualifiedTips?: number; qualifiedOvertime?: number; carLoanInterest?: number }
export interface Sch1aDTO { primary?: Sch1aPersonDTO; spouse?: Sch1aPersonDTO }
export interface HsaCoverageDTO { primary?: HsaCoverage; spouse?: HsaCoverage }
export interface WithholdingDTO { federal?: number; states?: Record<string, number> }

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
  creditsNonrefundable: string;
  creditsRefundable: string;
  hsaCoverage: HsaCoverageDTO;
  withholding: WithholdingDTO;
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
  customBase: string | null;
  sourcedIncome: string | null;
  sourcedManual: boolean;
  creditOverride: string | null;
  memo: string | null;
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
  updatedAt: string | null;
}
