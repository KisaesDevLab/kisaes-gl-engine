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
 *               company with the exact opposite amount within ±3 days, or
 *               the caller's transferWindowDays (1-10, feed-transfer-window-v1)
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
/** The largest transferWindowDays GET /feed and /feed/counts take (feed-transfer-window-v1, U-177). */
export const TRANSFER_WINDOW_DAYS_MAX = 10;

/**
 * The transfer window in days: an integer 1..TRANSFER_WINDOW_DAYS_MAX, else
 * the default. It is spliced into SQL as a literal, so anything else is
 * never used.
 */
export function transferWindowDays(days?: number | null): number {
  return typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= TRANSFER_WINDOW_DAYS_MAX
    ? days : TRANSFER_WINDOW_DAYS;
}

/** The item's bank GL account, from its connection. */
function bankAccountOf(tenantId: string): SQL {
  return sql`(SELECT bc.account_id FROM bank_connections bc
    WHERE bc.id = ${bankFeedItems.bankConnectionId} AND bc.tenant_id = ${tenantId})`;
}

/** A row is waiting for review. */
export function waitingSql(): SQL {
  return sql`${bankFeedItems.status} IN ('pending', 'assigned')`;
}

/** Any match signal on a waiting row (bucket "matches"); `windowDays` is the transfer window (default 3). */
export function matchSignalSql(tenantId: string, windowDays?: number): SQL {
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
  // served by idx_bfi_waiting_amount (0268).
  // The uncorrelated IN runs once as a hashed subplan, so a row without any
  // waiting opposite amount never reaches the correlated EXISTS (20k-row
  // counts stay fast even before the table is analyzed).
  const transfer = sql`(-${bankFeedItems.amount}) IN (
    SELECT o2.amount FROM bank_feed_items o2 WHERE o2.tenant_id = ${tenantId} AND o2.status IN ('pending', 'assigned')
  ) AND EXISTS (
    SELECT 1 FROM bank_feed_items o
    JOIN bank_connections oc ON oc.id = o.bank_connection_id AND oc.tenant_id = ${tenantId}
    WHERE ${transferTwinWhere(tenantId, bankAccountOf(tenantId), windowDays)}
  )`;
  return sql`(${bankFeedItems.matchedTransactionId} IS NULL AND ${amount} <> 0 AND (${line} OR ${clearing} OR ${transfer}))`;
}

/**
 * WHERE conditions for `o` (bank_feed_items) joined to `oc` (its
 * bank_connections row) being the other side of a transfer of the outer
 * bank_feed_items row (feed-accept-v1; U-171's transfer-candidates rule at
 * its default window): waiting, the exact opposite amount, another GL
 * account than `bankAccountId` (the outer row's), within
 * `windowDays` (TRANSFER_WINDOW_DAYS by default; feed-transfer-window-v1),
 * the same company. The "matches" bucket and the list's transferCandidate
 * both use it, so they never disagree at the same window.
 */
export function transferTwinWhere(tenantId: string, bankAccountId: SQL, windowDays?: number): SQL {
  const tdays = sql.raw(String(transferWindowDays(windowDays)));
  return sql`o.tenant_id = ${tenantId} AND o.status IN ('pending', 'assigned')
      AND o.amount = -${bankFeedItems.amount}
      AND o.id <> ${bankFeedItems.id}
      AND oc.account_id IS DISTINCT FROM ${bankAccountId}
      AND o.feed_date >= (${bankFeedItems.feedDate}::date - INTERVAL '${tdays} days')
      AND o.feed_date <= (${bankFeedItems.feedDate}::date + INTERVAL '${tdays} days')
      AND (${bankFeedItems.companyId} IS NULL OR o.company_id IS NULL OR o.company_id = ${bankFeedItems.companyId})`;
}

/**
 * The list row's transfer signal (feed-accept-v1, Q-P26y): on a waiting,
 * unmatched, non-zero row, {feedItemId, accountId, accountName} of the other
 * side when exactly one exists (transferTwinWhere), else null. `bankAccountId`
 * is the outer row's bank GL account as the list query joins it. Runs per
 * listed row only (a page), never in /counts.
 */
export function transferCandidateSql(tenantId: string, bankAccountId: SQL, windowDays?: number): SQL<{ feedItemId: string; accountId: string; accountName: string } | null> {
  return sql<{ feedItemId: string; accountId: string; accountName: string } | null>`(
    CASE WHEN ${waitingSql()} AND ${bankFeedItems.matchedTransactionId} IS NULL
          AND ${bankAccountId} IS NOT NULL AND CAST(${bankFeedItems.amount} AS DECIMAL) <> 0
    THEN (
      SELECT CASE WHEN COUNT(*) = 1 THEN json_build_object(
          'feedItemId', MIN(tc.id::text), 'accountId', MIN(tc.account_id::text), 'accountName', MIN(tc.account_name)) END
      FROM (
        SELECT o.id, oa.id AS account_id, oa.name AS account_name
        FROM bank_feed_items o
        JOIN bank_connections oc ON oc.id = o.bank_connection_id AND oc.tenant_id = ${tenantId}
        LEFT JOIN accounts oa ON oa.id = oc.account_id AND oa.tenant_id = ${tenantId}
        WHERE ${transferTwinWhere(tenantId, bankAccountId, windowDays)}
        LIMIT 2
      ) tc
    ) END
  )`;
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

/** The row's bucket, or NULL when it isn't waiting; `windowDays` is the transfer window (default 3). */
export function bucketSql(tenantId: string, windowDays?: number): SQL<FeedBucket | null> {
  return sql<FeedBucket | null>`(CASE
    WHEN NOT (${waitingSql()}) THEN NULL
    WHEN ${bankFeedItems.possibleDuplicate} THEN 'review'
    WHEN ${matchSignalSql(tenantId, windowDays)} THEN 'matches'
    WHEN ${needsReviewSql()} THEN 'review'
    ELSE 'ready' END)`;
}
