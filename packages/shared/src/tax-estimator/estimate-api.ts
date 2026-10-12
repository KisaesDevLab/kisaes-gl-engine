// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 10b API DTOs — the assembled estimate (engine results for one
// taxpayer / year / scenario), the estimated-tax payment ledger, Schedule AI period
// snapshots and estimate readiness. MONEY: decimal strings. The estimate carries the
// engine results unchanged (federal, state, vouchers, farmer, C corp) so the UI, the
// PDF and the portal read one contract; services never re-implement tax math.

import type { BooksReadiness, CharacterAmounts, PaymentJurisdiction, TaxEstimatorWarning, ThroughMonthSource } from './entities-api.js';
import type { EntityTaxType, FilingStatus, TaxMethod } from './types.js';
import type { SafeHarborOverride, PortalShows } from './taxpayers-api.js';
import type { FederalResult, ParameterUse } from './engine/types.js';
import type { StateResult, StateRuleUse } from './engine/state-types.js';
import type { JurisdictionEstimate } from './engine/vouchers.js';
import type { FarmerResult } from './engine/farmer.js';
import type { CcorpResult } from './engine/ccorp.js';
import type { SafeHarborRuleSource } from './engine/estimate-types.js';

export type EstimatePaymentSourceDTO = 'gl' | 'manual' | 'prior_year_overpayment';

