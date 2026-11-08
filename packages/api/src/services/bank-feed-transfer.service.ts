// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bank feed transfers (U-171, feed-match-post-v1).
//
// A transfer between two of the company's accounts shows up in the feed as
// two lines: money out of one account (positive feed amount) and the same
// amount into another (negative). POST /banking/feed/:id/transfer posts ONE
// transfer for the pair and matches both feed items to it, in one database
// transaction: both sides or nothing. With `toAccountId` instead of a second
// feed item, the other side is an account whose bank line isn't in the feed
// (yet); when it arrives later it matches the transfer's line like any other
// entry (PUT /feed/:id/match).
//
//   - Exact decimals: amounts post as stored (4 places), never through a
//     JavaScript number.
//   - Dated on the money-out side, so the closing date is checked against
//     that date (ledger.postTransaction does the check). With toAccountId the
//     only date is the item's own.
//   - Pairs on the same GL account are never a transfer (two connections can
//     point at one account).
//   - Feed rows are locked in sorted id order with FOR UPDATE SKIP LOCKED: a
//     row another request holds is 409 FEED_ITEM_IN_USE {id}, never a wait or
//     a deadlock. Only pending or assigned rows (409 FEED_ITEM_NOT_PENDING
//     {id, status}).
//   - Source bank_feed, source id = the item the request names.
//   - No AI_BUCKET_WORKFLOW_V1 dependency: the banking routes carry no
//     practice flag. match-apply's transfer dispatch (the practice path)
//     posts through here too, so it is atomic as well.
//
// Line-level links: the posted transfer has exactly one line on each side's
// account; the response names it per item (journalLineId) and
// linkFeedItemToEntry stores it in bank_feed_items.matched_journal_line_id
// (U-166), so the line is never offered to another feed item.

import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, type Tx } from '../db/index.js';
import {
  accounts, bankConnections, bankFeedItems, transactionClassificationState,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import { recordAcceptGroup } from './bank-feed-accept-records.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

export const TRANSFER_WINDOW_DEFAULT = 3;
export const TRANSFER_WINDOW_MAX = 10;

type FeedRow = typeof bankFeedItems.$inferSelect;

/** Statuses a feed row can be posted or matched from. */
const OPEN_STATUSES = ['pending', 'assigned'];

function companyMatches(rowCompanyId: string | null, companyId: string | undefined): boolean {
  return !companyId || !rowCompanyId || rowCompanyId === companyId;
}

function notFound(): AppError {
  return AppError.notFound('Bank feed item not found');
}

/**
 * Locks the feed rows in sorted id order, FOR UPDATE SKIP LOCKED. A missing
 * row (or another company's) is 404; a row another request holds is 409
 * FEED_ITEM_IN_USE; a row that isn't pending or assigned is 409
 * FEED_ITEM_NOT_PENDING; a row still flagged as a possible duplicate is 409
 * FEED_ITEM_POSSIBLE_DUPLICATE {id, possibleDuplicateOf}. Returns the rows by id.
 */
export async function lockOpenFeedItems(
  tx: Tx, tenantId: string, companyId: string | undefined, ids: string[],
): Promise<Map<string, FeedRow>> {
  const sorted = [...new Set(ids)].sort();
  const locked = await tx.select().from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, sorted)))
    .orderBy(bankFeedItems.id)
    .for('update', { skipLocked: true });
  const byId = new Map(locked.map((r) => [r.id, r]));
  for (const id of sorted) {
    const row = byId.get(id);
    if (!row) {
      // Skipped (held by another request) or missing: tell them apart without waiting.
      const [exists] = await tx.select({ id: bankFeedItems.id, companyId: bankFeedItems.companyId }).from(bankFeedItems)
        .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id))).limit(1);
      if (!exists || !companyMatches(exists.companyId, companyId)) throw notFound();
      throw AppError.conflict('Someone else is working on this bank line. Try again in a moment.', 'FEED_ITEM_IN_USE', { id });
    }
    if (!companyMatches(row.companyId, companyId)) throw notFound();
    if (!OPEN_STATUSES.includes(row.status ?? '')) {
      throw AppError.conflict(`Bank feed item is not pending (current status: ${row.status}).`, 'FEED_ITEM_NOT_PENDING',
        { id, status: row.status });
    }
    if (row.possibleDuplicate) {
      // As POST /accept's possible_duplicate skip: the owner decides first
      // (POST /feed/:id/duplicate keep | remove), so a look-alike of a line
      // already in the books never posts a second transfer or deposit.
      throw AppError.conflict('This bank line may be a duplicate of one already imported. Keep it or remove it first.',
        'FEED_ITEM_POSSIBLE_DUPLICATE', { id, possibleDuplicateOf: row.possibleDuplicateOf ?? null });
    }
  }
  return byId;
}

