// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, count, gte, lte, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { BankFeedFilters, CategorizeInput, CsvColumnMapping } from '@kis-books/shared';
import { db } from '../db/index.js';
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

export async function list(tenantId: string, filters: BankFeedFilters) {
  const conditions = [eq(bankFeedItems.tenantId, tenantId)];
  if (filters.status) {
    // An explicit single-status filter takes precedence over actionableOnly.
    conditions.push(eq(bankFeedItems.status, filters.status));
  } else if (filters.actionableOnly) {
    // "Hide processed" — exclude items that have already been handled,
    // leaving the actionable (pending) work to do.
    conditions.push(sql`${bankFeedItems.status} NOT IN ('matched', 'categorized', 'excluded')`);
  }
  if (filters.bankConnectionId) conditions.push(eq(bankFeedItems.bankConnectionId, filters.bankConnectionId));
  if (filters.startDate) conditions.push(sql`${bankFeedItems.feedDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${bankFeedItems.feedDate} <= ${filters.endDate}`);
  if ((filters as any).search) {
    const term = '%' + (filters as any).search + '%';
    conditions.push(sql`(${bankFeedItems.description} ILIKE ${term} OR ${bankFeedItems.category} ILIKE ${term})`);
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
      confidenceScore: bankFeedItems.confidenceScore,
      // STATEMENT_CHECK_PAYEE_V1 — surfaced in the UI so the payee read off a
      // check image is visible/confirmable before posting.
      payeeNameOnCheck: bankFeedItems.payeeNameOnCheck,
      checkNumber: bankFeedItems.checkNumber,
      memo: bankFeedItems.memo,
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
    }).from(bankFeedItems)
      .leftJoin(bankConnections, eq(bankFeedItems.bankConnectionId, bankConnections.id))
      .leftJoin(accounts, eq(bankConnections.accountId, accounts.id))
      .leftJoin(suggestedAccount, eq(bankFeedItems.suggestedAccountId, suggestedAccount.id))
      .leftJoin(suggestedTag, eq(bankFeedItems.suggestedTagId, suggestedTag.id))
      .leftJoin(assignedAccount, eq(bankFeedItems.assignedAccountId, assignedAccount.id))
      .leftJoin(assignedTag, eq(bankFeedItems.assignedTagId, assignedTag.id))
      .where(where)
      .orderBy(orderBy)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ count: count() }).from(bankFeedItems).where(where),
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

export async function checkPayrollOverlap(
  tenantId: string,
  feedDate: string,
  absAmount: number,
  bankAccountId: string,
): Promise<Array<{ txnId: string; memo: string; date: string; amount: string }>> {
  // Look for payroll-sourced transactions within ±5 days that have a journal
  // line touching the bank account with a matching amount.
  const startDate = new Date(feedDate);
  startDate.setDate(startDate.getDate() - 5);
  const endDate = new Date(feedDate);
  endDate.setDate(endDate.getDate() + 5);

  const matches = await db
    .select({
      txnId: transactions.id,
      memo: transactions.memo,
      txnDate: transactions.txnDate,
      credit: journalLines.credit,
      debit: journalLines.debit,
    })
    .from(transactions)
    .innerJoin(journalLines, and(
      eq(journalLines.transactionId, transactions.id),
      eq(journalLines.accountId, bankAccountId),
    ))
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.source, 'payroll_import'),
      eq(transactions.status, 'posted'),
      gte(transactions.txnDate, startDate.toISOString().split('T')[0]!),
      lte(transactions.txnDate, endDate.toISOString().split('T')[0]!),
    ));

  // Filter by matching amount (within $0.01)
  return matches
    .filter(m => {
      const lineAmount = Math.abs(parseFloat(m.credit || '0')) + Math.abs(parseFloat(m.debit || '0'));
      return Math.abs(lineAmount - absAmount) < 0.01;
    })
    .map(m => ({
      txnId: m.txnId,
      memo: m.memo || 'Payroll JE',
      date: m.txnDate,
      amount: (parseFloat(m.credit || '0') || parseFloat(m.debit || '0')).toFixed(2),
    }));
}

