// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Suspense: posting into the holding account, and clearing back out of it.
//
// The suspense account is resolved by ROLE (accounts.system_tag='suspense'),
// never by name — see system-accounts.service.ts.
//
// NOTHING here writes posting code. Posting an unposted bank-feed line goes
// through bankFeedService.categorize/bulkCategorize; moving an already-posted
// amount out of suspense goes through ledger.bulkUpdateTransactions. Both
// already enforce lock dates, void/AJE skips, reconciliation safety, and the
// denormalised accounts.balance bookkeeping, and re-implementing any of that
// here would be a second source of truth for the ledger.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, journalLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { getSuspenseAccountId, findSystemAccountId, SUSPENSE_TAG } from './system-accounts.service.js';
import { bulkUpdateTransactions } from './ledger.service.js';
import * as bankFeedService from './bank-feed.service.js';

export { getSuspenseAccountId, SUSPENSE_TAG };

// ── Posting in ──────────────────────────────────────────────────

export interface PostToSuspenseResult {
  suspenseAccountId: string;
  posted: number;
  /** Rows that were not in `pending` status, so bulkCategorize ignored them. */
  skipped: Array<{ id: string; reason: string }>;
  failures: Array<{ id: string; error: string }>;
}

/**
 * Post pending bank-feed rows to suspense so the bank reconciles even though
 * nobody has classified them yet.
 *
 * bulkCategorize silently ignores any row that is not `pending` and does not
 * record it as a failure, so its count can come back lower than the selection
 * with no explanation. We resolve the statuses up front and report the skips
 * ourselves — a bookkeeper who selected rows already staged as `assigned`
 * needs to be told why they did not move.
 */
export async function postFeedItemsToSuspense(
  tenantId: string,
  feedItemIds: string[],
  userId?: string,
  companyId?: string,
): Promise<PostToSuspenseResult> {
  if (feedItemIds.length === 0) throw AppError.badRequest('Select at least one bank line.');

  const suspenseAccountId = await getSuspenseAccountId(tenantId, companyId, userId);

  const rows = await db.execute<{ id: string; status: string }>(sql`
    SELECT id, status FROM bank_feed_items
    WHERE tenant_id = ${tenantId}
      AND id IN (${sql.join(feedItemIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const statusById = new Map(
    (rows.rows as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
  );

  const skipped: PostToSuspenseResult['skipped'] = [];
  const eligible: string[] = [];
  for (const id of feedItemIds) {
    const status = statusById.get(id);
    if (!status) skipped.push({ id, reason: 'not_found_or_wrong_tenant' });
    else if (status !== 'pending') skipped.push({ id, reason: `already_${status}` });
    else eligible.push(id);
  }

  if (eligible.length === 0) {
    return { suspenseAccountId, posted: 0, skipped, failures: [] };
  }

  const res = await bankFeedService.bulkCategorize(
    tenantId, eligible, suspenseAccountId,
    undefined, undefined, null, userId, companyId,
  );
  return { suspenseAccountId, posted: res.categorized, skipped, failures: res.failures };
}

// ── Listing what is sitting there ───────────────────────────────

export interface SuspenseSummary {
  suspenseAccountId: string | null;
  /** Denormalised account balance, debit-positive. '0' when unassigned. */
  balance: string;
  /** Distinct posted, non-void transactions with a line in suspense. */
  transactionCount: number;
  /** Bank-feed rows still unposted (the pre-suspense backlog). */
  unpostedCount: number;
}

export async function getSuspenseSummary(tenantId: string, companyId?: string): Promise<SuspenseSummary> {
  // Read-only: never mint the account just because someone opened the page.
  const suspenseAccountId = await findSystemAccountId(tenantId, SUSPENSE_TAG);

  const companyClause = companyId ? sql`AND t.company_id = ${companyId}` : sql``;
  const feedCompanyClause = companyId ? sql`AND b.company_id = ${companyId}` : sql``;

  let balance = '0';
  let transactionCount = 0;
  if (suspenseAccountId) {
    const [acct] = await db.select({ balance: accounts.balance }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, suspenseAccountId)))
      .limit(1);
    balance = acct?.balance ?? '0';

    const counted = await db.execute<{ n: string }>(sql`
      SELECT COUNT(DISTINCT t.id)::text AS n
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
      WHERE t.tenant_id = ${tenantId}
        AND jl.account_id = ${suspenseAccountId}
        AND t.status <> 'void'
        ${companyClause}
    `);
    transactionCount = Number((counted.rows as Array<{ n: string }>)[0]?.n ?? '0');
  }

  const unposted = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM bank_feed_items b
    WHERE b.tenant_id = ${tenantId} AND b.status = 'pending' ${feedCompanyClause}
  `);

  return {
    suspenseAccountId,
    balance,
    transactionCount,
    unpostedCount: Number((unposted.rows as Array<{ n: string }>)[0]?.n ?? '0'),
  };
}

