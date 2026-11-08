// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { resolveCompanyForConnection } from './feed-item-company.service.js';
import { eq, and, sql, count, inArray, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { BankFeedFilters, CategorizeInput, CsvColumnMapping, FeedSplitLine } from '@kis-books/shared';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { bankFeedItems, bankConnections, accounts, transactions, journalLines, contacts, tags, transactionTags as transactionTagsTable } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import { cleanBankDescription } from '../utils/bank-name-cleaner.js';
import { parseCheckNumber } from '../utils/check-number.js';
import { matchByName } from './ai-name-match.js';
import { cleanNameViaRules } from './bank-rules.service.js';
import { updateLearning } from './categorization-ai.service.js';
import { assertTagsInTenant } from './tags.service.js';
import type { StatementCheckImage } from './ai-statement-parser.service.js';
import { escapeLike } from '../utils/sql-like.js';
import { computeSplitLines, type StagedSplitsConfig } from './bank-feed-splits.js';
import { lineCandidatePredicate, resolveMatchLine, matchMismatch } from './bank-feed-lines.js';
import { claimIdempotency } from './idempotency.service.js';
import { errorSummaryForLog } from '../utils/log-safe.js';
import { isDesktop } from '../desktop/profile.js';
import { bucketSql, transferCandidateSql, waitingSql } from './bank-feed-buckets.js';
import { recordAcceptGroup, recordAcceptItem } from './bank-feed-accept-records.js';

const Decimal = DecimalLib.default || DecimalLib;

/**
 * Verify a client-supplied `bankConnectionId` belongs to the caller's
 * tenant. Without this check, the CSV/OFX/statement import paths would
 * let a user insert bank_feed_items labelled with their own tenantId
 * but pointing at another tenant's bank_connections.id, polluting
 * cross-tenant joins.
 */
async function assertConnectionInTenant(tenantId: string, bankConnectionId: string): Promise<void> {
  const conn = await db.query.bankConnections.findFirst({
    where: and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, bankConnectionId)),
  });
  if (!conn) throw AppError.notFound('Bank connection not found');
}

/** The scope GET /feed and GET /feed/counts share (connection and dates). */
function scopeConditions(tenantId: string, filters: Pick<BankFeedFilters, 'bankConnectionId' | 'startDate' | 'endDate'>): SQL[] {
  const conditions: SQL[] = [eq(bankFeedItems.tenantId, tenantId)];
  if (filters.bankConnectionId) conditions.push(eq(bankFeedItems.bankConnectionId, filters.bankConnectionId));
  if (filters.startDate) conditions.push(sql`${bankFeedItems.feedDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${bankFeedItems.feedDate} <= ${filters.endDate}`);
  return conditions;
}

/**
 * Counts per review bucket and state (U-174, feed-review-v1), with the same
 * predicates as GET /feed?bucket= / status / entryVoided / possibleDuplicate,
 * so each count equals that list's total. `waiting` = ready + review +
 * matches (pending and assigned rows); `accepted` = categorized and matched
 * rows, `entryVoided` included (Accepted · Entry voided); `inProgress` =
 * rows being posted right now.
 */
export async function counts(
  tenantId: string, filters: Pick<BankFeedFilters, 'bankConnectionId' | 'startDate' | 'endDate'> = {},
) {
  const bucket = bucketSql(tenantId);
  const [row] = await db.select({
    ready: sql<number>`COUNT(*) FILTER (WHERE ${bucket} = 'ready')::int`,
    review: sql<number>`COUNT(*) FILTER (WHERE ${bucket} = 'review')::int`,
    matches: sql<number>`COUNT(*) FILTER (WHERE ${bucket} = 'matches')::int`,
    possibleDuplicate: sql<number>`COUNT(*) FILTER (WHERE ${waitingSql()} AND ${bankFeedItems.possibleDuplicate})::int`,
    accepted: sql<number>`COUNT(*) FILTER (WHERE ${bankFeedItems.status} IN ('categorized', 'matched'))::int`,
    entryVoided: sql<number>`COUNT(*) FILTER (WHERE ${bankFeedItems.entryVoidedAt} IS NOT NULL)::int`,
    excluded: sql<number>`COUNT(*) FILTER (WHERE ${bankFeedItems.status} = 'excluded')::int`,
    inProgress: sql<number>`COUNT(*) FILTER (WHERE ${bankFeedItems.status} = 'categorizing')::int`,
  }).from(bankFeedItems).where(and(...scopeConditions(tenantId, filters)));
  const r = row ?? { ready: 0, review: 0, matches: 0, possibleDuplicate: 0, accepted: 0, entryVoided: 0, excluded: 0, inProgress: 0 };
  return { waiting: r.ready + r.review + r.matches, ...r };
}

export async function list(tenantId: string, filters: BankFeedFilters) {
  const conditions = scopeConditions(tenantId, filters);
  if (filters.status === 'accepted') {
    // feed-accept-v1 (Q-P26y): every accepted row, paged in SQL like the rest
    // (the predicate /counts accepted uses, entryVoided included).
    conditions.push(inArray(bankFeedItems.status, ['categorized', 'matched']));
  } else if (filters.status) {
    // An explicit single-status filter takes precedence over actionableOnly.
    conditions.push(eq(bankFeedItems.status, filters.status));
  } else if (filters.actionableOnly) {
    // "Hide processed" — exclude items that have already been handled,
    // leaving the actionable (pending) work to do.
    conditions.push(sql`${bankFeedItems.status} NOT IN ('matched', 'categorized', 'excluded')`);
  }
  if (filters.ruleOnly) {
    // "Rules" filter — only rows a rule mapped (match_type = 'rule'), the same
    // signal the NAME column's green "Rule" badge uses. Done in SQL so
    // pagination/total counts reflect the constrained set.
    conditions.push(eq(bankFeedItems.matchType, 'rule'));
  }
  // U-174 / U-166 filters, the predicates GET /feed/counts uses.
  const bucket = bucketSql(tenantId);
  if (filters.bucket) conditions.push(sql`${bucket} = ${filters.bucket}`);
  if (filters.possibleDuplicate !== undefined) {
    conditions.push(filters.possibleDuplicate
      ? sql`(${waitingSql()} AND ${bankFeedItems.possibleDuplicate})`
      : sql`NOT ${bankFeedItems.possibleDuplicate}`);
  }
  if (filters.entryVoided !== undefined) {
    conditions.push(filters.entryVoided ? sql`${bankFeedItems.entryVoidedAt} IS NOT NULL` : sql`${bankFeedItems.entryVoidedAt} IS NULL`);
  }

  // Separate aliases for the payee/vendor contact display names so the
  // feed's NAME column can show the resolved payee (rule- or AI-set, or
  // human-assigned) instead of only the cleaned bank descriptor. Declared
  // before the search clause so it can match on the resolved NAME too.
  const suggestedContact = alias(contacts, 'suggested_contact');
  const assignedContact = alias(contacts, 'assigned_contact');

  if ((filters as any).search) {
    const term = '%' + escapeLike(String((filters as any).search)) + '%';
    // Search the same NAME the feed's column shows (assigned/suggested contact)
    // and the AMOUNT (as text, so "12.50" matches "12.5000"), in addition to
    // the bank descriptor, category and raw memo. The contact aliases must
    // therefore be joined on BOTH the data and count queries below.
    conditions.push(sql`(
      ${bankFeedItems.description} ILIKE ${term}
      OR ${bankFeedItems.category} ILIKE ${term}
      OR ${bankFeedItems.memo} ILIKE ${term}
      OR ${assignedContact.displayName} ILIKE ${term}
      OR ${suggestedContact.displayName} ILIKE ${term}
      OR ${bankFeedItems.payeeNameOnCheck} ILIKE ${term}
      OR CAST(${bankFeedItems.checkNumber} AS TEXT) ILIKE ${term}
      OR CAST(${bankFeedItems.amount} AS TEXT) ILIKE ${term}
    )`);
  }

  const where = and(...conditions);

  // Separate alias for the suggested GL account so it doesn't collide with the
  // bank-account join (which resolves the connection's own account).
  const suggestedAccount = alias(accounts, 'suggested_account');
  // Alias for the rule-staged suggested tag (bank_feed_items.suggested_tag_id →
  // tags.name) so a pending item can surface a "suggested" tag pill before it
  // is categorized.
  const suggestedTag = alias(tags, 'suggested_tag');
  // Aliases for the STAGED assignment (two-phase workflow, migration 0119) so
  // an 'assigned' row can render its human-chosen category/tag before posting.
  const assignedAccount = alias(accounts, 'assigned_account');
  const assignedTag = alias(tags, 'assigned_tag');

  // Server-side column sort. The page paginates, so sorting must happen
  // here — the old client-side sort only ordered the visible page.
  // Whitelisted keys → concrete SQL; anything else falls back to date.
  // A stable createdAt/id tiebreaker keeps pagination deterministic.
  const dir = filters.sortDir === 'asc' ? sql`ASC` : sql`DESC`;
  const sortExpr = (() => {
    switch (filters.sortBy) {
      case 'description': return sql`${bankFeedItems.description}`;
      case 'category': return sql`${suggestedAccount.name}`;
      case 'status': return sql`${bankFeedItems.status}`;
      case 'amount': return sql`CAST(${bankFeedItems.amount} AS DECIMAL)`;
      case 'checkNumber': return sql`${bankFeedItems.checkNumber}`;
      // The name the Payee column shows: same precedence as the UI.
      case 'payee': return sql`COALESCE(${assignedContact.displayName}, ${suggestedContact.displayName}, ${bankFeedItems.payeeNameOnCheck})`;
      // The name the feed's NAME column shows: assigned contact, else the
      // rule/AI suggested contact, else the cleaned descriptor.
      case 'name': return sql`COALESCE(${assignedContact.displayName}, ${suggestedContact.displayName}, ${bankFeedItems.description})`;
      case 'originalDescription': return sql`${bankFeedItems.originalDescription}`;
      // decimal(3,2), NULL when nothing scored the row — NULLS LAST below.
      case 'confidence': return sql`CAST(${bankFeedItems.confidenceScore} AS DECIMAL)`;
      case 'feedDate':
      default: return sql`${bankFeedItems.feedDate}`;
    }
  })();
  const orderBy = sql`${sortExpr} ${dir} NULLS LAST, ${bankFeedItems.createdAt} DESC, ${bankFeedItems.id}`;

  const [data, total] = await Promise.all([
    db.select({
      id: bankFeedItems.id,
      tenantId: bankFeedItems.tenantId,
      bankConnectionId: bankFeedItems.bankConnectionId,
      providerTransactionId: bankFeedItems.providerTransactionId,
      feedDate: bankFeedItems.feedDate,
      description: bankFeedItems.description,
      originalDescription: bankFeedItems.originalDescription,
      amount: bankFeedItems.amount,
      category: bankFeedItems.category,
      status: bankFeedItems.status,
      matchedTransactionId: bankFeedItems.matchedTransactionId,
      suggestedAccountId: bankFeedItems.suggestedAccountId,
      suggestedContactId: bankFeedItems.suggestedContactId,
      suggestedContactName: suggestedContact.displayName,
      confidenceScore: bankFeedItems.confidenceScore,
      // Source of the staged suggestion ('rule' | 'history' | 'exact' | 'fuzzy'
      // | 'check_image' | 'manual' | null). Surfaced so the feed can badge a
      // rule-mapped row as "Rule" (green) instead of a generic confidence word.
      matchType: bankFeedItems.matchType,
      // STATEMENT_CHECK_PAYEE_V1 — surfaced in the UI so the payee read off a
      // check image is visible/confirmable before posting.
      payeeNameOnCheck: bankFeedItems.payeeNameOnCheck,
      checkNumber: bankFeedItems.checkNumber,
      memo: bankFeedItems.memo,
      // U-06 / Q-P25c: imported as a look-alike of possibleDuplicateOf.
      possibleDuplicate: bankFeedItems.possibleDuplicate,
      possibleDuplicateOf: bankFeedItems.possibleDuplicateOf,
      // U-174: the row it looks like (null when it has none or it was removed).
      duplicateOf: sql<{ id: string; date: string; amount: string; description: string | null; memo: string | null; status: string | null } | null>`(
        SELECT json_build_object('id', d.id, 'date', to_char(d.feed_date, 'YYYY-MM-DD'), 'amount', d.amount::text,
          'description', d.description, 'memo', d.memo, 'status', d.status)
        FROM bank_feed_items d
        WHERE d.tenant_id = ${tenantId} AND d.id = ${bankFeedItems.possibleDuplicateOf}
      )`,
      // U-174 (U-168): the rule that staged the suggestion. autoAccept is a
      // conditional rule's auto_accept (feed-accept-v1) or a legacy rule's
      // auto_confirm: "Accept all from this rule" is offered.
      suggestedRule: sql<{ id: string; kind: 'conditional' | 'legacy'; name: string; autoAccept: boolean; updatedAt: string | null } | null>`(
        CASE ${bankFeedItems.suggestedRuleKind}
          WHEN 'conditional' THEN (SELECT json_build_object('id', cr.id, 'kind', 'conditional', 'name', cr.name,
            'autoAccept', cr.auto_accept, 'updatedAt', cr.updated_at)
            FROM conditional_rules cr WHERE cr.id = ${bankFeedItems.suggestedRuleId})
          WHEN 'legacy' THEN (SELECT json_build_object('id', br.id, 'kind', 'legacy', 'name', br.name,
            'autoAccept', COALESCE(br.auto_confirm, false), 'updatedAt', br.updated_at)
            FROM bank_rules br WHERE br.id = ${bankFeedItems.suggestedRuleId}
              AND (br.tenant_id = ${tenantId} OR br.tenant_id IS NULL))
        END
      )`,
      // U-166: the entry's line this row is, and the voided-entry flag.
      matchedJournalLineId: bankFeedItems.matchedJournalLineId,
      entryVoided: sql<boolean>`(${bankFeedItems.entryVoidedAt} IS NOT NULL)`,
      entryVoidedAt: bankFeedItems.entryVoidedAt,
      exclusionReason: bankFeedItems.exclusionReason,
      // U-174: the waiting row's review bucket (null when not waiting).
      bucket,
      importBatchId: bankFeedItems.importBatchId,
      createdAt: bankFeedItems.createdAt,
      updatedAt: bankFeedItems.updatedAt,
      bankAccountName: accounts.name,
      institutionName: bankConnections.institutionName,
      suggestedAccountName: suggestedAccount.name,
      // Rule-staged suggested tag (shown as a "suggested" pill on pending
      // rows so a rule-set tag is visible before the user categorizes).
      suggestedTagId: bankFeedItems.suggestedTagId,
      suggestedTagName: suggestedTag.name,
      // Staged assignment (migration 0119) — the human-chosen category on an
      // 'assigned' item, awaiting approval. assignedAccountName/assignedTagName
      // are the joined display names.
      assignedAccountId: bankFeedItems.assignedAccountId,
      assignedAccountName: assignedAccount.name,
      assignedContactId: bankFeedItems.assignedContactId,
      assignedContactName: assignedContact.displayName,
      assignedTagId: bankFeedItems.assignedTagId,
      assignedTagName: assignedTag.name,
      assignedMemo: bankFeedItems.assignedMemo,
      // ADR 0XX §4.1 — for a CATEGORIZED/MATCHED item, the distinct tag
      // names actually applied on the matched transaction's journal lines.
      // Null when the item has no matched transaction or every line is
      // untagged; one element when uniform; two+ when mixed. Mirrors the
      // transaction-list lineTags idiom (ledger.service.ts).
      lineTags: sql<string[] | null>`(
        SELECT array_agg(DISTINCT lt.name ORDER BY lt.name)
        FROM journal_lines jl
        JOIN tags lt ON lt.id = jl.tag_id
        WHERE jl.transaction_id = ${bankFeedItems.matchedTransactionId}
          AND jl.tenant_id = ${tenantId}
          AND jl.tag_id IS NOT NULL
      )`,
      // Count of already-posted ledger transactions this PENDING item likely
      // duplicates — mirrors findMatchCandidates() so a "Match" indicator can
      // flag rows (e.g. checks written in-system) that already exist in the
      // ledger. Guarded by a CASE so it only runs for actionable rows; 0 for
      // matched/categorized/excluded/assigned or amount-zero items.
      // U-166: candidate journal LINES (the predicate findMatchCandidates
      // uses), for pending and assigned rows.
      matchCandidateCount: sql<number>`(
        CASE WHEN ${bankFeedItems.status} IN ('pending', 'assigned')
              AND ${bankFeedItems.matchedTransactionId} IS NULL
              AND ${accounts.id} IS NOT NULL
              AND CAST(${bankFeedItems.amount} AS DECIMAL) <> 0
        THEN COALESCE((
          SELECT COUNT(*)::int FROM journal_lines jl, transactions t
          WHERE ${lineCandidatePredicate({
            tenantId,
            bankAccountId: sql`${accounts.id}`,
            amount: sql`${bankFeedItems.amount}`,
            feedDate: sql`${bankFeedItems.feedDate}`,
            itemId: sql`${bankFeedItems.id}`,
          })}
        ), 0) ELSE 0 END
      )`,
      // feed-accept-v1 (Q-P26y): the other side of a transfer when exactly
      // one is waiting (the "matches" bucket's transfer rule), else null.
      transferCandidate: transferCandidateSql(tenantId, sql`${accounts.id}`),
    }).from(bankFeedItems)
      .leftJoin(bankConnections, eq(bankFeedItems.bankConnectionId, bankConnections.id))
      .leftJoin(accounts, eq(bankConnections.accountId, accounts.id))
      .leftJoin(suggestedAccount, eq(bankFeedItems.suggestedAccountId, suggestedAccount.id))
      .leftJoin(suggestedTag, eq(bankFeedItems.suggestedTagId, suggestedTag.id))
      .leftJoin(assignedAccount, eq(bankFeedItems.assignedAccountId, assignedAccount.id))
      .leftJoin(assignedTag, eq(bankFeedItems.assignedTagId, assignedTag.id))
      .leftJoin(suggestedContact, eq(bankFeedItems.suggestedContactId, suggestedContact.id))
      .leftJoin(assignedContact, eq(bankFeedItems.assignedContactId, assignedContact.id))
      .where(where)
      .orderBy(orderBy)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    // The count query mirrors the data query's contact joins so a NAME search
    // (assigned/suggested contact display name) resolves here too and the
    // total stays consistent with the returned rows.
    db.select({ count: count() }).from(bankFeedItems)
      .leftJoin(suggestedContact, eq(bankFeedItems.suggestedContactId, suggestedContact.id))
      .leftJoin(assignedContact, eq(bankFeedItems.assignedContactId, assignedContact.id))
      .where(where),
  ]);

  return { data, total: total[0]?.count ?? 0 };
}

