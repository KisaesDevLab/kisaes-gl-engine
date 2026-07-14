// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause } from './period.js';
import { money, summaryLine } from './present.js';

// `transaction_above_materiality` — single transaction at or
// above the materiality threshold. Default $10,000; per-tenant
// override common.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const threshold = Number(params['thresholdAmount'] ?? 10000);
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;
  const periodClause = periodDateClause(params, 't.txn_date');

  const result = await db.execute<{ id: string; total: string; txn_type: string; txn_date: string; payee: string | null }>(sql`
    SELECT t.id, t.total, t.txn_type, t.txn_date, c.display_name AS payee
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      ${periodClause}
      AND t.status = 'posted'
      AND t.total >= ${threshold}
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; total: string; txn_type: string; txn_date: string; payee: string | null }>).map((r) => ({
    checkKey: 'transaction_above_materiality',
    transactionId: r.id,
    payload: {
      summary: summaryLine(r.txn_date, r.payee ?? r.txn_type, money(r.total)),
      total: r.total,
      txnType: r.txn_type,
      txnDate: r.txn_date,
      threshold,
      reason: `This ${r.txn_type} is ${money(r.total)}, at or above the ${money(threshold)} materiality threshold, so it deserves a second look.`,
      suggestion: 'Confirm the amount and category are right, and attach supporting documentation (contract, invoice, settlement statement). Material transactions are the ones reviewers and lenders examine first.',
    },
  }));
};
