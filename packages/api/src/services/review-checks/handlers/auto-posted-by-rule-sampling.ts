// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';

// `auto_posted_by_rule_sampling` — sample N% of conditional-
// rule fires (Phase 4 audit) for human review. Default 10%.
// Helps the bookkeeper spot-check that the conditional rules
// engine is doing what they intended.
export const handler: CheckHandler = async (tenantId, _companyId, params): Promise<FindingDraft[]> => {
  const samplePercent = Math.max(0, Math.min(1, Number(params['samplePercent'] ?? 0.10)));

  // Random-sample fires from the last 30 days.
  const result = await db.execute<{ id: string; rule_id: string; bank_feed_item_id: string | null; transaction_id: string | null; matched_at: string }>(sql`
    SELECT id, rule_id, bank_feed_item_id, transaction_id, matched_at
    FROM conditional_rule_audit
    WHERE tenant_id = ${tenantId}
      AND matched_at > now() - INTERVAL '30 days'
      AND was_overridden = FALSE
      AND random() < ${samplePercent}
    LIMIT 500
  `);

  return (result.rows as Array<{ id: string; rule_id: string; bank_feed_item_id: string | null; transaction_id: string | null; matched_at: string }>).map((r) => ({
    checkKey: 'auto_posted_by_rule_sampling',
    transactionId: r.transaction_id,
    payload: {
      auditId: r.id,
      ruleId: r.rule_id,
      bankFeedItemId: r.bank_feed_item_id,
      matchedAt: r.matched_at,
      samplePercent,
      // Audit row id makes a stable dedupe key — sampling is
      // randomized so the natural transaction-id key would
      // re-fire across runs.
      dedupe_key: `audit:${r.id}`,
      reason: 'Sampled rule fire for spot-check.',
    },
  }));
};
