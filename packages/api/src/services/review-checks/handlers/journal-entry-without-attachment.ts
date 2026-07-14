// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause } from './period.js';
import { money, summaryLine } from './present.js';

// `journal_entry_without_attachment` — posted journal entries with no
// supporting document attached. JEs are the highest-risk entry type
// (they bypass every workflow) so auditors expect each one to carry
// its support: the amortization schedule, the loan statement, the
// accountant's adjusting-entry memo. `thresholdAmount` (default 0 =
// every JE) lets tenants exempt small entries.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const threshold = Number(params['thresholdAmount'] ?? 0);
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;
  const periodClause = periodDateClause(params, 't.txn_date');

  const result = await db.execute<{ id: string; total: string; txn_date: string; memo: string | null }>(sql`
    SELECT t.id, t.total, t.txn_date, t.memo
    FROM transactions t
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      ${periodClause}
      AND t.txn_type = 'journal_entry'
      AND t.status = 'posted'
      AND t.total >= ${threshold}
      AND NOT EXISTS (
        SELECT 1 FROM attachments a
        WHERE a.tenant_id = ${tenantId}
          -- JE attachments are stored with attachable_type =
          -- 'journal_entry' (the txn_type convention); 'transaction'
          -- is the legacy value migration 0037 converted away.
          AND a.attachable_type IN ('journal_entry', 'transaction')
          AND a.attachable_id = t.id
      )
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; total: string; txn_date: string; memo: string | null }>).map((r) => ({
    checkKey: 'journal_entry_without_attachment',
    transactionId: r.id,
    payload: {
      summary: summaryLine(r.txn_date, r.memo ?? 'journal entry', money(r.total)),
      total: r.total,
      txnDate: r.txn_date,
      threshold,
      reason: 'This journal entry has no supporting document attached — and journal entries bypass every other control, so their support matters most.',
      suggestion: 'Attach whatever justifies the entry: the depreciation schedule, loan statement, accrual worksheet, or the accountant’s instruction. An unsupported JE is the first thing a reviewer will question.',
    },
  }));
};
