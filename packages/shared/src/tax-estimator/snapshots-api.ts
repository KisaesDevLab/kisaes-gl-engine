// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 12 — immutable estimate snapshots (MODULE.md "Scenarios,
// snapshots, standards"; error TE_SNAPSHOT_IMMUTABLE). A snapshot freezes the inputs,
// the engine result, the resolved federal parameters and state rules WITH statuses,
// readiness, the assumptions block and the disclaimer in effect. The payload holds
// tax return information (D9: prior-year tax / AGI and figures derived from them) and
// is stored encrypted; only the metadata below is plain.

import type { TaxEstimatorWarning } from './entities-api.js';
import type {
  EstimateAssumptionsDTO, EstimateReadinessDTO, EstimateResultDTO, EstimateSummaryDTO,
} from './estimate-api.js';
import type { TaxParametersDTO } from './parameter-api.js';
import type { StateRulesDTO } from './state-rules-api.js';
import type { FirmSettingsDTO } from './years-api.js';
import type { FilingStatus } from './types.js';

export const SNAPSHOT_REASONS = ['finalize', 'vouchers', 'pdf', 'report_pack'] as const;
export type SnapshotReason = typeof SNAPSHOT_REASONS[number];

/** History row (plain metadata + the encrypted summary, decrypted for in-scope callers). */
export interface EstimateSnapshotListItemDTO {
  id: string;
  taxpayerId: string;
  taxYear: number;
  scenarioId: string;
  scenarioName: string;
  reason: SnapshotReason;
  note: string | null;
  engineVersion: string;
  inputsHash: string;
  createdBy: string | null;
  createdAt: string;
  /**
   * false = the snapshot includes a company in a client the caller can no longer reach
   * (D1): no figures are returned and the view / compare routes answer 404.
   */
  accessible: boolean;
  summary: EstimateSummaryDTO | null;
}

export interface EstimateSnapshotListDTO {
  data: EstimateSnapshotListItemDTO[];
  total: number;
  limit: number;
  offset: number;
}

/** Inputs exactly as the estimate read them (prior-year tax / AGI are REDACTED on the view; D9). */
export interface EstimateSnapshotInputsDTO {
  throughMonth: string | null;
  taxpayer: { id: string; displayName: string; filingStatus: FilingStatus; residentState: string | null };
  /** Annual settings; on the view the prior-year values are replaced by the *_Present flags. */
  year: Record<string, unknown>;
  safeHarbor: { rule: string; ruleSource: string };
  persons: unknown[];
  links: unknown[];
  /** Q50: `ownerSplits` (optional, additive) = the company's owner splits as read, when it has any. */
  companies: Array<{ tenantId: string; companyId: string; companyName: string | null; glVersionStamp: number; configVersion: string; settings: unknown; ownerSplits?: unknown[] }>;
  adjustments: unknown[];
  adjustmentTypes: unknown[];
  /** State rows; on the view prior-year state tax / AGI are redacted. */
  stateRows: unknown[];
  payments: unknown[];
  /** Schedule AI period figures frozen by tax_est_sch_ai_snapshots at the time. */
  schAiFigures: Array<{ key: string; figures: unknown }>;
  /** Q45 (optional, additive): businesses outside MyBooks with the year's entered amounts, as used. */
  outsideEntities?: unknown[];
}

/** The encrypted payload (version 1). */
export interface EstimateSnapshotPayload {
  version: 1;
  inputs: EstimateSnapshotInputsDTO;
  /** Federal parameters as resolved for the year, every key with value + status (D12a). */
  federalParameters: TaxParametersDTO;
  /** State rules per scenario state, every key with value + status. */
  stateRules: StateRulesDTO[];
  result: EstimateResultDTO;
  readiness: EstimateReadinessDTO | null;
  readinessWarnings: TaxEstimatorWarning[];
  assumptions: EstimateAssumptionsDTO;
  disclaimerText: string;
  firmSettings: FirmSettingsDTO;
}

export interface EstimateSnapshotDTO extends EstimateSnapshotListItemDTO {
  /** sha256 of the decrypted payload, verified on every read. */
  payloadSha256: string;
  payload: EstimateSnapshotPayload;
}

export interface SnapshotDiffRowDTO {
  path: string;
  label: string;
  snapshot: string | null;
  live: string | null;
  /** live − snapshot for money lines; null for non-numeric rows. */
  delta: string | null;
}

export interface SnapshotParameterChangeDTO {
  scope: 'federal' | string;
  key: string;
  snapshot: { value: unknown; status: string } | null;
  live: { value: unknown; status: string } | null;
}

export interface SnapshotCompareDTO {
  snapshotId: string;
  snapshotCreatedAt: string;
  /** Null when no live estimate could be computed (see `liveUnavailable`). */
  liveComputedAt: string | null;
  /**
   * Why there is no live side (R3-18): the scenario was deleted after the snapshot, or the
   * live compute failed. The frozen snapshot is still returned; differences are empty.
   */
  liveUnavailable: { code: string; message: string } | null;
  engineVersionChanged: boolean;
  /** The estimate inputs hash differs (it includes the as-of day, so a later day always differs). */
  inputsHashChanged: boolean;
  summary: { snapshot: EstimateSummaryDTO; live: EstimateSummaryDTO | null };
  /** Money lines that differ (same order as SNAPSHOT_COMPARE_LINES); unchanged lines are omitted. */
  differences: SnapshotDiffRowDTO[];
  /** Parameters / state rules used by either computation whose value or status changed. */
  parameterChanges: SnapshotParameterChangeDTO[];
  warningsAdded: TaxEstimatorWarning[];
  warningsRemoved: TaxEstimatorWarning[];
}
