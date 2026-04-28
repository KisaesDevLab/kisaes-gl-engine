// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `round_dollar_above_threshold` — transactions with whole-
// dollar totals at or above the threshold. Common indicator of
// estimates, made-up entries, or fraudulent round numbers.
// Default threshold $500.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const threshold = Number(params['thresholdAmount'] ?? 500);
  const companyClause = companyId
    ? sql`AND company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{ id: string; total: string; txn_type: string }>(sql`
    SELECT id, total, txn_type
    FROM transactions
    WHERE tenant_id = ${tenantId}
      ${companyClause}
      AND status = 'posted'
      AND total >= ${threshold}
      AND (total::TEXT NOT LIKE '%.%' OR total::TEXT LIKE '%.0000' OR total::TEXT LIKE '%.00')
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; total: string; txn_type: string }>).map((r) => ({
    checkKey: 'round_dollar_above_threshold',
    transactionId: r.id,
    payload: {
      total: r.total,
      txnType: r.txn_type,
      threshold,
      reason: `Round-dollar total $${r.total} ≥ $${threshold}.`,
    },
  }));
};
