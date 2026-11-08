// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Line-level bank feed matches (U-166, feed-match-v2; review B2).
 *
 * A feed item is one line on a bank statement, so it matches one journal
 * line on its own bank account, on the right side, for exactly its amount:
 *
 *   feed amount > 0 (money out)  a credit line on the bank account = |amount|
 *   feed amount < 0 (money in)   a debit line on the bank account  = |amount|
 *
 * The line's transaction is posted (a voided entry's lines never are), the
 * line is not a void reversal, and no other feed item holds the line (or,
 * for an item matched before migration 0265 with no line recorded, the
 * whole transaction). The transaction type and its total don't matter: a
 * payroll entry's two bank lines (net pay, taxes) are two candidates, and a
 * transfer's bank line matches the side imported later.
 *
 * One predicate serves findMatchCandidates, the list's matchCandidateCount,
 * the review buckets and payroll overlap (U-172), so they never disagree.
 */

import { sql, type SQL } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { AppError } from '../utils/errors.js';
import type { DbOrTx } from '../db/index.js';

const Decimal = DecimalLib.default || DecimalLib;

/** The default match window around the feed date, in days (in step with the list badge). */
export const MATCH_WINDOW_DAYS = 15;

export interface LinePredicateInput {
  tenantId: string;
  /** The item's bank GL account (an SQL expression or a value). */
  bankAccountId: SQL;
  /** The feed amount, feed sign (an SQL expression or a value). */
  amount: SQL;
  /** The feed date (an SQL expression or a value). */
  feedDate: SQL;
  /** The item looking for a match: its own link doesn't hide a line from it. */
  itemId: SQL | null;
  windowDays?: number;
  /** Alias of journal_lines in the surrounding query (default jl). */
  line?: string;
  /** Alias of transactions in the surrounding query (default t). */
  txn?: string;
}

/**
 * WHERE conditions for `<line>` (journal_lines) joined to `<txn>`
 * (transactions) being a match candidate. The caller writes the FROM.
 */
export function lineCandidatePredicate(p: LinePredicateInput): SQL {
  const jl = sql.raw(p.line ?? 'jl');
  const t = sql.raw(p.txn ?? 't');
  const days = sql.raw(String(Math.trunc(p.windowDays ?? MATCH_WINDOW_DAYS)));
  const amt = sql`CAST(${p.amount} AS DECIMAL)`;
  const self = p.itemId ? sql`AND bx.id <> ${p.itemId}` : sql``;
  return sql`${jl}.tenant_id = ${p.tenantId}
    AND ${jl}.account_id = ${p.bankAccountId}
    AND ${jl}.is_void_reversal = false
    AND ${t}.id = ${jl}.transaction_id
    AND ${t}.tenant_id = ${p.tenantId}
    AND ${t}.status = 'posted'
    AND ${t}.txn_date >= (CAST(${p.feedDate} AS date) - INTERVAL '${days} days')
    AND ${t}.txn_date <= (CAST(${p.feedDate} AS date) + INTERVAL '${days} days')
    AND ((${amt} > 0 AND ${jl}.credit = ABS(${amt}) AND ${jl}.debit = 0)
      OR (${amt} < 0 AND ${jl}.debit = ABS(${amt}) AND ${jl}.credit = 0))
    AND NOT EXISTS (
      SELECT 1 FROM bank_feed_items bx
      WHERE bx.tenant_id = ${p.tenantId} ${self}
        AND (bx.matched_journal_line_id = ${jl}.id
          OR (bx.matched_journal_line_id IS NULL AND bx.matched_transaction_id = ${jl}.transaction_id))
    )`;
}

/** The fields of a feed line that decide its match. */
export interface FeedLineRef {
  id: string;
  amount: string;
  feedDate: string;
}

export interface LineCheck {
  /** The line's bank account, side and amount fit the feed item. */
  ok: boolean;
  field?: 'account' | 'amount';
}

