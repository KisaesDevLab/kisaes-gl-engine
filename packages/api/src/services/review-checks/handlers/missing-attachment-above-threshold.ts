// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause } from './period.js';

// `missing_attachment_above_threshold` — expense/bill above the
// threshold with no attachment row referencing it. Threshold is
// dollar-amount; default 75. Per-tenant override allowed.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const threshold = Number(params['thresholdAmount'] ?? 75);
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;
  const periodClause = periodDateClause(params, 't.txn_date');

  const result = await db.execute<{ id: string; total: string; txn_type: string }>(sql`
    SELECT t.id, t.total, t.txn_type
    FROM transactions t
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      ${periodClause}
      AND t.txn_type IN ('expense', 'bill')
      AND t.status = 'posted'
      AND t.total >= ${threshold}
      AND NOT EXISTS (
        SELECT 1 FROM attachments a
        WHERE a.tenant_id = ${tenantId}
          AND a.attachable_type = 'transaction'
          AND a.attachable_id = t.id
      )
    LIMIT 1000
  `);

  return (result.rows as Array<{ id: string; total: string; txn_type: string }>).map((r) => ({
    checkKey: 'missing_attachment_above_threshold',
    transactionId: r.id,
    payload: {
      total: r.total,
      txnType: r.txn_type,
      threshold,
      reason: `${r.txn_type} ≥ $${threshold} has no attached receipt.`,
    },
  }));
};
