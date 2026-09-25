// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql, type SQL } from 'drizzle-orm';
import type { CheckParams } from './index.js';

// Shared helper for transaction-based checks. Given the run's params
// (into which the orchestrator injects the close-period window) and a
// date column reference, produce a SQL fragment bounding rows to the
// period [periodStart, periodEnd). periodEnd is exclusive
// (first-of-next-month) per ClosePeriodSelector, so we use `< end`.
//
// When no period is present (null/undefined bounds — an all-time run
// or the nightly scheduler) an empty fragment is returned so the query
// behaves exactly as before. Bounds are cast to ::date so the
// comparison is deterministic against a `date` column no matter whether
// the caller passed a bare date or a full ISO timestamp.
//
// `column` is an internal literal (e.g. 'txn_date', 't1.txn_date') —
// never user input — so sql.raw on it is safe.
export function periodDateClause(params: CheckParams, column: string): SQL {
  const start = typeof params.periodStart === 'string' ? params.periodStart : null;
  const end = typeof params.periodEnd === 'string' ? params.periodEnd : null;
  if (!start || !end) return sql``;
  const col = sql.raw(column);
  return sql`AND ${col} >= ${start}::date AND ${col} < ${end}::date`;
}

// True when the run carries a usable close-period window. Lets a
// handler choose between its all-time recency guard and a period bound.
export function hasPeriod(params: CheckParams): boolean {
  return typeof params.periodStart === 'string' && typeof params.periodEnd === 'string';
}

// Fallback-aware variant: bound `column` to the run's period, or apply
// `fallback` (the handler's historical recency guard) when a run has no
// period. Every UI-started run carries a period; the fallback only keeps
// direct/internal callers and older tests behaving as before.
export function periodOrFallback(params: CheckParams, column: string, fallback: SQL): SQL {
  return hasPeriod(params) ? periodDateClause(params, column) : fallback;
}

// History window for "vs history" checks: the `months` months BEFORE the
// period start (Double's trailing-12-month baseline). Without a period it
// returns `fallback`.
export function historyWindowClause(params: CheckParams, column: string, months: number, fallback: SQL): SQL {
  if (!hasPeriod(params)) return fallback;
  const start = params.periodStart as string;
  const col = sql.raw(column);
  return sql`AND ${col} >= (${start}::date - make_interval(months => ${months})) AND ${col} < ${start}::date`;
}
