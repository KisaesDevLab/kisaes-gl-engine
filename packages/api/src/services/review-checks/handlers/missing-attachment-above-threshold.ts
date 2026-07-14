// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause } from './period.js';
import { money, summaryLine } from './present.js';

// `missing_attachment_above_threshold` — expense/bill above the
// threshold with no attachment row referencing it. Threshold is
// dollar-amount; default 75. Per-tenant override allowed.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const threshold = Number(params['thresholdAmount'] ?? 75);
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
      AND t.txn_type IN ('expense', 'bill')
      AND t.status = 'posted'
      AND t.total >= ${threshold}
      AND NOT EXISTS (
        SELECT 1 FROM attachments a
        WHERE a.tenant_id = ${tenantId}
          -- Attachments are stored under the transaction's txn_type
          -- ('expense', 'bill', …), not the literal 'transaction' —
          -- that value was a legacy bug converted away in migration
          -- 0037. Accept both so stragglers still count as support.
          AND a.attachable_type IN (t.txn_type, 'transaction')
          AND a.attachable_id = t.id
      )
    LIMIT 1000
  `);

  return (result.rows as Array<{ id: string; total: string; txn_type: string; txn_date: string; payee: string | null }>).map((r) => ({
    checkKey: 'missing_attachment_above_threshold',
    transactionId: r.id,
    payload: {
      summary: summaryLine(r.txn_date, r.payee ?? r.txn_type, money(r.total)),
      total: r.total,
      txnType: r.txn_type,
      threshold,
      reason: `This ${r.txn_type} is ${money(r.total)} — at or above the ${money(threshold)} documentation threshold — and has no receipt or bill copy attached.`,
      suggestion: 'Attach the receipt, bill, or invoice to the transaction. Support for larger amounts is the first thing an auditor or tax preparer asks for.',
    },
  }));
};