/** The GL account a feed row's connection posts to (tenant-scoped). */
export async function feedAccountOf(tx: Tx, tenantId: string, item: FeedRow): Promise<{ id: string; name: string }> {
  const [row] = await tx.select({ id: accounts.id, name: accounts.name })
    .from(bankConnections)
    .innerJoin(accounts, and(eq(accounts.id, bankConnections.accountId), eq(accounts.tenantId, tenantId)))
    .where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, item.bankConnectionId)))
    .limit(1);
  if (!row) throw AppError.notFound('Bank connection not found');
  return row;
}

/**
 * Links a feed row to the entry that records it, in the caller's
 * transaction: status matched, the entry id, the classification state's
 * transaction id, and `journalLineId` (the entry's line on the row's own
 * account) in matched_journal_line_id (U-166; one item per line).
 */
export async function linkFeedItemToEntry(
  tx: Tx, tenantId: string, feedItemId: string, transactionId: string, journalLineId: string,
): Promise<void> {
  const [updated] = await tx.update(bankFeedItems).set({
    status: 'matched',
    matchedTransactionId: transactionId,
    matchedJournalLineId: journalLineId,
    entryVoidedAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(bankFeedItems.tenantId, tenantId),
    eq(bankFeedItems.id, feedItemId),
    inArray(bankFeedItems.status, OPEN_STATUSES),
  )).returning({ id: bankFeedItems.id });
  // The row is locked by this transaction, so this only fails on a bug.
  if (!updated) throw AppError.internal('Bank feed item changed while it was locked');
  await tx.update(transactionClassificationState)
    .set({ transactionId, updatedAt: new Date() })
    .where(and(
      eq(transactionClassificationState.tenantId, tenantId),
      eq(transactionClassificationState.bankFeedItemId, feedItemId),
    ));
}

function mismatch(message: string, field: string, extra: Record<string, unknown> = {}): AppError {
  return new AppError(400, message, 'TRANSFER_MISMATCH', { field, ...extra });
}

function dayNumber(d: string): number {
  return Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
}

function addDays(d: string, n: number): string {
  return new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);
}

/** Account system tags a transfer may not go to (they need a customer or vendor). */
const TRANSFER_REFUSED_TAGS = ['payments_clearing', 'accounts_receivable', 'accounts_payable'];
const BALANCE_SHEET_TYPES = ['asset', 'liability', 'equity'];

export interface TransferCandidate {
  feedItemId: string;
  accountId: string;
  accountName: string;
  date: string;
  /** The other item's amount as stored, in the feed sign (positive = money out). */
  amount: string;
}

/**
 * Feed rows on another GL account of the company with the exact opposite
 * amount, within `windowDays` days, pending or assigned. Closest date first.
 */
