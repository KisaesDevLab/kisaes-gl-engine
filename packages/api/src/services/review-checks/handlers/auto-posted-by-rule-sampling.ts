// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { FindingDraft } from '@kis-books/shared';
import { db } from '../../../db/index.js';
import type { CheckHandler } from './index.js';
import { money, summaryLine } from './present.js';

// `auto_posted_by_rule_sampling` — sample N% of conditional-
// rule fires (Phase 4 audit) for human review. Default 10%.
// Helps the bookkeeper spot-check that the conditional rules
// engine is doing what they intended.
export const handler: CheckHandler = async (tenantId, _companyId, params): Promise<FindingDraft[]> => {
  const samplePercent = Math.max(0, Math.min(1, Number(params['samplePercent'] ?? 0.10)));

  // Random-sample fires from the last 30 days. Joins pull the human
  // context (rule name, bank line) so the reviewer can judge the fire
  // without chasing UUIDs.
  const result = await db.execute<{
    id: string; rule_id: string; bank_feed_item_id: string | null; transaction_id: string | null;
    matched_at: string; rule_name: string | null; feed_description: string | null;
    feed_amount: string | null; feed_date: string | null;
  }>(sql`
    SELECT cra.id, cra.rule_id, cra.bank_feed_item_id, cra.transaction_id, cra.matched_at,
      cr.name AS rule_name,
      b.description AS feed_description, b.amount AS feed_amount, b.feed_date
    FROM conditional_rule_audit cra
    LEFT JOIN conditional_rules cr ON cr.id = cra.rule_id
    LEFT JOIN bank_feed_items b ON b.id = cra.bank_feed_item_id
    WHERE cra.tenant_id = ${tenantId}
      AND cra.matched_at > now() - INTERVAL '30 days'
      AND cra.was_overridden = FALSE
      AND random() < ${samplePercent}
    LIMIT 500
  `);

  return (result.rows as Array<{
    id: string; rule_id: string; bank_feed_item_id: string | null; transaction_id: string | null;
    matched_at: string; rule_name: string | null; feed_description: string | null;
    feed_amount: string | null; feed_date: string | null;
  }>).map((r) => ({
    checkKey: 'auto_posted_by_rule_sampling',
    transactionId: r.transaction_id,
    payload: {
      summary: summaryLine(
        r.feed_date,
        r.feed_description,
        r.feed_amount != null ? money(r.feed_amount) : null,
      ) || null,
      ruleName: r.rule_name,
      reason: r.rule_name
        ? `Randomly sampled from the recent fires of rule "${r.rule_name}" so you can verify the automation is categorizing correctly.`
        : 'Randomly sampled from recent rule fires so you can verify the automation is categorizing correctly.',
      suggestion:
        'Open the transaction and confirm the rule posted it to the right category and tag. If it is wrong, correct the transaction, then edit the rule so future fires post correctly.',
      samplePercent,
      auditId: r.id,
      ruleId: r.rule_id,
      bankFeedItemId: r.bank_feed_item_id,
      matchedAt: r.matched_at,
      // Audit row id makes a stable dedupe key — sampling is
      // randomized so the natural transaction-id key would
      // re-fire across runs.
      dedupe_key: `audit:${r.id}`,
    },
  }));
};