export async function updateFeedItem(tenantId: string, feedItemId: string, input: {
  feedDate?: string; description?: string; memo?: string; contactId?: string;
}) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (input.feedDate !== undefined) updates['feedDate'] = input.feedDate;
  if (input.description !== undefined) updates['description'] = input.description;
  // Real column as of migration 0118 — Plaid seeds it with the bank's
  // raw payee text; review-panel edits persist here and categorize()
  // stamps it onto the posted transaction.
  if (input.memo !== undefined) updates['memo'] = input.memo || null;
  if (input.contactId !== undefined) updates['suggestedContactId'] = input.contactId || null;

  await db.update(bankFeedItems).set(updates)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));
  return db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
}

// ── Feed Item Helpers ──

export async function getFeedItem(tenantId: string, itemId: string) {
  return db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, itemId)),
  });
}

export async function getConnectionForItem(tenantId: string, connectionId: string) {
  return db.query.bankConnections.findFirst({
    where: and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, connectionId)),
  });
}

// ── Payroll Overlap Check ──

/**
 * Payroll entries a money-out feed line may already be (U-172, Q-P26r):
 * posted payroll-import entries within ±5 days with a credit line on the
 * item's bank account for exactly the amount, not held by another feed item
 * (the U-166 line predicate). Each bank line of a payroll entry (net pay,
 * taxes) is its own overlap, matched to its own feed item with
 * PUT /feed/:id/match {transactionId, journalLineId}. `amount` is in the
 * feed sign (positive = money out). Money in is never a payroll overlap.
 */
export async function checkPayrollOverlap(
  tenantId: string,
  item: { id: string; feedDate: string; amount: string },
  bankAccountId: string,
): Promise<Array<{ txnId: string; journalLineId: string; memo: string; date: string; amount: string }>> {
  if (!new Decimal(item.amount).gt(0)) return [];
  const rows = await db.execute(sql`
    SELECT t.id AS txn_id, jl.id AS journal_line_id, t.memo, t.txn_date
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE t.source = 'payroll_import'
      AND ${lineCandidatePredicate({
        tenantId,
        bankAccountId: sql`${bankAccountId}`,
        amount: sql`${item.amount}`,
        feedDate: sql`${item.feedDate}`,
        itemId: sql`${item.id}`,
        windowDays: 5,
      })}
    ORDER BY ABS(t.txn_date - CAST(${item.feedDate} AS date)), t.id, jl.line_order NULLS LAST, jl.id`);
  const amount = new Decimal(item.amount).toFixed(2);
  return (rows.rows as Array<{ txn_id: string; journal_line_id: string; memo: string | null; txn_date: string }>).map((r) => ({
    txnId: r.txn_id,
    journalLineId: r.journal_line_id,
    memo: r.memo || 'Payroll JE',
    date: r.txn_date,
    amount,
  }));
}

// Phase 4 conditional split_by_* action: a JSONB blob staged on the feed
// item that expands into N user-facing journal lines at post time (the cash
// leg stays a single line so the bank account stays simple). The owner's own
// split (U-164) is staged as kind 'fixed'. The math lives in
// bank-feed-splits.ts.
type FeedSplitsConfig = StagedSplitsConfig | null;

/** The owner's split lines (U-164) as a staged config. */
function manualSplitsConfig(splits: FeedSplitLine[]): StagedSplitsConfig {
  return {
    kind: 'fixed',
    splits: splits.map((s) => ({ accountId: s.accountId, amount: s.amount, tagId: s.tagId ?? null, memo: s.memo ?? null })),
  };
}

/** Every account and tag an owner's split names must be in this tenant. */
async function assertSplitRefsInTenant(tenantId: string, splits: FeedSplitLine[]): Promise<void> {
  const accountIds = [...new Set(splits.map((s) => s.accountId))];
  const found = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, accountIds)));
  if (found.length !== accountIds.length) throw AppError.badRequest('A split account was not found in this tenant');
  const tagIds = [...new Set(splits.map((s) => s.tagId).filter((t): t is string => !!t))];
  if (tagIds.length > 0) await assertTagsInTenant(tenantId, tagIds);
}

/**
 * Resolve the memo that a feed item should post with.
 *
 * Precedence: the caller's explicit memo, then the feed item's own memo (Plaid
 * seeds it from payment_meta.payee, and the review panel edits it), then the
 * payee read off the check image, then the bank's raw descriptor.
 *
 * The payee step is why this exists. STATEMENT_CHECK_PAYEE_V1 fills
 * payee_name_on_check on a feed row from the statement's check images, and the
 * Bank Feeds screen shows it, but before this the value only ever reached the
 * posted row's payee_name_on_check metadata column. Every report and register
 * read the memo, which fell through to a descriptor like "CHECK 3607" or
 * "Unknown", so the payee the user had just confirmed on screen was invisible
 * everywhere downstream.
 *
 * When there is a check number the memo reads "Check 3607 - ACME Supply" so the
 * reference survives alongside the name; the number also lands in its own
 * transactions.check_number column (see postAssignment).
 */
export function resolveFeedMemo(
  item: Pick<typeof bankFeedItems.$inferSelect,
    'memo' | 'description' | 'payeeNameOnCheck' | 'checkNumber'>,
  explicit?: string | null,
): string | undefined {
  const staged = (explicit ?? '').trim();
  if (staged) return staged;

  const own = ((item.memo as string | null) ?? '').trim();
  if (own) return own;

  const payee = (item.payeeNameOnCheck ?? '').trim();
  if (payee) {
    return item.checkNumber != null ? `Check ${item.checkNumber} - ${payee}` : payee;
  }

  return (item.description ?? '').trim() || undefined;
}

// The fully-resolved values postAssignment posts. The caller has already
// resolved the tag (an explicit id, or null for untagged — the
// undefined→suggestedTagId fallback lives in categorize()), the contact, and
// the memo, so this helper never guesses.
export interface PostAssignmentValues {
  accountId: string;
  contactId?: string | null;
  tagId?: string | null;
  memo?: string | null;
  splitsConfig?: FeedSplitsConfig;
}

/** 409 FEED_ITEM_NOT_PENDING {status} (U-173): the item isn't waiting for this action any more. */
export function feedItemNotPending(status: string | null, message?: string): AppError {
  return AppError.conflict(
    message ?? `Bank feed item is not pending (current status: ${status}). It may already be posted, matched, excluded or in progress.`,
    'FEED_ITEM_NOT_PENDING', { status },
  );
}

/**
 * Shared posting body for BOTH the direct-post path (categorize(), used by
 * bulkCategorize, bulk approve and rule posting outside desktop mode) and the
 * two-phase approve() path.
 *
 * One database transaction (S9, U-173): lock the item (FOR UPDATE), check its
 * status is one of `allowed` (else 409 FEED_ITEM_NOT_PENDING {status}),
 * resolve what to post from the locked row, post the ledger transaction,
 * flip the item to 'categorized' and stamp the transaction and its bank line
 * (U-166). Nothing is claimed outside the transaction, so a failure or a
 * crash leaves the item exactly as it was (no 'categorizing' row to recover),
 * and two concurrent posts of one item serialize on the row lock.
 * Categorization learning is fed after the commit.
 */
async function postFeedItem(
  tenantId: string,
  feedItemId: string,
  allowed: readonly string[],
  resolve: (item: typeof bankFeedItems.$inferSelect) => PostAssignmentValues,
  userId?: string,
  companyId?: string,
) {
  let learn: FeedLearning | null = null;
  const txn = await db.transaction(async (tx) => {
    const [item] = await tx.select().from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)))
      .for('update');
    if (!item) throw AppError.notFound('Bank feed item not found');
    if (!allowed.includes(item.status ?? '')) {
      throw feedItemNotPending(item.status, item.status === 'pending' && !allowed.includes('pending')
        ? 'Bank feed item is not assigned (current status: pending). Assign a category before approving.' : undefined);
    }
    const posted = await postFeedItemInTx(tx, tenantId, item, resolve(item), userId, companyId);
    // U-169: the accept record Undo works from (B5).
    await recordAcceptGroup(tx, {
      tenantId, companyId, userId, source: allowed.includes('pending') ? 'categorize' : 'approve',
      items: [{ kind: 'post', before: item, transactionId: posted.transaction.id, journalLineId: posted.journalLineId }],
    });
    learn = posted.learn;
    return posted.transaction;
  });

  // Update categorization learning history. Fire-and-forget — the
  // transaction has already posted; this only feeds future suggestions.
  const l = learn as FeedLearning | null;
  if (l) learnFromFeed(tenantId, feedItemId, l, true);

  return txn;
}

/** What a posted feed item teaches the categorization history (after the commit). */
export interface FeedLearning { text: string; accountId: string; contactId: string | null }

/**
 * Feeds the categorization history after a commit, fire-and-forget:
 * `accepted` true confirms the account, false counts an override (an Undo,
 * Q-P26k). Logs only a code and the item id (U-167).
 */
export function learnFromFeed(tenantId: string, feedItemId: string, l: FeedLearning, accepted: boolean): void {
  updateLearning(tenantId, l.text, l.accountId, l.contactId, accepted).catch((err) => {
    // U-167: the error code and the item id only (Drizzle errors carry the description in params).
    // eslint-disable-next-line no-console
    console.warn(`[bank-feed] updateLearning failed for item ${feedItemId}: ${errorSummaryForLog(err)}`);
  });
}

/** The values an Accept sends for one row (feed-accept-v1). */
export interface AcceptRowInput {
  accountId?: string;
  contactId?: string | null;
  tagId?: string | null;
  memo?: string | null;
  splits?: FeedSplitLine[];
}

/**
 * What an Accept posts for a waiting row (feed-accept-v1), or null when
 * there is nothing to post (no account anywhere): the owner's values when
 * sent (as PUT /categorize with ownerChoice: an account without splits is
 * one line), else the owner's staged values on an assigned row (as
 * approve), else the suggestion as staged (as bulk approve).
 */
export function acceptValuesFor(item: typeof bankFeedItems.$inferSelect, input: AcceptRowInput): PostAssignmentValues | null {
  const tagOr = (fallback: string | null | undefined) => (input.tagId === undefined ? (fallback ?? null) : (input.tagId ?? null));
  const ownSplits = input.splits && input.splits.length > 0 ? manualSplitsConfig(input.splits) : null;
  if (input.accountId || ownSplits) {
    return {
      accountId: input.accountId ?? ownSplits!.splits[0]!.accountId,
      contactId: input.contactId || (item.suggestedContactId ?? undefined),
      tagId: tagOr(item.suggestedTagId),
      memo: resolveFeedMemo(item, input.memo),
      splitsConfig: ownSplits,
    };
  }
  if (item.status === 'assigned' && item.assignedAccountId) {
    return {
      accountId: item.assignedAccountId,
      contactId: input.contactId || item.assignedContactId || item.suggestedContactId || undefined,
      tagId: tagOr(item.assignedTagId),
      memo: resolveFeedMemo(item, input.memo ?? (item.assignedMemo as string | null)),
      splitsConfig: item.splitsConfig as FeedSplitsConfig,
    };
  }
  const staged = (item.splitsConfig as FeedSplitsConfig) ?? null;
  const account = item.suggestedAccountId ?? (staged && staged.splits.length > 0 ? staged.splits[0]!.accountId : null);
  if (!account) return null;
  return {
    accountId: account,
    contactId: input.contactId || (item.suggestedContactId ?? undefined),
    tagId: tagOr(item.suggestedTagId),
    memo: resolveFeedMemo(item, input.memo),
    splitsConfig: staged,
  };
}

