// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, lte, count, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import type { JournalLineInput, TxnType, TxnStatus } from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import { transactions, journalLines, accounts, companies, contacts, reconciliations, reconciliationLines, bankFeedItems, transactionTags, items } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { env } from '../config/env.js';
import { deriveHeaderTags } from './tags/derive-header-tags.js';
import { resolveDefaultTag } from './tags/resolve-default-tag.js';

// ADR 0XY §3.2 — belt-and-suspenders default-tag resolution at the
// ledger write path. When the split-level tags flag is on we batch-load
// both sources available at this layer — the contact's default_tag_id
// and items.default_tag_id for every itemId present on the lines — and
// feed them into `resolveDefaultTag` per line. Bank-rule and AI sources
// are attached by the calling service and flow through verbatim.
async function loadContactDefaultTagId(
  executor: DbOrTx,
  tenantId: string,
  contactId: string | null | undefined,
): Promise<string | null> {
  if (!contactId) return null;
  if (!env.TAGS_SPLIT_LEVEL_V2) return null;
  const rows = await executor
    .select({ defaultTagId: contacts.defaultTagId, contactType: contacts.contactType })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // ADR 0XY §2.1 — contact default only applies to vendor-type contacts.
  // Customers do not contribute to the default-tag chain.
  if (row.contactType !== 'vendor' && row.contactType !== 'both') return null;
  return row.defaultTagId ?? null;
}

// Batch-load items.default_tag_id for every distinct itemId referenced by
// the input lines. Returns a Map keyed by itemId so the resolver lookup
// stays O(1) inside the per-line loop. One query per transaction, not
// one per line — critical for invoices with many items.
async function loadItemDefaultTagMap(
  executor: DbOrTx,
  tenantId: string,
  lines: Array<{ itemId?: string | null | undefined }>,
): Promise<Map<string, string | null>> {
  if (!env.TAGS_SPLIT_LEVEL_V2) return new Map();
  const itemIds = Array.from(
    new Set(
      lines
        .map((l) => l.itemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  if (itemIds.length === 0) return new Map();
  const rows = await executor
    .select({ id: items.id, defaultTagId: items.defaultTagId })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(items.id, itemIds)));
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(r.id, r.defaultTagId ?? null);
  return map;
}

// ADR 0XX §4: when TAGS_SPLIT_LEVEL_V2 is on, journal_lines.tag_id is
// authoritative and transaction_tags is a derived compatibility surface.
// On every ledger write we replace the junction rows for this transaction
// with the set of distinct tag IDs present on its lines. When the flag is
// off (rollout states 1–3) we leave transaction_tags alone — it stays
// authoritative and tags.service.ts remains the sole writer.
//
// ADR 0XX §3.1 backfill rule "first-assigned wins" means multi-tag header
// transactions end up with every line stamped with the earliest tag.
// Re-syncing from lines then collapses the junction to that single tag,
// silently dropping the secondary tags. We detect that here and audit-log
// it so multi-tag tenants have a paper trail and can reconcile with
// ADR 0XX §5.3 multi-tag-per-line future work.
async function syncTransactionTagsFromLines(
  executor: DbOrTx,
  tenantId: string,
  companyId: string | null,
  transactionId: string,
  lines: Array<{ tagId?: string | null | undefined }>,
): Promise<void> {
  if (!env.TAGS_SPLIT_LEVEL_V2) return;
  const tagIds = deriveHeaderTags(lines);

  // Read existing junction rows before we clobber them — needed so we can
  // log exactly which tags get dropped. One SELECT is cheap; multi-tag
  // transactions are rare in practice.
  const existing = await executor
    .select({ tagId: transactionTags.tagId })
    .from(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, transactionId)));
  const existingIds = existing.map((r) => r.tagId);
  const newSet = new Set(tagIds);
  const dropped = existingIds.filter((id) => !newSet.has(id));

  await executor
    .delete(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, transactionId)));
  if (tagIds.length > 0) {
    await executor.insert(transactionTags).values(
      tagIds.map((tagId) => ({ tenantId, companyId, transactionId, tagId })),
    );
  }

  if (dropped.length > 0) {
    // Best-effort audit trail; never block the ledger write on a logging
    // failure. auditLog writes to its own table, so even if this throws
    // on a flaky DB connection the core write has already committed.
    try {
      await auditLog(
        tenantId,
        'update',
        'transaction_tags',
        transactionId,
        { tagIds: existingIds },
        { tagIds, droppedTagIds: dropped, reason: 'multi_tag_collapsed_by_line_sync' },
      );
    } catch {
      // Intentionally swallow — audit-log pressure shouldn't break ledger writes.
    }
  }
}

