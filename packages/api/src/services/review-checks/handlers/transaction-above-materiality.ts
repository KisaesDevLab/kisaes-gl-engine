// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `transaction_above_materiality` — single transaction at or
// above the materiality threshold. Default $10,000; per-tenant
// override common.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const threshold = Number(params['thresholdAmount'] ?? 10000);
  const companyClause = companyId
    ? sql`AND company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{ id: string; total: string; txn_type: string; txn_date: string }>(sql`
    SELECT id, total, txn_type, txn_date
    FROM transactions
    WHERE tenant_id = ${tenantId}
      ${companyClause}
      AND status = 'posted'
      AND total >= ${threshold}
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; total: string; txn_type: string; txn_date: string }>).map((r) => ({
    checkKey: 'transaction_above_materiality',
    transactionId: r.id,
    payload: {
      total: r.total,
      txnType: r.txn_type,
      txnDate: r.txn_date,
      threshold,
      reason: `Transaction total $${r.total} ≥ materiality $${threshold}.`,
    },
  }));
};