/** Throws the posting's split refusal (SPLITS_DONT_BALANCE, AMOUNT_NOT_CENTS) without posting anything. */
export function assertFeedSplitsPost(item: typeof bankFeedItems.$inferSelect, values: PostAssignmentValues): void {
  const cfg = values.splitsConfig ?? null;
  if (cfg && cfg.splits.length > 0) computeSplitLines(item.amount, cfg);
}

/** Every account and tag of an Accept's owner split must be in this tenant (400 otherwise). */
export async function assertAcceptSplitRefs(tenantId: string, splits: FeedSplitLine[] | undefined): Promise<void> {
  if (splits && splits.length > 0) await assertSplitRefsInTenant(tenantId, splits);
}

/**
 * Posts a feed row the caller locked (FOR UPDATE) and checked, in the
 * caller's database transaction: the ledger entry, the check stamp, status
 * 'categorized' and the entry's bank line (U-166). The caller feeds the
 * learning (`learn`) after the commit.
 */
export async function postFeedItemInTx(
  tx: Tx,
  tenantId: string,
  item: typeof bankFeedItems.$inferSelect,
  values: PostAssignmentValues,
  userId?: string,
  companyId?: string,
): Promise<{ transaction: Awaited<ReturnType<typeof ledger.postTransaction>>; journalLineId: string | null; learn: FeedLearning }> {
  const feedItemId = item.id;
  {

    // Determine if this is an expense (positive amount = money out) or deposit
    // (negative = money in). Exact decimals (U-164): the amount posts as
    // stored, never through a JavaScript number.
    const signed = new Decimal(item.amount);
    const amount = signed.abs();
    const isExpense = signed.gt(0);
    const amountStr = amount.toFixed(4);

    // Split lines are worked out (and refused with a code) before any read,
    // so an unbalanced split never reaches the ledger's generic message.
    const splitsConfig = values.splitsConfig ?? null;
    const splitLines = splitsConfig && splitsConfig.splits.length > 0
      ? computeSplitLines(item.amount, splitsConfig)
      : null;

    // Get the bank account from the connection. Tenant-scoped via a join on
    // accounts.tenant_id for defense in depth (CLAUDE.md rule #17).
    const [conn] = await tx.select().from(bankConnections).where(eq(bankConnections.id, item.bankConnectionId)).limit(1);
    if (!conn) throw AppError.notFound('Bank connection not found');
    const [connAccount] = await tx.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, conn.accountId))).limit(1);
    if (!connAccount) {
      throw AppError.notFound('Bank connection does not belong to this tenant');
    }

    const userLines: Array<{ accountId: string; debit: string; credit: string; description?: string; tagId?: string }> = [];
    if (splitLines) {
      for (const s of splitLines) {
        // A negative line (a fixed rule split may have one) goes on the other
        // side of the entry, so the user lines still net to |amount|.
        const userSideDebit = isExpense !== s.amount.isNegative();
        const lineAmt = s.amount.abs().toFixed(4);
        userLines.push({
          accountId: s.accountId,
          debit: userSideDebit ? lineAmt : '0',
          credit: userSideDebit ? '0' : lineAmt,
          // Falls back through the resolved transaction memo so a check payee
          // reaches the GL line description, not just the header memo.
          description: s.memo ?? values.memo ?? item.description ?? undefined,
          tagId: s.tagId ?? values.tagId ?? undefined,
        });
      }
    } else {
      userLines.push({
        accountId: values.accountId,
        debit: isExpense ? amountStr : '0',
        credit: isExpense ? '0' : amountStr,
        // Same reason as the split branch: reports that read the line
        // description showed the bank descriptor instead of the payee.
        description: values.memo || item.description || undefined,
        // The tag is already resolved by the caller (id or null).
        tagId: values.tagId ?? undefined,
      });
    }

    const cashLine = {
      accountId: conn.accountId,
      debit: isExpense ? '0' : amountStr,
      credit: isExpense ? amountStr : '0',
    };

    const t = await ledger.postTransaction(tenantId, {
      txnType: isExpense ? 'expense' : 'deposit',
      txnDate: item.feedDate,
      contactId: values.contactId || undefined,
      // Memo chain resolved by the caller; item.description is the final
      // fallback. The provider category hint ("FOOD_AND_DRINK") deliberately
      // stays out of this chain — it leaked classification codes into the
      // books on every bulk approve.
      memo: values.memo || item.description || undefined,
      total: amountStr,
      source: 'bank_feed',
      sourceId: item.id,
      // ADR 0XY §3.3 — the tag stamps on the user-facing expense/revenue
      // line(s); the cash-account leg stays untagged (not segment-relevant).
      lines: isExpense ? [...userLines, cashLine] : [cashLine, ...userLines],
    }, userId, companyId, tx);

    // STATEMENT_CHECK_PAYEE_V1 — stamp the parsed check number and the payee
    // read off the check image onto the posted transaction (metadata only).
    if (item.checkNumber != null || item.payeeNameOnCheck) {
      await tx.update(transactions).set({
        checkNumber: item.checkNumber ?? undefined,
        payeeNameOnCheck: item.payeeNameOnCheck ?? undefined,
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, t.id)));
    }

    // U-166: the item is the entry's (single) line on the bank account.
    const [cash] = await tx.select({ id: journalLines.id }).from(journalLines)
      .where(and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.transactionId, t.id),
        eq(journalLines.accountId, conn.accountId),
        eq(journalLines.isVoidReversal, false),
      ))
      .orderBy(journalLines.lineOrder)
      .limit(1);

    await tx.update(bankFeedItems).set({
      status: 'categorized',
      matchedTransactionId: t.id,
      matchedJournalLineId: cash?.id ?? null,
      entryVoidedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));
    return {
      transaction: t,
      journalLineId: cash?.id ?? null,
      learn: { text: item.originalDescription || item.description || '', accountId: values.accountId, contactId: values.contactId || null },
    };
  }
}

/**
 * DIRECT-POST path. Posts a feed item to the ledger the moment a category is
 * chosen. Retained for the callers that post-on-match BY DESIGN — legacy
 * autoConfirm bank rules outside desktop mode (S6: desktop rules only
 * stage), plus bulkCategorize. The interactive UI now stages via
 * assign()/approve() instead of calling this.
 */
export interface CategorizeOptions {
  /**
   * U-164: true when the account (and any `splits`) is the owner's own
   * choice — the PUT /categorize routes, bulk-categorize and the MCP tool.
   * The owner's account then overrides a split a rule staged on the item:
   * no `splits` posts one line on accountId. False (the default) is "accept
   * the suggestion as staged" (bulk approve, rule auto-posting, Close Review
   * approve), which keeps posting the staged split as before.
   */
  ownerChoice?: boolean;
}

/**
 * Posts a pending or assigned item (U-173: an assigned item may be
 * categorized with other values) on the given account. 409
 * FEED_ITEM_NOT_PENDING {status} otherwise. The claim, the post and the
 * status flip are one database transaction (postFeedItem).
 */
export async function categorize(
  tenantId: string, feedItemId: string, input: CategorizeInput, userId?: string, companyId?: string,
  opts: CategorizeOptions = {},
) {
  if (input.splits && input.splits.length > 0) await assertSplitRefsInTenant(tenantId, input.splits);

  return postFeedItem(tenantId, feedItemId, ['pending', 'assigned'], (item) => {
    // The owner's split wins; with ownerChoice and no split, one line on the
    // owner's account (a rule's staged split is not used); otherwise the
    // staged split, as before.
    const splitsConfig: FeedSplitsConfig = input.splits && input.splits.length > 0
      ? manualSplitsConfig(input.splits)
      : opts.ownerChoice ? null : (item.splitsConfig as FeedSplitsConfig);
    // Tag resolution distinguishes three caller intents:
    //   - key absent (undefined): no explicit choice → fall back to the
    //     rule-staged suggested tag (rule→categorize / "accept as-is").
    //   - explicit null: user cleared the picker → post UNTAGGED.
    //   - explicit id: that tag wins.
    const resolvedTagId = input.tagId === undefined
      ? (item.suggestedTagId ?? null)
      : (input.tagId ?? null);
    return {
      accountId: input.accountId,
      contactId: input.contactId || (item.suggestedContactId ?? undefined),
      tagId: resolvedTagId,
      memo: resolveFeedMemo(item, input.memo),
      splitsConfig,
    };
  }, userId, companyId);
}

// ── Two-phase workflow: ASSIGN (stage) then APPROVE (post) ──

export interface AssignInput {
  accountId: string;
  contactId?: string | null;
  tagId?: string | null;
  memo?: string | null;
  /**
   * U-164: the owner's split, staged for approve. Omitted clears a split a
   * rule staged, so approve posts one line on accountId (the owner's choice
   * wins over the rule's split).
   */
  splits?: FeedSplitLine[];
}

/**
 * ASSIGN — stage a category on a feed item WITHOUT posting to the ledger.
 * Persists the chosen account/contact/tag/memo in the assigned_* columns and
 * transitions pending → 'assigned' (an actionable, "ready to approve" state).
 * Re-assigning an already-'assigned' item overwrites the staged values;
 * anything already posted/handled (categorized/matched/excluded) is 409
 * FEED_ITEM_NOT_PENDING {status} (U-173).
 * NO postTransaction, NO matchedTransactionId — that only happens on approve.
 */
export async function assign(tenantId: string, feedItemId: string, input: AssignInput, userId?: string) {
  // Validate the target category account is a real account in this tenant.
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, input.accountId)),
  });
  if (!account) throw AppError.badRequest('Assigned account not found in this tenant');

  // Optional contact / tag — tenant-scoped when provided.
  if (input.contactId) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, input.contactId)),
    });
    if (!contact) throw AppError.badRequest('Assigned contact not found in this tenant');
  }
  if (input.tagId) await assertTagsInTenant(tenantId, [input.tagId]);
  const hasSplits = !!input.splits && input.splits.length > 0;
  if (hasSplits) await assertSplitRefsInTenant(tenantId, input.splits!);

  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');
  // Only a fresh (pending) or already-staged (assigned) item can be assigned.
  // categorized/matched are already posted; excluded is not applicable.
  if (item.status !== 'pending' && item.status !== 'assigned') throw feedItemNotPending(item.status);
  // U-164: the owner's split must add up exactly to |amount| now, not only
  // at approve (400 SPLITS_DONT_BALANCE / AMOUNT_NOT_CENTS).
  const stagedSplits = hasSplits ? manualSplitsConfig(input.splits!) : null;
  if (stagedSplits) computeSplitLines(item.amount, stagedSplits);

  const [updated] = await db.update(bankFeedItems)
    .set({
      assignedAccountId: input.accountId,
      assignedContactId: input.contactId ?? null,
      assignedTagId: input.tagId ?? null,
      assignedMemo: input.memo ?? null,
      // The owner's split, or none: an account without splits clears a
      // split a rule staged (U-164).
      splitsConfig: stagedSplits,
      assignedBy: userId ?? null,
      assignedAt: new Date(),
      status: 'assigned',
      updatedAt: new Date(),
    })
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      eq(bankFeedItems.id, feedItemId),
      // Guard against a concurrent approve/exclude between the read and write.
      sql`${bankFeedItems.status} IN ('pending', 'assigned')`,
    ))
    .returning();

  if (!updated) {
    const [now] = await db.select({ status: bankFeedItems.status }).from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId))).limit(1);
    throw feedItemNotPending(now?.status ?? null);
  }

  await auditLog(tenantId, 'update', 'bank_feed', feedItemId, item, updated, userId);
  return updated;
}

/**
 * APPROVE — post a previously-staged ('assigned') feed item to the ledger
 * using its assigned_* values. Transitions assigned → 'categorized' and
 * stamps matchedTransactionId. Requires status 'assigned' (else 409
 * FEED_ITEM_NOT_PENDING {status}, U-173) with an assigned_account_id (else
 * 400). Lock dates are enforced by the underlying ledger post.
 */
export async function approve(tenantId: string, feedItemId: string, userId?: string, companyId?: string) {
  return postFeedItem(tenantId, feedItemId, ['assigned'], (item) => {
    // Defensive: assign() always sets assigned_account_id, but guard anyway so
    // a hand-edited row can't post an empty category.
    if (!item.assignedAccountId) throw AppError.badRequest('No staged category to approve. Assign an account first.');
    return {
      accountId: item.assignedAccountId,
      // Fall back to the rule/AI/check-image suggested payee when assign()
      // staged none. assign() writes assigned_contact_id from the request and
      // nulls it when absent, so without this fallback a row whose payee the
      // Bank Feeds screen was showing (suggestedContactName) posts with no
      // contact at all. categorize() has always had this fallback; approve()
      // silently dropped it.
      contactId: item.assignedContactId ?? item.suggestedContactId ?? undefined,
      // Approve posts the tag exactly as staged (explicit id or null — no
      // suggested-tag fallback; the user already made the choice at assign).
      tagId: item.assignedTagId ?? null,
      memo: resolveFeedMemo(item, item.assignedMemo as string | null),
      splitsConfig: item.splitsConfig as FeedSplitsConfig,
    };
  }, userId, companyId);
}

export interface MatchOptions {
  /** The entry's line on the bank account (U-166); inferred when only one fits. */
  journalLineId?: string;
  /** Kept for callers of the U-136 era: not pending is always 409 now (U-173). */
  conflictCode?: boolean;
  userId?: string;
  companyId?: string;
  /** U-169: record the link in this accept group (POST /accept) instead of a group of its own. */
  acceptGroupId?: string;
  /** U-169: the record kind: 'payment' for POST /payments/receive with bankFeedItemId (U-136). */
  recordKind?: 'match' | 'payment';
  /** Called with the accept group the link was recorded in (the Undo toast's group). */
  onRecorded?: (undoGroupId: string) => void;
}

/**
 * Match a pending or assigned feed item to one journal line of a posted
 * entry (U-166, feed-match-v2), in one database transaction (claims the
 * Idempotency-Key). See matchInTx.
 */
export async function match(tenantId: string, feedItemId: string, transactionId: string, opts: MatchOptions = {}) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    return matchInTx(tx, tenantId, feedItemId, transactionId, opts);
  });
}

/**
 * match() on the caller's executor (U-136): POST /payments/receive with
 * bankFeedItemId matches the feed line in the payment's own database
 * transaction, so both commit or neither.
 *
 * U-166: the item (FOR UPDATE) must be pending or assigned (else 409
 * FEED_ITEM_NOT_PENDING {status}); the entry (FOR SHARE) must be posted and
 * have a line on the item's bank account on the right side for exactly the
 * amount (400 MATCH_MISMATCH {field}); with more than one such line the
 * caller names it (400 LINE_REQUIRED); a line another item holds is 409
 * LINE_ALREADY_MATCHED. Audited.
 */
