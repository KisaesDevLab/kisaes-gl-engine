// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Close Review → Bank feed, the reviewer pass. The bucket workflow only
// lists bank-feed items that are still uncategorized, and in practice the
// categorizing happens on the Banking screen before a reviewer opens the
// close — so the buckets are empty by then. This service lists the month's
// items that are already DONE (categorized / matched / excluded), says how
// each one got its category, and records the reviewer's "Looks right" mark
// (bank_feed_items.close_reviewed_at, migration 0188).

import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog as auditLogTable } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { sortDirSql } from '../utils/list-query.js';
import { bulkUpdateTransactions } from './ledger.service.js';
import { recordUserDecision } from './ai-categorization.service.js';

export const FEED_REVIEW_METHODS = [
  'rule', 'ai', 'history', 'check_image', 'manual', 'matched', 'excluded',
] as const;
export type FeedReviewMethod = (typeof FEED_REVIEW_METHODS)[number];
export type FeedReviewStatus = 'todo' | 'reviewed' | 'all';
export const FEED_REVIEW_SORT_KEYS = [
  'feedDate', 'description', 'payee', 'category', 'method', 'amount', 'reviewed',
] as const;
export type FeedReviewSortKey = (typeof FEED_REVIEW_SORT_KEYS)[number];

const DONE_STATUSES = sql`('categorized', 'matched', 'excluded')`;

export interface FeedReviewScope {
  companyId: string | null;
  periodStart: string;
  periodEnd: string;
}

function companyCond(companyId: string | null): SQL {
  return companyId ? sql`AND f.company_id = ${companyId}` : sql``;
}

// One row per done feed item in the period, with how it was coded. The
// category is the posted transaction's line(s) off the bank's own GL
// account; one such line → that account, several → a split.
//
// Method: excluded / matched come straight from the feed status. For a
// categorized item, a posted category that differs from the suggestion (or
// no suggestion at all) means a person chose it; otherwise the suggestion's
// source (match_type) says what coded it.
function doneItemsCte(tenantId: string, scope: FeedReviewScope): SQL {
  return sql`
    WITH done AS (
      SELECT
        f.id, f.feed_date, f.description, f.amount, f.status, f.memo,
        f.close_reviewed_at, f.matched_transaction_id,
        f.suggested_account_id,
        bc.institution_name, bc.mask, ba.name AS bank_account_name,
        t.txn_type, t.status AS txn_status, t.contact_id,
        co.display_name AS payee_name,
        cat.n AS category_count,
        CASE WHEN cat.n = 1 THEN cat.account_id END AS category_account_id,
        CASE
          WHEN f.status = 'excluded' THEN 'excluded'
          WHEN f.status = 'matched' THEN 'matched'
          WHEN f.suggested_account_id IS NULL THEN 'manual'
          WHEN cat.n = 1 AND cat.account_id <> f.suggested_account_id THEN 'manual'
          WHEN f.match_type = 'rule' THEN 'rule'
          WHEN f.match_type = 'history' THEN 'history'
          WHEN f.match_type = 'check_image' THEN 'check_image'
          ELSE 'ai'
        END AS method
      FROM bank_feed_items f
      JOIN bank_connections bc ON bc.id = f.bank_connection_id
      LEFT JOIN accounts ba ON ba.id = bc.account_id
      LEFT JOIN transactions t ON t.id = f.matched_transaction_id AND t.tenant_id = f.tenant_id
      LEFT JOIN contacts co ON co.id = t.contact_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n, MIN(jl.account_id::text)::uuid AS account_id
        FROM journal_lines jl
        WHERE jl.tenant_id = f.tenant_id
          AND jl.transaction_id = t.id
          AND jl.account_id IS DISTINCT FROM bc.account_id
          AND COALESCE(jl.is_void_reversal, false) = false
      ) cat ON true
      WHERE f.tenant_id = ${tenantId}
        ${companyCond(scope.companyId)}
        AND f.status IN ${DONE_STATUSES}
        AND f.feed_date >= ${scope.periodStart.slice(0, 10)}::date
        AND f.feed_date < ${scope.periodEnd.slice(0, 10)}::date
    )
  `;
}

export interface FeedReviewSummary {
  /** Feed items dated in the period, any status. */
  periodTotal: number;
  /** Still uncategorized (pending / assigned) in the period. */
  periodOpen: number;
  /** Done items in the period, and how many of them are reviewed. */
  doneTotal: number;
  reviewed: number;
  byMethod: Record<FeedReviewMethod, { total: number; reviewed: number }>;
  /** Whether this client has ever had a bank-feed item (any date). */
  hasBankFeed: boolean;
  /** Uncategorized items OUTSIDE the period, newest month first. */
  otherMonthsOpen: Array<{ month: string; count: number }>;
}