export interface SuspenseRow {
  transactionId: string;
  txnDate: string;
  txnType: string;
  txnNumber: string | null;
  memo: string | null;
  contactName: string | null;
  /** Signed suspense amount for this transaction: debit positive. */
  amount: string;
  /** >1 means a split with several suspense lines; they clear together. */
  suspenseLineCount: number;
  /** True when any suspense line on this transaction is a split sibling. */
  isSplit: boolean;
  source: string | null;
}

/**
 * Posted transactions carrying at least one line in suspense. Ordered newest
 * first. Offset/limit with a total, per the list-endpoint convention.
 */
export async function listInSuspense(
  tenantId: string,
  opts: { companyId?: string; startDate?: string; endDate?: string; search?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: SuspenseRow[]; total: number; suspenseAccountId: string | null }> {
  const suspenseAccountId = await findSystemAccountId(tenantId, SUSPENSE_TAG);
  if (!suspenseAccountId) return { rows: [], total: 0, suspenseAccountId: null };

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const companyClause = opts.companyId ? sql`AND t.company_id = ${opts.companyId}` : sql``;
  const startClause = opts.startDate ? sql`AND t.txn_date >= ${opts.startDate}` : sql``;
  const endClause = opts.endDate ? sql`AND t.txn_date <= ${opts.endDate}` : sql``;
  const searchClause = opts.search
    ? sql`AND (t.memo ILIKE ${'%' + opts.search + '%'} OR c.display_name ILIKE ${'%' + opts.search + '%'})`
    : sql``;

  const base = sql`
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = t.tenant_id
    WHERE t.tenant_id = ${tenantId}
      AND t.status <> 'void'
      AND EXISTS (
        SELECT 1 FROM journal_lines jl
        WHERE jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
          AND jl.account_id = ${suspenseAccountId}
      )
      ${companyClause} ${startClause} ${endClause} ${searchClause}
  `;

  const counted = await db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n ${base}`);
  const total = Number((counted.rows as Array<{ n: string }>)[0]?.n ?? '0');

  const res = await db.execute(sql`
    SELECT
      t.id                AS transaction_id,
      t.txn_date          AS txn_date,
      t.txn_type          AS txn_type,
      t.txn_number        AS txn_number,
      t.memo              AS memo,
      t.source            AS source,
      c.display_name      AS contact_name,
      (SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
         FROM journal_lines jl
        WHERE jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
          AND jl.account_id = ${suspenseAccountId})::text AS amount,
      (SELECT COUNT(*) FROM journal_lines jl
        WHERE jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
          AND jl.account_id = ${suspenseAccountId})::int AS suspense_line_count,
      (SELECT COUNT(*) FROM journal_lines jl
        WHERE jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id)::int AS total_line_count
    ${base}
    ORDER BY t.txn_date DESC, t.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const rows: SuspenseRow[] = (res.rows as Array<Record<string, unknown>>).map((r) => ({
    transactionId: String(r['transaction_id']),
    txnDate: String(r['txn_date']),
    txnType: String(r['txn_type']),
    txnNumber: (r['txn_number'] as string | null) ?? null,
    memo: (r['memo'] as string | null) ?? null,
    contactName: (r['contact_name'] as string | null) ?? null,
    amount: String(r['amount'] ?? '0'),
    suspenseLineCount: Number(r['suspense_line_count'] ?? 0),
    // A plain feed posting is 2 lines (bank + category). More than that means
    // the entry was split, which the UI flags because clearing sends every
    // suspense line to the SAME account.
    isSplit: Number(r['total_line_count'] ?? 0) > 2,
    source: (r['source'] as string | null) ?? null,
  }));

  return { rows, total, suspenseAccountId };
}

// ── Clearing out ────────────────────────────────────────────────

export interface ClearSuspenseResult {
  updated: number;
  skipped: Array<{ id: string; reason: string }>;
  targetAccountId: string;
}

/**
 * Move posted amounts out of suspense into a real category account.
 *
 * Uses bulkUpdateTransactions' SOURCE-MOVE arguments (moveFrom/moveTo), not
 * setCategoryAccountId. That matters: the category path only fires when a
 * transaction has exactly one category line and skips splits with
 * reason 'split', whereas the move path re-points every line sitting on the
 * from-account and is explicitly split-safe. Suspense lines are category
 * lines, so a split entry with two suspense lines clears in one call.
 *
 * Consequence to surface in the UI: one call sends EVERY suspense line on a
 * transaction to the same account. Splitting one suspense amount across
 * several categories needs the transaction editor.
 *
 * Modelled on acceptRuleException: the target is validated server-side and a
 * batch that moves nothing raises rather than reporting a silent success.
 */
export async function clearSuspense(
  tenantId: string,
  txnIds: string[],
  targetAccountId: string,
  userId?: string,
  companyId?: string,
): Promise<ClearSuspenseResult> {
  if (txnIds.length === 0) throw AppError.badRequest('Select at least one transaction.');
  if (txnIds.length > 500) throw AppError.badRequest('Clear at most 500 transactions at a time.');

  const suspenseAccountId = await findSystemAccountId(tenantId, SUSPENSE_TAG);
  if (!suspenseAccountId) {
    throw AppError.badRequest('This company has no suspense account.', 'SUSPENSE_NOT_CONFIGURED');
  }
  if (targetAccountId === suspenseAccountId) {
    throw AppError.badRequest('Pick a category other than the suspense account.', 'SUSPENSE_SELF_TARGET');
  }

  // Never trust the client's account id: it must belong to this tenant, be
  // active, and not be another system role (moving money onto A/R, A/P or a
  // clearing account from this screen is always a mistake).
  const [target] = await db.select({
    id: accounts.id, isActive: accounts.isActive,
    systemTag: accounts.systemTag, detailType: accounts.detailType,
  })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, targetAccountId)))
    .limit(1);
  if (!target) throw AppError.badRequest('Category account not found.', 'ACCOUNT_NOT_FOUND');
  if (!target.isActive) throw AppError.badRequest('That category account is inactive.', 'ACCOUNT_INACTIVE');
  if (target.systemTag) {
    throw AppError.badRequest(
      `"${target.systemTag}" is a system account and cannot be a category here.`,
      'SYSTEM_ACCOUNT_TARGET',
    );
  }

  const res = await bulkUpdateTransactions(
    tenantId,
    { txnIds, moveFromAccountId: suspenseAccountId, moveToAccountId: targetAccountId },
    userId,
    companyId,
  );

  if (res.updated === 0) {
    const reason = res.skipped[0]?.reason ?? 'unknown';
    throw AppError.unprocessableEntity(
      `Nothing could be moved out of suspense (${reason}).`,
      'SUSPENSE_CLEAR_SKIPPED',
      { skipped: res.skipped },
    );
  }

  return { updated: res.updated, skipped: res.skipped, targetAccountId };
}

/** True when this transaction still has a line in suspense. */
export async function hasSuspenseLine(tenantId: string, transactionId: string): Promise<boolean> {
  const suspenseAccountId = await findSystemAccountId(tenantId, SUSPENSE_TAG);
  if (!suspenseAccountId) return false;
  const [row] = await db.select({ id: journalLines.id })
    .from(journalLines)
    .innerJoin(transactions, eq(transactions.id, journalLines.transactionId))
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, transactionId),
      eq(journalLines.accountId, suspenseAccountId),
    ))
    .limit(1);
  return Boolean(row);
}