/**
 * Every journal line references an accountId. The caller supplies those IDs
 * in their request body — we cannot assume they belong to this tenant just
 * because the enclosing transaction row will. This runs a single query to
 * confirm every distinct accountId in the input is owned by the tenant (and
 * by the company, when a companyId is given). Without it, a malicious but
 * authenticated user in tenant A could post journal lines against an
 * account UUID belonging to tenant B — the lines would land with tenantId=A
 * but the foreign-key reference corrupts tenant B's balance denormalization.
 */
async function assertAccountsInScope(
  executor: DbOrTx,
  tenantId: string,
  companyId: string | null | undefined,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const unique = [...new Set(accountIds)];
  const rows = await executor
    .select({ id: accounts.id, companyId: accounts.companyId })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, unique)));
  if (rows.length !== unique.length) {
    throw AppError.badRequest('One or more journal line accounts do not belong to this tenant');
  }
  // Company-level check: if the caller is acting within a company scope,
  // only tenant-wide accounts (companyId IS NULL) and accounts belonging to
  // that same company are valid. Otherwise an invoice for company A could
  // post revenue to company B's income account inside the same tenant.
  if (companyId) {
    for (const row of rows) {
      if (row.companyId !== null && row.companyId !== companyId) {
        throw AppError.badRequest('One or more journal line accounts belong to a different company');
      }
    }
  }
}

async function checkLockDate(executor: DbOrTx, tenantId: string, txnDate: string) {
  const result = await executor.execute(sql`
    SELECT lock_date FROM companies WHERE tenant_id = ${tenantId} LIMIT 1
  `);
  const lockDate = (result.rows as any[])[0]?.lock_date;
  if (lockDate && txnDate <= lockDate) {
    throw AppError.badRequest(`Cannot create or modify transactions on or before the lock date (${lockDate}). Adjust the lock date in Settings to make changes.`);
  }
}

interface PostTransactionInput {
  txnType: TxnType;
  txnDate: string;
  txnNumber?: string;
  dueDate?: string;
  status?: TxnStatus;
  contactId?: string;
  memo?: string;
  internalNotes?: string;
  paymentTerms?: string;
  subtotal?: string;
  taxAmount?: string;
  total?: string;
  amountPaid?: string;
  balanceDue?: string;
  invoiceStatus?: string;
  // Accounts payable fields
  billStatus?: string;
  termsDays?: number;
  creditsApplied?: string;
  vendorInvoiceNumber?: string;
  appliedToInvoiceId?: string;
  sourceEstimateId?: string;
  // Source tracking
  source?: string;
  sourceId?: string;
  lines: JournalLineInput[];
}

export { PostTransactionInput };