export async function summarize(tenantId: string, scope: FeedReviewScope): Promise<FeedReviewSummary> {
  const byMethod = Object.fromEntries(
    FEED_REVIEW_METHODS.map((m) => [m, { total: 0, reviewed: 0 }]),
  ) as FeedReviewSummary['byMethod'];

  const methodRows = await db.execute<{ method: FeedReviewMethod; total: number; reviewed: number }>(sql`
    ${doneItemsCte(tenantId, scope)}
    SELECT method, COUNT(*)::int AS total, COUNT(close_reviewed_at)::int AS reviewed
    FROM done GROUP BY method
  `);
  let doneTotal = 0;
  let reviewed = 0;
  for (const r of methodRows.rows as Array<{ method: FeedReviewMethod; total: number; reviewed: number }>) {
    if (!(FEED_REVIEW_METHODS as readonly string[]).includes(r.method)) continue;
    byMethod[r.method] = { total: Number(r.total), reviewed: Number(r.reviewed) };
    doneTotal += Number(r.total);
    reviewed += Number(r.reviewed);
  }

  const start = scope.periodStart.slice(0, 10);
  const end = scope.periodEnd.slice(0, 10);
  const counts = await db.execute<{ period_total: number; period_open: number; any_feed: boolean }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE f.feed_date >= ${start}::date AND f.feed_date < ${end}::date)::int AS period_total,
      COUNT(*) FILTER (
        WHERE f.feed_date >= ${start}::date AND f.feed_date < ${end}::date
          AND f.status IN ('pending', 'assigned')
      )::int AS period_open,
      COUNT(*) > 0 AS any_feed
    FROM bank_feed_items f
    WHERE f.tenant_id = ${tenantId} ${companyCond(scope.companyId)}
  `);
  const c = counts.rows[0] as { period_total: number; period_open: number; any_feed: boolean } | undefined;

  const other = await db.execute<{ month: string; count: number }>(sql`
    SELECT to_char(date_trunc('month', f.feed_date), 'YYYY-MM') AS month, COUNT(*)::int AS count
    FROM bank_feed_items f
    WHERE f.tenant_id = ${tenantId} ${companyCond(scope.companyId)}
      AND f.status IN ('pending', 'assigned')
      AND (f.feed_date < ${start}::date OR f.feed_date >= ${end}::date)
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 12
  `);

  return {
    periodTotal: Number(c?.period_total ?? 0),
    periodOpen: Number(c?.period_open ?? 0),
    doneTotal,
    reviewed,
    byMethod,
    hasBankFeed: Boolean(c?.any_feed),
    otherMonthsOpen: (other.rows as Array<{ month: string; count: number }>).map((r) => ({
      month: r.month, count: Number(r.count),
    })),
  };
}

export interface FeedReviewRow {
  feedItemId: string;
  feedDate: string;
  description: string | null;
  amount: string;
  status: string;
  method: FeedReviewMethod;
  bankAccountName: string | null;
  institutionName: string | null;
  mask: string | null;
  transactionId: string | null;
  txnType: string | null;
  txnVoid: boolean;
  payeeContactId: string | null;
  payeeName: string | null;
  /** Posted category when the transaction has exactly one. */
  categoryAccountId: string | null;
  categoryAccountName: string | null;
  /** Lines off the bank account: 0 = none (excluded), >1 = split. */
  categoryCount: number;
  /** The suggestion, shown when a person overrode it. */
  suggestedAccountName: string | null;
  reviewedAt: string | null;
}

export async function list(
  tenantId: string,
  scope: FeedReviewScope & {
    method?: FeedReviewMethod;
    status?: FeedReviewStatus;
    sortBy?: FeedReviewSortKey;
    sortDir?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
  },
): Promise<{ rows: FeedReviewRow[]; total: number }> {
  const limit = Math.min(Math.max(scope.limit ?? 100, 1), 500);
  const offset = Math.max(scope.offset ?? 0, 0);
  const conds: SQL[] = [sql`true`];
  if (scope.method) conds.push(sql`d.method = ${scope.method}`);
  if (scope.status === 'todo') conds.push(sql`d.close_reviewed_at IS NULL`);
  if (scope.status === 'reviewed') conds.push(sql`d.close_reviewed_at IS NOT NULL`);
  const where = sql.join(conds, sql` AND `);

  // Server-side sort (the list pages by offset, so a client sort would only
  // order the loaded rows). Amount sorts by the displayed sign: money in is
  // positive. Blanks last, then newest first as a stable tiebreak.
  const dir = sortDirSql(scope.sortDir);
  let sortExpr: SQL | null = null;
  switch (scope.sortBy) {
    case 'feedDate': sortExpr = sql`d.feed_date`; break;
    case 'description': sortExpr = sql`LOWER(d.description)`; break;
    case 'payee': sortExpr = sql`LOWER(d.payee_name)`; break;
    case 'category': sortExpr = sql`LOWER(ca.name)`; break;
    case 'method': sortExpr = sql`d.method`; break;
    case 'amount': sortExpr = sql`(-CAST(d.amount AS DECIMAL))`; break;
    case 'reviewed': sortExpr = sql`d.close_reviewed_at`; break;
    default: sortExpr = null;
  }
  const orderBy = sortExpr
    ? sql`${sortExpr} ${dir} NULLS LAST, d.feed_date DESC, d.id`
    : sql`d.feed_date DESC, d.id`;

  const res = await db.execute(sql`
    ${doneItemsCte(tenantId, scope)}
    SELECT d.*, ca.name AS category_account_name, ca.account_number AS category_account_number,
      sa.name AS suggested_account_name,
      COUNT(*) OVER ()::int AS total_count
    FROM done d
    LEFT JOIN accounts ca ON ca.id = d.category_account_id
    LEFT JOIN accounts sa ON sa.id = d.suggested_account_id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `);

  const rows = res.rows as Array<Record<string, unknown>>;
  const total = rows.length > 0 ? Number(rows[0]!['total_count']) : 0;
  return {
    total,
    rows: rows.map((r) => {
      const method = r['method'] as FeedReviewMethod;
      const catName = r['category_account_name'] as string | null;
      const catNumber = r['category_account_number'] as string | null;
      return {
        feedItemId: r['id'] as string,
        feedDate: String(r['feed_date']).slice(0, 10),
        description: (r['description'] as string | null) ?? null,
        amount: String(r['amount']),
        status: r['status'] as string,
        method,
        bankAccountName: (r['bank_account_name'] as string | null) ?? null,
        institutionName: (r['institution_name'] as string | null) ?? null,
        mask: (r['mask'] as string | null) ?? null,
        transactionId: (r['matched_transaction_id'] as string | null) ?? null,
        txnType: (r['txn_type'] as string | null) ?? null,
        txnVoid: r['txn_status'] === 'void',
        payeeContactId: (r['contact_id'] as string | null) ?? null,
        payeeName: (r['payee_name'] as string | null) ?? null,
        categoryAccountId: (r['category_account_id'] as string | null) ?? null,
        categoryAccountName: catName ? (catNumber ? `${catNumber} · ${catName}` : catName) : null,
        categoryCount: Number(r['category_count'] ?? 0),
        suggestedAccountName: method === 'manual'
          ? ((r['suggested_account_name'] as string | null) ?? null)
          : null,
        reviewedAt: r['close_reviewed_at'] ? new Date(r['close_reviewed_at'] as string).toISOString() : null,
      };
    }),
  };
}

const MAX_IDS = 500;

// One audit row PER item (entity_id = the feed item), so a transaction's
// Activity card can show who reviewed it and when. `via` says which Close
// Review action set the mark.
async function auditMarks(
  tenantId: string,
  userId: string | undefined,
  feedItemIds: string[],
  reviewed: boolean,
  via: 'mark' | 'approve' | 'recategorize',
): Promise<void> {
  if (feedItemIds.length === 0) return;
  await db.insert(auditLogTable).values(feedItemIds.map((id) => ({
    tenantId,
    action: 'update',
    entityType: 'close_feed_review',
    entityId: id,
    beforeData: null,
    afterData: JSON.stringify({ reviewed, via }),
    userId: userId ?? null,
  })));
}

// "Looks right" (reviewed = true) or undo (false). Only done items can be
// marked — an uncategorized item has nothing to review yet.
export async function setReviewed(
  tenantId: string,
  userId: string,
  feedItemIds: string[],
  reviewed: boolean,
  companyId: string | null,
): Promise<{ updated: number }> {
  if (feedItemIds.length === 0) return { updated: 0 };
  if (feedItemIds.length > MAX_IDS) throw AppError.badRequest(`Mark at most ${MAX_IDS} items at a time.`);
  const ids = sql.join(feedItemIds.map((id) => sql`${id}::uuid`), sql`, `);
  const res = await db.execute<{ id: string }>(sql`
    UPDATE bank_feed_items f
    SET close_reviewed_at = ${reviewed ? sql`now()` : sql`NULL`},
        close_reviewed_by = ${reviewed ? sql`${userId}::uuid` : sql`NULL`}
    WHERE f.tenant_id = ${tenantId}
      ${companyCond(companyId)}
      AND f.id IN (${ids})
      AND f.status IN ${DONE_STATUSES}
    RETURNING f.id
  `);
  const changed = (res.rows as Array<{ id: string }>).map((r) => r.id);
  await auditMarks(tenantId, userId, changed, reviewed, 'mark');
  return { updated: changed.length };
}

// Stamp items a reviewer finished inside Close Review itself (bucket
// approve, recategorize), so they count as reviewed without a second click.
export async function markReviewedByIds(
  tenantId: string,
  userId: string | undefined,
  feedItemIds: string[],
  via: 'approve' | 'recategorize' = 'approve',
): Promise<void> {
  if (feedItemIds.length === 0) return;
  const ids = sql.join(feedItemIds.map((id) => sql`${id}::uuid`), sql`, `);
  const res = await db.execute<{ id: string }>(sql`
    UPDATE bank_feed_items
    SET close_reviewed_at = now(), close_reviewed_by = ${userId ?? null}
    WHERE tenant_id = ${tenantId} AND id IN (${ids}) AND close_reviewed_at IS NULL
    RETURNING id
  `);
  await auditMarks(tenantId, userId, (res.rows as Array<{ id: string }>).map((r) => r.id), true, via);
}

// Recategorize from the review list: re-point the posted transaction's
// single category line (and/or its payee) via the ledger's bulk update, teach
// the payee history the correction, and mark the items reviewed. Splits,
// excluded items and locked periods come back as skipped, never forced.
export async function recategorize(
  tenantId: string,
  userId: string,
  input: { feedItemIds: string[]; accountId?: string; contactId?: string },
  companyId: string | null,
): Promise<{ updated: number; skipped: Array<{ feedItemId: string; reason: string }> }> {
  const { feedItemIds, accountId, contactId } = input;
  if (feedItemIds.length === 0) throw AppError.badRequest('Select at least one transaction.');
  if (feedItemIds.length > MAX_IDS) throw AppError.badRequest(`Recategorize at most ${MAX_IDS} at a time.`);
  if (!accountId && !contactId) throw AppError.badRequest('Pick a category or a payee.');

  const ids = sql.join(feedItemIds.map((id) => sql`${id}::uuid`), sql`, `);
  const res = await db.execute<{ id: string; matched_transaction_id: string | null; status: string }>(sql`
    SELECT f.id, f.matched_transaction_id, f.status
    FROM bank_feed_items f
    WHERE f.tenant_id = ${tenantId} ${companyCond(companyId)} AND f.id IN (${ids})
  `);
  const items = res.rows as Array<{ id: string; matched_transaction_id: string | null; status: string }>;

  const skipped: Array<{ feedItemId: string; reason: string }> = [];
  const found = new Set(items.map((i) => i.id));
  for (const id of feedItemIds) if (!found.has(id)) skipped.push({ feedItemId: id, reason: 'not_found' });

  const feedByTxn = new Map<string, string>();
  for (const item of items) {
    if (item.status === 'excluded') { skipped.push({ feedItemId: item.id, reason: 'excluded' }); continue; }
    if (!item.matched_transaction_id) { skipped.push({ feedItemId: item.id, reason: 'not_posted' }); continue; }
    feedByTxn.set(item.matched_transaction_id, item.id);
  }
  if (feedByTxn.size === 0) return { updated: 0, skipped };

  const result = await bulkUpdateTransactions(
    tenantId,
    {
      txnIds: [...feedByTxn.keys()],
      ...(accountId ? { setCategoryAccountId: accountId } : {}),
      ...(contactId ? { setPayeeContactId: contactId } : {}),
    },
    userId,
    companyId ?? undefined,
  );

  const skippedTxns = new Set(result.skipped.map((s) => s.id));
  for (const s of result.skipped) {
    const feedItemId = feedByTxn.get(s.id);
    if (feedItemId) skipped.push({ feedItemId, reason: s.reason });
  }
  const changed = [...feedByTxn.entries()].filter(([txnId]) => !skippedTxns.has(txnId)).map(([, f]) => f);

  // Teach the payee history the reviewer's correction. Best-effort: the
  // ledger change is already committed and must not be reported as failed.
  if (accountId) {
    for (const feedItemId of changed) {
      try {
        await recordUserDecision(tenantId, feedItemId, accountId, contactId ?? null, false, true);
      } catch { /* learning is advisory */ }
    }
  }
  await markReviewedByIds(tenantId, userId, changed, 'recategorize');

  return { updated: changed.length, skipped };
}