/** Does this journal line (debit, credit, account) fit the feed item exactly? */
export function lineFits(item: { amount: string }, bankAccountId: string,
  line: { accountId: string; debit: string | null; credit: string | null; isVoidReversal?: boolean | null }): LineCheck {
  if (line.accountId !== bankAccountId) return { ok: false, field: 'account' };
  const feed = new Decimal(item.amount);
  const debit = new Decimal(line.debit ?? '0');
  const credit = new Decimal(line.credit ?? '0');
  if (line.isVoidReversal) return { ok: false, field: 'amount' };
  const fits = feed.gt(0) ? credit.eq(feed.abs()) && debit.isZero()
    : feed.lt(0) ? debit.eq(feed.abs()) && credit.isZero()
      : false;
  return fits ? { ok: true } : { ok: false, field: 'amount' };
}

/**
 * Resolves the journal line a feed item matches on a transaction (U-166):
 * the given line, checked; or, when none is given, the only line that fits.
 *
 *   400 MATCH_MISMATCH {field: 'transactionId' | 'journalLineId' | 'account' | 'amount'}
 *   400 LINE_REQUIRED {journalLineIds} when more than one line fits
 *   409 LINE_ALREADY_MATCHED {journalLineId, feedItemId}
 *
 * The caller has locked the feed item and the transaction (FOR SHARE) and
 * checked that the transaction is posted.
 */
export async function resolveMatchLine(
  executor: DbOrTx, tenantId: string, item: FeedLineRef, bankAccountId: string, transactionId: string, journalLineId?: string,
): Promise<string> {
  const res = await executor.execute(sql`
    SELECT jl.id, jl.account_id, jl.debit, jl.credit, jl.is_void_reversal,
      (SELECT bx.id FROM bank_feed_items bx
        WHERE bx.tenant_id = ${tenantId} AND bx.id <> ${item.id}
          AND (bx.matched_journal_line_id = jl.id
            OR (bx.matched_journal_line_id IS NULL AND bx.matched_transaction_id = jl.transaction_id))
        LIMIT 1) AS taken_by
    FROM journal_lines jl
    WHERE jl.tenant_id = ${tenantId} AND jl.transaction_id = ${transactionId}
    ORDER BY jl.line_order NULLS LAST, jl.id`);
  const lines = (res.rows as Array<{
    id: string; account_id: string; debit: string; credit: string; is_void_reversal: boolean; taken_by: string | null;
  }>).map((r) => ({ id: r.id, accountId: r.account_id, debit: r.debit, credit: r.credit, isVoidReversal: r.is_void_reversal, takenBy: r.taken_by }));

  const taken = (l: { id: string; takenBy: string | null }) => {
    if (l.takenBy) {
      throw AppError.conflict('Another bank line is already matched to this entry line.', 'LINE_ALREADY_MATCHED',
        { journalLineId: l.id, feedItemId: l.takenBy });
    }
  };

  if (journalLineId) {
    const line = lines.find((l) => l.id === journalLineId);
    if (!line) throw mismatch('journalLineId');
    const check = lineFits(item, bankAccountId, line);
    if (!check.ok) throw mismatch(check.field!);
    taken(line);
    return line.id;
  }
  const onBank = lines.filter((l) => l.accountId === bankAccountId && !l.isVoidReversal);
  if (onBank.length === 0) throw mismatch('account');
  const fitting = onBank.filter((l) => lineFits(item, bankAccountId, l).ok);
  if (fitting.length === 0) throw mismatch('amount');
  const free = fitting.filter((l) => !l.takenBy);
  if (free.length === 0) taken(fitting[0]!);
  if (free.length > 1) {
    throw AppError.badRequest('This entry has more than one line that fits this bank line. Pick the line.', 'LINE_REQUIRED',
      { journalLineIds: free.map((l) => l.id) });
  }
  return free[0]!.id;
}

function mismatch(field: string): AppError {
  const why: Record<string, string> = {
    transactionId: 'That entry was not found or is not posted.',
    journalLineId: 'That line is not part of this entry.',
    account: 'This entry has no line on the bank account of this bank line.',
    amount: 'The entry\'s line on this bank account is not for exactly this amount, on the same side (money in or out).',
  };
  return AppError.badRequest(why[field] ?? 'The entry does not match this bank line.', 'MATCH_MISMATCH', { field });
}

export { mismatch as matchMismatch };