// Phase 4 conditional split_by_* action: a JSONB blob staged on the feed
// item that expands into N user-facing journal lines at post time (the cash
// leg stays a single line so the bank account stays simple).
type FeedSplitsConfig =
  | { kind: 'percentage'; splits: Array<{ accountId: string; percent: number; tagId: string | null; memo: string | null }> }
  | { kind: 'fixed'; splits: Array<{ accountId: string; amount: string; tagId: string | null; memo: string | null }> }
  | null;

// The fully-resolved values postAssignment posts. The caller has already
// resolved the tag (an explicit id, or null for untagged — the
// undefined→suggestedTagId fallback lives in categorize()), the contact, and
// the memo, so this helper never guesses.
interface PostAssignmentValues {
  accountId: string;
  contactId?: string | null;
  tagId?: string | null;
  memo?: string | null;
  splitsConfig?: FeedSplitsConfig;
}

/**
 * Shared posting body for BOTH the direct-post path (categorize(), used by
 * autoConfirm legacy rules + bulkCategorize) and the two-phase approve()
 * path. Builds the user + cash journal lines, posts the ledger transaction,
 * transitions the feed item to 'categorized' + stamps matchedTransactionId,
 * and feeds categorization learning.
 *
 * The CALLER owns the atomic status claim (pending/assigned → 'categorizing')
 * and its revert on failure; this helper only runs the ledger post + final
 * status flip together in one DB transaction (a crash between them would
 * leave a posted transaction with the feed item stuck 'categorizing').
 */