export async function matchInTx(
  executor: DbOrTx, tenantId: string, feedItemId: string, transactionId: string, opts: MatchOptions = {},
) {
  const [item] = await executor.select().from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)))
    .for('update');
  if (!item || (opts.companyId && item.companyId && item.companyId !== opts.companyId)) {
    throw AppError.notFound('Bank feed item not found');
  }
  if (item.status !== 'pending' && item.status !== 'assigned') throw feedItemNotPending(item.status);
  const [conn] = await executor.select({ accountId: bankConnections.accountId }).from(bankConnections)
    .where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, item.bankConnectionId))).limit(1);
  if (!conn) throw AppError.notFound('Bank connection not found');

  // S2: the entry can't be voided or deleted under the match.
  const [txn] = await executor.select({ id: transactions.id, status: transactions.status, companyId: transactions.companyId })
    .from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)))
    .for('share');
  if (!txn || txn.status !== 'posted' || (opts.companyId && txn.companyId && txn.companyId !== opts.companyId)) {
    throw matchMismatch('transactionId');
  }
  const lineId = await resolveMatchLine(executor, tenantId,
    { id: item.id, amount: item.amount, feedDate: item.feedDate }, conn.accountId, transactionId, opts.journalLineId);

  let matched: typeof bankFeedItems.$inferSelect | undefined;
  try {
    [matched] = await executor.update(bankFeedItems)
      .set({
        status: 'matched',
        matchedTransactionId: transactionId,
        matchedJournalLineId: lineId,
        entryVoidedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)))
      .returning();
  } catch (err) {
    // Another item took the line between the check and here (uq_bfi_matched_journal_line).
    if ((err as { code?: string; cause?: { code?: string } })?.cause?.code === '23505'
      || (err as { code?: string })?.code === '23505') {
      throw AppError.conflict('Another bank line is already matched to this entry line.', 'LINE_ALREADY_MATCHED',
        { journalLineId: lineId });
    }
    throw err;
  }
  await auditLog(tenantId, 'update', 'bank_feed', feedItemId,
    { status: item.status, matchedTransactionId: item.matchedTransactionId },
    { status: 'matched', matchedTransactionId: transactionId, matchedJournalLineId: lineId,
      ...(opts.acceptGroupId ? { undoGroupId: opts.acceptGroupId } : {}) }, opts.userId, executor);
  // U-169: the accept record Undo works from (B5): in the caller's group, or one of its own.
  const record = { kind: opts.recordKind ?? 'match', before: item, transactionId, journalLineId: lineId } as const;
  if (opts.acceptGroupId) {
    await recordAcceptItem(executor, { tenantId, companyId: opts.companyId, groupId: opts.acceptGroupId, ...record });
    opts.onRecorded?.(opts.acceptGroupId);
  } else {
    opts.onRecorded?.(await recordAcceptGroup(executor, {
      tenantId, companyId: opts.companyId, userId: opts.userId, source: record.kind, items: [record],
    }));
  }
  return matched;
}

/**
 * Find candidate journal lines that could match a bank feed item (U-166,
 * feed-match-v2): lines on the item's bank account, on the right side (a
 * credit for money out, a debit for money in), for exactly |amount|, on a
 * posted entry within ±15 days, not held by another feed item. One row per
 * line (`id` is the entry, `journalLineId` its line): a payroll entry with
 * two bank lines is two candidates. `amount` is in the feed sign.
 *
 * (Was ±5; widened 2026-08-11 — printed checks routinely take longer than a
 * week to clear. The list's matchCandidateCount uses the same predicate.)
 * Bill payments are listed first so users can avoid creating duplicate
 * expenses for bills they already paid through Pay Bills.
 */
export async function findMatchCandidates(tenantId: string, feedItemId: string) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) return [];

  // Resolve the connected bank account so we only suggest lines that
  // touched the same physical account.
  if (!item.bankConnectionId) return [];
  const conn = await db.query.bankConnections.findFirst({
    where: and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, item.bankConnectionId)),
  });
  if (!conn) return [];

  // Exact decimals (U-136): no parseFloat, no tolerance.
  const feedAmount = new Decimal(String(item.amount || '0'));
  if (feedAmount.isZero()) return [];

  const rows = await db.execute(sql`
    SELECT t.id, jl.id AS journal_line_id, t.txn_type, t.txn_number, t.txn_date, t.total, t.memo,
      t.check_number, t.print_status, t.source, jl.description AS line_description,
      c.display_name AS contact_name
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE ${lineCandidatePredicate({
      tenantId,
      bankAccountId: sql`${conn.accountId}`,
      amount: sql`${item.amount}`,
      feedDate: sql`${item.feedDate}`,
      itemId: sql`${feedItemId}`,
    })}
    ORDER BY
      CASE t.txn_type WHEN 'bill_payment' THEN 0 ELSE 1 END,
      ABS(t.txn_date - CAST(${item.feedDate} AS date)) ASC,
      t.id, jl.line_order NULLS LAST, jl.id
    LIMIT 20
  `);

  const feedSign = feedAmount.toFixed(2);
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    journalLineId: r.journal_line_id,
    txnType: r.txn_type,
    txnNumber: r.txn_number,
    txnDate: r.txn_date,
    total: r.total,
    // The line's amount in the feed sign (equal to the item's amount).
    amount: feedSign,
    memo: r.memo,
    lineDescription: r.line_description,
    checkNumber: r.check_number,
    printStatus: r.print_status,
    source: r.source,
    contactName: r.contact_name,
  }));
}

/** The current status of an item (null when it doesn't exist in this tenant). */
async function statusOf(executor: DbOrTx, tenantId: string, feedItemId: string): Promise<string | null | undefined> {
  const [row] = await executor.select({ status: bankFeedItems.status }).from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId))).limit(1);
  return row ? row.status : undefined;
}

/**
 * Exclude a pending or assigned item (U-173): anything else (posted,
 * matched, already excluded, in progress) is 409 FEED_ITEM_NOT_PENDING
 * {status}, so a posted entry is never stranded behind an excluded line.
 * `reason` 'duplicate' is the possible-duplicate "Remove this one" (U-174).
 */
export async function exclude(tenantId: string, feedItemId: string, userId?: string, opts: { reason?: 'duplicate'; executor?: DbOrTx } = {}) {
  const executor = opts.executor ?? db;
  const [updated] = await executor.update(bankFeedItems).set({
    status: 'excluded',
    exclusionReason: opts.reason ?? null,
    updatedAt: new Date(),
  }).where(and(
    eq(bankFeedItems.tenantId, tenantId),
    eq(bankFeedItems.id, feedItemId),
    sql`${bankFeedItems.status} IN ('pending', 'assigned')`,
  )).returning();

  if (!updated) {
    const status = await statusOf(executor, tenantId, feedItemId);
    if (status === undefined) throw AppError.notFound('Bank feed item not found');
    throw feedItemNotPending(status);
  }
  // Excluding is how a whole batch of bank activity gets taken out of the
  // books' path, and it left no trace at all beyond updated_at. Every other
  // state change on a feed item is audited; this one was not.
  await auditLog(tenantId, 'update', 'bank_feed', feedItemId, null,
    { status: 'excluded', ...(opts.reason ? { exclusionReason: opts.reason } : {}) }, userId, executor);
  return updated;
}

/**
 * Put an excluded row back in play.
 *
 * The exclude confirmation has always told users "you can restore them later
 * from the Excluded filter", and that was not true: excluded rows had no
 * restore path at all, so undoing a mistaken bulk exclude meant direct SQL.
 *
 * Only touches rows that are actually 'excluded' (else 409
 * FEED_ITEM_NOT_PENDING {status}, U-173). It must never resurrect a
 * categorized or matched row, which would strand a posted transaction against
 * a feed line that thinks it is unhandled. A row removed as a duplicate
 * (U-174) comes back undecided: still flagged as a possible duplicate.
 */
export async function unexclude(tenantId: string, feedItemId: string, userId?: string) {
  const [updated] = await db.update(bankFeedItems).set({
    status: 'pending',
    exclusionReason: null,
    updatedAt: new Date(),
  }).where(and(
    eq(bankFeedItems.tenantId, tenantId),
    eq(bankFeedItems.id, feedItemId),
    eq(bankFeedItems.status, 'excluded'),
  )).returning();

  if (!updated) {
    const status = await statusOf(db, tenantId, feedItemId);
    if (status === undefined) throw AppError.notFound('Bank feed item not found');
    throw feedItemNotPending(status);
  }
  await auditLog(tenantId, 'update', 'bank_feed', feedItemId, { status: 'excluded' }, { status: 'pending' }, userId);
  return updated;
}

/**
 * The owner's decision on a possible duplicate (U-174, feed-review-v1;
 * Q-P26b, Q-P26g): `keep` clears the flag (both rows stay, this one waits
 * for review as usual); `remove` excludes this row with reason 'duplicate'
 * (the flag stays, so Restore brings it back undecided). Only a waiting
 * (pending or assigned) row flagged as a possible duplicate: else 409
 * NOT_A_POSSIBLE_DUPLICATE {status, possibleDuplicate}. One database
 * transaction (claims the Idempotency-Key), audited.
 */
export async function decideDuplicate(
  tenantId: string, feedItemId: string, decision: 'keep' | 'remove', userId?: string, companyId?: string,
) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const [item] = await tx.select().from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)))
      .for('update');
    if (!item || (companyId && item.companyId && item.companyId !== companyId)) throw AppError.notFound('Bank feed item not found');
    if (!item.possibleDuplicate || (item.status !== 'pending' && item.status !== 'assigned')) {
      throw AppError.conflict('This bank line is not waiting as a possible duplicate.', 'NOT_A_POSSIBLE_DUPLICATE',
        { status: item.status, possibleDuplicate: item.possibleDuplicate });
    }
    if (decision === 'remove') {
      const updated = await exclude(tenantId, feedItemId, userId, { reason: 'duplicate', executor: tx });
      return { item: updated, decision };
    }
    const [updated] = await tx.update(bankFeedItems).set({ possibleDuplicate: false, updatedAt: new Date() })
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)))
      .returning();
    await auditLog(tenantId, 'update', 'bank_feed', feedItemId,
      { possibleDuplicate: true, possibleDuplicateOf: item.possibleDuplicateOf },
      { possibleDuplicate: false, duplicateDecision: 'keep' }, userId, tx);
    return { item: updated!, decision };
  });
}

/**
 * Flags the feed items linked to an entry being voided (Q-P26u, review B4,
 * U-166): the void goes ahead; every item pointing at the entry (both sides
 * of a transfer) keeps its status and its link, gets entry_voided_at, and an
 * audit row (bank_feed, entry_voided). The bank line is never lost: it is
 * listed with entryVoided (filter entryVoided=true, /counts entryVoided)
 * until "Review again". Called inside the void's database transaction.
 */
export async function flagEntryVoidedInTx(tx: DbOrTx, tenantId: string, transactionId: string, userId?: string): Promise<string[]> {
  const flagged = await tx.update(bankFeedItems).set({ entryVoidedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      eq(bankFeedItems.matchedTransactionId, transactionId),
      sql`${bankFeedItems.entryVoidedAt} IS NULL`,
    ))
    .returning({ id: bankFeedItems.id, status: bankFeedItems.status });
  for (const f of flagged) {
    await auditLog(tenantId, 'update', 'bank_feed', f.id, { status: f.status, matchedTransactionId: transactionId },
      { action: 'entry_voided', status: f.status, matchedTransactionId: transactionId }, userId, tx);
  }
  return flagged.map((f) => f.id);
}

/**
 * Hook for the accept records of E3 (U-169): restores the row exactly as it
 * was before its accept. Until those records exist, the row goes back to
 * pending with its suggestion and without staged values (so a row that was
 * untouched before it was accepted is untouched again for import Undo).
 */
export type PriorStateRestorer = (tx: DbOrTx, tenantId: string, item: typeof bankFeedItems.$inferSelect)
  => Promise<Partial<typeof bankFeedItems.$inferInsert> | null>;
let priorStateRestorer: PriorStateRestorer | null = null;
export function setPriorStateRestorer(fn: PriorStateRestorer | null): void {
  priorStateRestorer = fn;
}

/**
 * "Review again" on a row whose entry was voided (Q-P26u, U-166): unlinks
 * it (clears the entry, its line and entry_voided_at) and puts it back to
 * waiting, audited, in one database transaction (claims the
 * Idempotency-Key). 409 ENTRY_NOT_VOIDED {status} on any other row. The void
 * entry itself stays as it is (void, in the audit trail).
 */
export async function reviewAgain(tenantId: string, feedItemId: string, userId?: string, companyId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const [item] = await tx.select().from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)))
      .for('update');
    if (!item || (companyId && item.companyId && item.companyId !== companyId)) throw AppError.notFound('Bank feed item not found');
    if (!item.entryVoidedAt) {
      throw AppError.conflict('The entry for this bank line was not voided, so there is nothing to review again.', 'ENTRY_NOT_VOIDED',
        { status: item.status });
    }
    const restored = priorStateRestorer ? await priorStateRestorer(tx, tenantId, item) : null;
    const [updated] = await tx.update(bankFeedItems).set({
      status: 'pending',
      assignedAccountId: null,
      assignedContactId: null,
      assignedTagId: null,
      assignedMemo: null,
      assignedBy: null,
      assignedAt: null,
      ...(restored ?? {}),
      matchedTransactionId: null,
      matchedJournalLineId: null,
      entryVoidedAt: null,
      closeReviewedAt: null,
      closeReviewedBy: null,
      updatedAt: new Date(),
    }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId))).returning();
    await auditLog(tenantId, 'update', 'bank_feed', feedItemId,
      { status: item.status, matchedTransactionId: item.matchedTransactionId, entryVoidedAt: item.entryVoidedAt },
      { action: 'review_again', status: updated!.status }, userId, tx);
    return updated!;
  });
}

