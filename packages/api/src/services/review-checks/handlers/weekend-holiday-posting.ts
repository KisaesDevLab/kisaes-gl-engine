// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `weekend_holiday_posting` — flag transactions dated on a
// Saturday or Sunday. Holiday calendar deferred per plan §D7
// (would need per-jurisdiction calendar data); v1 catches the
// most common case (weekend posting).
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND company_id = ${companyId}`
    : sql``;

  // EXTRACT(DOW FROM date) — 0=Sunday..6=Saturday in Postgres.
  const result = await db.execute<{ id: string; txn_date: string; total: string; txn_type: string }>(sql`
    SELECT id, txn_date, total, txn_type
    FROM transactions
    WHERE tenant_id = ${tenantId}
      ${companyClause}
      AND status = 'posted'
      AND EXTRACT(DOW FROM txn_date) IN (0, 6)
      AND txn_date >= now() - INTERVAL '90 days'
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; txn_date: string; total: string; txn_type: string }>).map((r) => ({
    checkKey: 'weekend_holiday_posting',
    transactionId: r.id,
    payload: {
      txnDate: r.txn_date,
      total: r.total,
      txnType: r.txn_type,
      reason: 'Posted on a weekend.',
    },
  }));
};
