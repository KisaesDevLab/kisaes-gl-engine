// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Bank feed Accept and Undo (U-170 feed-accept-v1, U-169 feed-undo-v1).
 *
 * POST /banking/feed/accept covers Accept (one row), Accept selected and
 * Accept all from this rule. POST /banking/feed/undo takes back one row, a
 * selection or a whole accept group. Both run in two phases inside ONE
 * database transaction (review B1):
 *
 *   1. Validate. Lock the feed rows in sorted id order, FOR UPDATE SKIP
 *      LOCKED (a row another request holds is reported, never waited for),
 *      and sort every row into skipped[] (nothing to do), failures[] (the
 *      owner can fix it: a closed period, an unbalanced split, a reconciled
 *      entry) or the work list. Only checks that can be predicted run here;
 *      nothing is written except the group row.
 *   2. Post. The work list is posted or undone in the same transaction, no
 *      savepoints. An unexpected error fails the whole call, so a request
 *      commits whole or not at all.
 *
 * Several postings under one Idempotency-Key in one database transaction are
 * fine: claimIdempotency is a no-op for a second claim on the same
 * transaction (idempotency.service.ts). The key names the accept group
 * (recorded before the first posting), so a replay over the 512 KB cap reads
 * the group's stored result (GET /banking/feed/accept-groups/:id).
 *
 * Rules never post on their own (U-168, S6). "Accept all from this rule"
 * needs the rule's auto_accept (a legacy rule's auto_confirm) and the
 * rule's updatedAt as the owner saw it (409 RULE_CHANGED), and takes only
 * pending rows the rule staged whose staging still matches the rule (S5).
 * A row with any match signal (a candidate line, a waiting payment, the
 * other side of a transfer) is skipped as has_match unless the owner sent
 * values or a match for it (B3). Possible duplicates are skipped. Rows whose
 * entry was voided are not waiting, so never selected.
 *
 * Undo works only from the accept records (bank-feed-accept-records.ts,
 * B5): a record acts only while its item still points at the recorded entry.
 * A posted entry (post, transfer, deposit) is deleted (Q-P26f), fee lines
 * included, after every item pointing at it is unlinked (both sides of a
 * transfer, also one matched later); a deposit's payments go back to
 * Payments Clearing exactly. A match or a received payment is unlinked and
 * the entry kept. An entry that was voided is only unlinked (as Review
 * again, no password). Each item gets its prior review state back, and the
 * categorization history counts an override (Q-P26k).
 */

import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import {
  bankConnections, bankFeedAcceptGroupItems, bankFeedAcceptGroups, bankFeedItems, bankRules, conditionalRules,
  journalLines, reconciliationLines, reconciliations, transactionClassificationState, transactions,
} from '../db/schema/index.js';
import type { Action } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import * as feed from './bank-feed.service.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { matchSignalSql } from './bank-feed-buckets.js';
import { resolveMatchLine } from './bank-feed-lines.js';
import {
  liveRecordFor, markUndone, newAcceptGroup, patchFromPriorState, recordAcceptItem, setAcceptGroupResult,
  txnFingerprint, type AcceptRecord,
} from './bank-feed-accept-records.js';
import * as engine from './conditional-rules-engine.service.js';
import { mapRow as mapConditionalRule } from './conditional-rules.service.js';
import { aggregateActions, stagePatch } from './conditional-rules-apply.service.js';
import * as symbolResolution from './rule-symbol-resolution.service.js';

/** Rows per accept or undo request. */
export const FEED_ACCEPT_MAX = 500;

type FeedRow = typeof bankFeedItems.$inferSelect;
const WAITING = ['pending', 'assigned'];

export type AcceptSkipReason =
  | 'not_found' | 'in_use' | 'not_pending' | 'possible_duplicate' | 'has_match' | 'incomplete' | 'staging_differs';

export interface AcceptItemInput extends feed.AcceptRowInput {
  id: string;
  /** Match this row to an existing entry instead of posting one. */
  matchTransactionId?: string;
  journalLineId?: string;
}

