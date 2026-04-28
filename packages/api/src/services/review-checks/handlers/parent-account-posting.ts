// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `parent_account_posting` — flag any journal_line whose
// account is a parent (some other account references it via
// `parent_id`). Direct posting to a parent account is a common
// chart-of-accounts modeling mistake; the children won't roll
// up correctly.
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND jl.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{ transaction_id: string; account_id: string; account_name: string }>(sql`
    SELECT DISTINCT jl.transaction_id, jl.account_id, a.name AS account_name
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    WHERE jl.tenant_id = ${tenantId}
      ${companyClause}
      AND EXISTS (
        SELECT 1 FROM accounts c
        WHERE c.parent_id = jl.account_id
          AND c.tenant_id = ${tenantId}
      )
    LIMIT 1000
  `);

  return (result.rows as Array<{ transaction_id: string; account_id: string; account_name: string }>).map((r) => ({
    checkKey: 'parent_account_posting',
    transactionId: r.transaction_id,
    payload: {
      accountId: r.account_id,
      accountName: r.account_name,
      reason: 'Posted directly to a parent account; children exist below it.',
    },
  }));
};
