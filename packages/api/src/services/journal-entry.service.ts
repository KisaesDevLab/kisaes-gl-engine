// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { CreateJournalEntryInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { accounts, journalLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { assertContactsInScope } from './line-contacts.service.js';

const CONTROL_TAGS = ['accounts_receivable', 'accounts_payable'];

export function buildJournalEntryPayload(input: CreateJournalEntryInput) {
  return {
    txnType: 'journal_entry' as const,
    txnDate: input.txnDate,
    // U-59: omitted leaves the stored number alone on an edit; "" clears it.
    ...(input.txnNumber !== undefined ? { txnNumber: input.txnNumber.trim() || null } : {}),
    memo: input.memo,
    basis: input.basis ?? 'both',
    // U-60: omitted is false on create and unchanged on edit.
    ...(input.isAdjusting !== undefined ? { isAdjusting: input.isAdjusting } : {}),
    lines: input.lines.map((l) => ({ ...l, contactId: l.contactId ?? null })),
  };
}

/** reverseOn (U-61) must be a date after the entry's own date. */
function assertReverseOn(txnDate: string, reverseOn: string | null | undefined) {
  if (reverseOn && !(reverseOn > txnDate)) {
    throw AppError.badRequest('The reversal date must be after the entry date', 'VALIDATION_ERROR');
  }
}

/**
 * arApNames (default true): enforce the A/R / A/P name rules below. The
 * entry points that post a JE the owner typed (POST / PUT /transactions,
 * API v2, MCP) keep the default; system and bulk posters whose input has no
 * name column (accrual schedules, the batch JE import) pass false and keep
 * their earlier behavior. Line contacts are always scope-checked.
 */
export interface JournalEntryOptions { arApNames?: boolean }

/**
 * Journal entry names (U-58, Q-206):
 *   - every line contactId belongs to the tenant and the company scope
 *     (400 VALIDATION_ERROR);
 *   - at most one line posts to an A/R or A/P account — detail type or system
 *     tag accounts_receivable / accounts_payable (400 JE_AR_AP_ONE_PER_ENTRY);
 *   - that line names its customer or vendor (400 JE_AR_AP_NAME_REQUIRED).
 */
export async function assertJournalEntryNames(
  executor: DbOrTx,
  tenantId: string,
  companyId: string | null | undefined,
  lines: ReadonlyArray<{ accountId: string; contactId?: string | null }>,
  opts: JournalEntryOptions = {},
): Promise<void> {
  await assertContactsInScope(
    executor, tenantId, companyId,
    lines.map((l) => l.contactId).filter((v): v is string => !!v),
    'One or more line names do not belong to this company',
  );
  if (opts.arApNames === false) return;
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  if (accountIds.length === 0) return;
  const control = await executor.select({ id: accounts.id }).from(accounts).where(and(
    eq(accounts.tenantId, tenantId),
    inArray(accounts.id, accountIds),
    or(inArray(accounts.detailType, CONTROL_TAGS), inArray(accounts.systemTag, CONTROL_TAGS)),
  ));
  const controlIds = new Set(control.map((a) => a.id));
  const controlLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => controlIds.has(l.accountId));
  if (controlLines.length > 1) {
    throw AppError.badRequest(
      'A journal entry can have only one Accounts Receivable or Accounts Payable line. Split it into separate entries.',
      'JE_AR_AP_ONE_PER_ENTRY',
    );
  }
  const unnamed = controlLines.find(({ l }) => !l.contactId);
  if (unnamed) {
    throw AppError.badRequest(
      `Line ${unnamed.i + 1} posts to Accounts Receivable or Accounts Payable, so it needs a customer or vendor name.`,
      'JE_AR_AP_NAME_REQUIRED',
    );
  }
}

async function loadEntry(tx: Tx, tenantId: string, id: string) {
  const [header] = await tx.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).limit(1);
  if (!header) throw AppError.internal('Journal entry vanished while posting');
  const lines = await tx.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, id)))
    .orderBy(journalLines.lineOrder);
  return { ...header, lines };
}

