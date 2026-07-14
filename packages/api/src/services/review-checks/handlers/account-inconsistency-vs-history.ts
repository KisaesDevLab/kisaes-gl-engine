// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { money, summaryLine } from './present.js';

// `account_inconsistency_vs_history` — the account-level twin of
// `tag_inconsistency_vs_history`: a recent journal line whose expense
// account is unusual for that vendor. Heuristic: the vendor has ≥5
// prior expense-side lines, one account dominates ≥80% of them, and
// the current line hits a different expense account. This is the
// classic "miscoding detector" — Staples suddenly coded to Meals.
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{
    transaction_id: string; journal_line_id: string; contact_id: string;
    used_account_id: string; dominant_account_id: string; share: number;
    txn_date: string; total: string; vendor_name: string | null;
    used_account: string | null; expected_account: string | null;
  }>(sql`
    WITH vendor_expense_history AS (
      SELECT t.contact_id, jl.account_id, COUNT(*) AS uses
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id
      JOIN accounts a ON a.id = jl.account_id
        AND a.account_type IN ('expense', 'cogs', 'other_expense')
      WHERE t.tenant_id = ${tenantId}
        ${companyClause}
        AND t.contact_id IS NOT NULL
        AND t.status = 'posted'
        AND t.created_at < now() - INTERVAL '7 days'  -- exclude very recent so dominant is stable
      GROUP BY t.contact_id, jl.account_id
    ),
    vendor_totals AS (
      SELECT contact_id, SUM(uses) AS total_uses
      FROM vendor_expense_history
      GROUP BY contact_id
      HAVING SUM(uses) >= 5
    ),
    dominant AS (
      SELECT DISTINCT ON (h.contact_id)
        h.contact_id, h.account_id AS dominant_account_id,
        h.uses::numeric / vt.total_uses AS share
      FROM vendor_expense_history h
      JOIN vendor_totals vt USING (contact_id)
      ORDER BY h.contact_id, h.uses DESC
    )
    SELECT
      t.id AS transaction_id,
      jl.id AS journal_line_id,
      t.contact_id,
      jl.account_id AS used_account_id,
      d.dominant_account_id,
      d.share,
      t.txn_date, t.total,
      vc.display_name AS vendor_name,
      ua.name AS used_account,
      da.name AS expected_account
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id
    JOIN accounts ua ON ua.id = jl.account_id
      AND ua.account_type IN ('expense', 'cogs', 'other_expense')
    JOIN dominant d ON d.contact_id = t.contact_id
      AND jl.account_id <> d.dominant_account_id
    JOIN accounts da ON da.id = d.dominant_account_id
    LEFT JOIN contacts vc ON vc.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      AND t.status = 'posted'
      AND t.created_at >= now() - INTERVAL '30 days'
      AND d.share >= 0.8
    LIMIT 500
  `);

  return (result.rows as Array<{
    transaction_id: string; journal_line_id: string; contact_id: string;
    used_account_id: string; dominant_account_id: string; share: number;
    txn_date: string; total: string; vendor_name: string | null;
    used_account: string | null; expected_account: string | null;
  }>).map((r) => {
    const sharePct = Math.round(Number(r.share) * 100);
    return {
      checkKey: 'account_inconsistency_vs_history',
      transactionId: r.transaction_id,
      vendorId: r.contact_id,
      payload: {
        summary: summaryLine(r.txn_date, r.vendor_name, money(r.total), r.used_account),
        vendorName: r.vendor_name,
        usedAccount: r.used_account,
        expectedAccount: r.expected_account,
        dominantShare: Number(r.share),
        reason: `${sharePct}% of ${r.vendor_name ?? 'this vendor'}'s expenses are coded to "${r.expected_account}", but this one went to "${r.used_account}".`,
        suggestion: `If this was a miscode, recategorize the line to "${r.expected_account}". If the vendor genuinely supplied something different this time, resolve with a note — that documents the exception for whoever reviews the books next.`,
        journalLineId: r.journal_line_id,
        // Line-level dedupe — the same odd line shouldn't re-flag
        // across runs, but a second odd line on the same txn should.
        dedupe_key: `line:${r.journal_line_id}`,
      },
    };
  });
};