async function postAssignment(
  tenantId: string,
  feedItemId: string,
  item: typeof bankFeedItems.$inferSelect,
  values: PostAssignmentValues,
  userId?: string,
  companyId?: string,
) {
  // Determine if this is an expense (positive amount = money out) or deposit
  // (negative = money in).
  const amount = Math.abs(parseFloat(item.amount));
  const isExpense = parseFloat(item.amount) > 0;

  // Get the bank account from the connection. Tenant-scoped via a join on
  // accounts.tenant_id for defense in depth (CLAUDE.md rule #17).
  const conn = await db.query.bankConnections.findFirst({
    where: eq(bankConnections.id, item.bankConnectionId),
  });
  if (!conn) throw AppError.notFound('Bank connection not found');
  const connAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, conn.accountId)),
  });
  if (!connAccount) {
    throw AppError.notFound('Bank connection does not belong to this tenant');
  }

  const splitsConfig = values.splitsConfig ?? null;
  const userLines: Array<{ accountId: string; debit: string; credit: string; description?: string; tagId?: string }> = [];
  if (splitsConfig && splitsConfig.splits.length > 0) {
    const totalCents = Math.round(amount * 100);
    let allocatedCents = 0;
    for (let i = 0; i < splitsConfig.splits.length; i++) {
      const s = splitsConfig.splits[i]!;
      let lineCents: number;
      if (splitsConfig.kind === 'percentage') {
        lineCents = i === splitsConfig.splits.length - 1
          ? totalCents - allocatedCents
          : Math.round((totalCents * (s as { percent: number }).percent) / 100);
      } else {
        lineCents = Math.round(parseFloat((s as { amount: string }).amount) * 100);
      }
      allocatedCents += lineCents;
      const lineAmt = (lineCents / 100).toFixed(4);
      userLines.push({
        accountId: s.accountId,
        debit: isExpense ? lineAmt : '0',
        credit: isExpense ? '0' : lineAmt,
        description: s.memo ?? item.description ?? undefined,
        tagId: s.tagId ?? values.tagId ?? undefined,
      });
    }
  } else {
    userLines.push({
      accountId: values.accountId,
      debit: isExpense ? amount.toFixed(4) : '0',
      credit: isExpense ? '0' : amount.toFixed(4),
      description: item.description || undefined,
      // The tag is already resolved by the caller (id or null).
      tagId: values.tagId ?? undefined,
    });
  }

  const cashLine = {
    accountId: conn.accountId,
    debit: isExpense ? '0' : amount.toFixed(4),
    credit: isExpense ? amount.toFixed(4) : '0',
  };

  const txn = await db.transaction(async (tx) => {
    const t = await ledger.postTransaction(tenantId, {
      txnType: isExpense ? 'expense' : 'deposit',
      txnDate: item.feedDate,
      contactId: values.contactId || undefined,
      // Memo chain resolved by the caller; item.description is the final
      // fallback. The provider category hint ("FOOD_AND_DRINK") deliberately
      // stays out of this chain — it leaked classification codes into the
      // books on every bulk approve.
      memo: values.memo || item.description || undefined,
      total: amount.toFixed(4),
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

    await tx.update(bankFeedItems).set({
      status: 'categorized',
      matchedTransactionId: t.id,
      updatedAt: new Date(),
    }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));
    return t;
  });

  // Update categorization learning history. Fire-and-forget — the
  // transaction has already posted; this only feeds future suggestions.
  updateLearning(
    tenantId,
    item.originalDescription || item.description || '',
    values.accountId,
    values.contactId || null,
    true,
  ).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[bank-feed] updateLearning failed for tenant ${tenantId}:`, err?.message ?? err);
  });

  return txn;
}

/**
 * DIRECT-POST path. Posts a feed item to the ledger the moment a category is
 * chosen. Retained for the callers that post-on-match BY DESIGN — legacy
 * autoConfirm bank rules and conditional split rules in runRulesStages, plus
 * bulkCategorize. The interactive UI now stages via assign()/approve()
 * instead of calling this.
 */
export async function categorize(tenantId: string, feedItemId: string, input: CategorizeInput, userId?: string, companyId?: string) {
  // Atomic claim: flip the feed item from 'pending' to 'categorizing' in one
  // UPDATE. Two concurrent categorize calls serialize here — only one gets a
  // row back, the other throws cleanly (no duplicate ledger posts).
  const [claimed] = await db.update(bankFeedItems)
    .set({ status: 'categorizing', updatedAt: new Date() })
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      eq(bankFeedItems.id, feedItemId),
      eq(bankFeedItems.status, 'pending'),
    ))
    .returning();

  if (!claimed) {
    const existing = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
    });
    if (!existing) throw AppError.notFound('Bank feed item not found');
    throw AppError.badRequest(
      `Bank feed item is not pending (current status: ${existing.status}). ` +
      `It may already be categorized or in progress.`,
    );
  }

  const item = claimed;

  try {
    const splitsConfig = item.splitsConfig as FeedSplitsConfig;
    // Tag resolution distinguishes three caller intents:
    //   - key absent (undefined): no explicit choice → fall back to the
    //     rule-staged suggested tag (rule→categorize / "accept as-is").
    //   - explicit null: user cleared the picker → post UNTAGGED.
    //   - explicit id: that tag wins.
    const resolvedTagId = input.tagId === undefined
      ? (item.suggestedTagId ?? null)
      : (input.tagId ?? null);

    return await postAssignment(tenantId, feedItemId, item, {
      accountId: input.accountId,
      contactId: input.contactId || (item.suggestedContactId ?? undefined),
      tagId: resolvedTagId,
      memo: input.memo || (item.memo as string | null) || item.description || undefined,
      splitsConfig,
    }, userId, companyId);
  } catch (err) {
    // Revert the claim so the user can retry (only if we still own it).
    await db.update(bankFeedItems).set({
      status: 'pending',
      updatedAt: new Date(),
    }).where(and(
      eq(bankFeedItems.tenantId, tenantId),
      eq(bankFeedItems.id, feedItemId),
      eq(bankFeedItems.status, 'categorizing'),
    ));
    throw err;
  }
}

// ── Two-phase workflow: ASSIGN (stage) then APPROVE (post) ──

export interface AssignInput {
  accountId: string;
  contactId?: string | null;
  tagId?: string | null;
  memo?: string | null;
}

/**
 * ASSIGN — stage a category on a feed item WITHOUT posting to the ledger.
 * Persists the chosen account/contact/tag/memo in the assigned_* columns and
 * transitions pending → 'assigned' (an actionable, "ready to approve" state).
 * Re-assigning an already-'assigned' item overwrites the staged values;
 * anything already posted/handled (categorized/matched/excluded) is rejected.
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

  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');
  // Only a fresh (pending) or already-staged (assigned) item can be assigned.
  // categorized/matched are already posted; excluded is not applicable.
  if (item.status !== 'pending' && item.status !== 'assigned') {
    throw AppError.badRequest(
      `Bank feed item cannot be assigned (current status: ${item.status}). ` +
      `It may already be posted or excluded.`,
    );
  }

  const [updated] = await db.update(bankFeedItems)
    .set({
      assignedAccountId: input.accountId,
      assignedContactId: input.contactId ?? null,
      assignedTagId: input.tagId ?? null,
      assignedMemo: input.memo ?? null,
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
    throw AppError.badRequest('Bank feed item changed state; reload and try again.');
  }

  await auditLog(tenantId, 'update', 'bank_feed', feedItemId, item, updated, userId);
  return updated;
}

/**
 * APPROVE — post a previously-staged ('assigned') feed item to the ledger
 * using its assigned_* values. Transitions assigned → 'categorized' and
 * stamps matchedTransactionId. Requires status 'assigned' with an
 * assigned_account_id; otherwise rejects with a clear error. Lock dates are
 * enforced by the underlying ledger post.
 */
export async function approve(tenantId: string, feedItemId: string, userId?: string, companyId?: string) {
  // Atomic claim assigned → 'categorizing' (same anti-double-post guard as
  // categorize). Only one concurrent approve wins.
  const [claimed] = await db.update(bankFeedItems)
    .set({ status: 'categorizing', updatedAt: new Date() })
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      eq(bankFeedItems.id, feedItemId),
      eq(bankFeedItems.status, 'assigned'),
    ))
    .returning();

  if (!claimed) {
    const existing = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
    });
    if (!existing) throw AppError.notFound('Bank feed item not found');
    throw AppError.badRequest(
      `Bank feed item is not assigned (current status: ${existing.status}). ` +
      `Assign a category before approving.`,
    );
  }

  const item = claimed;

  // Defensive: assign() always sets assigned_account_id, but guard anyway so
  // a hand-edited row can't post an empty category.
  if (!item.assignedAccountId) {
    await db.update(bankFeedItems).set({ status: 'assigned', updatedAt: new Date() })
      .where(and(
        eq(bankFeedItems.tenantId, tenantId),
        eq(bankFeedItems.id, feedItemId),
        eq(bankFeedItems.status, 'categorizing'),
      ));
    throw AppError.badRequest('No staged category to approve. Assign an account first.');
  }

  try {
    const splitsConfig = item.splitsConfig as FeedSplitsConfig;
    return await postAssignment(tenantId, feedItemId, item, {
      accountId: item.assignedAccountId,
      contactId: item.assignedContactId ?? undefined,
      // Approve posts the tag exactly as staged (explicit id or null — no
      // suggested-tag fallback; the user already made the choice at assign).
      tagId: item.assignedTagId ?? null,
      memo: (item.assignedMemo as string | null) || (item.memo as string | null) || item.description || undefined,
      splitsConfig,
    }, userId, companyId);
  } catch (err) {
    // Revert the claim back to 'assigned' so the staged values survive and
    // the user can retry (e.g. after a lock-date fix).
    await db.update(bankFeedItems).set({
      status: 'assigned',
      updatedAt: new Date(),
    }).where(and(
      eq(bankFeedItems.tenantId, tenantId),
      eq(bankFeedItems.id, feedItemId),
      eq(bankFeedItems.status, 'categorizing'),
    ));
    throw err;
  }
}

export async function match(tenantId: string, feedItemId: string, transactionId: string) {
  // Claim atomically in the same style as categorize: only transition
  // from 'pending' → 'matched'. Prevents double-matching the same feed
  // item if the user clicks "Match" twice or two users race.
  const [matched] = await db.update(bankFeedItems)
    .set({
      status: 'matched',
      matchedTransactionId: transactionId,
      updatedAt: new Date(),
    })
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      eq(bankFeedItems.id, feedItemId),
      eq(bankFeedItems.status, 'pending'),
    ))
    .returning();
  if (!matched) {
    const existing = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
    });
    if (!existing) throw AppError.notFound('Bank feed item not found');
    throw AppError.badRequest(`Bank feed item is not pending (current status: ${existing.status}).`);
  }
}

/**
 * Find candidate transactions that could match a bank feed item.
 *
 * Heuristic: same dollar amount, within ±5 days of the feed item's date,
 * not already matched to another feed item, and on the same bank account.
 *
 * Returns bill payments, write-checks (expense txns with check fields), and
 * other expense/deposit txns that touch the connected bank account. Bill
 * payments are prioritized so users can avoid creating duplicate expenses
 * for invoices they already paid through Pay Bills.
 */
export async function findMatchCandidates(tenantId: string, feedItemId: string) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) return [];

  // Resolve the connected bank account so we only suggest transactions that
  // touched the same physical account.
  if (!item.bankConnectionId) return [];
  const conn = await db.query.bankConnections.findFirst({
    where: eq(bankConnections.id, item.bankConnectionId),
  });
  if (!conn) return [];

  const feedAmount = parseFloat(String(item.amount || '0'));
  if (feedAmount === 0) return [];

  // ±5-day window
  const feedDate = new Date(item.feedDate);
  const start = new Date(feedDate);
  start.setDate(start.getDate() - 5);
  const end = new Date(feedDate);
  end.setDate(end.getDate() + 5);
  const startStr = start.toISOString().split('T')[0]!;
  const endStr = end.toISOString().split('T')[0]!;

  // Bank feed amounts are signed: negative = money leaving (expense, check,
  // bill payment), positive = money in (deposit). For matching we compare
  // absolute value against the txn total.
  const absAmount = Math.abs(feedAmount).toFixed(4);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.total, t.memo,
      t.check_number, t.print_status,
      c.display_name AS contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.txn_date >= ${startStr} AND t.txn_date <= ${endStr}
      AND ABS(CAST(t.total AS DECIMAL) - ${absAmount}) < 0.01
      AND t.txn_type IN ('bill_payment', 'expense', 'deposit', 'transfer')
      AND t.id IN (
        SELECT transaction_id FROM journal_lines
        WHERE tenant_id = ${tenantId}
          AND account_id = ${conn.accountId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM bank_feed_items bfi
        WHERE bfi.tenant_id = ${tenantId}
          AND bfi.matched_transaction_id = t.id
          AND bfi.id != ${feedItemId}
      )
    ORDER BY
      CASE t.txn_type WHEN 'bill_payment' THEN 0 ELSE 1 END,
      ABS(EXTRACT(EPOCH FROM (t.txn_date::timestamp - ${item.feedDate}::timestamp))) ASC
    LIMIT 10
  `);

  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    txnType: r.txn_type,
    txnNumber: r.txn_number,
    txnDate: r.txn_date,
    total: r.total,
    memo: r.memo,
    checkNumber: r.check_number,
    printStatus: r.print_status,
    contactName: r.contact_name,
  }));
}