/** `outerTx` (templates, U-62): post inside the caller's transaction. */
export async function createJournalEntry(
  tenantId: string, input: CreateJournalEntryInput, userId?: string, companyId?: string, opts: JournalEntryOptions = {},
  outerTx?: Tx,
) {
  assertReverseOn(input.txnDate, input.reverseOn);
  const payload = buildJournalEntryPayload(input);
  const inner = async (tx: Tx) => {
    await assertJournalEntryNames(tx, tenantId, companyId, payload.lines, opts);
    const posted = await ledger.postTransaction(tenantId, payload, userId, companyId, tx);
    const entry = await loadEntry(tx, tenantId, posted.id);
    const reversal = input.reverseOn
      ? await ledger.postReversal(tx, tenantId, entry, input.reverseOn, userId, companyId)
      : null;
    return { ...entry, reversalTransactionId: reversal?.id ?? null, reverseOn: reversal?.txnDate ?? null };
  };
  return outerTx ? inner(outerTx) : db.transaction(inner);
}

/**
 * Edit (PUT). reverseOn has three states (U-61):
 *   - omitted: the entry keeps its automatic reversal, if it has one, on
 *     its stored date; when the edit changes what the reversal must hold
 *     (lines, number, basis, adjusting flag) it is re-posted on that date;
 *   - null: the reversal is removed;
 *   - a date: the reversal moves to (or is created on) that date.
 * Re-posting or removing deletes the old reversal (soft, with reversing
 * lines), all in one database transaction; a reversal changed after it was
 * created refuses that (409 REVERSAL_EDITED). A reversal the edit leaves as
 * it is stays untouched. The effective reversal date must be after the
 * entry date (400 VALIDATION_ERROR).
 */
export async function updateJournalEntry(tenantId: string, txnId: string, input: CreateJournalEntryInput, userId?: string, companyId?: string) {
  if (input.reverseOn !== undefined) assertReverseOn(input.txnDate, input.reverseOn);
  const payload = buildJournalEntryPayload(input);
  return db.transaction(async (tx) => {
    await assertJournalEntryNames(tx, tenantId, companyId, payload.lines);
    const [existing] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update').limit(1);
    // Another company's entry is not found (ledger.updateTransaction agrees).
    if (!existing || (companyId && existing.companyId && existing.companyId !== companyId)) {
      throw AppError.notFound('Transaction not found');
    }
    const reversal = existing.txnType === 'journal_entry' && existing.status === 'posted'
      ? await ledger.findLiveReversal(tx, tenantId, txnId)
      : null;
    const targetReverseOn = input.reverseOn === undefined ? (reversal?.txnDate ?? null) : input.reverseOn;
    assertReverseOn(input.txnDate, targetReverseOn);
    const originalLines = reversal
      ? await tx.select().from(journalLines)
        .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)))
      : [];

    await ledger.updateTransaction(tenantId, txnId, payload, userId, companyId, tx);
    const entry = await loadEntry(tx, tenantId, txnId);

    if (reversal && targetReverseOn && await ledger.reversalMatches(tx, tenantId, reversal, entry, targetReverseOn)) {
      return { ...entry, reversalTransactionId: reversal.id, reverseOn: reversal.txnDate };
    }
    if (reversal) {
      await ledger.assertReversalUnchanged(tx, tenantId, reversal, originalLines);
      await ledger.deleteTransactionInTx(tx, tenantId, reversal.id, {
        reason: 'Original journal entry edited', userId, companyId,
      });
    }
    const posted = targetReverseOn
      ? await ledger.postReversal(tx, tenantId, entry, targetReverseOn, userId, companyId)
      : null;
    return { ...entry, reversalTransactionId: posted?.id ?? null, reverseOn: posted?.txnDate ?? null };
  });
}

/**
 * Suggested next journal entry number (U-59): the highest all-digit JE
 * number in the company, plus one; "1" when there is none. Numbers of void
 * and deleted entries count, so a number is not suggested twice. AJEs keep
 * their own numbering and are not counted.
 */
export async function nextJournalEntryNumber(tenantId: string, companyId?: string | null, executor: DbOrTx = db): Promise<string> {
  const result = await executor.execute(sql`
    SELECT (COALESCE(MAX(txn_number::numeric), 0) + 1)::text AS next
    FROM transactions
    WHERE tenant_id = ${tenantId}
      AND txn_type = 'journal_entry'
      AND txn_number ~ '^[0-9]{1,19}$'
      AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
  `);
  return (result.rows as Array<{ next: string }>)[0]?.next ?? '1';
}