export interface AcceptRuleSelection {
  ruleId: string;
  ruleKind: 'conditional' | 'legacy';
  /** The rule's updatedAt as the owner saw it (the list's suggestedRule.updatedAt). */
  ruleUpdatedAt: string;
  bankConnectionId?: string;
  /** Continue after this row id (the previous response's nextAfterId). */
  afterId?: string;
}

export type AcceptRequest = { items: AcceptItemInput[]; rule?: undefined } | { rule: AcceptRuleSelection; items?: undefined };

export interface AcceptFailure { id: string; code: string; error: string; details?: Record<string, unknown> }

export interface AcceptResult {
  undoGroupId: string;
  posted: number;
  matched: number;
  /** Rows not accepted and nothing to fix: reason as AcceptSkipReason. */
  skipped: Array<{ id: string; reason: AcceptSkipReason }>;
  /** Rows the owner can fix and send again (TB_PERIOD_LOCKED, SPLITS_DONT_BALANCE, MATCH_MISMATCH ...). */
  failures: AcceptFailure[];
  /** Rule mode: rule rows after this batch (send nextAfterId to continue); 0 for items. */
  remaining: number;
  nextAfterId: string | null;
}

function failureOf(id: string, err: AppError): AcceptFailure {
  return { id, code: err.code ?? 'ERROR', error: err.message, ...(err.details ? { details: err.details } : {}) };
}

function companyMatches(rowCompanyId: string | null, companyId: string | undefined): boolean {
  return !companyId || !rowCompanyId || rowCompanyId === companyId;
}

/**
 * Locks feed rows in sorted id order, FOR UPDATE SKIP LOCKED. Returns the
 * locked rows and, for the rest, whether they exist (in_use) or not.
 */
async function lockRows(tx: Tx, tenantId: string, companyId: string | undefined, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  const rows = sorted.length === 0 ? [] : await tx.select().from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, sorted)))
    .orderBy(asc(bankFeedItems.id))
    .for('update', { skipLocked: true });
  const locked = new Map(rows.filter((r) => companyMatches(r.companyId, companyId)).map((r) => [r.id, r]));
  const missing = sorted.filter((id) => !rows.some((r) => r.id === id));
  const existing = missing.length === 0 ? [] : await tx.select({ id: bankFeedItems.id, companyId: bankFeedItems.companyId })
    .from(bankFeedItems).where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, missing)));
  const busy = new Set(existing.filter((r) => companyMatches(r.companyId, companyId)).map((r) => r.id));
  return { sorted, locked, busy };
}

/** The closed-period refusal for a date, or null when the date may be posted (no audit here). */
async function closedPeriodFailure(tx: Tx, tenantId: string, date: string, companyId: string | null | undefined, id: string) {
  try {
    await ledger.checkLockDate(tx, tenantId, date, companyId, undefined, { deferAudit: true });
    return null;
  } catch (err) {
    if (err instanceof AppError && err.code === 'TB_PERIOD_LOCKED') return failureOf(id, err);
    throw err;
  }
}

// ─── Rule mode ─────────────────────────────────────────────────

interface RuleInfo {
  kind: 'conditional' | 'legacy';
  id: string;
  check: (tx: Tx, row: FeedRow) => Promise<boolean>;
}

/** The connection's GL account (the rules' account_source_id). */
async function connectionAccountId(tx: Tx, tenantId: string, row: FeedRow): Promise<string | null> {
  const [c] = await tx.select({ accountId: bankConnections.accountId }).from(bankConnections)
    .where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, row.bankConnectionId))).limit(1);
  return c?.accountId ?? null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Loads the rule for "Accept all from this rule": 404 RULE_NOT_FOUND, 409
 * RULE_CHANGED {updatedAt} when it was saved since the owner looked, 409
 * RULE_NOT_AUTO_ACCEPT when its suggestions may not be accepted together.
 * `check` tells whether a row's staging still is what the rule stages (S5).
 */
