// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Bank feed review buckets (U-174, feed-review-v1; review S11).
 *
 * One SQL builder serves GET /banking/feed?bucket= and GET
 * /banking/feed/counts, so the counts always equal the list totals. A
 * waiting row (pending or assigned) is in exactly one bucket, first match
 * wins:
 *
 *   1. review   a possible duplicate (the owner decides Keep both / Remove)
 *   2. matches  any match signal: a candidate journal line (U-166 predicate,
 *               payroll lines included), for money in one posted item
 *               waiting in Payments Clearing for exactly the amount within
 *               ±10 days (not deposited, not bounced), or the other side of
 *               a transfer: a waiting item on another GL account of the
 *               company with the exact opposite amount within ±3 days
 *               (feed-accept-v1, the transfer-candidates predicate of U-171)
 *   3. review   no account, a suggestion that isn't a rule's with a
 *               confidence under 0.80 (AI, history; a rule's mark_for_review
 *               stages 0.00), or a staged split that can't post (fixed lines
 *               that don't add up to |amount|, percentages that don't total
 *               exactly 100, an amount with more than 2 decimals)
 *   4. ready    everything else
 *
 * Rows that are not waiting (accepted, excluded, in progress) are in no
 * bucket; an accepted row whose entry was voided (entry_voided_at) is
 * "Accepted · Entry voided", never waiting.
 */

import { sql, type SQL } from 'drizzle-orm';
import { bankFeedItems } from '../db/schema/index.js';
import { lineCandidatePredicate } from './bank-feed-lines.js';

export const FEED_BUCKETS = ['ready', 'review', 'matches'] as const;
export type FeedBucket = (typeof FEED_BUCKETS)[number];

/** AI or history suggestions under this confidence wait in review (Q-P26i). */
export const REVIEW_CONFIDENCE = '0.80';
/** Payments Clearing window for the exact-item match signal (as deposit groupings, U-56). */
export const CLEARING_WINDOW_DAYS = 10;
/** Transfer-twin window (Q-P26l; GET /feed/:id/transfer-candidates' default). */
export const TRANSFER_WINDOW_DAYS = 3;

/** The item's bank GL account, from its connection. */
function bankAccountOf(tenantId: string): SQL {
  return sql`(SELECT bc.account_id FROM bank_connections bc
    WHERE bc.id = ${bankFeedItems.bankConnectionId} AND bc.tenant_id = ${tenantId})`;
}

/** A row is waiting for review. */
export function waitingSql(): SQL {
  return sql`${bankFeedItems.status} IN ('pending', 'assigned')`;
}

/** Any match signal on a waiting row (bucket "matches"). */
export function matchSignalSql(tenantId: string): SQL {
  const amount = sql`CAST(${bankFeedItems.amount} AS DECIMAL)`;
  const line = sql`EXISTS (
    SELECT 1 FROM journal_lines jl, transactions t
    WHERE ${lineCandidatePredicate({
      tenantId,
      bankAccountId: bankAccountOf(tenantId),
      amount: sql`${bankFeedItems.amount}`,
      feedDate: sql`${bankFeedItems.feedDate}`,
      itemId: sql`${bankFeedItems.id}`,
    })})`;
  const days = sql.raw(String(CLEARING_WINDOW_DAYS));
  const clearing = sql`(${amount} < 0 AND EXISTS (
    SELECT 1 FROM transactions pt
    WHERE pt.tenant_id = ${tenantId} AND pt.status = 'posted'
      AND pt.txn_date >= (${bankFeedItems.feedDate}::date - INTERVAL '${days} days')
      AND pt.txn_date <= (${bankFeedItems.feedDate}::date + INTERVAL '${days} days')
      AND (${bankFeedItems.companyId} IS NULL OR pt.company_id IS NULL OR pt.company_id = ${bankFeedItems.companyId})
      AND (SELECT SUM(pl.debit - pl.credit) FROM journal_lines pl
            JOIN accounts pa ON pa.id = pl.account_id AND pa.tenant_id = ${tenantId} AND pa.system_tag = 'payments_clearing'
            WHERE pl.tenant_id = ${tenantId} AND pl.transaction_id = pt.id AND pl.is_void_reversal = false) = ABS(${amount})
      AND NOT EXISTS (SELECT 1 FROM deposit_lines dl JOIN transactions d ON d.id = dl.deposit_id
        WHERE dl.source_transaction_id = pt.id AND d.tenant_id = ${tenantId} AND d.status = 'posted')
      AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.tenant_id = ${tenantId} AND r.source_txn_id = pt.id
        AND r.txn_type = 'returned_payment' AND r.status = 'posted')
  ))`;
  // The other side of a transfer (feed-accept-v1; U-171's candidate rule):
  // served by idx_bfi_waiting_amount (0269).
  const tdays = sql.raw(String(TRANSFER_WINDOW_DAYS));
  const transfer = sql`EXISTS (
    SELECT 1 FROM bank_feed_items o
    JOIN bank_connections oc ON oc.id = o.bank_connection_id AND oc.tenant_id = ${tenantId}
    WHERE o.tenant_id = ${tenantId} AND o.status IN ('pending', 'assigned')
      AND o.amount = -${bankFeedItems.amount}
      AND o.id <> ${bankFeedItems.id}
      AND oc.account_id IS DISTINCT FROM ${bankAccountOf(tenantId)}
      AND o.feed_date >= (${bankFeedItems.feedDate}::date - INTERVAL '${tdays} days')
      AND o.feed_date <= (${bankFeedItems.feedDate}::date + INTERVAL '${tdays} days')
      AND (${bankFeedItems.companyId} IS NULL OR o.company_id IS NULL OR o.company_id = ${bankFeedItems.companyId})
  )`;
  return sql`(${bankFeedItems.matchedTransactionId} IS NULL AND ${amount} <> 0 AND (${line} OR ${clearing} OR ${transfer}))`;
}

