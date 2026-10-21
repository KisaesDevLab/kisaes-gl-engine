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

function buildJournalEntryPayload(input: CreateJournalEntryInput) {
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
function assertReverseOn(input: CreateJournalEntryInput) {
  if (input.reverseOn && !(input.reverseOn > input.txnDate)) {
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

async function withReversal(
  tx: Tx,
  tenantId: string,
  posted: { id: string },
  reverseOn: string | null | undefined,
  userId?: string,
  companyId?: string,
) {
  const [header] = await tx.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, posted.id))).limit(1);
  if (!header) throw AppError.internal('Journal entry vanished while posting');
  const lines = await tx.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, posted.id)))
    .orderBy(journalLines.lineOrder);
  const reversal = reverseOn
    ? await ledger.postReversal(tx, tenantId, { ...header, lines }, reverseOn, userId, companyId)
    : null;
  return { ...header, lines, reversalTransactionId: reversal?.id ?? null, reverseOn: reversal?.txnDate ?? null };
}

export async function createJournalEntry(
  tenantId: string, input: CreateJournalEntryInput, userId?: string, companyId?: string, opts: JournalEntryOptions = {},
) {
  assertReverseOn(input);
  const payload = buildJournalEntryPayload(input);
  return db.transaction(async (tx) => {
    await assertJournalEntryNames(tx, tenantId, companyId, payload.lines, opts);
    const posted = await ledger.postTransaction(tenantId, payload, userId, companyId, tx);
    return withReversal(tx, tenantId, posted, input.reverseOn, userId, companyId);
  });
}

/**
 * Edit (PUT): the body is the entry's full state. A live automatic reversal
 * is deleted (soft, with reversing lines) and, when reverseOn is sent, a new
 * one is posted from the edited lines — all in one database transaction. A
 * reversal changed after it was created refuses the edit (409
 * REVERSAL_EDITED).
 */
export async function updateJournalEntry(tenantId: string, txnId: string, input: CreateJournalEntryInput, userId?: string, companyId?: string) {
  assertReverseOn(input);
  const payload = buildJournalEntryPayload(input);
  return db.transaction(async (tx) => {
    await assertJournalEntryNames(tx, tenantId, companyId, payload.lines);
    const [existing] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update').limit(1);
    const reversal = existing?.txnType === 'journal_entry' && existing.status === 'posted'
      ? await ledger.findLiveReversal(tx, tenantId, txnId)
      : null;
    if (reversal) {
      const originalLines = await tx.select().from(journalLines)
        .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
      await ledger.assertReversalUnchanged(tx, tenantId, reversal, originalLines);
    }
    const updated = await ledger.updateTransaction(tenantId, txnId, payload, userId, companyId, tx);
    if (reversal) {
      await ledger.deleteTransactionInTx(tx, tenantId, reversal.id, {
        reason: 'Original journal entry edited', userId, companyId,
      });
    }
    return withReversal(tx, tenantId, updated as { id: string }, input.reverseOn, userId, companyId);
  });
}

/**
 * Suggested next journal entry number (U-59): the highest all-digit JE
 * number in the company, plus one; "1" when there is none. Numbers of void
 * and deleted entries count, so a number is not suggested twice. AJEs keep
 * their own numbering and are not counted.
 */
export async function nextJournalEntryNumber(tenantId: string, companyId?: string | null): Promise<string> {
  const result = await db.execute(sql`
    SELECT (COALESCE(MAX(txn_number::numeric), 0) + 1)::text AS next
    FROM transactions
    WHERE tenant_id = ${tenantId}
      AND txn_type = 'journal_entry'
      AND txn_number ~ '^[0-9]{1,19}$'
      AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
  `);
  return (result.rows as Array<{ next: string }>)[0]?.next ?? '1';
}
