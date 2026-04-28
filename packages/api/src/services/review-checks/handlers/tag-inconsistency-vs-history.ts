// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `tag_inconsistency_vs_history` — find a journal_line whose
// (account_id, tag_id) combination is rare for that vendor
// compared to its history. Heuristic: vendor has ≥5 prior
// transactions on this account, the dominant tag covers ≥80%
// of them, and the current line uses a different tag.
export const handler: CheckHandler = async (tenantId, companyId): Promise<FindingDraft[]> => {
  const companyClause = companyId
    ? sql`AND t.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{
    transaction_id: string;
    journal_line_id: string;
    contact_id: string;
    account_id: string;
    used_tag_id: string | null;
    dominant_tag_id: string | null;
    dominant_tag_share: number;
  }>(sql`
    WITH vendor_account_history AS (
      SELECT
        t.contact_id,
        jl.account_id,
        jl.tag_id,
        COUNT(*) AS uses
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id
      WHERE t.tenant_id = ${tenantId}
        ${companyClause}
        AND t.contact_id IS NOT NULL
        AND t.created_at < now() - INTERVAL '7 days'  -- exclude very recent so dominant is stable
      GROUP BY t.contact_id, jl.account_id, jl.tag_id
    ),
    vendor_account_totals AS (
      SELECT contact_id, account_id, SUM(uses) AS total_uses
      FROM vendor_account_history
      GROUP BY contact_id, account_id
      HAVING SUM(uses) >= 5
    ),
    dominant_tags AS (
      SELECT DISTINCT ON (h.contact_id, h.account_id)
        h.contact_id, h.account_id, h.tag_id AS dominant_tag_id,
        h.uses::numeric / vat.total_uses AS share
      FROM vendor_account_history h
      JOIN vendor_account_totals vat USING (contact_id, account_id)
      WHERE h.tag_id IS NOT NULL
      ORDER BY h.contact_id, h.account_id, h.uses DESC
    )
    SELECT
      t.id AS transaction_id,
      jl.id AS journal_line_id,
      t.contact_id,
      jl.account_id,
      jl.tag_id AS used_tag_id,
      d.dominant_tag_id,
      d.share AS dominant_tag_share
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id
    JOIN dominant_tags d ON d.contact_id = t.contact_id AND d.account_id = jl.account_id
    WHERE t.tenant_id = ${tenantId}
      ${companyClause}
      AND t.created_at >= now() - INTERVAL '30 days'
      AND d.share >= 0.8
      AND (jl.tag_id IS DISTINCT FROM d.dominant_tag_id)
    LIMIT 500
  `);

  return (result.rows as Array<{
    transaction_id: string; journal_line_id: string; contact_id: string;
    account_id: string; used_tag_id: string | null;
    dominant_tag_id: string | null; dominant_tag_share: number;
  }>).map((r) => ({
    checkKey: 'tag_inconsistency_vs_history',
    transactionId: r.transaction_id,
    vendorId: r.contact_id,
    payload: {
      journalLineId: r.journal_line_id,
      accountId: r.account_id,
      usedTagId: r.used_tag_id,
      expectedTagId: r.dominant_tag_id,
      dominantShare: Number(r.dominant_tag_share),
      reason: `Tag differs from vendor's dominant tag for this account (${Math.round(Number(r.dominant_tag_share) * 100)}% historical share).`,
    },
  }));
};