/** Restore many at once, mirroring bulkExclude's per-row tolerance. */
export async function bulkUnexclude(tenantId: string, feedItemIds: string[], userId?: string) {
  let restored = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of feedItemIds) {
    try {
      await unexclude(tenantId, id, userId);
      restored++;
    } catch (err) {
      failures.push({ id, error: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return { restored, failures };
}

/**
 * BULK APPROVE — commit every selected item that HAS a category to post:
 *   - 'assigned' items → post their staged assigned_* values (via approve()).
 *   - 'pending' items with an AI/rule suggestedAccountId → post that
 *     suggestion (via categorize()). This is the explicit "accept and
 *     commit these" action, so it posts regardless of confidence — the
 *     user hand-selected the rows and clicked Approve.
 *
 * Skipped (never posted): pending WITHOUT a suggestion (nothing to post),
 * and already-processed rows (categorized/matched/excluded, or missing).
 * Per-item try/catch keeps one failure (e.g. a lock-date rejection) from
 * aborting the batch.
 */
export async function bulkApprove(tenantId: string, feedItemIds: string[], userId?: string, companyId?: string) {
  if (!Array.isArray(feedItemIds)) {
    throw AppError.badRequest('feedItemIds must be an array');
  }
  // Cap the batch size — the sequential loop makes one DB round-trip per id;
  // an uncapped input serializes thousands of ledger posts on one request.
  const MAX_BATCH = 500;
  if (feedItemIds.length > MAX_BATCH) {
    throw AppError.badRequest(`Bulk approve is limited to ${MAX_BATCH} items per request`);
  }

  let approved = 0;
  let skipped = 0;
  // `code` (U-165): the failed item's error code, e.g. TB_PERIOD_LOCKED.
  const failures: Array<{ id: string; error: string; code?: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (!item) { skipped++; continue; }
      if (item.status === 'assigned') {
        // Post the staged assignment.
        await approve(tenantId, id, userId, companyId);
        approved++;
      } else if (item.status === 'pending' && item.suggestedAccountId) {
        // Post the AI/rule suggestion. Bulk Approve is an EXPLICIT user
        // action on hand-selected rows, so it commits any selected item
        // that has a category to post — no confidence gate here (that
        // gate is for unattended auto-approval, not this deliberate one).
        // A pending item with no suggestion has nothing to post → skip.
        await categorize(tenantId, id, {
          accountId: item.suggestedAccountId,
          contactId: item.suggestedContactId ?? undefined,
          tagId: item.suggestedTagId ?? undefined,
        }, userId, companyId);
        approved++;
      } else {
        // pending-without-suggestion / already posted / excluded / matched.
        skipped++;
      }
    } catch (err: any) {
      failures.push({ id, error: err?.message || 'unknown error', ...(typeof err?.code === 'string' ? { code: err.code } : {}) });
    }
  }
  return { approved, skipped, failed: failures.length, failures };
}

/**
 * BULK ASSIGN — stage the SAME assignment (account/contact/tag/memo) across
 * many pending/assigned items. Powers the toolbar "Categorize" action, which
 * now STAGES rather than posts. Reuses assign() per item so validation and
 * audit logging stay identical to the single-item path; per-item try/catch
 * keeps one bad item from aborting the batch.
 */
export async function bulkAssign(tenantId: string, feedItemIds: string[], input: AssignInput, userId?: string) {
  if (!Array.isArray(feedItemIds)) {
    throw AppError.badRequest('feedItemIds must be an array');
  }
  const MAX_BATCH = 500;
  if (feedItemIds.length > MAX_BATCH) {
    throw AppError.badRequest(`Bulk assign is limited to ${MAX_BATCH} items per request`);
  }

  let assigned = 0;
  let skipped = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (item && (item.status === 'pending' || item.status === 'assigned')) {
        await assign(tenantId, id, input, userId);
        assigned++;
      } else {
        skipped++;
      }
    } catch (err) {
      failures.push({ id, error: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return { assigned, skipped, failed: failures.length, failures };
}

export async function bulkCategorize(tenantId: string, feedItemIds: string[], accountId: string, contactId?: string, memo?: string, tagId?: string | null, userId?: string, companyId?: string) {
  let categorized = 0;
  const failures: Array<{ id: string; error: string; code?: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (item && item.status === 'pending') {
        await categorize(tenantId, id, { accountId, contactId, memo, tagId }, userId, companyId, { ownerChoice: true });
        categorized++;
      }
    } catch (err: any) {
      failures.push({ id, error: err?.message || 'unknown error', ...(typeof err?.code === 'string' ? { code: err.code } : {}) });
    }
  }
  return { categorized, failures };
}

// ADR 0XX §7 / build plan Phase 8 — Bank Feed bulk "set tag" action.
// Applies only to feed items that have already been converted into a
// transaction (status in 'categorized' or 'matched'). Stamps the given
// tag onto every journal_line of each matched transaction and syncs
// the transaction_tags junction when TAGS_SPLIT_LEVEL_V2 is on.
// Bank Feed bulk "set name": overwrite the (cleaned) description shown in the
// NAME column for the selected items — useful for normalizing a batch of cryptic
// bank descriptors to one human-readable payee/name. Tenant-scoped; the raw
// originalDescription is preserved.
// Bulk "Set Name" assigns a PAYEE CONTACT to the selected feed items — the
// same thing the single-item editor does — so the name shows in the NAME
// column (assigned contact → suggested contact → description precedence) AND
// carries onto the posted transaction's contact_id. The previous version
// wrote bankFeedItems.description, the lowest-precedence field, so on any row
// that already had a suggested/assigned contact the typed name was invisible
// and the posted transaction's payee stayed empty.
//
// Match-existing-only: the typed name is matched (case-insensitive, exact) to
// an existing tenant contact. If no contact matches, nothing is created and
// every selected row is reported as skipped — the caller surfaces that so the
// user can create the contact (or pick it from the list) first.
/**
 * Bulk "Set payee" from the Uncategorized page: put ONE contact (or none) on
 * many still-pending lines without staging or posting them. Writes
 * suggested_contact_id — the field updateFeedItem and the Bank Feeds editor
 * write — so the line stays `pending`, stays on the Not posted list, and the
 * contact carries onto the transaction when the line is later categorized
 * (categorize() falls back to suggestedContactId). Contrast bulkSetName,
 * which flips pending → assigned.
 *
 * Lines not in `pending` are reported as skipped, never touched: an assigned
 * line has a human-staged contact this must not silently override, and a
 * posted line's payee lives on the transaction.
 */
export async function bulkSetContact(
  tenantId: string,
  feedItemIds: string[],
  contactId: string | null,
): Promise<{ updated: number; skipped: Array<{ id: string; reason: string }> }> {
  if (contactId) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
    });
    if (!contact) throw AppError.badRequest('Contact not found in this tenant');
  }
  const ids = [...new Set(feedItemIds)];
  const rows = await db.select({ id: bankFeedItems.id, status: bankFeedItems.status })
    .from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, ids)));
  const statusById = new Map(rows.map((r) => [r.id, r.status]));

  const skipped: Array<{ id: string; reason: string }> = [];
  const targets: string[] = [];
  for (const id of ids) {
    const status = statusById.get(id);
    if (!status) skipped.push({ id, reason: 'not_found_or_wrong_tenant' });
    else if (status !== 'pending') skipped.push({ id, reason: `already_${status}` });
    else targets.push(id);
  }
  if (targets.length === 0) return { updated: 0, skipped };

  const updated = await db.update(bankFeedItems)
    .set({ suggestedContactId: contactId, updatedAt: new Date() })
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      inArray(bankFeedItems.id, targets),
      // Re-checked in the write: a line approved between the read and here
      // must not have its posted payee silently shadowed.
      eq(bankFeedItems.status, 'pending'),
    ))
    .returning({ id: bankFeedItems.id });
  return { updated: updated.length, skipped };
}

export async function bulkSetName(tenantId: string, feedItemIds: string[], name: string) {
  const trimmed = name.trim();
  if (!trimmed || feedItemIds.length === 0) {
    return { updated: 0, skipped: feedItemIds.length, matchedContactId: null, matchedContactName: null, failures: [] as Array<{ id: string; error: string }> };
  }

  // Resolve the name to one existing contact. Prefer an exact
  // case-insensitive display-name match; among ties, the oldest active
  // contact wins (deterministic). No fuzzy matching here — bulk assignment
  // must be predictable, not a guess.
  const match = await db.query.contacts.findFirst({
    where: and(
      eq(contacts.tenantId, tenantId),
      sql`lower(${contacts.displayName}) = lower(${trimmed})`,
    ),
    orderBy: (c, { asc }) => [asc(c.createdAt)],
  });

  if (!match) {
    return { updated: 0, skipped: feedItemIds.length, matchedContactId: null, matchedContactName: null, noContactMatch: true, failures: [] as Array<{ id: string; error: string }> };
  }

  const contactId = match.id;
  let updated = 0;
  const failures: Array<{ id: string; error: string }> = [];

  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (!item) { failures.push({ id, error: 'feed item not found' }); continue; }

      if (!item.matchedTransactionId) {
        // Not yet posted — stage the contact on the feed item so it carries
        // into the ledger on approve (postAssignment reads assignedContactId).
        if (item.status !== 'pending' && item.status !== 'assigned') {
          failures.push({ id, error: `cannot set name on item in status ${item.status}` });
          continue;
        }
        await db.update(bankFeedItems)
          .set({
            assignedContactId: contactId,
            status: item.status === 'pending' ? 'assigned' : item.status,
            updatedAt: new Date(),
          })
          .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)));
        updated++;
        continue;
      }

      // Already posted — set the contact on the transaction (and its journal
      // lines) so the posted "Name" reflects the payee. Mirror the feed row
      // too, so the list keeps showing the assigned contact. One per-item
      // transaction keeps txn/journal_lines/feed-row consistent.
      await db.transaction(async (tx) => {
        // Set the contact on the transaction HEADER only — that's where a
        // normally-posted check/bill carries its payee; ledger.postTransaction
        // leaves journal-line contactId null (except lines explicitly given
        // one). Stamping every line here (incl. the bank leg) diverged from
        // that and skewed any contact-grouped journal-line reporting.
        await tx.update(transactions).set({ contactId, updatedAt: new Date() })
          .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, item.matchedTransactionId!)));
        await tx.update(bankFeedItems).set({ assignedContactId: contactId, updatedAt: new Date() })
          .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)));
      });
      updated++;
    } catch (err: any) {
      failures.push({ id, error: err?.message || 'unknown error' });
    }
  }

  return {
    updated,
    skipped: feedItemIds.length - updated - failures.length,
    matchedContactId: contactId,
    matchedContactName: match.displayName,
    failures,
  };
}

export async function bulkSetTag(tenantId: string, feedItemIds: string[], tagId: string | null) {
  // Cross-tenant guard: a client could otherwise know another tenant's
  // tag UUID and stamp it onto their own journal lines. Validate once
  // up front so the loop below doesn't repeat the check per item.
  if (tagId) await assertTagsInTenant(tenantId, [tagId]);
  let updated = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (!item) {
        failures.push({ id, error: 'feed item not found' });
        continue;
      }
      if (!item.matchedTransactionId) {
        // Not yet posted. Stage the tag on the feed item so it carries into
        // the ledger when the item is approved/posted (approve reads
        // assigned_tag_id — see postAssignment/approve). Previously these
        // items were silently skipped, so bulk-tagging pending/assigned
        // rows appeared to do nothing.
        if (item.status !== 'pending' && item.status !== 'assigned') {
          failures.push({ id, error: `cannot tag item in status ${item.status}` });
          continue;
        }
        await db.update(bankFeedItems)
          .set({ assignedTagId: tagId, updatedAt: new Date() })
          .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)));
        updated++;
        continue;
      }
      // Already posted — retag the transaction's journal lines directly.
      // Wrap the journal_lines update + transaction_tags sync in a
      // single per-item transaction so a mid-flight failure can't leave
      // journal_lines.tagId stamped while transaction_tags is stale (or
      // vice versa). Per-item rather than around the whole batch keeps
      // partial-progress visibility — the failures[] result still
      // identifies which item didn't apply.
      await db.transaction(async (tx) => {
        await tx.update(journalLines).set({ tagId })
          .where(and(
            eq(journalLines.tenantId, tenantId),
            eq(journalLines.transactionId, item.matchedTransactionId!),
          ));
        if (tagId) {
          await tx.insert(transactionTagsTable).values({
            tenantId,
            companyId: item.companyId,
            transactionId: item.matchedTransactionId!,
            tagId,
          }).onConflictDoNothing();
        } else {
          await tx.delete(transactionTagsTable).where(and(
            eq(transactionTagsTable.tenantId, tenantId),
            eq(transactionTagsTable.transactionId, item.matchedTransactionId!),
          ));
        }
      });
      updated++;
    } catch (err: any) {
      failures.push({ id, error: err?.message || 'unknown error' });
    }
  }
  return { updated, failures };
}

export async function bulkExclude(tenantId: string, feedItemIds: string[], userId?: string) {
  let excluded = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (item && item.status === 'pending') {
        await exclude(tenantId, id, userId);
        excluded++;
      }
    } catch (err: any) {
      failures.push({ id, error: err?.message || 'unknown error' });
    }
  }
  return { excluded, failures };
}

/**
 * Full cleansing pipeline per AI_PROCESSING_PLAN.md §3.1:
 *   1. Tenant bank rules (deterministic)
 *   2. Global bank rules (deterministic)
 *   3. Categorization history lookup (local, no AI)
 *   4. AI categorization (LLM — returns clean vendor name + category suggestion)
 *   5. Basic cleaning (last resort fallback if all above fail)
 *
 * Each step can produce a clean name. The first step that succeeds wins.
 * Steps 3 & 4 also set suggestedAccountId/suggestedContactId on the feed item.
 */
/**
 * STATEMENT_CHECK_PAYEE_V1 — correlate payees read off check-image
 * thumbnails to their "CHECK ####" feed items. Match by check number, then
 * confirm by amount (within a cent). On a match we always stage the read
 * payee on `payee_name_on_check` (report fallback + audit); resolves the payee
 * to a contact (matching an existing one, else creating a vendor contact) and
 * sets `suggested_contact_id` so the posted transaction gets a real
 * `contact_id`, and the check payee also feeds the cleansed name + rule matching.
 */
