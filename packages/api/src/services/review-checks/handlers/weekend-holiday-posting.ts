// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause, hasPeriod } from './period.js';
import { money, summaryLine } from './present.js';

// `weekend_holiday_posting` — flag transactions dated on a
// Saturday or Sunday. Holiday calendar deferred per plan §D7
// (would need per-jurisdiction calendar data); v1 catches the
// most common case (weekend posting).
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;
  // When a close period is supplied, bound to it; otherwise keep the
  // all-time behavior's 90-day recency guard.
  const dateClause = hasPeriod(params)
    ? periodDateClause(params, 't.txn_date')
    : sql`AND t.txn_date >= now() - INTERVAL '90 days'`;

  // EXTRACT(DOW FROM date) — 0=Sunday..6=Saturday in Postgres.
  const result = await db.execute<{ id: string; txn_date: string; total: string; txn_type: string; payee: string | null }>(sql`
    SELECT t.id, t.txn_date, t.total, t.txn_type, c.display_name AS payee
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      AND t.status = 'posted'
      AND EXTRACT(DOW FROM t.txn_date) IN (0, 6)
      ${dateClause}
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; txn_date: string; total: string; txn_type: string; payee: string | null }>).map((r) => ({
    checkKey: 'weekend_holiday_posting',
    transactionId: r.id,
    payload: {
      summary: summaryLine(r.txn_date, r.payee ?? r.txn_type, money(r.total)),
      txnDate: r.txn_date,
      total: r.total,
      txnType: r.txn_type,
      reason: `This ${r.txn_type} is dated ${r.txn_date}, a weekend day — unusual for most business activity.`,
      suggestion: 'Confirm the date is the real activity date and not a data-entry slip. Card purchases on weekends are normal; checks, bills, and journal entries usually are not, and a wrong date can shift activity across a month or year boundary.',
    },
  }));
};