export async function postTransaction(tenantId: string, input: PostTransactionInput, userId?: string, companyId?: string) {
  // Validate debits = credits BEFORE opening a database transaction —
  // there's no point holding a tx open while we add up two numbers in
  // memory, and a fast-fail on bad input avoids unnecessary lock churn.
  // Uses Decimal.js to avoid floating-point rounding in monetary sums.
  let totalDebits = new Decimal('0');
  let totalCredits = new Decimal('0');
  for (const line of input.lines) {
    totalDebits = totalDebits.plus(line.debit || '0');
    totalCredits = totalCredits.plus(line.credit || '0');
  }

  if (totalDebits.minus(totalCredits).abs().greaterThan('0.0001')) {
    throw AppError.badRequest(
      `Transaction does not balance: debits (${totalDebits.toFixed(4)}) != credits (${totalCredits.toFixed(4)})`,
    );
  }

  if (totalDebits.isZero() && totalCredits.isZero()) {
    throw AppError.badRequest('Transaction must have non-zero amounts');
  }

  // Wrap the transaction header insert + lines insert + balance updates +
  // audit log in a single database transaction. Without this, a crash or
  // error between any two of these steps leaves torn state — a transaction
  // missing its lines, or lines whose accounts.balance was never updated.
  return await db.transaction(async (tx) => {
    await checkLockDate(tx, tenantId, input.txnDate);
    await assertAccountsInScope(
      tx,
      tenantId,
      companyId ?? null,
      input.lines.map((l) => l.accountId),
    );

    // Insert transaction header
    const [txn] = await tx.insert(transactions).values({
      tenantId,
      companyId: companyId || null,
      txnType: input.txnType,
      txnNumber: input.txnNumber || null,
      txnDate: input.txnDate,
      dueDate: input.dueDate || null,
      status: input.status || 'posted',
      contactId: input.contactId || null,
      memo: input.memo || null,
      internalNotes: input.internalNotes || null,
      paymentTerms: input.paymentTerms || null,
      subtotal: input.subtotal || null,
      taxAmount: input.taxAmount || '0',
      total: input.total || null,
      amountPaid: input.amountPaid || '0',
      balanceDue: input.balanceDue || null,
      invoiceStatus: input.invoiceStatus || null,
      billStatus: input.billStatus || null,
      termsDays: input.termsDays ?? null,
      creditsApplied: input.creditsApplied || '0',
      vendorInvoiceNumber: input.vendorInvoiceNumber || null,
      appliedToInvoiceId: input.appliedToInvoiceId || null,
      sourceEstimateId: input.sourceEstimateId || null,
      source: input.source || null,
      sourceId: input.sourceId || null,
    }).returning();

    if (!txn) throw AppError.internal('Failed to create transaction');

    // ADR 0XY §3.2 — resolve default tags once per transaction before
    // inserting lines. Contact + item defaults are batch-loaded here;
    // bank-rule and AI sources ride along on each line from the caller.
    const [contactDefaultTagId, itemDefaultTagMap] = await Promise.all([
      loadContactDefaultTagId(tx, tenantId, input.contactId),
      loadItemDefaultTagMap(tx, tenantId, input.lines),
    ]);

    // Insert journal lines
    const lineValues = input.lines.map((line, i) => ({
      tenantId,
      companyId: companyId || null,
      transactionId: txn.id,
      accountId: line.accountId,
      debit: line.debit || '0',
      credit: line.credit || '0',
      description: line.description || null,
      itemId: line.itemId || null,
      quantity: line.quantity || null,
      unitPrice: line.unitPrice || null,
      isTaxable: line.isTaxable || false,
      taxRate: line.taxRate || '0',
      taxAmount: line.taxAmount || '0',
      lineOrder: i,
      tagId: resolveDefaultTag({
        explicitUserTagId: line.tagId,
        bankRuleTagId: line.bankRuleTagId ?? undefined,
        aiSuggestedTagId: line.aiSuggestedTagId ?? undefined,
        itemDefaultTagId: line.itemId ? itemDefaultTagMap.get(line.itemId) ?? null : undefined,
        contactDefaultTagId,
      }),
    }));

    const lines = await tx.insert(journalLines).values(lineValues).returning();

    await syncTransactionTagsFromLines(tx, tenantId, companyId || null, txn.id, lineValues);

    // Update account balances (only for posted transactions)
    if (txn.status === 'posted') {
      await updateAccountBalances(tx, tenantId, input.lines);
    }

    await auditLog(tenantId, 'create', 'transaction', txn.id, null, { txnType: txn.txnType, total: input.total }, userId, tx);

    return { ...txn, lines };
  });
}

export async function voidTransaction(tenantId: string, txnId: string, reason: string, userId?: string) {
  // Wrap in a database transaction AND lock the row up front. Without the
  // row lock, two concurrent void calls on the same transaction can both
  // observe status='posted', both pass the check below, and both call
  // updateAccountBalances — double-reversing the balances and corrupting
  // the trial balance. SELECT … FOR UPDATE serializes the void path so
  // the second caller blocks until the first commits, then reads the
  // already-voided state and throws "already void" cleanly.
  return await db.transaction(async (tx) => {
    const [txn] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update')
      .limit(1);

    if (!txn) throw AppError.notFound('Transaction not found');
    if (txn.status === 'void') throw AppError.badRequest('Transaction is already void');

    // Check lock date against the transaction's date
    await checkLockDate(tx, tenantId, txn.txnDate);

    // Get original lines
    const originalLines = await tx.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));

    // Mark as void. Tenant_id is included in the WHERE clause for
    // defense-in-depth (CLAUDE.md rule #17) — even though we already
    // confirmed the row belongs to this tenant via the locked SELECT.
    await tx.update(transactions).set({
      status: 'void',
      voidReason: reason,
      voidedAt: new Date(),
      updatedAt: new Date(),
      invoiceStatus: txn.txnType === 'invoice' ? 'void' : txn.invoiceStatus,
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));

    // Create reversing journal lines (swap debits and credits)
    if (originalLines.length > 0) {
      const reversingLines = originalLines.map((line) => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: `Void: ${line.description || ''}`.trim(),
      }));

      // Reverse account balances
      await updateAccountBalances(tx, tenantId, reversingLines);
    }

    await auditLog(tenantId, 'void', 'transaction', txnId, txn, { reason }, userId, tx);
  });
}

