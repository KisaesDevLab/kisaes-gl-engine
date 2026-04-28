// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `uncategorized_stale` — bank-feed item still in `pending`
// status N days after ingestion. Default 14 days.
export const handler: CheckHandler = async (tenantId, companyId, params): Promise<FindingDraft[]> => {
  const olderThanDays = Number(params['olderThanDays'] ?? 14);
  const companyClause = companyId
    ? sql`AND b.company_id = ${companyId}`
    : sql``;

  const result = await db.execute<{ id: string; description: string | null; amount: string; feed_date: string }>(sql`
    SELECT b.id, b.description, b.amount, b.feed_date
    FROM bank_feed_items b
    WHERE b.tenant_id = ${tenantId}
      ${companyClause}
      AND b.status = 'pending'
      AND b.created_at < now() - (${olderThanDays}::INT || ' days')::INTERVAL
    LIMIT 1000
  `);

  return (result.rows as Array<{ id: string; description: string | null; amount: string; feed_date: string }>).map((r) => ({
    checkKey: 'uncategorized_stale',
    payload: {
      bankFeedItemId: r.id,
      description: r.description,
      amount: r.amount,
      feedDate: r.feed_date,
      olderThanDays,
      // Use the feed item id as dedupe key — there's no
      // matching transaction yet for this finding shape.
      dedupe_key: `bank_feed_item:${r.id}`,
      reason: `Bank-feed item pending for >${olderThanDays} days.`,
    },
  }));
};
