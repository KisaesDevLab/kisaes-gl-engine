// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Bank feed accept records (U-169, feed-undo-v1; review B5, S4).
 *
 * Every path that links a feed item to an entry writes one record per item,
 * in the same database transaction as the link:
 *
 *   post      POST /banking/feed/accept, PUT /:id/categorize, POST /:id/approve
 *             (the entry was posted for the item)
 *   match     an accept with matchTransactionId, PUT /:id/match, match-apply
 *             (the entry existed already)
 *   transfer  POST /:id/transfer (one entry, both sides)
 *   deposit   POST /:id/deposit
 *   payment   POST /payments/receive with bankFeedItemId (U-136)
 *
 * A record names the entry and its bank line, the entry's fingerprint at
 * commit (date, contact, memo and every line's account, debit, credit and
 * tag: a later edit changes it, other processes touching updated_at don't)
 * and the item's review state before the link (`prior_state`). Undo acts
 * only on records whose item still points at the recorded entry and that are
 * not undone, so a stale Undo (the item was undone and accepted again) does
 * nothing.
 *
 * No imports from the feed services: they import this module.
 */

import { createHash } from 'crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { bankFeedAcceptGroupItems, bankFeedAcceptGroups, bankFeedItems, journalLines, transactions } from '../db/schema/index.js';

export type AcceptRecordKind = 'post' | 'match' | 'transfer' | 'deposit' | 'payment';
export type AcceptGroupSource = 'accept' | 'categorize' | 'approve' | 'match' | 'transfer' | 'deposit' | 'payment';

type FeedRow = typeof bankFeedItems.$inferSelect;
type FeedPatch = Partial<typeof bankFeedItems.$inferInsert>;

/** The review state of a feed item that an accept changes and Undo restores. */
const PRIOR_STATE_COLUMNS = [
  'status',
  'suggestedAccountId', 'suggestedContactId', 'suggestedTagId', 'confidenceScore', 'matchType',
  'suggestedRuleId', 'suggestedRuleKind', 'skipAi', 'splitsConfig', 'memo',
  'assignedAccountId', 'assignedContactId', 'assignedTagId', 'assignedMemo', 'assignedBy', 'assignedAt',
  'closeReviewedAt', 'closeReviewedBy',
] as const satisfies ReadonlyArray<keyof FeedRow>;
const PRIOR_STATE_DATES = new Set<string>(['assignedAt', 'closeReviewedAt']);
/** Statuses an item can be accepted from; anything else restores as pending. */
const WAITING = new Set(['pending', 'assigned']);

/** The item's review state, as JSON (dates as ISO strings). */
export function priorStateOf(row: FeedRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of PRIOR_STATE_COLUMNS) {
    const v = row[c];
    out[c] = v instanceof Date ? v.toISOString() : (v ?? null);
  }
  return out;
}

/** The columns that put an item back exactly as `prior_state` recorded it (never a non-waiting status). */
export function patchFromPriorState(prior: unknown): FeedPatch {
  const p = (prior && typeof prior === 'object' ? prior : {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const c of PRIOR_STATE_COLUMNS) {
    if (!(c in p)) continue;
    const v = p[c];
    patch[c] = PRIOR_STATE_DATES.has(c) && typeof v === 'string' ? new Date(v) : v;
  }
  if (!WAITING.has(String(patch['status'] ?? ''))) patch['status'] = 'pending';
  if (patch['skipAi'] === null || patch['skipAi'] === undefined) delete patch['skipAi'];
  return patch as FeedPatch;
}

/**
 * sha256 of what the owner sees of an entry: date, contact, memo and every
 * live line (account, debit, credit, tag), lines in a stable order.
 * `updated_at` is not used (other processes touch it). Null when the entry
 * doesn't exist.
 */
export async function txnFingerprint(executor: DbOrTx, tenantId: string, transactionId: string): Promise<string | null> {
  const [txn] = await executor.select({
    txnDate: transactions.txnDate, contactId: transactions.contactId, memo: transactions.memo,
  }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId))).limit(1);
  if (!txn) return null;
  const lines = await executor.select({
    accountId: journalLines.accountId, debit: journalLines.debit, credit: journalLines.credit, tagId: journalLines.tagId,
  }).from(journalLines)
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, transactionId),
      eq(journalLines.isVoidReversal, false),
    ));
  const norm = lines
    .map((l) => [l.accountId, String(l.debit), String(l.credit), l.tagId ?? ''].join('|'))
    .sort();
  const body = JSON.stringify({ d: txn.txnDate, c: txn.contactId ?? null, m: txn.memo ?? null, l: norm });
  return createHash('sha256').update(body).digest('hex');
}