export async function updateTransaction(tenantId: string, txnId: string, input: PostTransactionInput, userId?: string, companyId?: string) {
  // Validate the new lines balance up front (in-memory, no DB access).
  let totalDebits = new Decimal('0');
  let totalCredits = new Decimal('0');
  for (const line of input.lines) {
    totalDebits = totalDebits.plus(line.debit || '0');
    totalCredits = totalCredits.plus(line.credit || '0');
  }
  if (totalDebits.minus(totalCredits).abs().greaterThan('0.0001')) {
    throw AppError.badRequest('Transaction does not balance');
  }

  // Wrap in a database transaction AND lock the row. Without the lock,
  // two concurrent updates of the same transaction can interleave their
  // reverse-old-balances → delete-lines → insert-new-lines → apply-new
  // balances steps and corrupt account balances + leave duplicated /
  // missing journal lines. SELECT … FOR UPDATE serializes them.
  return await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update')
      .limit(1);

    if (!existing) throw AppError.notFound('Transaction not found');
    if (existing.status === 'void') throw AppError.badRequest('Cannot update a void transaction');

    // Check lock date for both old and new dates
    await checkLockDate(tx, tenantId, existing.txnDate);
    await checkLockDate(tx, tenantId, input.txnDate);

    // Validate the new lines' account ownership inside this tenant/company.
    await assertAccountsInScope(
      tx,
      tenantId,
      companyId ?? existing.companyId ?? null,
      input.lines.map((l) => l.accountId),
    );

    // Refuse to edit if any of this transaction's journal lines were
    // marked cleared inside a completed reconciliation. Allowing the edit
    // would silently decouple the reconciliation's cleared total from the
    // actual line amounts, which is an audit-trail integrity break that
    // isn't recoverable without re-doing the reconciliation.
    const clearedInCompleted = await tx.execute(sql`
      SELECT 1
      FROM ${reconciliationLines} rl
      JOIN ${reconciliations} r ON r.id = rl.reconciliation_id
      JOIN ${journalLines} jl ON jl.id = rl.journal_line_id
      WHERE r.tenant_id = ${tenantId}
        AND r.status = 'complete'
        AND rl.is_cleared = true
        AND jl.transaction_id = ${txnId}
      LIMIT 1
    `);
    if ((clearedInCompleted.rows as unknown[]).length > 0) {
      throw AppError.badRequest(
        'Cannot edit a transaction that is part of a completed bank reconciliation. ' +
          'Undo the reconciliation first, or void this transaction and post a correcting entry.',
      );
    }

    // Get original lines and reverse their balances
    const originalLines = await tx.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));

    if (originalLines.length > 0 && existing.status === 'posted') {
      const reversingLines = originalLines.map((line) => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
      }));
      await updateAccountBalances(tx, tenantId, reversingLines);
    }

    // Delete old lines (tenant_id scoped — defense in depth per CLAUDE.md #17)
    await tx.delete(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));

    // Update transaction
    await tx.update(transactions).set({
      txnDate: input.txnDate,
      dueDate: input.dueDate || null,
      contactId: input.contactId || null,
      memo: input.memo || null,
      subtotal: input.subtotal || null,
      taxAmount: input.taxAmount || '0',
      total: input.total || null,
      balanceDue: input.balanceDue || null,
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));

    // Resolve default tags for the new line set (ADR 0XY §3.2 as above).
    const [contactDefaultTagId, itemDefaultTagMap] = await Promise.all([
      loadContactDefaultTagId(tx, tenantId, input.contactId),
      loadItemDefaultTagMap(tx, tenantId, input.lines),
    ]);

    // Insert new lines
    const lineValues = input.lines.map((line, i) => ({
      tenantId,
      companyId: companyId || null,
      transactionId: txnId,
      accountId: line.accountId,
      debit: line.debit || '0',
      credit: line.credit || '0',
      description: line.description || null,
      itemId: line.itemId || null,
      quantity: line.quantity || null,
      unitPrice: line.unitPrice || null,
      isTaxable: line.isTaxable || false,
      taxRate: line.taxRate || '0',
      taxAmount: line.taxAmount || '0',
      lineOrder: i,
      tagId: resolveDefaultTag({
        explicitUserTagId: line.tagId,
        bankRuleTagId: line.bankRuleTagId ?? undefined,
        aiSuggestedTagId: line.aiSuggestedTagId ?? undefined,
        itemDefaultTagId: line.itemId ? itemDefaultTagMap.get(line.itemId) ?? null : undefined,
        contactDefaultTagId,
      }),
    }));

    const lines = await tx.insert(journalLines).values(lineValues).returning();

    await syncTransactionTagsFromLines(tx, tenantId, companyId ?? existing.companyId ?? null, txnId, lineValues);

    // Apply new balances
    if (existing.status === 'posted') {
      await updateAccountBalances(tx, tenantId, input.lines);
    }

    await auditLog(tenantId, 'update', 'transaction', txnId, existing, input, userId, tx);

    const [updated] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .limit(1);
    return { ...updated, lines };
  });
}

