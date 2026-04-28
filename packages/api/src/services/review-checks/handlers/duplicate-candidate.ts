// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `duplicate_candidate` — two transactions in the same window
// with the same vendor + same total. Both halves of the pair
// are flagged as findings (the bookkeeper resolves whichever).
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const windowDays = Math.max(1, Number(params['windowDays'] ?? 7));
  const companyClause = companyId
    ? sql`AND t1.company_id = ${companyId} AND t2.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{
    a_id: string; b_id: string; contact_id: string; total: string;
  }>(sql`
    SELECT
      LEAST(t1.id, t2.id) AS a_id,
      GREATEST(t1.id, t2.id) AS b_id,
      t1.contact_id,
      t1.total
    FROM transactions t1
    JOIN transactions t2 ON
      t1.tenant_id = t2.tenant_id
      AND t1.id < t2.id
      AND t1.contact_id = t2.contact_id
      AND t1.txn_type = t2.txn_type
      AND t1.total = t2.total
      AND ABS(EXTRACT(EPOCH FROM (t1.txn_date::TIMESTAMP - t2.txn_date::TIMESTAMP))) <= ${windowDays * 24 * 3600}
    WHERE t1.tenant_id = ${tenantId}
      ${companyClause}
      AND t1.contact_id IS NOT NULL
      AND t1.status = 'posted'
      AND t2.status = 'posted'
    LIMIT 500
  `);

  // Emit one finding per pair, attached to the EARLIER half;
  // the payload notes the partner so the UI can link both.
  return (result.rows as Array<{ a_id: string; b_id: string; contact_id: string; total: string }>).map((r) => ({
    checkKey: 'duplicate_candidate',
    transactionId: r.a_id,
    vendorId: r.contact_id,
    payload: {
      partnerTransactionId: r.b_id,
      total: r.total,
      windowDays,
      // Pair-level dedupe key — the same pair re-fires across
      // runs would otherwise create duplicate findings.
      dedupe_key: `pair:${r.a_id}:${r.b_id}`,
      reason: `Possible duplicate: same vendor + same total within ${windowDays} days.`,
    },
  }));
};