export async function listTransferCandidates(
  tenantId: string, companyId: string | undefined, feedItemId: string, windowDays = TRANSFER_WINDOW_DEFAULT,
): Promise<TransferCandidate[]> {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item || !companyMatches(item.companyId, companyId)) throw notFound();
  const amount = new Decimal(item.amount);
  if (amount.isZero()) return [];
  const [own] = await db.select({ accountId: bankConnections.accountId }).from(bankConnections)
    .where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, item.bankConnectionId))).limit(1);
  if (!own) return [];

  const rows = await db.select({
    feedItemId: bankFeedItems.id,
    accountId: accounts.id,
    accountName: accounts.name,
    date: bankFeedItems.feedDate,
    amount: bankFeedItems.amount,
  }).from(bankFeedItems)
    .innerJoin(bankConnections, and(eq(bankConnections.id, bankFeedItems.bankConnectionId), eq(bankConnections.tenantId, tenantId)))
    .innerJoin(accounts, and(eq(accounts.id, bankConnections.accountId), eq(accounts.tenantId, tenantId)))
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      ne(bankFeedItems.id, item.id),
      ne(bankConnections.accountId, own.accountId),
      inArray(bankFeedItems.status, OPEN_STATUSES),
      sql`${bankFeedItems.amount} = ${amount.neg().toFixed(4)}::numeric`,
      gte(bankFeedItems.feedDate, addDays(item.feedDate, -windowDays)),
      lte(bankFeedItems.feedDate, addDays(item.feedDate, windowDays)),
      companyId ? sql`(${bankFeedItems.companyId} = ${companyId} OR ${bankFeedItems.companyId} IS NULL)` : sql`TRUE`,
    ))
    .limit(50);
  const target = dayNumber(item.feedDate);
  return rows
    .map((r) => ({ ...r, amount: new Decimal(r.amount).toFixed(Math.max(2, new Decimal(r.amount).decimalPlaces())) }))
    .sort((a, b) => Math.abs(dayNumber(a.date) - target) - Math.abs(dayNumber(b.date) - target)
      || a.date.localeCompare(b.date) || a.feedItemId.localeCompare(b.feedItemId));
}

export type TransferRequest = { otherFeedItemId: string; toAccountId?: undefined } | { toAccountId: string; otherFeedItemId?: undefined };

export interface FeedTransferResult {
  transaction: Awaited<ReturnType<typeof ledger.postTransaction>>;
  /** One per matched feed item: the transfer line on that item's account. */
  items: Array<{ feedItemId: string; journalLineId: string }>;
  /** U-169 (feed-undo-v1): POST /banking/feed/undo {undoGroupId} takes it back. */
  undoGroupId: string;
}

/**
 * Posts one transfer for a feed item and the other side (a second feed item
 * or an account) and matches the feed item(s) to it, in `tx` (see header).
 */