export async function exclude(tenantId: string, feedItemId: string) {
  await db.update(bankFeedItems).set({
    status: 'excluded',
    updatedAt: new Date(),
  }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));
}

/**
 * BULK APPROVE — post every 'assigned' item in the selection to the ledger
 * using its STAGED assigned_* values (via approve()). This REPLACES the old
 * behavior, which posted 'pending' items on their AI suggestedAccountId; the
 * two-phase workflow means approval only ever posts what a human staged.
 *
 * Items not in status 'assigned' (pending/categorized/matched/excluded, or
 * missing) are skipped, never posted. Per-item try/catch keeps one failure
 * (e.g. a lock-date rejection) from aborting the batch.
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
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (item && item.status === 'assigned') {
        await approve(tenantId, id, userId, companyId);
        approved++;
      } else {
        // Not staged (pending/posted/excluded/missing) → skip, don't post.
        skipped++;
      }
    } catch (err: any) {
      failures.push({ id, error: err?.message || 'unknown error' });
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
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (item && item.status === 'pending') {
        await categorize(tenantId, id, { accountId, contactId, memo, tagId }, userId, companyId);
        categorized++;
      }
    } catch (err: any) {
      failures.push({ id, error: err?.message || 'unknown error' });
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
export async function bulkSetName(tenantId: string, feedItemIds: string[], name: string) {
  const trimmed = name.trim().slice(0, 500);
  if (!trimmed || feedItemIds.length === 0) return { updated: 0 };
  const updatedRows = await db.update(bankFeedItems)
    .set({ description: trimmed, updatedAt: new Date() })
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      inArray(bankFeedItems.id, feedItemIds),
    ))
    .returning({ id: bankFeedItems.id });
  return { updated: updatedRows.length };
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
      if (!item || !item.matchedTransactionId) {
        failures.push({ id, error: 'no converted transaction to tag' });
        continue;
      }
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

export async function bulkExclude(tenantId: string, feedItemIds: string[]) {
  let excluded = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (item && item.status === 'pending') {
        await exclude(tenantId, id);
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
 * payee on `payee_name_on_check` (report fallback + audit); when it resolves
 * to a unique existing contact we also set `suggested_contact_id` so the
 * posted transaction gets a real `contact_id` (auto-apply on exact match).
 * Never creates contacts.
 */
