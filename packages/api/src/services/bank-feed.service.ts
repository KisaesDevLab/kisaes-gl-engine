// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, count, gte, lte, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { BankFeedFilters, CategorizeInput, CsvColumnMapping } from '@kis-books/shared';
import { db } from '../db/index.js';
import { bankFeedItems, bankConnections, accounts, transactions, journalLines, contacts, transactionTags as transactionTagsTable } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
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
      createdAt: bankFeedItems.createdAt,
      updatedAt: bankFeedItems.updatedAt,
      bankAccountName: accounts.name,
      institutionName: bankConnections.institutionName,
      suggestedAccountName: suggestedAccount.name,
    }).from(bankFeedItems)
      .leftJoin(bankConnections, eq(bankFeedItems.bankConnectionId, bankConnections.id))
      .leftJoin(accounts, eq(bankConnections.accountId, accounts.id))
      .leftJoin(suggestedAccount, eq(bankFeedItems.suggestedAccountId, suggestedAccount.id))
      .where(where)
      .orderBy(sql`${bankFeedItems.feedDate} DESC`)
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
  if (input.memo !== undefined) updates['memo'] = input.memo;
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

export async function categorize(tenantId: string, feedItemId: string, input: CategorizeInput, userId?: string, companyId?: string) {
  // Atomic claim: flip the feed item from 'pending' to 'categorizing'
  // in one UPDATE. Two concurrent categorize calls (double-clicks,
  // retries, two users opening the same item) serialize here — only
  // one of them gets a row back from the UPDATE, the other gets an
  // empty result and throws cleanly. Previously there was no guard at
  // all, so both calls would post duplicate ledger transactions for
  // the same feed item.
  //
  // The intermediate 'categorizing' state is a claim marker. On
  // success we transition it to 'categorized'; on failure in the
  // posting step below we revert it back to 'pending' so the user can
  // retry.
  const [claimed] = await db.update(bankFeedItems)
    .set({ status: 'categorizing', updatedAt: new Date() })
    .where(and(
      eq(bankFeedItems.tenantId, tenantId),
      eq(bankFeedItems.id, feedItemId),
      eq(bankFeedItems.status, 'pending'),
    ))
    .returning();

  if (!claimed) {
    // Either the item doesn't exist, belongs to another tenant, or
    // has already been categorized/matched/claimed by another call.
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
    // Determine if this is an expense (positive amount = money out) or deposit (negative = money in)
    const amount = Math.abs(parseFloat(item.amount));
    const isExpense = parseFloat(item.amount) > 0;

    // Get the bank account from the connection.
    // Tenant-scoped via a join on accounts.tenant_id for defense in
    // depth — connection.id is already known-good (came from `item`),
    // but this keeps CLAUDE.md rule #17 honest.
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

    // Phase 4 — when a conditional rule's split_by_* action
    // staged a splits_config blob, post N user-facing journal
    // lines instead of the standard one. The cash-leg is still
    // a single line so the bank account stays simple.
    const splitsConfig = item.splitsConfig as
      | { kind: 'percentage'; splits: Array<{ accountId: string; percent: number; tagId: string | null; memo: string | null }> }
      | { kind: 'fixed'; splits: Array<{ accountId: string; amount: string; tagId: string | null; memo: string | null }> }
      | null;

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
          tagId: s.tagId ?? input.tagId ?? undefined,
        });
      }
    } else {
      userLines.push({
        accountId: input.accountId,
        debit: isExpense ? amount.toFixed(4) : '0',
        credit: isExpense ? '0' : amount.toFixed(4),
        description: item.description || undefined,
        tagId: input.tagId ?? undefined,
      });
    }

    const cashLine = {
      accountId: conn.accountId,
      debit: isExpense ? '0' : amount.toFixed(4),
      credit: isExpense ? amount.toFixed(4) : '0',
    };

    // Atomicity: ledger post + bank-feed-item status update must
    // commit together. A crash between the two would leave the
    // transaction posted but the feed item still 'categorizing',
    // so the user would see a pending row that's actually already
    // a journal entry — confusing and hard to reconcile.
    const txn = await db.transaction(async (tx) => {
      const t = await ledger.postTransaction(tenantId, {
        txnType: isExpense ? 'expense' : 'deposit',
        txnDate: item.feedDate,
        contactId: input.contactId || (item.suggestedContactId ?? undefined),
        memo: input.memo || (item.category as string) || item.description || undefined,
        total: amount.toFixed(4),
        source: 'bank_feed',
        sourceId: item.id,
        // ADR 0XY §3.3 — bank-feed categorization stamps the rule-
        // provided (or user-provided) tag on the user-facing expense or
        // revenue line. The cash-account leg stays untagged because it
        // isn't a segment-relevant posting. Phase 4 split actions
        // produce one user line per split + the single cash line.
        lines: isExpense ? [...userLines, cashLine] : [cashLine, ...userLines],
      }, userId, companyId, tx);

      // STATEMENT_CHECK_PAYEE_V1 — stamp the parsed check number and the
      // payee read off the check image onto the posted transaction (mirrors
      // write-check). Metadata only — no journal lines change. Reports fall
      // back to payee_name_on_check when no contact matched.
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
    // user's transaction has already posted; this only feeds the model's
    // future suggestions. Log so a regression on the learning subsystem
    // doesn't go silent.
    updateLearning(
      tenantId,
      item.originalDescription || item.description || '',
      input.accountId,
      input.contactId || null,
      true,
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[bank-feed] updateLearning failed for tenant ${tenantId}:`, err?.message ?? err);
    });

    return txn;
  } catch (err) {
    // Revert the claim so the user can retry. Only revert if we still
    // own the claim (status === 'categorizing'); if something else has
    // changed the status, leave it alone.
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

export async function bulkApprove(tenantId: string, feedItemIds: string[]) {
  if (!Array.isArray(feedItemIds)) {
    throw AppError.badRequest('feedItemIds must be an array');
  }
  // Cap the batch size — without this the sequential loop below makes one
  // DB query per id, letting a caller serialize thousands of queries on a
  // single request and lock up the event loop.
  const MAX_BATCH = 500;
  if (feedItemIds.length > MAX_BATCH) {
    throw AppError.badRequest(`Bulk approve is limited to ${MAX_BATCH} items per request`);
  }
  // Wrap each item in try/catch so a single bad row (already
  // claimed, deleted, missing suggestion, ledger-post failure) can't
  // abort the whole batch. Returns per-item failures for the caller
  // to surface.
  let approved = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of feedItemIds) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (item && item.status === 'pending' && item.suggestedAccountId) {
        await categorize(tenantId, id, { accountId: item.suggestedAccountId, contactId: item.suggestedContactId || undefined });
        approved++;
      }
    } catch (err: any) {
      failures.push({ id, error: err?.message || 'unknown error' });
    }
  }
  return { approved, failures };
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

export async function runCleansingPipeline(tenantId: string, items: any[]) {
  for (const item of items) {
    const raw = item.originalDescription || item.description || '';
    let cleanedName: string | null = null;

    // STATEMENT_CHECK_PAYEE_V1 — a payee read off the check image is the
    // most reliable name; use it as the description and skip the AI guess
    // (which can't derive a vendor from "CHECK ####" anyway).
    if (item.payeeNameOnCheck) {
      cleanedName = item.payeeNameOnCheck;
    }

    // Step 1 & 2: Tenant rules, then global rules
    if (!cleanedName) cleanedName = await cleanNameViaRules(tenantId, raw);

    // Step 3 & 4: Categorization history + AI (also sets suggestions on the feed item)
    if (!cleanedName) {
      try {
        const { getConfig } = await import('./ai-config.service.js');
        const config = await getConfig();

        // Try categorization history first (inside categorize())
        // Then AI if enabled — categorize() returns vendor_name from AI
        const { categorize: aiCategorize } = await import('./ai-categorization.service.js');
        const result = await aiCategorize(tenantId, item.id);

        if (result?.contactName) {
          cleanedName = result.contactName;
        }
      } catch {
        // AI/history is best-effort
      }
    }

    // Step 5: Basic cleaning (last resort)
    if (!cleanedName) {
      cleanedName = cleanBankDescription(raw);
    }

    // Update the description if it changed
    if (cleanedName && cleanedName !== item.description) {
      await db.update(bankFeedItems).set({ description: cleanedName, updatedAt: new Date() })
        .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)));
      (item as any).description = cleanedName;
    }
  }
}

/**
 * Post-import categorization pipeline:
 *   1. Bank rules with autoConfirm → auto-categorize matching items
 *   2. AI suggestions on remaining pending items
 */
export async function runCategorizationPipeline(tenantId: string, items: any[]) {
  const bankRulesService = await import('./bank-rules.service.js');
  const categorizationService = await import('./categorization-ai.service.js');
  const classificationStateService = await import('./practice-classification.service.js');
  const conditionalRulesApply = await import('./conditional-rules-apply.service.js');

  // Per-item rule lookup. A rule that fires here needs to record
  // its id on the state row so Bucket 2 can render "grouped by
  // rule" in Phase 2b. Rules that don't auto-confirm still
  // produce a state row with bucket='rule' so a bookkeeper can
  // see the rule attribution without the transaction being
  // auto-posted.
  const ruleFiredByItem = new Map<string, { ruleId: string | null }>();
  // Tracks items where a Phase-4 conditional rule fired without
  // continue_after_match — those skip the legacy bank-rule eval
  // entirely (build plan §4.5).
  const conditionalShortCircuited = new Set<string>();

  // Phase 4 — conditional rules engine. Runs BEFORE legacy bank
  // rules per build plan §4.5. Conditional rules can stage
  // suggestedAccountId / suggestedContactId / suggestedTagId /
  // memo / skip_ai / splits_config on the feed item before the
  // legacy evaluator runs. If a conditional rule fires without
  // continue_after_match, we mark the item to skip legacy rules.
  for (const item of items) {
    const current = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)),
    });
    if (!current || current.status !== 'pending') continue;
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
      });
      if (result.shortCircuitedLegacyRules) {
        conditionalShortCircuited.add(item.id);
      }
      // Stash the conditional rule attribution so the
      // classification-state upsert below records it. The first
      // fire wins for attribution (lowest priority); stacked
      // continue_after_match fires don't overwrite.
      if (result.fires.length > 0) {
        const firstFire = result.fires[0]!;
        if (!ruleFiredByItem.has(item.id)) {
          ruleFiredByItem.set(item.id, { ruleId: firstFire.ruleId });
        }
      }
    } catch (err) {
      // Engine failures shouldn't abort the pipeline.
      console.warn(
        `[runCategorizationPipeline] conditional-rules apply failed for item ${item.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

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
      await categorize(tenantId, item.id, {
        accountId: ruleResult.assignAccountId,
        contactId: ruleResult.assignContactId || undefined,
        memo: ruleResult.assignMemo || undefined,
        // ADR 0XY §3.3 — rule-assigned tag propagates to the new txn.
        tagId: ruleResult.assignTagId ?? undefined,
      });
    }
  }

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
  await runCleansingPipeline(tenantId, items);
  return { cleansed: items.length };
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

    items.push({
      tenantId,
      bankConnectionId,
      feedDate: dateStr,
      description: description, // raw — will be cleaned after insert
      originalDescription: description,
      amount: amount.toFixed(4),
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

  if (deduped.length === 0) return [];

  const inserted = await db.insert(bankFeedItems).values(deduped).returning();

  // Run full cleansing pipeline on each item
  await runCleansingPipeline(tenantId, inserted);

  // Run categorization pipeline (rules autoConfirm + AI suggestions)
  await runCategorizationPipeline(tenantId, inserted);

  return inserted;
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

  if (dedupedOfx.length === 0) return [];

  const insertedOfx = await db.insert(bankFeedItems).values(dedupedOfx).returning();

  // Run full cleansing pipeline on each item
  await runCleansingPipeline(tenantId, insertedOfx);

  // Run categorization pipeline (rules autoConfirm + AI suggestions)
  await runCategorizationPipeline(tenantId, insertedOfx);

  return insertedOfx;
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

  if (dedupedPrepared.length === 0) return { imported: 0, skipped: transactions.length };

  const insertedStmt = await db.insert(bankFeedItems).values(dedupedPrepared.map((p) => p.row)).returning();

  // STATEMENT_CHECK_PAYEE_V1 — correlate check-image payees to the
  // "CHECK ####" feed items and stage the payee (+ contact on a unique
  // match) BEFORE cleansing/categorization, so the check-derived payee wins.
  if (checks.length > 0) await applyCheckImagePayees(tenantId, insertedStmt, checks);

  // Cleansing only for rows that did NOT carry a cleaned name from the review
  // (carried names are authoritative — don't let rules overwrite them).
  const freshForCleansing = insertedStmt.filter((_, i) => !dedupedPrepared[i]!.carriedClean);
  if (freshForCleansing.length > 0) await runCleansingPipeline(tenantId, freshForCleansing);

  // Categorization pipeline runs for ALL rows (rules + match detection); its AI
  // step skips rows that already carry a suggestedAccountId.
  await runCategorizationPipeline(tenantId, insertedStmt);

  return { imported: insertedStmt.length, skipped: transactions.length - insertedStmt.length };
}

