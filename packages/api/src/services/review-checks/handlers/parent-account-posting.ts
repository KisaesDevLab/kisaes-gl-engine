// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { money, summaryLine } from './present.js';

// `parent_account_posting` — flag any journal_line whose
// account is a parent (some other account references it via
// `parent_id`). Direct posting to a parent account is a common
// chart-of-accounts modeling mistake; the children won't roll
// up correctly.
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND jl.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{
    transaction_id: string; account_id: string; account_name: string;
    txn_date: string | null; total: string | null; txn_type: string | null; payee: string | null;
  }>(sql`
    SELECT DISTINCT jl.transaction_id, jl.account_id, a.name AS account_name,
      t.txn_date, t.total, t.txn_type, c.display_name AS payee
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE jl.tenant_id = ${tenantId}
      ${companyClause}
      AND EXISTS (
        SELECT 1 FROM accounts ch
        WHERE ch.parent_id = jl.account_id
          AND ch.tenant_id = ${tenantId}
      )
    LIMIT 1000
  `);

  return (result.rows as Array<{
    transaction_id: string; account_id: string; account_name: string;
    txn_date: string | null; total: string | null; txn_type: string | null; payee: string | null;
  }>).map((r) => ({
    checkKey: 'parent_account_posting',
    transactionId: r.transaction_id,
    payload: {
      summary: summaryLine(r.txn_date, r.payee ?? r.txn_type, r.total != null ? money(r.total) : null) || null,
      accountName: r.account_name,
      reason: `Posted directly to "${r.account_name}", which is a parent account with sub-accounts below it.`,
      suggestion: `Recode the line to the specific sub-account under "${r.account_name}" it belongs to. Parent-level postings don't roll up cleanly — reports end up mixing the parent's own activity with its children's subtotals.`,
      accountId: r.account_id,
    },
  }));
};