/** One payment-ledger row: a stored row (manual / overpayment / pinned GL) or a live GL row read from the books. */
export interface EstimatePaymentDTO {
  /** Stored row id, or `gl:<transactionId>` for a live GL row. */
  id: string;
  /** true = a tax_est_payments row (editable); false = read live from the books. */
  stored: boolean;
  taxpayerId: string;
  taxYear: number;
  /** null = applies to every scenario of the year. */
  scenarioId: string | null;
  jurisdiction: PaymentJurisdiction;
  /** 'YYYY-MM-DD'; null only for a prior-year overpayment (credited on the prior return's original due date). */
  date: string | null;
  amount: string;
  source: EstimatePaymentSourceDTO;
  tenantId: string | null;
  transactionId: string | null;
  memo: string | null;
  /** GL rows: the payment account and company (names shown only for in-scope tenants). */
  accountName: string | null;
  companyName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PaymentLedgerDTO {
  taxpayerId: string;
  taxYear: number;
  scenarioId: string | null;
  /**
   * GL attribution window (R3-02): the day after the PRIOR year's Q4 cutoff → this year's Q4
   * cutoff (the later of the last installment due date and the Q4 file-and-pay date, in the
   * next calendar year). Consecutive years never overlap, so a booked payment is credited to
   * exactly one year; a stored row pins it to another. `returnDueDate` is the penalty end.
   */
  window: { start: string; end: string; returnDueDate?: string | null };
  /** Effective ledger (stored rows first, then GL rows not superseded by a stored row with the same transaction); paged by limit / offset. */
  payments: EstimatePaymentDTO[];
  /** Rows in the full effective ledger (before paging). */
  total: number;
  limit: number;
  offset: number;
  /** GL rows dropped because a stored row carries the same transaction id. */
  duplicatesDropped: EstimatePaymentDTO[];
  /** Per-jurisdiction totals of the FULL effective ledger. */
  totals: Record<PaymentJurisdiction, string>;
  warnings: TaxEstimatorWarning[];
}

export interface EstimateEntityDTO {
  tenantId: string;
  companyId: string;
  companyName: string;
  entityType: EntityTaxType | null;
  /** individual = rolled into the taxpayer's federal / state computation; c_corp = entity-level path; skipped = see reason. */
  path: 'individual' | 'c_corp' | 'skipped';
  skippedReason: string | null;
  throughMonth: string | null;
  throughMonthSource: ThroughMonthSource | null;
  monthsElapsed: number;
  monthsRemaining: number;
  glVersionStamp: number;
  providerCached: boolean;
  /** Phase 12 (optional, additive): tax method the books were read on. */
  basis?: TaxMethod | null;
  /** Phase 12: why `throughMonth` was chosen (provider's explanation). */
  throughMonthReason?: string | null;
  /** Phase 12: YTD amounts flagged non-recurring (excluded from the run-rate), by character. */
  nonRecurringYtd?: CharacterAmounts | null;
  /** Phase 12: YTD treatment-map reclass totals (assumptions page). */
  reclass?: EstimateEntityReclassDTO | null;
  /** Q41: whether the >2% shareholder health W-2 add-on was counted as §199A W-2 wages for this entity (S corps; absent = default, excluded). */
  includeSehiInW2Wages?: boolean;
}

/** YTD GL reclass totals applied by the treatment map before the engine (positive magnitudes). */
export interface EstimateEntityReclassDTO {
  ownerSehi: string;
  ownerRetirement: string;
  ownerPersonalDropped: string;
  sehiAsW2Wages: string;
  guaranteedPayments: string;
  nondeductibleAddBack: string;
  estimatedTaxPayments: string;
  /** Book depreciation kept in profit on accounts flagged tax_depreciation_differs (profit-positive, so ≤ 0). */
  taxDepreciationBook: string;
}

/** One scenario adjustment as used by the estimate (full-year total of its monthly allocation). */
export interface EstimateAdjustmentSummaryDTO {
  id: string;
  label: string;
  typeName: string | null;
  typeCode: string | null;
  kind: string;
  /** Σ of the 12-month allocation actually fed to the engine (GL-linked: actuals + plan). */
  fullYearAmount: string;
  cadence: string | null;
  glLinked: boolean;
  nonRecurring: boolean;
  personId: string | null;
  linkId: string | null;
}

// ── Assumptions block (Phase 12) ──────────────────────────────────────

export const ASSUMPTION_SECTION_IDS = [
  'rate_mode', 'projection', 'non_recurring', 'reclass', 'adjustments', 'safe_harbor', 'state_methods',
  'parameters', 'readiness', 'engine_notes', 'disclaimer',
] as const;
export type AssumptionSectionId = typeof ASSUMPTION_SECTION_IDS[number];

/** 'verify' = CPA must check; 'estimate_may_differ' = known simplification (D12b); statuses = parameter status (D12a). */
export type AssumptionBadge = 'verify' | 'estimate_may_differ' | 'unverified' | 'provisional';

export interface AssumptionItemDTO {
  label: string;
  detail: string;
  badge?: AssumptionBadge | null;
  /** Stable code where one exists (warning code, parameter key, Q-number). */
  code?: string | null;
}

export interface AssumptionSectionDTO {
  id: AssumptionSectionId;
  title: string;
  items: AssumptionItemDTO[];
}

/** The assumptions page (MODULE.md "Scenarios, snapshots, standards"): every section always present, in order. */
export interface EstimateAssumptionsDTO {
  version: 1;
  sections: AssumptionSectionDTO[];
  disclaimerText: string;
}

/** Where each Schedule AI column's actuals came from. */
export interface SchAiPeriodSourceDTO {
  periodIndex: number;
  periodEnd: string;
  /** snapshot = every entity from a stored snapshot; live = read now from the books; mixed; unavailable = period not reached. */
  source: 'snapshot' | 'live' | 'mixed' | 'unavailable';
  snapshotEntities: number;
  liveEntities: number;
}

export interface EstimateSummaryDTO {
  federalTotal: string;
  stateTotal: string;
  /** federal + state (C corps are entity-level and not included). */
  total: string;
  federalRequiredAnnualPayment: string;
  federalUnpaid: string;
  federalPenalty: string;
  statePenalty: string;
  /** Marginal ordinary rate (fraction string). */
  marginalRate: string;
}

export interface EstimateResultDTO {
  taxpayerId: string;
  taxYear: number;
  scenarioId: string;
  scenarioName: string;
  filingStatus: FilingStatus;
  engineVersion: string;
  computedAt: string;
  /** true = served from the Redis estimate cache (key = GL stamps + inputs hash). */
  cached: boolean;
  inputsHash: string;
  safeHarborRule: SafeHarborOverride;
  safeHarborRuleSource: SafeHarborRuleSource;
  entities: EstimateEntityDTO[];
  federal: FederalResult;
  /** null when the scenario has no state rows. */
  state: StateResult | null;
  federalEstimates: JurisdictionEstimate;
  stateEstimates: JurisdictionEstimate[];
  /** Farmer / fisherman test (§6654(i)); null when no farm entity, override or manual figures. */
  farmer: FarmerResult | null;
  /** Linked C corporations, entity level (not in the taxpayer totals). */
  ccorps: CcorpResult[];
  payments: EstimatePaymentDTO[];
  scheduleAi: SchAiPeriodSourceDTO[];
  summary: EstimateSummaryDTO;
  /** Readiness, provider, engine and D12a warnings, de-duplicated. */
  warnings: TaxEstimatorWarning[];
  parametersUsed: ParameterUse[];
  rulesUsed: StateRuleUse[];
  /** Phase 12 (optional, additive): adjustments as fed to the engine. */
  adjustments?: EstimateAdjustmentSummaryDTO[];
  /** Phase 12: the assumptions block (buildEstimateAssumptions). */
  assumptions?: EstimateAssumptionsDTO;
  /** Phase 12: firm disclaimer in effect (firm text, else the shipped default). */
  disclaimerText?: string;
  /** Phase 12: what the portal shows for this taxpayer (taxpayer override, else the firm default; D10). */
  portalShows?: PortalShows;
  /** Phase 12: the firm's safe-harbor default at compute time (D4). */
  firmSafeHarborDefault?: SafeHarborOverride;
}

export interface SchAiSnapshotDTO {
  id: string;
  periodIndex: number;
  periodEnd: string;
  tenantId: string;
  companyId: string;
  companyName: string | null;
  throughMonth: string;
  glVersionStamp: number;
  capturedAt: string;
  capturedBy: string | null;
}

export interface EstimateReadinessEntityDTO {
  tenantId: string;
  companyId: string;
  companyName: string | null;
  linkCount: number;
  /** false = the link's tenant left the caller's scope: excluded from the estimate (D1). */
  inScope: boolean;
  readiness: BooksReadiness | null;
  error: string | null;
}

export interface EstimateReadinessPeriodDTO {
  periodIndex: number;
  periodEnd: string;
  /** 'YYYY-MM' of the period end. */
  periodMonth: string;
  /** The period end is in a complete month (the column can be captured). */
  reached: boolean;
  /** Every in-scope entity's books are closed (reconciled) through the period month. */
  closedForAllEntities: boolean;
  snapshotsCaptured: number;
  entitiesExpected: number;
}

/** "Snapshot readiness": can this year's estimate be finalized, and which Schedule AI columns are frozen. */
export interface EstimateReadinessDTO {
  taxpayerId: string;
  taxYear: number;
  entities: EstimateReadinessEntityDTO[];
  outOfScopeLinks: number;
  schAiPeriods: EstimateReadinessPeriodDTO[];
  /** true when no entity has a 'warning'-severity readiness item and no link is out of scope. */
  ready: boolean;
  warnings: TaxEstimatorWarning[];
}