export async function postFeedTransferInTx(
  tx: Tx, tenantId: string, companyId: string | undefined, feedItemId: string, req: TransferRequest, userId?: string,
): Promise<FeedTransferResult> {
  const ids = req.otherFeedItemId ? [feedItemId, req.otherFeedItemId] : [feedItemId];
  if (req.otherFeedItemId === feedItemId) throw mismatch('A transfer needs two different bank lines.', 'otherFeedItemId');
  const locked = await lockOpenFeedItems(tx, tenantId, companyId, ids);
  const item = locked.get(feedItemId)!;
  const amount = new Decimal(item.amount);
  if (amount.isZero()) throw mismatch('A bank line of 0.00 can’t be a transfer.', 'amount');
  const thisAccount = await feedAccountOf(tx, tenantId, item);

  let other: FeedRow | null = null;
  let otherAccountId: string;
  if (req.otherFeedItemId) {
    other = locked.get(req.otherFeedItemId)!;
    otherAccountId = (await feedAccountOf(tx, tenantId, other)).id;
    if (otherAccountId === thisAccount.id) {
      throw mismatch('Both bank lines are on the same account, so they aren’t a transfer.', 'account');
    }
    if (!new Decimal(other.amount).plus(amount).isZero()) {
      throw mismatch('The two bank lines aren’t the same amount in and out.', 'amount',
        { amount: amount.toFixed(2), otherAmount: new Decimal(other.amount).toFixed(2) });
    }
    if (Math.abs(dayNumber(other.feedDate) - dayNumber(item.feedDate)) > TRANSFER_WINDOW_MAX) {
      throw mismatch(`The two bank lines are more than ${TRANSFER_WINDOW_MAX} days apart.`, 'date');
    }
  } else {
    const [acct] = await tx.select({
      id: accounts.id, companyId: accounts.companyId, accountType: accounts.accountType, systemTag: accounts.systemTag,
    }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, req.toAccountId!))).limit(1);
    if (!acct || !companyMatches(acct.companyId, companyId)) {
      throw mismatch('The other account was not found in this company.', 'toAccountId');
    }
    if (acct.id === thisAccount.id) {
      throw mismatch('A transfer needs two different accounts.', 'toAccountId');
    }
    if (!BALANCE_SHEET_TYPES.includes(acct.accountType) || (acct.systemTag && TRANSFER_REFUSED_TAGS.includes(acct.systemTag))) {
      throw mismatch('A transfer goes to a bank, card, asset, liability or equity account (not Payments Clearing, '
        + 'Accounts Receivable or Accounts Payable).', 'toAccountId');
    }
    otherAccountId = acct.id;
  }

  // Money out of `fromAccount`, into `toAccount`; dated on the money-out side.
  const thisIsOut = amount.greaterThan(0);
  const fromAccountId = thisIsOut ? thisAccount.id : otherAccountId;
  const toAccountId = thisIsOut ? otherAccountId : thisAccount.id;
  const outItem = thisIsOut ? item : other;
  const txnDate = outItem ? outItem.feedDate : item.feedDate;
  const abs: DecimalValue = amount.abs();
  const amountStr = abs.toFixed(4);
  const description = item.description ?? other?.description ?? '';

  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'transfer',
    txnDate,
    memo: `Transfer: ${description}`.trim(),
    total: amountStr,
    source: 'bank_feed',
    sourceId: item.id,
    lines: [
      { accountId: toAccountId, debit: amountStr, credit: '0' },
      { accountId: fromAccountId, debit: '0', credit: amountStr },
    ],
  }, userId, companyId, tx);

  const lineOn = (accountId: string) => {
    const line = txn.lines.find((l) => l.accountId === accountId);
    if (!line) throw AppError.internal('Transfer line missing');
    return line.id;
  };
  const items = [{ feedItemId: item.id, journalLineId: lineOn(thisAccount.id) }];
  if (other) items.push({ feedItemId: other.id, journalLineId: lineOn(otherAccountId) });
  for (const it of items) {
    await linkFeedItemToEntry(tx, tenantId, it.feedItemId, txn.id, it.journalLineId);
    const before = locked.get(it.feedItemId)!;
    await auditLog(tenantId, 'update', 'bank_feed', it.feedItemId,
      { status: before.status, matchedTransactionId: before.matchedTransactionId },
      { status: 'matched', matchedTransactionId: txn.id, kind: 'transfer', journalLineId: it.journalLineId },
      userId, tx);
  }
  // U-169: the accept records Undo works from (one entry, both sides).
  const undoGroupId = await recordAcceptGroup(tx, {
    tenantId, companyId, userId, source: 'transfer',
    items: items.map((it) => ({
      kind: 'transfer' as const, before: locked.get(it.feedItemId)!, transactionId: txn.id, journalLineId: it.journalLineId,
    })),
  });
  return { transaction: txn, items, undoGroupId };
}

/** POST /banking/feed/:id/transfer: one database transaction (see header). */
export async function postFeedTransfer(
  tenantId: string, companyId: string | undefined, feedItemId: string, req: TransferRequest, userId?: string,
): Promise<FeedTransferResult> {
  return db.transaction((tx) => postFeedTransferInTx(tx, tenantId, companyId, feedItemId, req, userId));
}
