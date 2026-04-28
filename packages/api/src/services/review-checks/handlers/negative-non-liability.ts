// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `negative_non_liability` — accounts with negative balances
// where a negative balance is unusual. Asset accounts going
// negative typically indicate over-applied payments or
// double-entry mistakes. Revenue/expense accounts negative
// usually indicate posting reversal issues.
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{ id: string; name: string; account_type: string; balance: string }>(sql`
    SELECT id, name, account_type, balance
    FROM accounts
    WHERE tenant_id = ${tenantId}
      ${companyClause}
      AND is_active = TRUE
      AND balance::NUMERIC < 0
      AND account_type IN ('asset', 'expense', 'revenue', 'cogs', 'other_expense')
    LIMIT 200
  `);

  return (result.rows as Array<{ id: string; name: string; account_type: string; balance: string }>).map((r) => ({
    checkKey: 'negative_non_liability',
    payload: {
      accountId: r.id,
      accountName: r.name,
      accountType: r.account_type,
      balance: r.balance,
      // Per-account dedupe — re-fires on next run only if the
      // negative balance persists.
      dedupe_key: `account:${r.id}`,
      reason: `${r.account_type} account "${r.name}" has negative balance ${r.balance}.`,
    },
  }));
};