/** A new accept group (one per request), in the caller's transaction. */
export async function newAcceptGroup(executor: DbOrTx, g: {
  tenantId: string; companyId?: string | null; userId?: string | null; source: AcceptGroupSource;
  ruleId?: string | null; ruleKind?: string | null;
}): Promise<string> {
  const [row] = await executor.insert(bankFeedAcceptGroups).values({
    tenantId: g.tenantId,
    companyId: g.companyId ?? null,
    userId: g.userId ?? null,
    source: g.source,
    ruleId: g.ruleId ?? null,
    ruleKind: g.ruleKind ?? null,
  }).returning({ id: bankFeedAcceptGroups.id });
  return row!.id;
}

/** Stores the group's response (GET /banking/feed/accept-groups/:id). */
export async function setAcceptGroupResult(executor: DbOrTx, tenantId: string, groupId: string, result: unknown): Promise<void> {
  await executor.update(bankFeedAcceptGroups).set({ result: result as never })
    .where(and(eq(bankFeedAcceptGroups.tenantId, tenantId), eq(bankFeedAcceptGroups.id, groupId)));
}

/**
 * Records one linked item. `before` is the item as it was before the link
 * (the locked row). The fingerprint is taken now, after the posting, in the
 * same transaction.
 */
export async function recordAcceptItem(executor: DbOrTx, r: {
  tenantId: string; companyId?: string | null; groupId: string; kind: AcceptRecordKind;
  before: FeedRow; transactionId: string; journalLineId?: string | null;
}): Promise<void> {
  await executor.insert(bankFeedAcceptGroupItems).values({
    tenantId: r.tenantId,
    companyId: r.companyId ?? r.before.companyId ?? null,
    groupId: r.groupId,
    feedItemId: r.before.id,
    kind: r.kind,
    transactionId: r.transactionId,
    journalLineId: r.journalLineId ?? null,
    txnFingerprint: await txnFingerprint(executor, r.tenantId, r.transactionId),
    priorState: priorStateOf(r.before),
  });
}

/**
 * Records a request's links in a group of its own (the single-item routes:
 * categorize, approve, match, transfer, deposit, payment). Returns the group id.
 */
export async function recordAcceptGroup(executor: DbOrTx, g: {
  tenantId: string; companyId?: string | null; userId?: string | null; source: AcceptGroupSource;
  items: Array<{ kind: AcceptRecordKind; before: FeedRow; transactionId: string; journalLineId?: string | null }>;
}): Promise<string> {
  const groupId = await newAcceptGroup(executor, g);
  for (const it of g.items) {
    await recordAcceptItem(executor, { tenantId: g.tenantId, companyId: g.companyId, groupId, ...it });
  }
  return groupId;
}

export type AcceptRecord = typeof bankFeedAcceptGroupItems.$inferSelect;

/**
 * The live record of an item for the entry it points at now (newest first),
 * or undefined: the record must name the entry the item still points at and
 * not be undone.
 */
export async function liveRecordFor(executor: DbOrTx, tenantId: string, item: Pick<FeedRow, 'id' | 'matchedTransactionId'>): Promise<AcceptRecord | undefined> {
  if (!item.matchedTransactionId) return undefined;
  const [rec] = await executor.select().from(bankFeedAcceptGroupItems)
    .where(and(
      eq(bankFeedAcceptGroupItems.tenantId, tenantId),
      eq(bankFeedAcceptGroupItems.feedItemId, item.id),
      eq(bankFeedAcceptGroupItems.transactionId, item.matchedTransactionId),
      isNull(bankFeedAcceptGroupItems.undoneAt),
    ))
    .orderBy(desc(bankFeedAcceptGroupItems.createdAt), desc(bankFeedAcceptGroupItems.id))
    .limit(1);
  return rec;
}

/** Marks records undone (in the caller's transaction). */
export async function markUndone(executor: DbOrTx, tenantId: string, recordIds: string[], userId?: string | null): Promise<void> {
  if (recordIds.length === 0) return;
  await executor.update(bankFeedAcceptGroupItems).set({ undoneAt: new Date(), undoneBy: userId ?? null })
    .where(and(
      eq(bankFeedAcceptGroupItems.tenantId, tenantId),
      inArray(bankFeedAcceptGroupItems.id, recordIds),
      isNull(bankFeedAcceptGroupItems.undoneAt),
    ));
}
