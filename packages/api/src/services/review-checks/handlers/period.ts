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
