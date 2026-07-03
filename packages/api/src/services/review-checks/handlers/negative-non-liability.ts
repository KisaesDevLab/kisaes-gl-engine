// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `negative_non_liability` — accounts carrying an ABNORMAL balance for
// their type. accounts.balance is stored debit−credit for every type,
// so a HEALTHY revenue account is negative in this column (invoice: CR
// revenue). The previous version flagged `balance < 0` for revenue too,
// which fired on every revenue account with any sales. Abnormal means:
//   debit-normal (asset, expense, cogs, other_expense): balance < 0
//   credit-normal income (revenue, other_revenue):      balance > 0
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
      AND (
        (account_type IN ('asset', 'expense', 'cogs', 'other_expense') AND balance::NUMERIC < 0)
        OR (account_type IN ('revenue', 'other_revenue') AND balance::NUMERIC > 0)
      )
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
      // abnormal balance persists.
      dedupe_key: `account:${r.id}`,
      reason: `${r.account_type} account "${r.name}" has an abnormal balance (${r.balance}).`,
    },
  }));
};