async function applyCheckImagePayees(
  tenantId: string,
  items: Array<typeof bankFeedItems.$inferSelect>,
  checks: StatementCheckImage[],
) {
  // Debit-side only: a check is money out, so a deposit can never receive a
  // check payee no matter how its description parsed. This is the single
  // guard that prevents "DEPOSIT REF #1234" from acquiring check 1234's
  // image payee — the check number itself stays on the row for reporting.
  const candidates = items.filter((it) => it.checkNumber != null && parseFloat(String(it.amount)) > 0);
  if (candidates.length === 0) return;

  const byNumber = new Map<number, StatementCheckImage[]>();
  for (const c of checks) {
    // Bank check-sequence markers ('1042*', '1042A') are legitimate variants
    // of check 1042 — parseInt buckets them onto 1042, matching the integer
    // feed-item number. A ref with no leading digits has no valid bucket.
    const n = Number.parseInt(c.checkNumber, 10);
    if (!Number.isFinite(n)) continue;
    const arr = byNumber.get(n) ?? [];
    arr.push(c);
    byNumber.set(n, arr);
  }
  if (byNumber.size === 0) return;

  const tenantContacts = await db.query.contacts.findMany({
    where: eq(contacts.tenantId, tenantId),
    columns: { id: true, displayName: true },
  });
  const contactsService = await import('./contacts.service.js');

  for (const item of candidates) {
    const num = item.checkNumber as number;
    const matches = byNumber.get(num);
    if (!matches || matches.length === 0) continue;
    const feedAmount = Math.abs(parseFloat(String(item.amount || '0')));
    // Confirm by amount within a cent; if a check thumbnail had no readable
    // amount, fall back to number-only when it's the sole check with that #.
    // A sole candidate whose READABLE amount disagrees is a different
    // check sharing the number — never apply it (this path also
    // auto-creates a contact at 0.95 confidence, so a wrong write here
    // compounds).
    const amountAgrees = (c: StatementCheckImage) =>
      c.amount != null && Math.abs(Math.abs(parseFloat(c.amount)) - feedAmount) <= 0.01;
    const match =
      matches.find(amountAgrees) ??
      (matches.length === 1 && matches[0]!.amount == null ? matches[0] : undefined);
    if (!match) continue;
    const payee = match.payee.trim();
    if (!payee) continue;

    let contact = matchByName(tenantContacts, (c) => c.displayName, payee);
    if (!contact) {
      // Auto-create a vendor contact from the check payee so the Payee column
      // fills in and later imports/rules can match it. Best-effort: a creation
      // failure just leaves the payee as metadata (the prior behavior).
      try {
        const created = await contactsService.create(tenantId, {
          displayName: payee.slice(0, 255),
          contactType: 'vendor',
        });
        contact = { id: created.id, displayName: created.displayName };
        tenantContacts.push(contact); // reuse for another check with the same payee
      } catch (err) {
        // U-167: never the payee itself, only the error code and the item id.
        console.warn(`[applyCheckImagePayees] contact create failed for item ${item.id}: ${errorSummaryForLog(err)}`);
      }
    }
    const update: Partial<typeof bankFeedItems.$inferInsert> = {
      payeeNameOnCheck: payee.slice(0, 255),
      updatedAt: new Date(),
    };
    if (contact) {
      update.suggestedContactId = contact.id;
      update.matchType = 'check_image';
      update.confidenceScore = '0.95';
    }
    await db.update(bankFeedItems).set(update)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)));
    // Mirror onto the in-memory row so the cleansing pipeline below sees it.
    item.payeeNameOnCheck = update.payeeNameOnCheck ?? null;
    if (contact) item.suggestedContactId = contact.id;
  }
}

/** Outcome accounting for one runCleansingPipeline() invocation, surfaced
 *  additively on every import/re-cleanse response so an AI outage is
 *  visible instead of silently degrading to regex-only cleaning. */
export interface CleansingAggregate {
  /** Items that went through the pipeline. */
  processed: number;
  /** Items whose clean name came from the AI/history step. */
  aiCleansed: number;
  /** Items whose AI step threw — or was skipped after repeated failures. */
  aiFailed: number;
  /** Items whose AI step was skipped because AI is deliberately off
   *  (globally disabled, no provider, or the function's "Enable this
   *  function" toggle) — deterministic cleaning still ran. */
  disabled: number;
  /** First AI failure message, for operator-facing surfaces. */
  firstError?: string;
}

export function emptyCleansingAggregate(): CleansingAggregate {
  return { processed: 0, aiCleansed: 0, aiFailed: 0, disabled: 0 };
}

// Error codes that mean the AI step is DELIBERATELY unavailable — an admin
// state, not an outage. Counted as `disabled` (silent skip) so non-AI
// installs don't see "AI cleanup unavailable" warnings on every import. The
// consecutive-OUTAGE short-circuit itself now lives in the batched engine
// (categorizeFeedItemsBatch), at batch granularity (FIX 3).
const CLEANSE_DISABLED_CODES = new Set([
  'ai_disabled_globally',
  'ai_no_provider_configured',
  'ai_function_disabled',
  // A company that hasn't opted in / enabled the task (or whose consent is
  // stale) is a deliberate state, not a provider outage — bucket it as
  // `disabled` (silent), never as a "failure". createJob throws this code
  // (ai_consent_blocked).
  'ai_consent_blocked',
]);

// Apply an AI/history contact name to a feed item description, mirroring the
// single path's validated/unvalidated handling. Returns the name to write, or
// null when the (unvalidated) model text isn't a plausible name.
export function applyCleanseContactName(contactName: string, contactId: string | null | undefined): string | null {
  if (contactId) {
    // VALIDATED: resolved to a real tenant contact — trusted as-is.
    return String(contactName).slice(0, 255);
  }
  // UNVALIDATED raw model text: never written verbatim — normalize through the
  // same deterministic cleaner as the regex fallback and keep only a plausible
  // name (has letters). Otherwise the caller falls back to the regex-cleaned
  // original.
  const aiCleaned = cleanBankDescription(String(contactName)).slice(0, 255).trim();
  if (aiCleaned.length >= 2 && /[a-z]/i.test(aiCleaned)) return aiCleaned;
  return null;
}

export async function runCleansingPipeline(
  tenantId: string,
  items: any[],
  // `llm: false` (the bank-file import batch, U-06) skips the LLM pass
  // whatever the AI settings say; deterministic cleaning still runs.
  opts: { llm?: boolean } = {},
): Promise<CleansingAggregate> {
  const agg = emptyCleansingAggregate();

  // M1: the LLM cleansing step is a real paid AI call, so it honors the
  // "Auto-categorize bank feed transactions on import" master switch
  // (ai_config.autoCategorizeOnImport). When off, skip the LLM entirely
  // (counted as `disabled`) — deterministic rules + regex cleaning still run.
  const { getConfig } = await import('./ai-config.service.js');
  // Desktop mode (Q-P26c, S6): AI runs only when the owner asks, never in
  // the unattended cleansing (imports, recleanse).
  const llmOff = opts.llm === false || isDesktop();
  const aiCfg = llmOff ? null : await getConfig().catch(() => null);
  const aiDisabled = llmOff || !(aiCfg?.autoCategorizeOnImport ?? true);

  const { resolvePreAiLayers, categorizeFeedItemsBatch } = await import('./ai-categorization.service.js');

  // The fields the cleansing pipeline reads/writes on each feed item. The
  // callers pass full bankFeedItems rows (typed `any[]` at the boundary);
  // narrowing here keeps the pipeline body free of `any`.
  type CleanseItem = {
    id: string;
    description: string | null;
    originalDescription: string | null;
    payeeNameOnCheck?: string | null;
    suggestedAccountId: string | null;
    confidenceScore: string | null;
  };
  interface Stash { item: CleanseItem; raw: string; cleanedName: string | null; wouldNeedLlm: boolean; }
  const stash: Stash[] = [];

  // ── Pass 1: deterministic naming + rules/history precedence (per item) ──
  // check-image → tenant/global rules → rule/history. Only items still
  // without a name AND without a rule/history hit become LLM candidates —
  // the LLM step (Pass 2) is what batches.
  for (const item of items) {
    agg.processed++;
    const raw = item.originalDescription || item.description || '';
    let cleanedName: string | null = null;

    // STATEMENT_CHECK_PAYEE_V1 — a payee read off the check image is the most
    // reliable name; use it and skip the AI guess.
    if (item.payeeNameOnCheck) cleanedName = item.payeeNameOnCheck;

    // Tenant rules, then global rules.
    if (!cleanedName) cleanedName = await cleanNameViaRules(tenantId, raw);

    let wouldNeedLlm = false;
    if (!cleanedName) {
      // Rules (Layer 1) + trusted history (Layer 2) — deterministic, persists
      // any hit. Runs regardless of the AI master switch (it's not an AI cost).
      const pre = await resolvePreAiLayers(tenantId, item).catch(() => null);
      if (pre && pre.contactName) {
        const applied = applyCleanseContactName(pre.contactName, pre.contactId);
        if (applied) { cleanedName = applied; agg.aiCleansed++; }
      } else if (!pre) {
        // No deterministic/history name → an LLM candidate.
        wouldNeedLlm = true;
      }
      // pre resolved without a contactName (e.g. a rule hit) → regex fallback,
      // never the LLM (matches the historical Layer-1 behavior).
    }
    stash.push({ item, raw, cleanedName, wouldNeedLlm });
  }

  // ── Batch: ONE LLM call per company-chunked batch of `batchSize` ──
  // (vs. one call per row). Governance, the array mapping, and the
  // consecutive-OUTAGE short-circuit (now at batch granularity) all live in
  // categorizeFeedItemsBatch. Skipped entirely when the master switch is off.
  const llmIds = aiDisabled ? [] : stash.filter((s) => s.wouldNeedLlm).map((s) => s.item.id);
  const llmResults = llmIds.length > 0
    ? await categorizeFeedItemsBatch(tenantId, llmIds, aiCfg ? { config: aiCfg } : undefined)
    : new Map();

  // ── Pass 2: apply LLM results, regex fallback, and write descriptions ──
  for (const s of stash) {
    let cleanedName = s.cleanedName;
    if (!cleanedName && s.wouldNeedLlm) {
      if (aiDisabled) {
        // Master switch off — LLM deliberately skipped (deterministic clean).
        agg.disabled++;
      } else {
        const r = llmResults.get(s.item.id);
        if (r?.outcome && r.outcome.contactName) {
          const applied = applyCleanseContactName(r.outcome.contactName, r.outcome.contactId);
          if (applied) { cleanedName = applied; agg.aiCleansed++; }
        } else if (r?.error) {
          if (CLEANSE_DISABLED_CODES.has(r.error.code)) {
            // Deliberate off-state (globally disabled / no provider / function
            // toggled off / consent not granted) — silent skip, not a failure.
            agg.disabled++;
          } else {
            agg.aiFailed++;
            if (!agg.firstError) agg.firstError = r.error.message;
            // eslint-disable-next-line no-console
            // U-167: the provider's error text may echo the description; the code only.
            console.warn(`[cleanse] AI step failed for item ${s.item.id}: code=${r.error.code}`);
          }
        } else if (r?.skipped) {
          // The batch covering this item was abandoned by the outage
          // short-circuit — count as a failure (it wasn't cleansed).
          agg.aiFailed++;
        }
        // r?.outcome without a usable name (no_confident_match) → regex below.
      }
    }

    // Basic cleaning (last resort).
    if (!cleanedName) cleanedName = cleanBankDescription(s.raw);

    if (cleanedName && cleanedName !== s.item.description) {
      await db.update(bankFeedItems).set({ description: cleanedName, updatedAt: new Date() })
        .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, s.item.id)));
      s.item.description = cleanedName;
    }
  }
  return agg;
}

/** Outcome of the two RULES stages (conditional rules → legacy bank
 *  rules). Shared by the import-time categorization pipeline and the
 *  bank-feed "Reprocess Rules" bulk action so rule semantics can never
 *  drift between the two entry points. */
/** A rule that fired for an item (U-168): its id and which table it is in. */
export interface RuleFire { ruleId: string | null; kind: 'conditional' | 'legacy' }

interface RulesStagesOutcome {
  /** Ids of items that were still 'pending' when rule evaluation ran. */
  processedIds: string[];
  /** itemId → rule attribution (first conditional fire wins; a legacy
   *  match otherwise). The pipeline feeds this into the
   *  classification-state upsert so Bucket 2 can render "grouped by
   *  rule"; a rule that doesn't auto-confirm still gets attributed. */
  ruleFiredByItem: Map<string, RuleFire>;
  /** Items where a Phase-4 conditional rule fired without
   *  continue_after_match — legacy bank-rule eval was skipped for
   *  these (build plan §4.5). */
  conditionalShortCircuited: Set<string>;
  /** Items posted to the ledger via a legacy autoConfirm rule (never in desktop mode, S6). */
  autoCategorizedIds: string[];
  /** Per-item autoConfirm posting failures. categorize() reverts the
   *  claim on failure, so these items stay pending and retryable. */
  failures: Array<{ id: string; error: string }>;
}

/**
 * The RULES stages of categorization, in build-plan order:
 *   1. Phase-4 conditional rules engine — stages suggestedAccountId /
 *      suggestedContactId / suggestedTagId / memo / skip_ai /
 *      splits_config on the feed item. A rule that fires without
 *      continue_after_match short-circuits stage 2 for that item.
 *   2. Legacy bank rules — a match records attribution; a match with
 *      autoConfirm + assignAccountId posts the item via categorize(),
 *      except in desktop mode (Q-P26o, S6) and the bank-file import batch,
 *      where a rule only stages its suggestion.
 *
 * Runs at import time (inside runCategorizationPipeline) and again on
 * demand via reprocessRules(). Items no rule matches are left untouched.
 */
