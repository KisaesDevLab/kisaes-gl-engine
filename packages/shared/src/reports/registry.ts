// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Report Packs — shared report registry.
//
// A "report pack" is a bulk multi-report combined PDF. The registry below
// is the SINGLE source of truth for which reports a pack can include, their
// temporal shape (date-range vs. as-of vs. current-state), page orientation,
// and which per-report options are configurable. The API render map and the
// pack builder UI both consume it.
//
// This module is intentionally additive: it does NOT drive the existing
// ReportsPage / App routing. It exists solely for the pack feature.

import { z } from 'zod';

/**
 * How a report's date parameters are shaped:
 *   - date-range     start_date + end_date (P&L, Cash Flow, GL, ...)
 *   - as-of          a single as_of_date (Balance Sheet, AR/AP aging)
 *   - current-state  no date params at all (e.g. live balances)
 */
export type ReportTemporalMode = 'date-range' | 'as-of' | 'current-state';

/** Which per-report toggles a pack item can carry. */
export interface ReportOptionSpec {
  basis?: boolean;
  compare?: boolean;
  tagFilter?: boolean;
  groupBy?: boolean;
  showPct?: boolean;
}

export interface ReportDef {
  /** Stable slug — equals the API endpoint segment (e.g. 'profit-loss'). */
  id: string;
  label: string;
  group: string;
  /** API endpoint slug under /reports (equals `id` for the v1 curated set). */
  endpoint: string;
  temporal: ReportTemporalMode;
  orientation: 'portrait' | 'landscape';
  options: ReportOptionSpec;
}

/**
 * The curated v1 report set. Every entry is a report that
 * `extractDataAndColumns` renders natively (financial statements, GL,
 * aging summaries, expense-by-category). `id === endpoint`.
 */
export const REPORT_CATALOG: ReportDef[] = [
  {
    id: 'profit-loss',
    label: 'Profit & Loss',
    group: 'Financial',
    endpoint: 'profit-loss',
    temporal: 'date-range',
    orientation: 'portrait',
    options: { basis: true, compare: true, tagFilter: true, groupBy: true, showPct: true },
  },
  {
    id: 'balance-sheet',
    label: 'Balance Sheet',
    group: 'Financial',
    endpoint: 'balance-sheet',
    temporal: 'as-of',
    orientation: 'portrait',
    options: { basis: true, compare: true, tagFilter: true, groupBy: true },
  },
  {
    id: 'cash-flow',
    label: 'Cash Flow Statement',
    group: 'Financial',
    endpoint: 'cash-flow',
    temporal: 'date-range',
    orientation: 'portrait',
    options: { tagFilter: true },
  },
  {
    id: 'trial-balance',
    label: 'Trial Balance',
    group: 'Financial',
    endpoint: 'trial-balance',
    temporal: 'date-range',
    orientation: 'portrait',
    options: { tagFilter: true },
  },
  {
    id: 'general-ledger',
    label: 'General Ledger',
    group: 'Detail',
    endpoint: 'general-ledger',
    temporal: 'date-range',
    orientation: 'landscape',
    options: { tagFilter: true },
  },
  {
    id: 'ar-aging-summary',
    label: 'A/R Aging Summary',
    group: 'Receivables',
    endpoint: 'ar-aging-summary',
    temporal: 'as-of',
    orientation: 'portrait',
    options: { tagFilter: true },
  },
  {
    id: 'ap-aging-summary',
    label: 'A/P Aging Summary',
    group: 'Payables',
    endpoint: 'ap-aging-summary',
    temporal: 'as-of',
    orientation: 'portrait',
    options: { tagFilter: true },
  },
  {
    id: 'expense-by-category',
    label: 'Expenses by Category',
    group: 'Expenses',
    endpoint: 'expense-by-category',
    temporal: 'date-range',
    orientation: 'portrait',
    options: { tagFilter: true },
  },
];

/** Fast lookup by report id. */
export function getReportDef(id: string): ReportDef | undefined {
  return REPORT_CATALOG.find((r) => r.id === id);
}

export type PeriodPreset =
  | 'this-month'
  | 'last-month'
  | 'qtd'
  | 'last-quarter'
  | 'ytd'
  | 'last-year'
  | 'custom';

/** Warn (soft) at this many reports; hard-cap at PACK_MAX_COUNT. */
export const PACK_WARN_COUNT = 15;
export const PACK_MAX_COUNT = 30;

/** Local-date ISO string (YYYY-MM-DD) built from a Date's local fields. */
function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Resolve a relative period preset to a concrete {start, end} ISO date pair.
 *
 * Pure and testable — `today` is injectable. `custom` returns empty strings;
 * the caller is expected to supply explicit dates in that case.
 */
export function resolvePreset(
  preset: PeriodPreset,
  today: Date = new Date(),
): { start: string; end: string } {
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-based

  switch (preset) {
    case 'this-month': {
      const start = new Date(y, m, 1);
      const end = new Date(y, m + 1, 0);
      return { start: isoLocal(start), end: isoLocal(end) };
    }
    case 'last-month': {
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0);
      return { start: isoLocal(start), end: isoLocal(end) };
    }
    case 'qtd': {
      const qStartMonth = Math.floor(m / 3) * 3;
      const start = new Date(y, qStartMonth, 1);
      return { start: isoLocal(start), end: isoLocal(today) };
    }
    case 'last-quarter': {
      const currentQStartMonth = Math.floor(m / 3) * 3;
      const start = new Date(y, currentQStartMonth - 3, 1);
      const end = new Date(y, currentQStartMonth, 0);
      return { start: isoLocal(start), end: isoLocal(end) };
    }
    case 'ytd': {
      const start = new Date(y, 0, 1);
      return { start: isoLocal(start), end: isoLocal(today) };
    }
    case 'last-year': {
      const start = new Date(y - 1, 0, 1);
      const end = new Date(y - 1, 11, 31);
      return { start: isoLocal(start), end: isoLocal(end) };
    }
    case 'custom':
    default:
      return { start: '', end: '' };
  }
}

/**
 * Map a resolved {start,end} range (+ optional as-of override) to the query
 * params a given report endpoint expects, based on its temporal mode.
 */
export function resolveReportDates(
  def: ReportDef,
  range: { start: string; end: string },
  asOfOverride?: string,
): Record<string, string> {
  switch (def.temporal) {
    case 'date-range':
      return { start_date: range.start, end_date: range.end };
    case 'as-of':
      return { as_of_date: asOfOverride ?? range.end };
    case 'current-state':
    default:
      return {};
  }
}

/**
 * Zod schema for a pack item's `options_json`. Strict so unknown keys are
 * rejected rather than silently persisted.
 */
export const reportPackItemOptionsSchema = z
  .object({
    basis: z.enum(['accrual', 'cash']).optional(),
    compare: z.boolean().optional(),
    tagId: z.string().uuid().nullable().optional(),
    groupBy: z.enum(['detail_type']).nullable().optional(),
    showPct: z.boolean().optional(),
  })
  .strict();

export type ReportPackItemOptions = z.infer<typeof reportPackItemOptionsSchema>;
