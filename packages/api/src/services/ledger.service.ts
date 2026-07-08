// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, lte, count, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import type { JournalLineInput, TxnType, TxnStatus, BulkUpdateTransactionsInput, BulkUpdateTransactionsResult } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
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
// Exported so divergent posting paths (bill payments) can apply the
// same tenant/company account-scope guard as postTransaction.
export async function assertAccountsInScope(
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

// Company-scoped lock check. The previous version selected an ARBITRARY
// company row (`LIMIT 1`, no ORDER BY), so in a multi-company tenant
// whichever row Postgres returned first governed every company — a
// locked year could be silently editable (or an unlocked company
// over-blocked), and the answer could flip with the query plan. Now:
// with a companyId we check that company's lock; without one we apply
// the STRICTEST lock across the tenant (deterministic, and a scope-less
// posting can't sneak under any company's close).
// Exported so posting paths that can't route through postTransaction
// (bill payments) enforce the same policy.
export async function checkLockDate(
  executor: DbOrTx,
  tenantId: string,
  txnDate: string,
  companyId?: string | null,
) {
  const result = companyId
    ? await executor.execute(sql`
        SELECT lock_date FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId}
      `)
    : await executor.execute(sql`
        SELECT MAX(lock_date) AS lock_date FROM companies WHERE tenant_id = ${tenantId}
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
  // Reporting basis: 'both' (default), 'cash', or 'accrual'. Only meaningful
  // for manual journal entries today; all other txns pass 'both'.
  basis?: 'cash' | 'accrual' | 'both';
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

export async function postTransaction(
  tenantId: string,
  input: PostTransactionInput,
  userId?: string,
  companyId?: string,
  // Optional outer transaction. When provided, postTransaction runs all
  // its writes against `outerTx` instead of opening its own — letting
  // higher-level operations (invoice.recordPayment, bill payment, etc.)
  // commit the ledger post together with their own header updates in a
  // single atomic transaction. Without this, a crash between the ledger
  // commit and the caller's follow-up write leaves stored state torn.
  // Postgres doesn't support nested transactions natively (only
  // savepoints), so callers MUST pass `outerTx` rather than starting
  // their own and calling this unsupplied.
  outerTx?: Tx,
) {
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
  const inner = async (tx: Tx) => {
    await checkLockDate(tx, tenantId, input.txnDate, companyId ?? null);
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
      basis: input.basis || 'both',
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
      contactId: line.contactId ?? null,
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
  };

  // Reuse the outer tx if one was passed in (caller is already inside a
  // transaction), otherwise open our own.
  if (outerTx) return await inner(outerTx);
  return await db.transaction(inner);
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

    // Check lock date against the transaction's date (company-scoped)
    await checkLockDate(tx, tenantId, txn.txnDate, txn.companyId);

    // Mirror updateTransaction's reconciliation guard: a transaction
    // whose lines are cleared in a COMPLETED bank rec must not be
    // voided directly. Voiding flips status without writing reversing
    // lines onto the cleared journal_lines themselves, which leaves
    // the rec's cleared total stale and unreconcilable. Operator must
    // undo the rec first, then void + post a correction.
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
        'Cannot void a transaction whose lines are cleared in a completed bank reconciliation. ' +
          'Undo the reconciliation first, then void and post a correcting entry.',
      );
    }

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

    // Create reversing journal lines (swap debits and credits) and
    // PERSIST them on the voided transaction (CLAUDE.md rule #23 —
    // never delete journal_lines; the reversal is part of the audit
    // record). Previously these lines were built only in memory to
    // adjust the denormalized balances and were never inserted, so the
    // DB held no evidence of the reversal. Reports filter
    // status='posted', so lines attached to the void-status header
    // don't affect any report — but SUM(debit−credit) over ALL lines
    // now nets to zero per voided transaction, and the transaction
    // detail view shows exactly what the void did.
    if (originalLines.length > 0) {
      const maxOrder = originalLines.reduce((m, l) => Math.max(m, l.lineOrder ?? 0), 0);
      const reversingLines = originalLines.map((line) => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: `Void: ${line.description || ''}`.trim(),
      }));

      await tx.insert(journalLines).values(originalLines.map((line, i) => ({
        tenantId,
        companyId: line.companyId,
        transactionId: txnId,
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: `Void: ${line.description || ''}`.trim(),
        tagId: line.tagId,
        lineOrder: maxOrder + 1 + i,
        isVoidReversal: true,
      })));

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

    // Check lock date for both old and new dates (company-scoped)
    await checkLockDate(tx, tenantId, existing.txnDate, existing.companyId);
    await checkLockDate(tx, tenantId, input.txnDate, companyId ?? existing.companyId ?? null);

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
    const clearedRows = await tx.execute(sql`
      SELECT DISTINCT jl.id AS journal_line_id
      FROM ${reconciliationLines} rl
      JOIN ${reconciliations} r ON r.id = rl.reconciliation_id
      JOIN ${journalLines} jl ON jl.id = rl.journal_line_id
      WHERE r.tenant_id = ${tenantId}
        AND r.status = 'complete'
        AND rl.is_cleared = true
        AND jl.transaction_id = ${txnId}
    `);
    const clearedLineIds = new Set((clearedRows.rows as Array<{ journal_line_id: string }>).map((r) => r.journal_line_id));

    if (clearedLineIds.size > 0) {
      // Reconciled transaction. The reconciliation cleared this txn's
      // balance-sheet line(s) (the bank / credit-card account). Those lines
      // must NOT change — their amount is the reconciled total, and their
      // journal_line ids are referenced by reconciliation_lines (no FK, so a
      // delete/recreate would leave dangling references and corrupt the rec).
      // The OTHER (income/expense) lines don't touch the reconciled balance,
      // so the user may recategorize / split / re-tag them freely — as long as
      // the balance-sheet lines and the date stay put.
      const existingLines = await tx.select().from(journalLines)
        .where(and(
          eq(journalLines.tenantId, tenantId),
          eq(journalLines.transactionId, txnId),
          eq(journalLines.isVoidReversal, false),
        ));
      const acctIds = Array.from(new Set([...existingLines.map((l) => l.accountId), ...input.lines.map((l) => l.accountId)]));
      const acctRows = acctIds.length
        ? await tx.select({ id: accounts.id, accountType: accounts.accountType })
            .from(accounts).where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, acctIds)))
        : [];
      const typeOf = new Map(acctRows.map((a) => [a.id, a.accountType]));
      const isBalanceSheet = (accountId: string) => {
        const t = typeOf.get(accountId);
        return t === 'asset' || t === 'liability' || t === 'equity';
      };
      const keyOf = (accountId: string, debit?: string | null, credit?: string | null) =>
        `${accountId}|${new Decimal(debit || '0').toFixed(4)}|${new Decimal(credit || '0').toFixed(4)}`;

      const existingBS = existingLines.filter((l) => isBalanceSheet(l.accountId));
      const existingPL = existingLines.filter((l) => !isBalanceSheet(l.accountId));

      // Match each existing balance-sheet line to an UNCHANGED input line.
      const inputPool = new Map<string, Array<{ idx: number; line: (typeof input.lines)[number] }>>();
      input.lines.forEach((line, idx) => {
        const k = keyOf(line.accountId, line.debit, line.credit);
        const b = inputPool.get(k) ?? []; b.push({ idx, line }); inputPool.set(k, b);
      });
      const preservedIdx = new Set<number>();
      const bsPairs: Array<{ lineId: string; input: (typeof input.lines)[number] }> = [];
      let ok = existing.txnDate === input.txnDate;
      if (ok) {
        for (const bs of existingBS) {
          const match = inputPool.get(keyOf(bs.accountId, bs.debit, bs.credit))?.shift();
          if (!match) { ok = false; break; }
          preservedIdx.add(match.idx);
          bsPairs.push({ lineId: bs.id, input: match.line });
        }
      }
      // Remaining input lines replace the P&L side; none may be a balance-sheet
      // account (that would add/alter the reconciled side).
      const newPLLines = ok ? input.lines.filter((_, idx) => !preservedIdx.has(idx)) : [];
      if (ok && newPLLines.some((l) => isBalanceSheet(l.accountId))) ok = false;

      if (!ok) {
        throw AppError.badRequest(
          'This transaction is part of a completed bank reconciliation, so its reconciled (balance-sheet) line and date can’t change. ' +
            'You can still recategorize or re-tag the income/expense lines. To change the reconciled amount, undo the reconciliation, or void and re-post.',
        );
      }

      const [contactDefaultTagId, itemDefaultTagMap] = await Promise.all([
        loadContactDefaultTagId(tx, tenantId, input.contactId),
        loadItemDefaultTagMap(tx, tenantId, input.lines),
      ]);
      const tagFor = (inLine: (typeof input.lines)[number]) => resolveDefaultTag({
        explicitUserTagId: inLine.tagId,
        bankRuleTagId: inLine.bankRuleTagId ?? undefined,
        aiSuggestedTagId: inLine.aiSuggestedTagId ?? undefined,
        itemDefaultTagId: inLine.itemId ? itemDefaultTagMap.get(inLine.itemId) ?? null : undefined,
        contactDefaultTagId,
      });

      // 1. Preserve balance-sheet lines: update tag/description IN PLACE (no
      //    amount/account change → reconciliation references untouched).
      for (const { lineId, input: inLine } of bsPairs) {
        await tx.update(journalLines).set({ tagId: tagFor(inLine), description: inLine.description || null })
          .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.id, lineId)));
      }
      // 2. Replace P&L lines: reverse old balances, delete, insert new, apply.
      if (existingPL.length > 0) {
        await updateAccountBalances(tx, tenantId, existingPL.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit })));
        await tx.delete(journalLines).where(and(
          eq(journalLines.tenantId, tenantId),
          inArray(journalLines.id, existingPL.map((l) => l.id)),
        ));
      }
      const newPLValues = newPLLines.map((line, i) => ({
        tenantId, companyId: companyId || null, transactionId: txnId,
        accountId: line.accountId, debit: line.debit || '0', credit: line.credit || '0',
        description: line.description || null, itemId: line.itemId || null,
        quantity: line.quantity || null, unitPrice: line.unitPrice || null,
        isTaxable: line.isTaxable || false, taxRate: line.taxRate || '0', taxAmount: line.taxAmount || '0',
        lineOrder: existingBS.length + i, contactId: line.contactId ?? null, tagId: tagFor(line),
      }));
      if (newPLValues.length > 0) {
        await tx.insert(journalLines).values(newPLValues);
        await updateAccountBalances(tx, tenantId, newPLLines);
      }
      // 3. Ledger-neutral header fields (memo / contact / basis).
      await tx.update(transactions).set({
        memo: input.memo || null,
        contactId: input.contactId || null,
        ...(input.basis ? { basis: input.basis } : {}),
        updatedAt: new Date(),
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));
      // 4. Rebuild transaction_tags from the full (preserved + new) line set.
      const fullValues = [
        ...bsPairs.map(({ input: inLine }) => ({ accountId: inLine.accountId, tagId: tagFor(inLine) })),
        ...newPLValues,
      ];
      await syncTransactionTagsFromLines(tx, tenantId, existing.companyId ?? null, txnId, fullValues);
      await auditLog(tenantId, 'update', 'transaction', txnId, existing, { reconciledPartialEdit: true }, userId, tx);
      const refreshed = await tx.select().from(journalLines)
        .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
      const [updatedTxn] = await tx.select().from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId))).limit(1);
      return { ...updatedTxn, lines: refreshed };
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
      // Editable on a JE edit; other callers omit basis so it's left as 'both'.
      ...(input.basis ? { basis: input.basis } : {}),
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
      contactId: line.contactId ?? null,
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
    contactId: journalLines.contactId,
  }).from(journalLines)
    .leftJoin(accounts, eq(journalLines.accountId, accounts.id))
    // Exclude the persisted void-reversal rows (rule 23) so the detail
    // view keeps showing the document as entered; the reversal is a GL
    // artifact, visible in ledger exports.
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, txnId),
      eq(journalLines.isVoidReversal, false),
    ))
    .orderBy(journalLines.lineOrder);

  return { ...txn, lines };
}

export async function listTransactions(tenantId: string, filters: {
  txnType?: string; status?: string; contactId?: string; accountId?: string; startDate?: string; endDate?: string;
  // ADR 0XX §5.2 — header-level tag filter semantics: keep the
  // transaction if *any* of its journal_lines carries this tag.
  tagId?: string;
  /**
   * Filter by transactions.source — used by the bulk-import success
   * links to navigate to "the transactions I just imported" via tags
   * like 'accounting_power_import' / 'quickbooks_online_import' /
   * 'trial_balance_import'. Indexed (idx_txn_source) so this is cheap.
   */
  source?: string;
  search?: string;
  sortBy?: 'date' | 'type' | 'number' | 'payee' | 'memo' | 'category' | 'amount' | 'status';
  sortDir?: 'asc' | 'desc';
  limit?: number; offset?: number;
}, companyId?: string) {
  const conditions = [eq(transactions.tenantId, tenantId)];
  if (companyId) conditions.push(eq(transactions.companyId, companyId));

  if (filters.txnType) conditions.push(eq(transactions.txnType, filters.txnType));
  if (filters.status) conditions.push(eq(transactions.status, filters.status));
  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (filters.source) conditions.push(eq(transactions.source, filters.source));
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

  // Column sort. Whitelisted keys → a concrete SQL expression; everything else
  // falls back to date. CATEGORY sorts on the first P&L account name via the
  // same correlated subquery the SELECT uses. A stable createdAt tiebreaker
  // keeps pagination deterministic.
  const dir = filters.sortDir === 'asc' ? sql`ASC` : sql`DESC`;
  const sortExpr = (() => {
    switch (filters.sortBy) {
      case 'type': return sql`${transactions.txnType}`;
      case 'number': return sql`${transactions.txnNumber}`;
      case 'payee': return sql`${contacts.displayName}`;
      case 'memo': return sql`${transactions.memo}`;
      // Same COALESCE as the displayTotal select — NULL-total JEs and
      // transfers sort by their journal-line magnitude instead of
      // clumping at the end.
      case 'amount': return sql`COALESCE(${transactions.total}, (
        SELECT SUM(jl6.debit) FROM journal_lines jl6
        WHERE jl6.transaction_id = ${transactions.id}
          AND jl6.tenant_id = ${tenantId}
      ))`;
      case 'status': return sql`${transactions.status}`;
      case 'category': return sql`(
        SELECT min(a2.name) FROM journal_lines jl4
        JOIN accounts a2 ON a2.id = jl4.account_id
        WHERE jl4.transaction_id = ${transactions.id}
          AND jl4.tenant_id = ${tenantId}
          AND a2.account_type IN ('revenue','other_revenue','cogs','expense','other_expense')
      )`;
      case 'date':
      default: return sql`${transactions.txnDate}`;
    }
  })();
  const orderBy = sql`${sortExpr} ${dir} NULLS LAST, ${transactions.createdAt} DESC`;

  const [data, total, totalsRow] = await Promise.all([
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
      // Amount column fallback: `total` is caller-supplied and NULL for
      // journal entries, transfers, and GL-imported entries (they have
      // no document total). The transaction's magnitude is the sum of
      // its debit legs (= sum of credits by rule 22), so the list can
      // always show an amount.
      displayTotal: sql<string | null>`COALESCE(${transactions.total}, (
        SELECT SUM(jl5.debit) FROM journal_lines jl5
        WHERE jl5.transaction_id = ${transactions.id}
          AND jl5.tenant_id = ${tenantId}
      ))`,
      // When the list is filtered to a specific account, expose that account's
      // debit and credit totals per transaction so the UI can render a
      // GL/register-style Debit | Credit split (from THIS account's
      // perspective). NULL when no account filter is active.
      accountDebit: filters.accountId
        ? sql<string | null>`(SELECT SUM(jl7.debit) FROM journal_lines jl7
            WHERE jl7.transaction_id = ${transactions.id}
              AND jl7.tenant_id = ${tenantId} AND jl7.account_id = ${filters.accountId})`
        : sql<string | null>`NULL`,
      accountCredit: filters.accountId
        ? sql<string | null>`(SELECT SUM(jl8.credit) FROM journal_lines jl8
            WHERE jl8.transaction_id = ${transactions.id}
              AND jl8.tenant_id = ${tenantId} AND jl8.account_id = ${filters.accountId})`
        : sql<string | null>`NULL`,
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
      // Category column: distinct names of the P&L (category) accounts on
      // this transaction's lines — the income/expense side, excluding the
      // bank/AR/AP/equity "money" accounts. One element → single category;
      // two+ → rendered as "— Split —"; null → "—".
      lineCategories: sql<string[] | null>`(
        SELECT array_agg(DISTINCT a2.name ORDER BY a2.name)
        FROM journal_lines jl3
        JOIN accounts a2 ON a2.id = jl3.account_id
        WHERE jl3.transaction_id = ${transactions.id}
          AND jl3.tenant_id = ${tenantId}
          AND a2.account_type IN ('revenue','other_revenue','cogs','expense','other_expense')
      )`,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .leftJoin(bankFeedItems, and(
        eq(transactions.source, 'bank_feed'),
        sql`${transactions.sourceId} = ${bankFeedItems.id}::text`,
      ))
      .where(where)
      .orderBy(orderBy)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    // Must mirror the data query's contacts join: the `search` filter
    // references contacts.displayName, so without this join the count query
    // throws ("missing FROM-clause entry for table contacts") and the whole
    // list 500s whenever a search term is present.
    db.select({ count: count() }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where),
    // Grand totals across the WHOLE filtered set (not just the page), so the
    // list can show a footer total. Void transactions are excluded — they net
    // to zero and display as 0. `amount` mirrors displayTotal; debit/credit are
    // the filtered account's legs (0 when no account filter).
    db.select({
      amount: sql<string>`COALESCE(SUM(COALESCE(${transactions.total}, (
        SELECT SUM(jlt.debit) FROM journal_lines jlt
        WHERE jlt.transaction_id = ${transactions.id} AND jlt.tenant_id = ${tenantId}
      ))), 0)`,
      debit: filters.accountId
        ? sql<string>`COALESCE(SUM((SELECT SUM(jld.debit) FROM journal_lines jld
            WHERE jld.transaction_id = ${transactions.id} AND jld.tenant_id = ${tenantId} AND jld.account_id = ${filters.accountId})), 0)`
        : sql<string>`'0'`,
      credit: filters.accountId
        ? sql<string>`COALESCE(SUM((SELECT SUM(jlc.credit) FROM journal_lines jlc
            WHERE jlc.transaction_id = ${transactions.id} AND jlc.tenant_id = ${tenantId} AND jlc.account_id = ${filters.accountId})), 0)`
        : sql<string>`'0'`,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(and(where, sql`${transactions.status} <> 'void'`)),
  ]);

  return {
    data,
    total: total[0]?.count ?? 0,
    totals: {
      amount: totalsRow[0]?.amount ?? '0',
      debit: totalsRow[0]?.debit ?? '0',
      credit: totalsRow[0]?.credit ?? '0',
    },
  };
}

export async function getAccountBalance(tenantId: string, accountId: string, asOfDate?: string) {
  const conditions = [
    eq(journalLines.tenantId, tenantId),
    eq(journalLines.accountId, accountId),
  ];

  // Always restrict to POSTED transactions. Without a date bound this
  // used to sum every line — drafts, voids, and (now that rule 23
  // persists them) void-reversal lines — none of which belong in a
  // balance.
  if (asOfDate) {
    conditions.push(sql`${journalLines.transactionId} IN (
      SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND txn_date <= ${asOfDate} AND status = 'posted'
    )`);
  } else {
    conditions.push(sql`${journalLines.transactionId} IN (
      SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
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

// P&L (category) account types — the income/expense side a transaction is
// "categorized" to, excluding the bank / AR / AP / equity money accounts.
const CATEGORY_ACCOUNT_TYPES = ['revenue', 'other_revenue', 'cogs', 'expense', 'other_expense'];

/**
 * Bulk-edit Payee / Category / Tag across many transactions from the list
 * view. Atomic — the whole batch commits or rolls back together. Invariants:
 *   - Payee (transactions.contact_id) is header-level — always safe to set.
 *   - Tag sets journal_lines.tag_id on every line, then re-syncs the
 *     transaction_tags junction (no-op when TAGS_SPLIT_LEVEL_V2 is off).
 *   - Category re-points the transaction's SINGLE P&L line to a new account
 *     and moves the denormalised accounts.balance to match. Split
 *     transactions (0 or >1 category lines) are skipped, never collapsed.
 *   - Void, lock-dated, and reconciled (cleared in a completed rec)
 *     transactions are skipped for line-touching changes.
 * Returns counts so the UI can report "N updated, M skipped (splits, etc.)".
 */
export async function bulkUpdateTransactions(
  tenantId: string,
  input: BulkUpdateTransactionsInput,
  userId?: string,
  companyId?: string,
): Promise<BulkUpdateTransactionsResult> {
  const { txnIds, setPayeeContactId, setCategoryAccountId, setTagId, tagAccountId } = input;
  const skipped: Array<{ id: string; reason: string }> = [];
  let updated = 0;

  return await db.transaction(async (tx) => {
    // Validate targets once up front — a bad account/contact id should 400
    // the whole batch rather than silently no-op per transaction.
    if (setCategoryAccountId !== undefined) {
      await assertAccountsInScope(tx, tenantId, companyId ?? null, [setCategoryAccountId]);
    }
    if (setPayeeContactId) {
      const [contact] = await tx.select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, setPayeeContactId)))
        .limit(1);
      if (!contact) throw AppError.badRequest('Payee contact does not belong to this tenant');
    }

    // Per-company lock dates — loaded once. Each transaction is checked
    // against ITS company's lock; scope-less transactions fall back to
    // the strictest lock in the tenant (matches checkLockDate policy —
    // the old single-arbitrary-row load let one company's rows govern
    // every company in a multi-company tenant).
    const lockResult = await tx.execute(sql`SELECT id, lock_date FROM companies WHERE tenant_id = ${tenantId}`);
    const lockByCompany = new Map<string, string | null>();
    let maxLock: string | null = null;
    for (const row of lockResult.rows as Array<{ id: string; lock_date: string | null }>) {
      lockByCompany.set(row.id, row.lock_date);
      if (row.lock_date && (!maxLock || row.lock_date > maxLock)) maxLock = row.lock_date;
    }

    for (const txnId of txnIds) {
      const conds = [eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)];
      if (companyId) conds.push(eq(transactions.companyId, companyId));
      const [txn] = await tx.select().from(transactions).where(and(...conds)).for('update').limit(1);

      if (!txn) { skipped.push({ id: txnId, reason: 'not_found' }); continue; }
      if (txn.status === 'void') { skipped.push({ id: txnId, reason: 'void' }); continue; }
      const lockDate = txn.companyId ? (lockByCompany.get(txn.companyId) ?? null) : maxLock;
      if (lockDate && txn.txnDate <= lockDate) { skipped.push({ id: txnId, reason: 'locked' }); continue; }

      // Reconciled transactions are intentionally NOT skipped here. A completed
      // reconciliation only ever clears a txn's balance-sheet (bank / credit-
      // card) line, and every bulk operation below is neutral to that cleared
      // line: a tag change is ledger-neutral, a category move only ever
      // relocates a P&L line (CATEGORY_ACCOUNT_TYPES — never the cleared
      // balance-sheet line), and a payee change is header-level. So the
      // reconciled total, the cleared-line amounts, and the journal_line ids
      // that reconciliation_lines references all stay put. This matches the
      // single-edit policy in updateTransaction ("you can still recategorize or
      // re-tag the income/expense lines"); the previous blanket skip wrongly
      // blocked ledger-neutral tag edits on reconciled rows.
      let changed = false;

      // Payee — header-level, always applicable.
      if (setPayeeContactId !== undefined) {
        await tx.update(transactions)
          .set({ contactId: setPayeeContactId, updatedAt: new Date() })
          .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));
        changed = true;
      }

      // Category — only when there's exactly one P&L line to move.
      if (setCategoryAccountId !== undefined) {
        const catLines = await tx.select({
          id: journalLines.id, accountId: journalLines.accountId,
          debit: journalLines.debit, credit: journalLines.credit,
        })
          .from(journalLines)
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .where(and(
            eq(journalLines.tenantId, tenantId),
            eq(journalLines.transactionId, txnId),
            inArray(accounts.accountType, CATEGORY_ACCOUNT_TYPES),
          ));

        if (catLines.length === 1) {
          const line = catLines[0]!;
          if (line.accountId !== setCategoryAccountId) {
            if (txn.status === 'posted') {
              // Move the denormalised balance: reverse the line off its old
              // account, apply it to the new one. Amounts are unchanged so the
              // trial balance still balances; only the per-account split moves.
              await updateAccountBalances(tx, tenantId, [{ accountId: line.accountId, debit: line.credit, credit: line.debit }]);
              await updateAccountBalances(tx, tenantId, [{ accountId: setCategoryAccountId, debit: line.debit, credit: line.credit }]);
            }
            await tx.update(journalLines)
              .set({ accountId: setCategoryAccountId })
              .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.id, line.id)));
          }
          changed = true;
        } else if (setPayeeContactId === undefined && setTagId === undefined) {
          // Category was the sole requested change and this isn't a single-
          // category transaction — skip it so the caller can report it.
          skipped.push({ id: txnId, reason: catLines.length === 0 ? 'no_category_line' : 'split' });
          continue;
        }
        // else: payee/tag still apply below; the category just didn't move.
      }

      // Tag — set (uuid) or clear (null). Scoped to the viewed account's
      // line(s) when tagAccountId is given, so a split / journal entry only
      // tags the account the operator is looking at rather than every line.
      if (setTagId !== undefined) {
        const tagConds = [eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)];
        if (tagAccountId) tagConds.push(eq(journalLines.accountId, tagAccountId));
        const touched = await tx.update(journalLines)
          .set({ tagId: setTagId })
          .where(and(...tagConds))
          .returning({ id: journalLines.id });
        if (touched.length > 0) {
          // Re-sync the header junction from the ACTUAL per-line tags — with
          // account scoping the lines can now carry mixed tags, so we can't
          // assume the whole transaction collapses to the single set tag.
          const postLines = await tx.select({ tagId: journalLines.tagId })
            .from(journalLines)
            .where(and(
              eq(journalLines.tenantId, tenantId),
              eq(journalLines.transactionId, txnId),
              eq(journalLines.isVoidReversal, false),
            ));
          await syncTransactionTagsFromLines(tx, tenantId, txn.companyId ?? null, txnId, postLines);
          changed = true;
        }
      }

      if (changed) {
        updated++;
        await auditLog(tenantId, 'update', 'transaction', txnId, null, {
          bulk: true,
          ...(setPayeeContactId !== undefined ? { contactId: setPayeeContactId } : {}),
          ...(setCategoryAccountId !== undefined ? { categoryAccountId: setCategoryAccountId } : {}),
          ...(setTagId !== undefined ? { tagId: setTagId } : {}),
        }, userId, tx);
      } else {
        skipped.push({ id: txnId, reason: 'no_change' });
      }
    }

    return { updated, skipped };
  });
}