async function loadRule(tx: Tx, tenantId: string, sel: AcceptRuleSelection): Promise<RuleInfo> {
  const notFound = () => new AppError(404, 'The rule was not found.', 'RULE_NOT_FOUND');
  const changed = (updatedAt: unknown) => AppError.conflict(
    'The rule was changed since this list was loaded. Refresh and try again.', 'RULE_CHANGED', { updatedAt });
  const notAuto = () => AppError.conflict(
    'This rule\'s suggestions can\'t be accepted all at once. Turn on "Accept all" for the rule first.', 'RULE_NOT_AUTO_ACCEPT');
  const sameTime = sql<boolean>`(updated_at = ${sel.ruleUpdatedAt}::timestamptz)`;

  if (sel.ruleKind === 'conditional') {
    const [row] = await tx.select({ rule: conditionalRules, same: sameTime }).from(conditionalRules)
      .where(and(eq(conditionalRules.id, sel.ruleId),
        sql`(${conditionalRules.tenantId} = ${tenantId} OR ${conditionalRules.scope} = 'global_firm')`))
      .limit(1).for('share');
    if (!row) throw notFound();
    if (!row.same) throw changed(row.rule.updatedAt);
    if (!row.rule.autoAccept) throw notAuto();
    const rule = mapConditionalRule(row.rule);
    return {
      kind: 'conditional', id: rule.id,
      check: async (t, item) => {
        const accountId = await connectionAccountId(t, tenantId, item);
        if (!accountId) return false;
        const res = engine.evaluateRule(rule, engine.contextFromFeedItem({
          description: item.description, originalDescription: item.originalDescription, amount: item.amount,
          feedDate: item.feedDate, bankConnectionAccountId: accountId, payeeNameOnCheck: item.payeeNameOnCheck,
        }));
        if (!res.matched) return false;
        const actions: Action[] = await symbolResolution.resolveActionsForTenant(tenantId, res.appliedActions, {
          scope: rule.scope, dryRun: true,
        });
        const patch = stagePatch(aggregateActions(actions));
        if (patch.suggestedAccountId !== undefined && patch.suggestedAccountId !== item.suggestedAccountId) return false;
        if (patch.suggestedContactId !== undefined && patch.suggestedContactId !== item.suggestedContactId) return false;
        if (patch.suggestedTagId !== undefined && patch.suggestedTagId !== item.suggestedTagId) return false;
        if (patch.splitsConfig !== undefined && !sameJson(patch.splitsConfig, item.splitsConfig)) return false;
        return true;
      },
    };
  }
  const [row] = await tx.select({ rule: bankRules, same: sameTime }).from(bankRules)
    .where(and(eq(bankRules.id, sel.ruleId), sql`(${bankRules.tenantId} = ${tenantId} OR ${bankRules.tenantId} IS NULL)`))
    .limit(1).for('share');
  if (!row) throw notFound();
  if (!row.same) throw changed(row.rule.updatedAt);
  if (!row.rule.autoConfirm) throw notAuto();
  const r = row.rule;
  return {
    kind: 'legacy', id: r.id,
    check: async (_t, item) => (!r.assignAccountId || r.assignAccountId === item.suggestedAccountId)
      && (!r.assignContactId || r.assignContactId === item.suggestedContactId)
      && (!r.assignTagId || r.assignTagId === item.suggestedTagId),
  };
}

// ─── Accept ────────────────────────────────────────────────────