async function updateAccountBalances(
  executor: DbOrTx,
  tenantId: string,
  lines: Array<{ accountId: string; debit?: string; credit?: string }>,
) {
  // The arithmetic is done SQL-side (`balance = balance + delta`) so the
  // UPDATE is atomic at the row level — Postgres serializes concurrent
  // updates on the same row and the read-modify-write is internal to the
  // statement. The lost-update race that would happen if we did
  // `read balance → compute new → write` from JS is not present here.
  //
  // The transaction wrapper around this helper exists to keep the balance
  // update atomic *with the journal_lines insert*, not to protect the
  // increment itself.
  for (const line of lines) {
    const delta = new Decimal(line.debit || '0').minus(line.credit || '0');

    if (!delta.isZero()) {
      await executor.update(accounts).set({
        balance: sql`${accounts.balance} + ${delta.toFixed(4)}::decimal`,
        updatedAt: new Date(),
      }).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, line.accountId)));
    }
  }
}

export async function getTransaction(tenantId: string, txnId: string) {
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)),
  });
  if (!txn) throw AppError.notFound('Transaction not found');

  const lines = await db.select({
    id: journalLines.id,
    tenantId: journalLines.tenantId,
    transactionId: journalLines.transactionId,
    accountId: journalLines.accountId,
    accountName: accounts.name,
    accountNumber: accounts.accountNumber,
    debit: journalLines.debit,
    credit: journalLines.credit,
    description: journalLines.description,
    itemId: journalLines.itemId,
    quantity: journalLines.quantity,
    unitPrice: journalLines.unitPrice,
    isTaxable: journalLines.isTaxable,
    taxRate: journalLines.taxRate,
    taxAmount: journalLines.taxAmount,
    lineOrder: journalLines.lineOrder,
    tagId: journalLines.tagId,
  }).from(journalLines)
    .leftJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)))
    .orderBy(journalLines.lineOrder);

  return { ...txn, lines };
}

