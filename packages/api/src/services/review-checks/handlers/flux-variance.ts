// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler, CheckParams } from './index.js';
import { money, summaryLine } from './present.js';

// `flux_variance` — final-review flux analysis: each P&L account's
// activity in the close period vs. its trailing monthly average
// (up to 12 prior months, needs ≥3 to be meaningful). Flags moves
// that are BOTH ≥ `minPercent` (default 20%) of the average AND
// ≥ `minAmountDollars` (default $100) — the classic "why did rent
// double" / "where did revenue go" reviewer question. Requires a
// close period; a period-less run returns nothing.
export const handler: CheckHandler = async (tenantId, companyId, params: CheckParams): Promise<FindingDraft[]> => {
  const start = params.periodStart ?? null;
  const end = params.periodEnd ?? null;
  if (!start || !end) return [];
  const minDollars = Math.max(0, Number(params['minAmountDollars'] ?? 100));
  const minPercent = Math.max(0, Number(params['minPercent'] ?? 0.2));
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{
    account_id: string; account_name: string; account_type: string;
    current_net: string | null; avg_net: string; months: number;
  }>(sql`
    WITH monthly AS (
      SELECT jl.account_id,
        date_trunc('month', t.txn_date)::date AS month,
        SUM(jl.debit - jl.credit) AS net
      FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id
      JOIN accounts a ON a.id = jl.account_id
        AND a.account_type IN ('revenue', 'other_revenue', 'expense', 'cogs', 'other_expense')
      WHERE t.tenant_id = ${tenantId}
        ${companyClause}
        AND t.status = 'posted'
        AND t.txn_date >= (${start}::date - INTERVAL '12 months')
        AND t.txn_date < ${end}::date
      GROUP BY jl.account_id, date_trunc('month', t.txn_date)
    ),
    -- Align to month boundaries: a mid-month periodStart would leak
    -- the period's own month into the baseline and empty the current
    -- side. History is months strictly BEFORE the period's first
    -- month; the current side AVERAGES per month so a multi-month
    -- close window yields exactly one row per account (the dedupe
    -- key is per account+period).
    hist AS (
      SELECT account_id, AVG(net) AS avg_net, COUNT(*) AS months
      FROM monthly
      WHERE month < date_trunc('month', ${start}::date)::date
      GROUP BY account_id
      HAVING COUNT(*) >= 3
    ),
    cur AS (
      SELECT account_id, AVG(net) AS net
      FROM monthly
      WHERE month >= date_trunc('month', ${start}::date)::date
      GROUP BY account_id
    )
    SELECT h.account_id, a.name AS account_name, a.account_type,
      c.net AS current_net, h.avg_net, h.months
    FROM hist h
    LEFT JOIN cur c ON c.account_id = h.account_id
    JOIN accounts a ON a.id = h.account_id
    WHERE ABS(COALESCE(c.net, 0) - h.avg_net) >= ${minDollars}
      AND ABS(COALESCE(c.net, 0) - h.avg_net) >= ABS(h.avg_net) * ${minPercent}
    LIMIT 200
  `);

  return (result.rows as Array<{
    account_id: string; account_name: string; account_type: string;
    current_net: string | null; avg_net: string; months: number;
  }>).map((r) => {
    // debit − credit: expenses are positive, revenue negative. Show
    // reviewers magnitudes, which is how they think about activity.
    const current = Math.abs(Number(r.current_net ?? 0));
    const avg = Math.abs(Number(r.avg_net));
    const direction = current > avg ? 'up' : 'down';
    const pct = avg > 0 ? Math.round((Math.abs(current - avg) / avg) * 100) : null;
    return {
      checkKey: 'flux_variance',
      payload: {
        summary: summaryLine(r.account_name, `${money(current)} this period`, `${money(avg)} typical`),
        accountName: r.account_name,
        accountType: r.account_type,
        currentActivity: current,
        trailingAverage: avg,
        monthsOfHistory: r.months,
        reason: pct !== null
          ? `"${r.account_name}" is ${direction} ${pct}% from its trailing ${r.months}-month average (${money(current)} vs. the usual ${money(avg)}).`
          : `"${r.account_name}" shows ${money(current)} of activity this period after ${r.months} months of none.`,
        suggestion: 'Open the account and scan the period’s transactions. A real business change is worth a footnote for the client; a miscode, a duplicate, or a missing entry is worth fixing before the statements go out.',
        // Per account per period — next month is a fresh look.
        dedupe_key: `flux:${r.account_id}:${start}`,
      },
    };
  });
};