/** Every account, contact and tag the owner named must be in this tenant (400 before anything posts). */
async function assertAcceptRefs(tenantId: string, items: AcceptItemInput[]): Promise<void> {
  const accountIds = [...new Set(items.map((i) => i.accountId).filter((v): v is string => !!v))];
  if (accountIds.length > 0) {
    const rows = await db.execute(sql`SELECT id FROM accounts WHERE tenant_id = ${tenantId}
      AND id IN (${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    if (rows.rows.length !== accountIds.length) throw AppError.badRequest('An account was not found in this company.', 'VALIDATION_ERROR');
  }
  const contactIds = [...new Set(items.map((i) => i.contactId).filter((v): v is string => !!v))];
  if (contactIds.length > 0) {
    const rows = await db.execute(sql`SELECT id FROM contacts WHERE tenant_id = ${tenantId}
      AND id IN (${sql.join(contactIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    if (rows.rows.length !== contactIds.length) throw AppError.badRequest('A name was not found in this company.', 'VALIDATION_ERROR');
  }
  const tagIds = [...new Set(items.map((i) => i.tagId).filter((v): v is string => !!v))];
  if (tagIds.length > 0) {
    const rows = await db.execute(sql`SELECT id FROM tags WHERE tenant_id = ${tenantId}
      AND id IN (${sql.join(tagIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    if (rows.rows.length !== tagIds.length) throw AppError.badRequest('A tag was not found in this company.', 'VALIDATION_ERROR');
  }
  for (const i of items) await feed.assertAcceptSplitRefs(tenantId, i.splits);
}

type AcceptPlan =
  | { kind: 'post'; row: FeedRow; values: feed.PostAssignmentValues }
  | { kind: 'match'; row: FeedRow; transactionId: string; journalLineId: string };

/** POST /banking/feed/accept (see the header). */
export async function acceptFeedItems(
  tenantId: string, companyId: string | undefined, userId: string | undefined, req: AcceptRequest,
): Promise<AcceptResult> {
  if (req.items) {
    if (new Set(req.items.map((i) => i.id)).size !== req.items.length) {
      throw AppError.badRequest('The same bank line is listed twice.', 'VALIDATION_ERROR');
    }
    await assertAcceptRefs(tenantId, req.items);
  }
  const learned: Array<{ id: string; l: feed.FeedLearning }> = [];

  const result = await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const rule = req.rule ? await loadRule(tx, tenantId, req.rule) : null;
    const undoGroupId = await newAcceptGroup(tx, {
      tenantId, companyId, userId, source: 'accept', ruleId: rule?.id ?? null, ruleKind: rule?.kind ?? null,
    });
    // The key names the group, before any posting records a transaction.
    await recordIdempotentEntity(tx, 'bank_feed_accept_group', undoGroupId);

    // Which rows.
    let requested: AcceptItemInput[];
    let remaining = 0;
    let nextAfterId: string | null = null;
    if (req.rule) {
      const sel = req.rule;
      const where = and(
        eq(bankFeedItems.tenantId, tenantId),
        eq(bankFeedItems.status, 'pending'),
        eq(bankFeedItems.suggestedRuleId, sel.ruleId),
        eq(bankFeedItems.suggestedRuleKind, sel.ruleKind),
        isNull(bankFeedItems.entryVoidedAt),
        companyId ? sql`(${bankFeedItems.companyId} = ${companyId} OR ${bankFeedItems.companyId} IS NULL)` : undefined,
        sel.bankConnectionId ? eq(bankFeedItems.bankConnectionId, sel.bankConnectionId) : undefined,
        sel.afterId ? gt(bankFeedItems.id, sel.afterId) : undefined,
      );
      const ids = await tx.select({ id: bankFeedItems.id }).from(bankFeedItems).where(where)
        .orderBy(asc(bankFeedItems.id)).limit(FEED_ACCEPT_MAX);
      requested = ids.map((r) => ({ id: r.id }));
      if (ids.length === FEED_ACCEPT_MAX) {
        const last = ids[ids.length - 1]!.id;
        const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(bankFeedItems)
          .where(and(where, gt(bankFeedItems.id, last)));
        remaining = c?.n ?? 0;
        nextAfterId = remaining > 0 ? last : null;
      }
    } else {
      requested = req.items!;
    }
    const inputs = new Map(requested.map((r) => [r.id, r]));
    const { sorted, locked, busy } = await lockRows(tx, tenantId, companyId, requested.map((r) => r.id));

    // One query for the match signal of every row that would post a suggestion.
    const needSignal = sorted.filter((id) => {
      const i = inputs.get(id)!;
      return locked.has(id) && !i.matchTransactionId && !i.accountId && !(i.splits && i.splits.length > 0);
    });
    const signalled = new Set(needSignal.length === 0 ? [] : (await tx.select({ id: bankFeedItems.id }).from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, needSignal), matchSignalSql(tenantId))))
      .map((r) => r.id));

    // 1. Validate.
    const skipped: AcceptResult['skipped'] = [];
    const failures: AcceptFailure[] = [];
    const plan: AcceptPlan[] = [];
    const linesTaken = new Set<string>();
    for (const id of sorted) {
      const input = inputs.get(id)!;
      const row = locked.get(id);
      if (!row) { skipped.push({ id, reason: busy.has(id) ? 'in_use' : 'not_found' }); continue; }
      if (!WAITING.includes(row.status ?? '') || row.entryVoidedAt) { skipped.push({ id, reason: 'not_pending' }); continue; }
      if (row.possibleDuplicate) { skipped.push({ id, reason: 'possible_duplicate' }); continue; }

      if (input.matchTransactionId) {
        try {
          const [txn] = await tx.select({ status: transactions.status, companyId: transactions.companyId }).from(transactions)
            .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, input.matchTransactionId))).for('share');
          if (!txn || txn.status !== 'posted' || !companyMatches(txn.companyId, companyId)) {
            throw new AppError(400, 'The entry to match was not found or is not posted.', 'MATCH_MISMATCH', { field: 'transactionId' });
          }
          const bankAccountId = await connectionAccountId(tx, tenantId, row);
          if (!bankAccountId) throw AppError.notFound('Bank connection not found');
          const lineId = await resolveMatchLine(tx, tenantId, { id: row.id, amount: row.amount, feedDate: row.feedDate },
            bankAccountId, input.matchTransactionId, input.journalLineId);
          if (linesTaken.has(lineId)) {
            throw AppError.conflict('Another bank line in this request is matched to the same entry line.', 'LINE_ALREADY_MATCHED',
              { journalLineId: lineId });
          }
          linesTaken.add(lineId);
          plan.push({ kind: 'match', row, transactionId: input.matchTransactionId, journalLineId: lineId });
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          failures.push(failureOf(id, err));
        }
        continue;
      }

      const explicit = !!input.accountId || !!(input.splits && input.splits.length > 0);
      if (!explicit && signalled.has(id)) { skipped.push({ id, reason: 'has_match' }); continue; }
      if (rule && !(await rule.check(tx, row))) { skipped.push({ id, reason: 'staging_differs' }); continue; }
      const values = feed.acceptValuesFor(row, input);
      if (!values) { skipped.push({ id, reason: 'incomplete' }); continue; }
      try {
        feed.assertFeedSplitsPost(row, values);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        failures.push(failureOf(id, err));
        continue;
      }
      const closed = await closedPeriodFailure(tx, tenantId, row.feedDate, companyId, id);
      if (closed) { failures.push(closed); continue; }
      plan.push({ kind: 'post', row, values });
    }

    // 2. Post: same transaction, no savepoints.
    let posted = 0;
    let matched = 0;
    for (const p of plan) {
      if (p.kind === 'match') {
        await feed.matchInTx(tx, tenantId, p.row.id, p.transactionId, {
          journalLineId: p.journalLineId, userId, companyId, acceptGroupId: undoGroupId,
        });
        matched++;
        continue;
      }
      const r = await feed.postFeedItemInTx(tx, tenantId, p.row, p.values, userId, companyId);
      await recordAcceptItem(tx, {
        tenantId, companyId, groupId: undoGroupId, kind: 'post', before: p.row,
        transactionId: r.transaction.id, journalLineId: r.journalLineId,
      });
      await auditLog(tenantId, 'update', 'bank_feed', p.row.id,
        { status: p.row.status, matchedTransactionId: p.row.matchedTransactionId },
        { action: 'accept', status: 'categorized', matchedTransactionId: r.transaction.id, undoGroupId,
          ...(rule ? { ruleId: rule.id, ruleKind: rule.kind } : {}) }, userId, tx);
      learned.push({ id: p.row.id, l: r.learn });
      posted++;
    }

    const out: AcceptResult = { undoGroupId, posted, matched, skipped, failures, remaining, nextAfterId };
    await setAcceptGroupResult(tx, tenantId, undoGroupId, out);
    return out;
  });

  for (const { id, l } of learned) feed.learnFromFeed(tenantId, id, l, true);
  return result;
}

/** GET /banking/feed/accept-groups/:id: the stored accept response (404 when not this company's). */
export async function getAcceptGroup(tenantId: string, companyId: string | undefined, groupId: string): Promise<AcceptResult> {
  const [g] = await db.select().from(bankFeedAcceptGroups)
    .where(and(eq(bankFeedAcceptGroups.tenantId, tenantId), eq(bankFeedAcceptGroups.id, groupId))).limit(1);
  if (!g || !companyMatches(g.companyId, companyId)) throw AppError.notFound('Accept group not found');
  if (g.result) return g.result as AcceptResult;
  // A group written by a single-item route: its records, in the accept shape.
  const items = await db.select().from(bankFeedAcceptGroupItems)
    .where(and(eq(bankFeedAcceptGroupItems.tenantId, tenantId), eq(bankFeedAcceptGroupItems.groupId, groupId)));
  return {
    undoGroupId: g.id,
    posted: items.filter((i) => i.kind !== 'match' && i.kind !== 'payment').length,
    matched: items.filter((i) => i.kind === 'match' || i.kind === 'payment').length,
    skipped: [], failures: [], remaining: 0, nextAfterId: null,
  };
}

// ─── Undo ──────────────────────────────────────────────────────

export interface UndoRequest {
  feedItemIds?: string[];
  undoGroupId?: string;
  /** Undo entries changed since they were accepted (after FEED_UNDO_CHANGED). */
  force?: boolean;
}

export interface UndoResult {
  /** entry: 'deleted' (posted for the row), 'kept' (a match, a payment or a voided entry: only unlinked). */
  undone: Array<{ id: string; kind: string; transactionId: string; entry: 'deleted' | 'kept'; undoGroupId: string }>;
  failures: AcceptFailure[];
}

interface UndoUnit {
  transactionId: string;
  records: AcceptRecord[];
  /** Every feed item pointing at the entry (both sides of a transfer). */
  linked: FeedRow[];
  action: 'delete' | 'unlink';
}

/** True when a line is cleared in a completed reconciliation. */
async function reconciled(tx: Tx, tenantId: string, opts: { transactionId?: string; lineIds?: string[] }): Promise<boolean> {
  const conds = [eq(reconciliations.tenantId, tenantId), eq(reconciliations.status, 'complete'), eq(reconciliationLines.isCleared, true)];
  if (opts.transactionId) conds.push(eq(journalLines.transactionId, opts.transactionId));
  else if (opts.lineIds && opts.lineIds.length > 0) conds.push(inArray(reconciliationLines.journalLineId, opts.lineIds));
  else return false;
  const rows = await tx.select({ one: sql<number>`1` }).from(reconciliationLines)
    .innerJoin(reconciliations, eq(reconciliations.id, reconciliationLines.reconciliationId))
    .innerJoin(journalLines, eq(journalLines.id, reconciliationLines.journalLineId))
    .where(and(...conds)).limit(1);
  return rows.length > 0;
}

/** What an undone post teaches the history: the account of its first non-bank line (an override, Q-P26k). */
async function overrideFor(tx: Tx, tenantId: string, item: FeedRow, txnId: string): Promise<feed.FeedLearning | null> {
  const bank = await connectionAccountId(tx, tenantId, item);
  const [txn] = await tx.select({ contactId: transactions.contactId }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId))).limit(1);
  const [line] = await tx.select({ accountId: journalLines.accountId }).from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false),
      bank ? sql`${journalLines.accountId} <> ${bank}` : undefined))
    .orderBy(asc(journalLines.lineOrder)).limit(1);
  if (!line) return null;
  return { text: item.originalDescription || item.description || '', accountId: line.accountId, contactId: txn?.contactId ?? null };
}

/** POST /banking/feed/undo (see the header). */
export async function undoFeedAccepts(
  tenantId: string, companyId: string | undefined, userId: string | undefined, req: UndoRequest,
): Promise<UndoResult> {
  const overrides: Array<{ id: string; l: feed.FeedLearning }> = [];

  const result = await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const failures: AcceptFailure[] = [];
    const notAccepted = (id: string) => failures.push({
      id, code: 'FEED_ITEM_NOT_ACCEPTED',
      error: 'This bank line is not linked by an accept that can be undone (it may have been undone already).',
    });

    // The records to act on, by feed item.
    let ids: string[];
    let groupRecords: AcceptRecord[] | null = null;
    if (req.undoGroupId) {
      const [g] = await tx.select().from(bankFeedAcceptGroups)
        .where(and(eq(bankFeedAcceptGroups.tenantId, tenantId), eq(bankFeedAcceptGroups.id, req.undoGroupId))).limit(1);
      if (!g || !companyMatches(g.companyId, companyId)) throw AppError.notFound('Accept group not found');
      groupRecords = await tx.select().from(bankFeedAcceptGroupItems)
        .where(and(eq(bankFeedAcceptGroupItems.tenantId, tenantId), eq(bankFeedAcceptGroupItems.groupId, g.id)))
        .orderBy(asc(bankFeedAcceptGroupItems.feedItemId));
      ids = [...new Set(groupRecords.map((r) => r.feedItemId))];
    } else {
      ids = [...new Set(req.feedItemIds ?? [])];
    }
    const { sorted, locked, busy } = await lockRows(tx, tenantId, companyId, ids);

    // 1. Validate: one unit per entry.
    const units = new Map<string, UndoUnit>();
    for (const id of sorted) {
      const item = locked.get(id);
      if (!item) {
        if (busy.has(id)) {
          failures.push({ id, code: 'FEED_ITEM_IN_USE', error: 'Someone else is working on this bank line. Try again in a moment.' });
        } else notAccepted(id);
        continue;
      }
      const rec = groupRecords
        ? groupRecords.find((r) => r.feedItemId === id && !r.undoneAt && r.transactionId === item.matchedTransactionId)
        : await liveRecordFor(tx, tenantId, item);
      if (!rec || rec.transactionId !== item.matchedTransactionId) { notAccepted(id); continue; }
      const unit = units.get(rec.transactionId) ?? { transactionId: rec.transactionId, records: [], linked: [], action: 'unlink' as const };
      unit.records.push(rec);
      units.set(rec.transactionId, unit);
    }

    const changedIds: string[] = [];
    const ready: UndoUnit[] = [];
    for (const unit of [...units.values()].sort((a, b) => a.transactionId.localeCompare(b.transactionId))) {
      const failAll = (code: string, error: string, details?: Record<string, unknown>) => {
        for (const r of unit.records) failures.push({ id: r.feedItemId, code, error, ...(details ? { details } : {}) });
      };
      const [txn] = await tx.select().from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, unit.transactionId))).for('update');
      // Every item pointing at the entry, also one not in this request (the other side of a transfer).
      const linkedIds = (await tx.select({ id: bankFeedItems.id }).from(bankFeedItems)
        .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.matchedTransactionId, unit.transactionId))))
        .map((r) => r.id);
      const extra = linkedIds.filter((i) => !locked.has(i));
      const extraLocked = extra.length === 0 ? [] : await tx.select().from(bankFeedItems)
        .where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, extra.sort())))
        .orderBy(asc(bankFeedItems.id)).for('update', { skipLocked: true });
      if (extraLocked.length !== extra.length) {
        failAll('FEED_ITEM_IN_USE', 'Someone else is working on the other side of this entry. Try again in a moment.');
        continue;
      }
      unit.linked = [...linkedIds.filter((i) => locked.has(i)).map((i) => locked.get(i)!), ...extraLocked];

      const voided = !txn || txn.status !== 'posted' || unit.linked.some((l) => l.entryVoidedAt);
      const kinds = new Set(unit.records.map((r) => r.kind));
      unit.action = voided || kinds.has('match') || kinds.has('payment') ? 'unlink' : 'delete';

      if (!voided) {
        const isReconciled = unit.action === 'delete'
          ? await reconciled(tx, tenantId, { transactionId: unit.transactionId })
          : await reconciled(tx, tenantId, { lineIds: unit.linked.map((l) => l.matchedJournalLineId).filter((v): v is string => !!v) });
        if (isReconciled) {
          failAll('FEED_UNDO_RECONCILED', 'This entry is part of a completed bank reconciliation, so it can\'t be undone. '
            + 'Undo the reconciliation first.');
          continue;
        }
      }
      if (unit.action === 'delete') {
        if (!req.force) {
          const now = await txnFingerprint(tx, tenantId, unit.transactionId);
          if (unit.records.some((r) => r.txnFingerprint && r.txnFingerprint !== now)) {
            changedIds.push(...unit.records.map((r) => r.feedItemId));
          }
        }
        const lockedPeriod = await closedPeriodFailure(tx, tenantId, txn!.txnDate, txn!.companyId, unit.records[0]!.feedItemId);
        if (lockedPeriod) {
          failAll(lockedPeriod.code, lockedPeriod.error, lockedPeriod.details);
          continue;
        }
        if (txn!.txnType === 'deposit') {
          try {
            await (await import('./payment.service.js')).assertDepositSourcesNotBounced(tx, tenantId, unit.transactionId);
          } catch (err) {
            if (!(err instanceof AppError)) throw err;
            const f = failureOf(unit.records[0]!.feedItemId, err);
            failAll(f.code, f.error, f.details);
            continue;
          }
        }
      }
      ready.push(unit);
    }
    if (changedIds.length > 0) {
      // Ask first (Q-P26f): nothing is undone; the desktop asks and sends force.
      throw AppError.conflict('Some of these entries were changed after they were accepted. Undo deletes them with the changes.',
        'FEED_UNDO_CHANGED', { ids: [...new Set(changedIds)].sort() });
    }

    // 2. Post: unlink every item on the entry, restore it, then delete the entry.
    const undone: UndoResult['undone'] = [];
    for (const unit of ready) {
      const learn = unit.action === 'delete' && unit.records.some((r) => r.kind === 'post')
        ? await overrideFor(tx, tenantId, unit.linked.find((l) => l.id === unit.records[0]!.feedItemId) ?? unit.linked[0]!, unit.transactionId)
        : null;
      const recordIds: string[] = [];
      for (const item of unit.linked) {
        const rec = unit.records.find((r) => r.feedItemId === item.id) ?? await liveRecordFor(tx, tenantId, item);
        if (rec) recordIds.push(rec.id);
        const restore = rec ? patchFromPriorState(rec.priorState) : {
          status: 'pending', assignedAccountId: null, assignedContactId: null, assignedTagId: null, assignedMemo: null,
          assignedBy: null, assignedAt: null,
        };
        await tx.update(bankFeedItems).set({
          ...restore,
          matchedTransactionId: null,
          matchedJournalLineId: null,
          entryVoidedAt: null,
          updatedAt: new Date(),
        }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)));
        await tx.update(transactionClassificationState).set({ transactionId: null, updatedAt: new Date() })
          .where(and(eq(transactionClassificationState.tenantId, tenantId), eq(transactionClassificationState.bankFeedItemId, item.id)));
        await auditLog(tenantId, 'update', 'bank_feed', item.id,
          { status: item.status, matchedTransactionId: item.matchedTransactionId },
          { action: 'undo', status: restore.status, entry: unit.action === 'delete' ? 'deleted' : 'kept',
            undoGroupId: rec?.groupId ?? null }, userId, tx);
        undone.push({
          id: item.id, kind: rec?.kind ?? unit.records[0]!.kind, transactionId: unit.transactionId,
          entry: unit.action === 'delete' ? 'deleted' : 'kept', undoGroupId: rec?.groupId ?? unit.records[0]!.groupId,
        });
      }
      await markUndone(tx, tenantId, recordIds, userId);
      if (unit.action === 'delete') {
        await ledger.deleteTransactionInTx(tx, tenantId, unit.transactionId, {
          userId, companyId, reason: 'Bank feed Undo',
        });
        if (learn) overrides.push({ id: unit.records[0]!.feedItemId, l: learn });
      }
    }
    undone.sort((a, b) => a.id.localeCompare(b.id));
    failures.sort((a, b) => a.id.localeCompare(b.id));
    return { undone, failures };
  });

  for (const { id, l } of overrides) feed.learnFromFeed(tenantId, id, l, false);
  return result;
}

/**
 * Review again after a void (U-166 hook): the item's prior state from its
 * live accept record, which is then marked undone.
 */
export const restorePriorState: feed.PriorStateRestorer = async (tx, tenantId, item) => {
  const rec = await liveRecordFor(tx, tenantId, item);
  if (!rec) return null;
  await markUndone(tx, tenantId, [rec.id]);
  return patchFromPriorState(rec.priorState);
};

/**
 * Installs restorePriorState as Review again's hook. Called when the banking
 * routes load (app start, and every test that mounts them), so the hook is
 * in place in every process that serves Review again.
 */
export function registerPriorStateRestorer(): void {
  feed.setPriorStateRestorer(restorePriorState);
}
