// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Core vocabulary shared by the engine, API and web. Grows phase by phase.

export const TAX_ESTIMATOR_FLAG = 'TAX_ESTIMATOR_V1' as const;
export const TAX_ESTIMATOR_RESOURCE = 'tax_estimator' as const;

export const FILING_STATUSES = ['single', 'mfj', 'mfs', 'hoh', 'qss'] as const;
export type FilingStatus = typeof FILING_STATUSES[number];

export const ENTITY_TAX_TYPES = ['sch_c', 'sch_f', 's_corp', 'partnership', 'c_corp'] as const;
export type EntityTaxType = typeof ENTITY_TAX_TYPES[number];

export const TAX_METHODS = ['cash', 'accrual'] as const;
export type TaxMethod = typeof TAX_METHODS[number];

export const ACTIVITY_TYPES = ['active', 'passive', 'rental', 'investment'] as const;
export type ActivityType = typeof ACTIVITY_TYPES[number];

export const PARAMETER_STATUSES = ['verified', 'unverified', 'provisional'] as const;
export type ParameterStatus = typeof PARAMETER_STATUSES[number];

/** Source of a trace row — drives the UI drill-down and the assumptions page. */
export const TRACE_SOURCES = ['gl', 'gl_map', 'adjustment', 'parameter', 'state_rule', 'input'] as const;
export type TraceSource = typeof TRACE_SOURCES[number];

export interface TraceRow {
  label: string;
  /** Whole dollars (half-up) at final per-line amounts; decimal string before. */
  amount: string;
  formula?: string;
  source: TraceSource;
}