async function runRulesStages(
  tenantId: string,
  items: Array<{ id: string }>,
  // `autoConfirm: false` (the bank-file import batch, U-06): a legacy rule
  // match is attributed but never posted.
  opts: { userId?: string; companyId?: string; autoConfirm?: boolean } = {},
): Promise<RulesStagesOutcome> {
  // S6, Q-P26o: rules never post in desktop mode (legacy auto_confirm and
  // split rules only stage); the owner accepts what they staged.
  const stageOnly = opts.autoConfirm === false || isDesktop();
  const bankRulesService = await import('./bank-rules.service.js');
  const conditionalRulesApply = await import('./conditional-rules-apply.service.js');

  const processedIds: string[] = [];
  const ruleFiredByItem = new Map<string, RuleFire>();
  const conditionalShortCircuited = new Set<string>();
  const autoCategorizedIds: string[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  // Stage 1 — conditional rules engine. Runs BEFORE legacy bank
  // rules per build plan §4.5.
  for (const item of items) {
    const current = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)),
    });
    if (!current || current.status !== 'pending') continue;
    processedIds.push(item.id);
    try {
      // Resolve the bank-connection's GL account so the Phase-4
      // condition field `account_source_id` tests against the
      // human-meaningful account uuid, not the connection PK.
      const conn = await db.query.bankConnections.findFirst({
        where: and(
          eq(bankConnections.tenantId, tenantId),
          eq(bankConnections.id, current.bankConnectionId),
        ),
        columns: { id: true, accountId: true },
      });
      const result = await conditionalRulesApply.applyForFeedItem(tenantId, {
        id: current.id,
        description: current.description,
        originalDescription: current.originalDescription,
        amount: current.amount,
        feedDate: current.feedDate,
        bankConnectionAccountId: conn?.accountId ?? current.bankConnectionId,
        payeeNameOnCheck: current.payeeNameOnCheck,
      }, { currentUserId: opts.userId ?? null });
      if (result.shortCircuitedLegacyRules) {
        conditionalShortCircuited.add(item.id);
      }
      // Stash the conditional rule attribution so the
      // classification-state upsert records it. The first
      // fire wins for attribution (lowest priority); stacked
      // continue_after_match fires don't overwrite.
      if (result.fires.length > 0) {
        const firstFire = result.fires[0]!;
        if (!ruleFiredByItem.has(item.id)) {
          ruleFiredByItem.set(item.id, { ruleId: firstFire.ruleId, kind: 'conditional' });
        }
      }
    } catch (err) {
      // Engine failures shouldn't abort the run.
      console.warn(`[runRulesStages] conditional-rules apply failed for item ${item.id}: ${errorSummaryForLog(err)}`);
    }
  }

  // Stage 2 — legacy bank rules (+ autoConfirm posting).
  for (const item of items) {
    if (conditionalShortCircuited.has(item.id)) continue;
    const current = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)),
    });
    if (!current || current.status !== 'pending') continue;

    const ruleResult = await bankRulesService.evaluateRules(tenantId, {
      // Include the check payee so vendor-name rules match on checks (the raw
      // description is only "CHECK 3301").
      description: current.payeeNameOnCheck
        ? `${current.description ?? ''} ${current.payeeNameOnCheck}`.trim()
        : current.description,
      amount: parseFloat(current.amount),
    });
    if (ruleResult.matched) {
      // Capture which rule fired — even if autoConfirm is false.
      ruleFiredByItem.set(item.id, { ruleId: ruleResult.ruleId ?? null, kind: 'legacy' });
    }
    // Bank-file import batch (U-06, Q-P25j): a matching rule is staged as a
    // suggestion only (never categorized, never posted), unless a
    // conditional rule already staged one.
    if (stageOnly && ruleResult.matched && ruleResult.assignAccountId && !current.suggestedAccountId) {
      await db.update(bankFeedItems).set({
        suggestedAccountId: ruleResult.assignAccountId,
        // U-168: the attribution, in the same UPDATE as the suggestion.
        ...(ruleResult.ruleId ? { suggestedRuleId: ruleResult.ruleId, suggestedRuleKind: 'legacy' } : {}),
        ...(ruleResult.assignContactId && !current.suggestedContactId ? { suggestedContactId: ruleResult.assignContactId } : {}),
        ...(ruleResult.assignTagId && !current.suggestedTagId ? { suggestedTagId: ruleResult.assignTagId } : {}),
        matchType: 'rule',
        updatedAt: new Date(),
      }).where(and(
        eq(bankFeedItems.tenantId, tenantId),
        eq(bankFeedItems.id, item.id),
        eq(bankFeedItems.status, 'pending'),
        sql`${bankFeedItems.suggestedAccountId} IS NULL`,
      ));
    }
    if (!stageOnly && ruleResult.matched && ruleResult.autoConfirm && ruleResult.assignAccountId) {
      try {
        await categorize(tenantId, item.id, {
          accountId: ruleResult.assignAccountId,
          contactId: ruleResult.assignContactId || undefined,
          memo: ruleResult.assignMemo || undefined,
          // ADR 0XY §3.3 — rule-assigned tag propagates to the new txn.
          tagId: ruleResult.assignTagId ?? undefined,
        }, opts.userId, opts.companyId);
        autoCategorizedIds.push(item.id);
      } catch (err) {
        // A single bad posting (deleted account, unbalanced ledger
        // guard, concurrent claim) must not abort the rest of the
        // batch. categorize() reverts the claim so the item stays
        // pending and can be retried.
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ id: item.id, error: msg });
        console.warn(`[runRulesStages] autoConfirm categorize failed for item ${item.id}: ${errorSummaryForLog(err)}`);
      }
    }
  }

  return { processedIds, ruleFiredByItem, conditionalShortCircuited, autoCategorizedIds, failures };
}

/**
 * Post-import categorization pipeline:
 *   1. Bank rules with autoConfirm → auto-categorize matching items
 *   2. AI suggestions on remaining pending items
 */
export async function runCategorizationPipeline(
  tenantId: string,
  items: any[],
  // The bank-file import batch (U-06) passes { llm: false, autoConfirm:
  // false }: no AI suggestions and no rule posting; rule attribution,
  // potential-match detection and the classification state still run.
  opts: { llm?: boolean; autoConfirm?: boolean } = {},
) {
  const categorizationService = await import('./categorization-ai.service.js');
  const classificationStateService = await import('./practice-classification.service.js');

  // RULES stages — conditional rules, then legacy bank rules (with
  // autoConfirm posting). Shared with reprocessRules() so the "run the
  // rules again later" bulk action can never drift from import behavior.
  const { ruleFiredByItem } = await runRulesStages(tenantId, items, { autoConfirm: opts.autoConfirm });

  // AI suggestions on remaining pending items.
  // Phase 4 — items with skip_ai=true (set by a conditional
  // rule's `skip_ai` action) are filtered out so the AI
  // categorizer doesn't waste tokens on patterns the bookkeeper
  // has explicitly excluded.
  const pendingIds = [];
  for (const item of items) {
    const current = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)),
    });
    // Skip rows that already carry a suggestion (e.g. statement import carried
    // the review's previewed account) — don't recompute/overwrite it, and don't
    // spend tokens. Rules + match detection above still ran for every row.
    if (current && current.status === 'pending' && !current.skipAi && !current.suggestedAccountId) {
      pendingIds.push(item.id);
    }
  }
  // Q-P26c: in desktop mode AI runs only when the owner asks (Suggest with
  // AI), never unattended after an import.
  if (pendingIds.length > 0 && opts.llm !== false && !isDesktop()) {
    // Honor the "Auto-categorize bank feed transactions" setting
    // (ai_config.autoCategorizeOnImport, default on). This pipeline runs for
    // EVERY import path — CSV/OFX, Plaid sync, AND bank-statement import — so
    // gating here makes the setting apply uniformly (incl. statement imports).
    const { getConfig } = await import('./ai-config.service.js');
    const aiCfg = await getConfig().catch(() => null);
    if (aiCfg?.autoCategorizeOnImport ?? true) {
      // AI batch suggestions — best-effort. If the categorizer is down or
      // mis-configured, the feed still imports correctly without auto
      // suggestions; users can still categorize manually. Log so the
      // outage is visible to operators.
      await categorizationService.suggestForBatch(tenantId, pendingIds).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[bank-feed] AI batch suggest failed for tenant ${tenantId}: ${errorSummaryForLog(err)}`);
      });
    }
  }

  // Phase 3 — potential-match detection. Runs after rules + AI
  // so the matcher has access to the final feed item state, but
  // before the classification-state upsert so the upsert can
  // persist the candidates and use them for bucket assignment.
  // Lazy-imported to avoid pulling the matcher's transitive deps
  // when this hot path runs in non-bucket-workflow tenants.
  const potentialMatchService = await import('./potential-match.service.js');
  const candidatesByItem = new Map<string, Awaited<ReturnType<typeof potentialMatchService.findMatches>>>();
  for (const item of items) {
    const current = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)),
    });
    if (!current || current.status !== 'pending') continue;
    try {
      const candidates = await potentialMatchService.findMatches(tenantId, item.id);
      candidatesByItem.set(item.id, candidates);
    } catch (err) {
      // A matcher failure on one item shouldn't kill the
      // pipeline — log and move on with no candidates for that
      // item. The state-row upsert below still runs so the row
      // ends up in some non-Bucket-1 bucket.
      console.warn(`[runCategorizationPipeline] potential-match find failed for item ${item.id}: ${errorSummaryForLog(err)}`);
    }
  }

  // Classification state upsert — runs AFTER rules + AI + matcher
  // so the state row reads the final suggestedAccountId /
  // confidenceScore / matchType plus the persisted candidates.
  // Failures here are logged but do not abort the pipeline: the
  // state table is an augmentation, not the source of truth for
  // legacy categorization.
  for (const item of items) {
    const current = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)),
    });
    if (!current) continue;
    const matched = ruleFiredByItem.get(item.id);
    const candidates = candidatesByItem.get(item.id) ?? [];
    try {
      await classificationStateService.upsertStateForFeedItem(tenantId, item.id, {
        matchedRuleId: matched?.ruleId ?? null,
        matchedRuleKind: matched?.kind,
        matchCandidates: candidates,
      });
    } catch {
      // Retry once — observed failures here have been transient (the same
      // upsert succeeds on immediate re-run), and a lost state row stays
      // lost until the next reprocess. Log the UNDERLYING cause on a
      // repeat failure: DrizzleQueryError.message is only the SQL text.
      try {
        await new Promise((r) => setTimeout(r, 250));
        await classificationStateService.upsertStateForFeedItem(tenantId, item.id, {
          matchedRuleId: matched?.ruleId ?? null,
          matchCandidates: candidates,
        });
      } catch (err) {
        // errorSummaryForLog carries the cause's code and message, never the params.
        console.warn(`[runCategorizationPipeline] classification-state upsert failed for item ${item.id}: ${errorSummaryForLog(err)}`);
      }
    }
  }
}

export async function bulkRecleanse(tenantId: string, feedItemIds: string[]) {
  const items = [];
  for (const id of feedItemIds) {
    const item = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
    });
    if (item) items.push(item);
  }
  // S6: recleanse never calls AI in desktop mode (Q-P26c: AI only on request).
  const cleansing = await runCleansingPipeline(tenantId, items, isDesktop() ? { llm: false } : {});
  return { cleansed: items.length, cleansing };
}

// ─── Reprocess Rules (bulk) ────────────────────────────────────────

export interface ReprocessRulesSelector {
  /** Explicit selection. Validated against tenant + 'pending' status;
   *  non-pending / unknown ids are silently skipped. */
  feedItemIds?: string[];
  /** Re-run rules over every pending feed item for the tenant. */
  allPending?: boolean;
  /** Optional connection scope for the allPending path. */
  bankConnectionId?: string;
}

export interface ReprocessRulesResult {
  /** Pending items rule evaluation actually ran over. */
  processed: number;
  /** Items at least one rule (conditional or legacy) matched. */
  matched: number;
  /** Matched items posted to the ledger via a legacy autoConfirm rule. */
  autoCategorized: number;
  /** Matched items whose suggestion fields / rule attribution were
   *  refreshed but that stay pending for review. */
  suggestionsUpdated: number;
  /** Processed items no rule matched — left exactly as they were
   *  (existing AI suggestions preserved). */
  untouched: number;
}

const REPROCESS_BATCH_SIZE = 500;
// Sanity ceiling for the allPending path — a backlog past this is a
// data problem to look at, not something to chew through in one
// request. The loop just stops there; re-running picks up the rest
// (auto-categorized items leave 'pending', so progress is monotonic).
const REPROCESS_MAX_ITEMS = 10_000;

/**
 * "Reprocess Rules" bulk action — re-runs ONLY the rules stages
 * (conditional rules, then legacy bank rules) over pending feed items,
 * so a rule created after import applies to the backlog. Deliberately
 * skips the AI-suggestion and potential-match stages: a matching rule
 * refreshes the suggestion fields exactly as at import (autoConfirm
 * rules post via categorize()); items no rule matches keep whatever
 * suggestion they already have.
 */
export async function reprocessRules(
  tenantId: string,
  selector: ReprocessRulesSelector,
  userId?: string,
  companyId?: string,
): Promise<ReprocessRulesResult> {
  const hasIds = Array.isArray(selector.feedItemIds) && selector.feedItemIds.length > 0;
  if (hasIds === (selector.allPending === true)) {
    throw AppError.badRequest('Provide exactly one of feedItemIds or allPending');
  }
  if (hasIds && selector.feedItemIds!.length > REPROCESS_BATCH_SIZE) {
    // The route schema already caps at 500; re-check here so direct
    // service callers can't serialize thousands of queries either.
    throw AppError.badRequest(`Reprocess rules is limited to ${REPROCESS_BATCH_SIZE} explicit items per request`);
  }
  if (selector.bankConnectionId) {
    await assertConnectionInTenant(tenantId, selector.bankConnectionId);
  }

  const classificationStateService = await import('./practice-classification.service.js');

  let processed = 0;
  let matched = 0;
  let autoCategorized = 0;

  const processBatch = async (batch: Array<{ id: string }>) => {
    const outcome = await runRulesStages(tenantId, batch, { userId, companyId });
    processed += outcome.processedIds.length;
    matched += outcome.ruleFiredByItem.size;
    autoCategorized += outcome.autoCategorizedIds.length;
    // Refresh the classification-state row for items a rule matched so
    // the bucket UI reflects the new attribution (mirrors the pipeline;
    // best-effort — the state table is an augmentation, not the source
    // of truth). Untouched items keep their existing state row.
    for (const [itemId, fired] of outcome.ruleFiredByItem) {
      try {
        await classificationStateService.upsertStateForFeedItem(tenantId, itemId, {
          matchedRuleId: fired.ruleId,
          matchedRuleKind: fired.kind,
        });
      } catch {
        // Same transient-failure retry + cause logging as the
        // categorization pipeline's upsert above.
        try {
          await new Promise((r) => setTimeout(r, 250));
          await classificationStateService.upsertStateForFeedItem(tenantId, itemId, {
            matchedRuleId: fired.ruleId,
          });
        } catch (err) {
          console.warn(`[reprocessRules] classification-state upsert failed for item ${itemId}: ${errorSummaryForLog(err)}`);
        }
      }
    }
  };

  if (hasIds) {
    // Tenant scoping + pending filter in one query; anything that
    // doesn't survive the WHERE is silently skipped by design.
    const rows = await db.select({ id: bankFeedItems.id })
      .from(bankFeedItems)
      .where(and(
        eq(bankFeedItems.tenantId, tenantId),
        inArray(bankFeedItems.id, selector.feedItemIds!),
        eq(bankFeedItems.status, 'pending'),
      ));
    await processBatch(rows);
  } else {
    // All-pending path: keyset-paginate by id so rows auto-categorized
    // mid-run (status flips off 'pending') can't shift the window.
    let lastId: string | null = null;
    let fetched = 0;
    for (;;) {
      const conditions = [
        eq(bankFeedItems.tenantId, tenantId),
        eq(bankFeedItems.status, 'pending'),
      ];
      if (selector.bankConnectionId) {
        conditions.push(eq(bankFeedItems.bankConnectionId, selector.bankConnectionId));
      }
      if (lastId) conditions.push(sql`${bankFeedItems.id} > ${lastId}`);
      const batch: Array<{ id: string }> = await db.select({ id: bankFeedItems.id })
        .from(bankFeedItems)
        .where(and(...conditions))
        .orderBy(bankFeedItems.id)
        .limit(REPROCESS_BATCH_SIZE);
      if (batch.length === 0) break;
      await processBatch(batch);
      lastId = batch[batch.length - 1]!.id;
      fetched += batch.length;
      if (fetched >= REPROCESS_MAX_ITEMS) break;
    }
  }

  const result: ReprocessRulesResult = {
    processed,
    matched,
    autoCategorized,
    suggestionsUpdated: matched - autoCategorized,
    untouched: processed - matched,
  };

  // One summary audit entry for the whole action (per-item effects are
  // already audited by categorize→postTransaction and the conditional
  // rules' own fire audit).
  await auditLog(tenantId, 'update', 'bank_feed', null, null, {
    action: 'reprocess_rules',
    selector: hasIds
      ? { feedItemIds: selector.feedItemIds!.length }
      : { allPending: true, bankConnectionId: selector.bankConnectionId ?? null },
    ...result,
  }, userId);

  return result;
}

export interface ImportDateRange {
  start?: string | null; // YYYY-MM-DD inclusive
  end?: string | null; // YYYY-MM-DD inclusive
}

// Parse a date string (ISO YYYY-MM-DD, US M/D/YYYY, or anything Date.parse
// handles) to a UTC day timestamp for range comparison. Returns null when
// unparseable so the caller can choose not to silently drop the row.
function parseDayMs(s: string): number | null {
  const trimmed = s.trim();
  let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = +m[3]!;
    if (y < 100) y += 2000;
    return Date.UTC(y, +m[1]! - 1, +m[2]!);
  }
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? null : t;
}

// True if `feedDate` falls within the (inclusive) range. An empty range admits
// everything; an unparseable row date is admitted rather than silently dropped.
function withinRange(feedDate: string, range?: ImportDateRange): boolean {
  if (!range || (!range.start && !range.end)) return true;
  const t = parseDayMs(feedDate);
  if (t === null) return true;
  if (range.start) {
    const s = parseDayMs(range.start);
    if (s !== null && t < s) return false;
  }
  if (range.end) {
    const e = parseDayMs(range.end);
    if (e !== null && t > e) return false;
  }
  return true;
}

export async function importFromCsv(
  tenantId: string,
  bankConnectionId: string,
  csvText: string,
  mapping: CsvColumnMapping,
  dateRange?: ImportDateRange,
) {
  await assertConnectionInTenant(tenantId, bankConnectionId);
  // Byte ceiling: a single 50MB line would sail past the row-count check
  // below but still exhaust memory when split into a giant single-entry
  // array. Express.json already caps the request body, but this route can
  // be fed via other paths (tenant import, worker retry) so enforce it
  // here too.
  const MAX_CSV_BYTES = 20 * 1024 * 1024;
  if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
    throw AppError.badRequest(`CSV exceeds ${MAX_CSV_BYTES / 1024 / 1024}MB limit`);
  }
  const lines = csvText.split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw AppError.badRequest('CSV must have header + data rows');
  // Cap import size so a caller can't tie up the DB connection with a
  // multi-megabyte CSV. 50k statement lines is well past anything a real
  // bank statement produces.
  const MAX_ROWS = 50_000;
  if (lines.length - 1 > MAX_ROWS) {
    throw AppError.badRequest(`CSV is limited to ${MAX_ROWS} transactions per import`);
  }

  const items: Array<typeof bankFeedItems.$inferInsert> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const dateStr = cols[mapping.date] || '';
    const description = cols[mapping.description] || '';

    let amount: number;
    if (mapping.debitColumn !== undefined && mapping.creditColumn !== undefined) {
      const debit = parseFloat(cols[mapping.debitColumn] || '0') || 0;
      const credit = parseFloat(cols[mapping.creditColumn] || '0') || 0;
      amount = debit - credit; // positive = spend, negative = deposit
    } else {
      amount = parseFloat(cols[mapping.amount] || '0') || 0;
    }

    if (!dateStr || amount === 0) continue;
    if (!withinRange(dateStr, dateRange)) continue;

    // Check number: an explicitly mapped column wins; otherwise parse it
    // from the description ("CHECK 1234", "CHK #1234", ...) the same way
    // the statement import does — every import method must land check
    // numbers in bank_feed_items.check_number.
    const mappedCheck = mapping.checkNumber !== undefined
      ? Number.parseInt(cols[mapping.checkNumber] || '', 10) || null
      : null;

    items.push({
      tenantId,
      bankConnectionId,
      feedDate: dateStr,
      description: description, // raw — will be cleaned after insert
      originalDescription: description,
      amount: amount.toFixed(4),
      checkNumber: mappedCheck ?? parseCheckNumber(description),
      status: 'pending',
    });
  }

  if (items.length === 0) throw AppError.badRequest('No valid rows found in CSV');

  // Duplicate detection: skip items that already exist (same date + amount + original description)
  const deduped = [];
  for (const item of items) {
    const existing = await db.query.bankFeedItems.findFirst({
      where: and(
        eq(bankFeedItems.tenantId, tenantId),
        eq(bankFeedItems.bankConnectionId, bankConnectionId),
        sql`${bankFeedItems.feedDate} = ${item.feedDate}`,
        sql`${bankFeedItems.amount} = ${item.amount}`,
        sql`${bankFeedItems.originalDescription} = ${item.originalDescription}`,
      ),
    });
    if (!existing) deduped.push(item);
  }

  if (deduped.length === 0) return { items: [], cleansing: emptyCleansingAggregate() };

  const companyId = await resolveCompanyForConnection(tenantId, bankConnectionId);
  const inserted = await db.insert(bankFeedItems).values(deduped.map((d) => ({ ...d, companyId }))).returning();

  // Run full cleansing pipeline on each item
  const cleansing = await runCleansingPipeline(tenantId, inserted);

  // Run categorization pipeline (rules autoConfirm + AI suggestions)
  await runCategorizationPipeline(tenantId, inserted);

  return { items: inserted, cleansing };
}

export async function importFromOfx(tenantId: string, bankConnectionId: string, ofxContent: string, dateRange?: ImportDateRange) {
  await assertConnectionInTenant(tenantId, bankConnectionId);
  // Simple OFX/QFX parser — extract STMTTRN elements
  // Lookahead-terminated (not `.*?</STMTTRN>`): the lazy form goes quadratic
  // on a file with unclosed <STMTTRN> tags (measured 360 KB → 3 s, 10 MB cap
  // → minutes of blocked event loop). Same shape as bank-statements.service.
  const txnRegex = /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/STMTTRN>|<\/BANKTRANLIST>|<LEDGERBAL>|$)/gi;
  const items: Array<typeof bankFeedItems.$inferInsert> = [];
  let match;

  while ((match = txnRegex.exec(ofxContent)) !== null) {
    const block = match[1]!;
    const getTag = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}>([^<\\n]+)`, 'i'));
      return m?.[1]?.trim() || '';
    };

    const dateRaw = getTag('DTPOSTED');
    const amount = parseFloat(getTag('TRNAMT'));
    const name = getTag('NAME') || getTag('MEMO');
    const fitid = getTag('FITID');
    // OFX carries the check number as its own CHECKNUM tag; non-numeric
    // values are dropped rather than imported as NaN. When the tag is
    // absent, fall back to parsing the description like statement/CSV
    // imports do.
    const checkNumRaw = getTag('CHECKNUM');
    const checkNumber = (checkNumRaw ? Number.parseInt(checkNumRaw, 10) || null : null)
      ?? parseCheckNumber(name);

    if (!dateRaw || isNaN(amount)) continue;

    // Parse OFX date format: YYYYMMDD or YYYYMMDDHHMMSS
    const feedDate = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
    if (!withinRange(feedDate, dateRange)) continue;

    items.push({
      tenantId,
      bankConnectionId,
      providerTransactionId: fitid || null,
      feedDate,
      description: name, // raw — will be cleaned after insert
      originalDescription: name,
      amount: (-amount).toFixed(4), // OFX: negative = spend, but we want positive = spend
      checkNumber,
      status: 'pending',
    });
  }

  if (items.length === 0) throw AppError.badRequest('No transactions found in OFX file');

  // A FITID that occurs more than once in this file: this route keeps its
  // long-standing rule (owner Q-P25z, 2026-11-07) — the first row with the
  // FITID imports, the later rows with it are skipped. Before U-163 the
  // repeats reached the insert and the unique index failed the whole file
  // with a 500. (The bank-import-batch route keeps both rows instead.)
  const seenFitids = new Set<string>();
  const firstOccurrences = items.filter((item) => {
    if (!item.providerTransactionId) return true;
    if (seenFitids.has(item.providerTransactionId)) return false;
    seenFitids.add(item.providerTransactionId);
    return true;
  });

  // Duplicate detection: OFX has FITID (provider transaction ID) — skip if
  // this connection already imported it. A FITID is unique per bank
  // account, not per tenant: another account's transaction with the same
  // FITID is not a duplicate (U-163, migration 0262).
  const dedupedOfx = [];
  for (const item of firstOccurrences) {
    if (item.providerTransactionId) {
      const existing = await db.query.bankFeedItems.findFirst({
        where: and(
          eq(bankFeedItems.tenantId, tenantId),
          eq(bankFeedItems.bankConnectionId, bankConnectionId),
          eq(bankFeedItems.providerTransactionId, item.providerTransactionId),
        ),
      });
      if (existing) continue;
    } else {
      const existing = await db.query.bankFeedItems.findFirst({
        where: and(
          eq(bankFeedItems.tenantId, tenantId),
          eq(bankFeedItems.bankConnectionId, bankConnectionId),
          sql`${bankFeedItems.feedDate} = ${item.feedDate}`,
          sql`${bankFeedItems.amount} = ${item.amount}`,
          sql`${bankFeedItems.originalDescription} = ${item.originalDescription}`,
        ),
      });
      if (existing) continue;
    }
    dedupedOfx.push(item);
  }

  if (dedupedOfx.length === 0) return { items: [], cleansing: emptyCleansingAggregate() };

  const ofxCompanyId = await resolveCompanyForConnection(tenantId, bankConnectionId);
  // A concurrent import of the same file may have inserted a FITID since
  // the lookup above: the unique index skips it instead of failing the
  // whole import.
  const insertedOfx = await db.insert(bankFeedItems)
    .values(dedupedOfx.map((d) => ({ ...d, companyId: ofxCompanyId })))
    .onConflictDoNothing()
    .returning();
  if (insertedOfx.length === 0) return { items: [], cleansing: emptyCleansingAggregate() };

  // Run full cleansing pipeline on each item
  const cleansing = await runCleansingPipeline(tenantId, insertedOfx);

  // Run categorization pipeline (rules autoConfirm + AI suggestions)
  await runCategorizationPipeline(tenantId, insertedOfx);

  return { items: insertedOfx, cleansing };
}