async function applyCheckImagePayees(
  tenantId: string,
  items: Array<typeof bankFeedItems.$inferSelect>,
  checks: StatementCheckImage[],
) {
  const candidates = items.filter((it) => it.checkNumber != null);
  if (candidates.length === 0) return;

  const byNumber = new Map<number, StatementCheckImage[]>();
  for (const c of checks) {
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

  for (const item of candidates) {
    const num = item.checkNumber as number;
    const matches = byNumber.get(num);
    if (!matches || matches.length === 0) continue;
    const feedAmount = Math.abs(parseFloat(String(item.amount || '0')));
    // Confirm by amount within a cent; if a check thumbnail had no readable
    // amount, fall back to number-only when it's the sole check with that #.
    const match =
      matches.find((c) => c.amount != null && Math.abs(Math.abs(parseFloat(c.amount)) - feedAmount) <= 0.01) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (!match) continue;
    const payee = match.payee.trim();
    if (!payee) continue;

    const contact = matchByName(tenantContacts, (c) => c.displayName, payee);
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
function applyCleanseContactName(contactName: string, contactId: string | null | undefined): string | null {
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

export async function runCleansingPipeline(tenantId: string, items: any[]): Promise<CleansingAggregate> {
  const agg = emptyCleansingAggregate();

  // M1: the LLM cleansing step is a real paid AI call, so it honors the
  // "Auto-categorize bank feed transactions on import" master switch
  // (ai_config.autoCategorizeOnImport). When off, skip the LLM entirely
  // (counted as `disabled`) — deterministic rules + regex cleaning still run.
  const { getConfig } = await import('./ai-config.service.js');
  const aiCfg = await getConfig().catch(() => null);
  const aiDisabled = !(aiCfg?.autoCategorizeOnImport ?? true);

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
            console.warn(`[cleanse] AI step failed for item ${s.item.id}: ${r.error.message}`);
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
interface RulesStagesOutcome {
  /** Ids of items that were still 'pending' when rule evaluation ran. */
  processedIds: string[];
  /** itemId → rule attribution (first conditional fire wins; a legacy
   *  match otherwise). The pipeline feeds this into the
   *  classification-state upsert so Bucket 2 can render "grouped by
   *  rule"; a rule that doesn't auto-confirm still gets attributed. */
  ruleFiredByItem: Map<string, { ruleId: string | null }>;
  /** Items where a Phase-4 conditional rule fired without
   *  continue_after_match — legacy bank-rule eval was skipped for
   *  these (build plan §4.5). */
  conditionalShortCircuited: Set<string>;
  /** Items posted to the ledger via a legacy autoConfirm rule. */
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
 *      autoConfirm + assignAccountId posts the item via categorize().
 *
 * Runs at import time (inside runCategorizationPipeline) and again on
 * demand via reprocessRules(). Items no rule matches are left untouched.
 */
async function runRulesStages(
  tenantId: string,
  items: Array<{ id: string }>,
  opts: { userId?: string; companyId?: string } = {},
): Promise<RulesStagesOutcome> {
  const bankRulesService = await import('./bank-rules.service.js');
  const conditionalRulesApply = await import('./conditional-rules-apply.service.js');

  const processedIds: string[] = [];
  const ruleFiredByItem = new Map<string, { ruleId: string | null }>();
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
          ruleFiredByItem.set(item.id, { ruleId: firstFire.ruleId });
        }
      }
    } catch (err) {
      // Engine failures shouldn't abort the run.
      console.warn(
        `[runRulesStages] conditional-rules apply failed for item ${item.id}:`,
        err instanceof Error ? err.message : String(err),
      );
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
      description: current.description,
      amount: parseFloat(current.amount),
    });
    if (ruleResult.matched) {
      // Capture which rule fired — even if autoConfirm is false.
      ruleFiredByItem.set(item.id, { ruleId: ruleResult.ruleId ?? null });
    }
    if (ruleResult.matched && ruleResult.autoConfirm && ruleResult.assignAccountId) {
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
        console.warn(`[runRulesStages] autoConfirm categorize failed for item ${item.id}: ${msg}`);
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
export async function runCategorizationPipeline(tenantId: string, items: any[]) {
  const categorizationService = await import('./categorization-ai.service.js');
  const classificationStateService = await import('./practice-classification.service.js');

  // RULES stages — conditional rules, then legacy bank rules (with
  // autoConfirm posting). Shared with reprocessRules() so the "run the
  // rules again later" bulk action can never drift from import behavior.
  const { ruleFiredByItem } = await runRulesStages(tenantId, items);

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
  if (pendingIds.length > 0) {
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
        console.warn(`[bank-feed] AI batch suggest failed for tenant ${tenantId}:`, err?.message ?? err);
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
      console.warn(
        `[runCategorizationPipeline] potential-match find failed for item ${item.id}:`,
        err instanceof Error ? err.message : String(err),
      );
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
        matchCandidates: candidates,
      });
    } catch (err) {
      console.warn(
        `[runCategorizationPipeline] classification-state upsert failed for item ${item.id}:`,
        err instanceof Error ? err.message : String(err),
      );
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
  const cleansing = await runCleansingPipeline(tenantId, items);
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
        });
      } catch (err) {
        console.warn(
          `[reprocessRules] classification-state upsert failed for item ${itemId}:`,
          err instanceof Error ? err.message : String(err),
        );
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

  const inserted = await db.insert(bankFeedItems).values(deduped).returning();

  // Run full cleansing pipeline on each item
  const cleansing = await runCleansingPipeline(tenantId, inserted);

  // Run categorization pipeline (rules autoConfirm + AI suggestions)
  await runCategorizationPipeline(tenantId, inserted);

  return { items: inserted, cleansing };
}

export async function importFromOfx(tenantId: string, bankConnectionId: string, ofxContent: string, dateRange?: ImportDateRange) {
  await assertConnectionInTenant(tenantId, bankConnectionId);
  // Simple OFX/QFX parser — extract STMTTRN elements
  const txnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
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

  // Duplicate detection: OFX has FITID (provider transaction ID) — skip if already imported
  const dedupedOfx = [];
  for (const item of items) {
    if (item.providerTransactionId) {
      const existing = await db.query.bankFeedItems.findFirst({
        where: and(
          eq(bankFeedItems.tenantId, tenantId),
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

  const insertedOfx = await db.insert(bankFeedItems).values(dedupedOfx).returning();

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

  const insertedStmt = await db.insert(bankFeedItems).values(dedupedPrepared.map((p) => p.row)).returning();

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