/** A staged split the posting would refuse (SPLITS_DONT_BALANCE, AMOUNT_NOT_CENTS). */
export function unbalancedSplitsSql(): SQL {
  const cfg = sql`${bankFeedItems.splitsConfig}`;
  const abs = sql`ABS(CAST(${bankFeedItems.amount} AS DECIMAL))`;
  const num = (field: string) => sql.raw(`CASE WHEN s->>'${field}' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (s->>'${field}')::numeric END`);
  const lines = sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${cfg}->'splits') = 'array' THEN ${cfg}->'splits' ELSE '[]'::jsonb END) s`;
  return sql`(${cfg} IS NOT NULL AND jsonb_typeof(${cfg}->'splits') = 'array' AND jsonb_array_length(${cfg}->'splits') > 0 AND (
    ${abs} <> ROUND(${abs}, 2)
    OR (${cfg}->>'kind' = 'fixed' AND COALESCE((SELECT CASE WHEN bool_and(${num('amount')} IS NOT NULL)
          THEN SUM(ROUND(${num('amount')}, 2)) END FROM ${lines}), -1) <> ${abs})
    OR (${cfg}->>'kind' = 'percentage' AND COALESCE((SELECT CASE WHEN bool_and(${num('percent')} IS NOT NULL AND ${num('percent')} >= 0)
          THEN SUM(${num('percent')}) END FROM ${lines}), -1) <> 100)
    OR (${cfg}->>'kind' NOT IN ('fixed', 'percentage'))
  ))`;
}

/** A waiting row the owner must look at (after duplicates and matches). */
export function needsReviewSql(): SQL {
  const staged = sql`${bankFeedItems.status} = 'assigned'`;
  const noAccount = sql`(CASE WHEN ${staged} THEN ${bankFeedItems.assignedAccountId} IS NULL
    ELSE ${bankFeedItems.suggestedAccountId} IS NULL AND ${bankFeedItems.splitsConfig} IS NULL END)`;
  const lowConfidence = sql`(NOT ${staged} AND ${bankFeedItems.matchType} IS DISTINCT FROM 'rule'
    AND (${bankFeedItems.confidenceScore} IS NULL OR ${bankFeedItems.confidenceScore} < ${REVIEW_CONFIDENCE}::numeric))`;
  return sql`(${noAccount} OR ${lowConfidence} OR ${unbalancedSplitsSql()})`;
}

/** The row's bucket, or NULL when it isn't waiting. */
export function bucketSql(tenantId: string): SQL<FeedBucket | null> {
  return sql<FeedBucket | null>`(CASE
    WHEN NOT (${waitingSql()}) THEN NULL
    WHEN ${bankFeedItems.possibleDuplicate} THEN 'review'
    WHEN ${matchSignalSql(tenantId)} THEN 'matches'
    WHEN ${needsReviewSql()} THEN 'review'
    ELSE 'ready' END)`;
}