export async function listTransactions(tenantId: string, filters: {
  txnType?: string; status?: string; contactId?: string; accountId?: string; startDate?: string; endDate?: string;
  // ADR 0XX §5.2 — header-level tag filter semantics: keep the
  // transaction if *any* of its journal_lines carries this tag.
  tagId?: string;
  search?: string; limit?: number; offset?: number;
}, companyId?: string) {
  const conditions = [eq(transactions.tenantId, tenantId)];
  if (companyId) conditions.push(eq(transactions.companyId, companyId));

  if (filters.txnType) conditions.push(eq(transactions.txnType, filters.txnType));
  if (filters.status) conditions.push(eq(transactions.status, filters.status));
  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);
  if (filters.accountId) {
    conditions.push(sql`${transactions.id} IN (SELECT transaction_id FROM journal_lines WHERE account_id = ${filters.accountId} AND tenant_id = ${tenantId})`);
  }
  if (filters.tagId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = ${transactions.id} AND jl.tenant_id = ${tenantId} AND jl.tag_id = ${filters.tagId})`);
  }
  if (filters.search) {
    conditions.push(sql`(${transactions.memo} ILIKE ${'%' + filters.search + '%'} OR ${transactions.txnNumber} ILIKE ${'%' + filters.search + '%'} OR ${contacts.displayName} ILIKE ${'%' + filters.search + '%'})`);
  }

  const where = and(...conditions);

  const [data, total] = await Promise.all([
    db.select({
      id: transactions.id,
      tenantId: transactions.tenantId,
      txnType: transactions.txnType,
      txnNumber: transactions.txnNumber,
      txnDate: transactions.txnDate,
      dueDate: transactions.dueDate,
      status: transactions.status,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      memo: transactions.memo,
      subtotal: transactions.subtotal,
      taxAmount: transactions.taxAmount,
      total: transactions.total,
      amountPaid: transactions.amountPaid,
      balanceDue: transactions.balanceDue,
      invoiceStatus: transactions.invoiceStatus,
      source: transactions.source,
      sourceId: transactions.sourceId,
      aiCategorized: bankFeedItems.matchType,
      createdAt: transactions.createdAt,
      // ADR 0XX §4.1 — aggregate of distinct tag names from the
      // transaction's journal lines. Null when every line is untagged;
      // a one-element array when uniform; two+ elements when mixed.
      // Rendered in the list's Tag column as a pill / "Mixed" / "—".
      lineTags: sql<string[] | null>`(
        SELECT array_agg(DISTINCT t2.name ORDER BY t2.name)
        FROM journal_lines jl
        JOIN tags t2 ON t2.id = jl.tag_id
        WHERE jl.transaction_id = ${transactions.id}
          AND jl.tenant_id = ${tenantId}
          AND jl.tag_id IS NOT NULL
      )`,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .leftJoin(bankFeedItems, and(
        eq(transactions.source, 'bank_feed'),
        sql`${transactions.sourceId} = ${bankFeedItems.id}::text`,
      ))
      .where(where)
      .orderBy(sql`${transactions.txnDate} DESC`, sql`${transactions.createdAt} DESC`)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ count: count() }).from(transactions).where(where),
  ]);

  return { data, total: total[0]?.count ?? 0 };
}

export async function getAccountBalance(tenantId: string, accountId: string, asOfDate?: string) {
  const conditions = [
    eq(journalLines.tenantId, tenantId),
    eq(journalLines.accountId, accountId),
  ];

  if (asOfDate) {
    conditions.push(sql`${journalLines.transactionId} IN (
      SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND txn_date <= ${asOfDate} AND status = 'posted'
    )`);
  }

  const result = await db.select({
    totalDebit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
    totalCredit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)`,
  }).from(journalLines).where(and(...conditions));

  const row = result[0];
  // Sum through Decimal then round to 4-decimal precision once, so callers
  // get a clean `number` without the IEEE754 drift that repeated parseFloat
  // accumulation used to produce on large ledgers.
  const debit = new Decimal(row?.totalDebit || '0');
  const credit = new Decimal(row?.totalCredit || '0');
  const balance = debit.minus(credit);
  return {
    debit: Number(debit.toFixed(4)),
    credit: Number(credit.toFixed(4)),
    balance: Number(balance.toFixed(4)),
  };
}

export async function validateBalance(tenantId: string): Promise<{ valid: boolean; totalDebits: number; totalCredits: number; difference: number }> {
  // Only sum lines from posted transactions
  const result = await db.select({
    totalDebits: sql<string>`COALESCE(SUM(jl.debit), 0)`,
    totalCredits: sql<string>`COALESCE(SUM(jl.credit), 0)`,
  }).from(sql`journal_lines jl JOIN transactions t ON jl.transaction_id = t.id WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'`);

  const row = result[0];
  const totalDebits = new Decimal(row?.totalDebits || '0');
  const totalCredits = new Decimal(row?.totalCredits || '0');
  const difference = totalDebits.minus(totalCredits).abs();

  return {
    valid: difference.lessThan('0.01'),
    totalDebits: Number(totalDebits.toFixed(4)),
    totalCredits: Number(totalCredits.toFixed(4)),
    difference: Number(difference.toFixed(4)),
  };
}