export async function importStatementItems(
  tenantId: string,
  bankConnectionId: string,
  transactions: Array<{
    date: string; description: string; amount: string; type?: string;
    // Carried from the review preview (cleaned vendor name + chosen category/tag).
    cleanedName?: string | null; suggestedAccountId?: string | null; tagId?: string | null;
  }>,
  checks: StatementCheckImage[] = [],
  // Statement-driven reconciliation: stamp each imported item with the
  // bank_statements row it came from (migration 0115).
  statementId: string | null = null,
) {
  await assertConnectionInTenant(tenantId, bankConnectionId);
  // Track which rows carried a cleaned name so cleansing doesn't overwrite it.
  const prepared = transactions.map((txn) => {
    const cleaned = txn.cleanedName?.trim() || '';
    return {
      carriedClean: cleaned.length > 0,
      row: {
        tenantId,
        bankConnectionId,
        statementId,
        feedDate: txn.date,
        // Carried cleaned name becomes the displayed description; the raw stays
        // in originalDescription (and drives dedup) so re-imports still dedupe.
        description: cleaned || txn.description,
        originalDescription: txn.description,
        // Statement parsers hand us a positive magnitude + a debit/credit `type`.
        // Persist the SIGNED amount so the bank feed matches the OFX/CSV
        // convention (positive = spend / money out; negative = money in). `credit`
        // (deposit, money in) → negative; everything else (debit/spend) → positive.
        amount: (txn.type === 'credit'
          ? -Math.abs(parseFloat(txn.amount))
          : Math.abs(parseFloat(txn.amount))
        ).toFixed(4),
        // Keep the parsed check number on credit rows too — a returned/NSF
        // check reversal is a credit that legitimately references its check.
        // Payee CONTAMINATION (a deposit acquiring a check's image payee) is
        // prevented at the correlation point instead (applyCheckImagePayees
        // only stamps payees onto debit-side items).
        checkNumber: parseCheckNumber(txn.description),
        status: 'pending' as const,
        // Carried category/tag from the review → shown in the feed; the AI step
        // skips rows that already have suggestedAccountId (see runCategorizationPipeline).
        suggestedAccountId: txn.suggestedAccountId ?? null,
        suggestedTagId: txn.tagId ?? null,
        matchType: txn.suggestedAccountId ? ('ai' as const) : null,
      } satisfies typeof bankFeedItems.$inferInsert,
    };
  });

  // Duplicate detection
  const dedupedPrepared: typeof prepared = [];
  for (const p of prepared) {
    const existing = await db.query.bankFeedItems.findFirst({
      where: and(
        eq(bankFeedItems.tenantId, tenantId),
        sql`${bankFeedItems.feedDate} = ${p.row.feedDate}`,
        sql`${bankFeedItems.amount} = ${p.row.amount}`,
        sql`${bankFeedItems.originalDescription} = ${p.row.originalDescription}`,
      ),
    });
    if (!existing) dedupedPrepared.push(p);
  }

  if (dedupedPrepared.length === 0) {
    return { imported: 0, skipped: transactions.length, cleansing: emptyCleansingAggregate() };
  }

  const stmtCompanyId = await resolveCompanyForConnection(tenantId, bankConnectionId);
  const insertedStmt = await db.insert(bankFeedItems).values(dedupedPrepared.map((p) => ({ ...p.row, companyId: stmtCompanyId }))).returning();

  // STATEMENT_CHECK_PAYEE_V1 — correlate check-image payees to the
  // "CHECK ####" feed items and stage the payee (+ contact on a unique
  // match) BEFORE cleansing/categorization, so the check-derived payee wins.
  if (checks.length > 0) await applyCheckImagePayees(tenantId, insertedStmt, checks);

  // Cleansing only for rows that did NOT carry a cleaned name from the review
  // (carried names are authoritative — don't let rules overwrite them).
  const freshForCleansing = insertedStmt.filter((_, i) => !dedupedPrepared[i]!.carriedClean);
  const cleansing = freshForCleansing.length > 0
    ? await runCleansingPipeline(tenantId, freshForCleansing)
    : emptyCleansingAggregate();

  // Categorization pipeline runs for ALL rows (rules + match detection); its AI
  // step skips rows that already carry a suggestedAccountId.
  await runCategorizationPipeline(tenantId, insertedStmt);

  return { imported: insertedStmt.length, skipped: transactions.length - insertedStmt.length, cleansing };
}


/**
 * Engine start (U-173, S9): rows left in 'categorizing' by an older engine
 * (or a crash during the separate claim it used) for more than 5 minutes go
 * back to where they were: 'assigned' when they carry a staged account, else
 * 'pending'; a row that has its posted entry is 'categorized'. Feed posting
 * no longer leaves this state behind (the claim is inside the posting
 * transaction). Every tenant; returns how many rows moved.
 */
export const STUCK_CATEGORIZING_MS = 5 * 60 * 1000;
export async function recoverStuckCategorizing(olderThanMs = STUCK_CATEGORIZING_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await db.execute(sql`
    UPDATE bank_feed_items SET
      status = CASE
        WHEN matched_transaction_id IS NOT NULL THEN 'categorized'
        WHEN assigned_account_id IS NOT NULL AND assigned_at IS NOT NULL THEN 'assigned'
        ELSE 'pending' END,
      updated_at = now()
    WHERE status = 'categorizing' AND (updated_at IS NULL OR updated_at < ${cutoff})
    RETURNING id`);
  return (res.rows as unknown[]).length;
}
