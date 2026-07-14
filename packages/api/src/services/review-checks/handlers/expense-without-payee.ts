// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { periodDateClause } from './period.js';
import { money, summaryLine } from './present.js';

// `expense_without_payee` — posted expenses/checks with no vendor on
// them. The customer-side twin is `missing_required_customer`; this is
// the vendor half: payee-less spending breaks vendor reports, 1099
// tracking, and every history-based check (duplicates, miscoding).
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND company_id = ${companyId}`
    : sql``;
  const periodClause = periodDateClause(params, 'txn_date');

  const result = await db.execute<{ id: string; txn_type: string; total: string; txn_date: string; memo: string | null }>(sql`
    SELECT id, txn_type, total, txn_date, memo
    FROM transactions
    WHERE tenant_id = ${tenantId}
      ${companyClause}
      ${periodClause}
      AND txn_type IN ('expense', 'check')
      AND status = 'posted'
      AND contact_id IS NULL
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; txn_type: string; total: string; txn_date: string; memo: string | null }>).map((r) => ({
    checkKey: 'expense_without_payee',
    transactionId: r.id,
    payload: {
      summary: summaryLine(r.txn_date, r.memo ?? r.txn_type, money(r.total)),
      txnType: r.txn_type,
      total: r.total,
      txnDate: r.txn_date,
      reason: `This ${r.txn_type} has no payee — nobody is recorded as having been paid.`,
      suggestion: 'Open the transaction and assign the vendor. Payee-less spending disappears from vendor reports and 1099 totals, and the duplicate/miscoding checks can’t protect transactions they can’t attribute.',
    },
  }));
};
