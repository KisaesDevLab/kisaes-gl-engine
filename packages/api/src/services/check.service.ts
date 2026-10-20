// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql, count } from 'drizzle-orm';
import type { WriteCheckInput } from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import { transactions, companies, journalLines as journalLinesTable } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { auditLog } from '../middleware/audit.js';
import { signatureApplies } from './check-signature.service.js';
import { assertLineContacts } from './line-contacts.service.js';
import { exactAmount } from '../utils/money.js';
import crypto from 'crypto';

// Check numbers are tracked PER BANK ACCOUNT in
// check_settings.nextCheckNumbers keyed by the bank GL account id. This SQL
// fragment reads a bank account's current next-number, falling back to the
// legacy company-wide check_settings.nextCheckNumber, then 1001. Reused by
// every allocate/advance site so the fallback stays consistent.
function nextNumFor(bankAccountId: string) {
  return sql`COALESCE(
    (check_settings->'nextCheckNumbers'->>${bankAccountId})::int,
    (check_settings->>'nextCheckNumber')::int,
    1001
  )`;
}

// Merge a new next-number for one bank account into
// check_settings.nextCheckNumbers, preserving the other accounts' counters
// (and the legacy nextCheckNumber). `value` is a jsonb expression.
function setNextNumSql(bankAccountId: string, value: ReturnType<typeof sql>) {
  return sql`jsonb_set(
    COALESCE(check_settings, '{}'::jsonb),
    '{nextCheckNumbers}',
    COALESCE(check_settings->'nextCheckNumbers', '{}'::jsonb) || jsonb_build_object(${bankAccountId}::text, ${value})
  )`;
}

// Refuse a check number that a non-void, non-deleted transaction on this
// bank account already holds (409). `excludeTxnId` skips the check being
// edited, so re-saving a check with its own number is not a clash.
async function assertCheckNumberFree(
  executor: DbOrTx, tenantId: string, bankAccountId: string, checkNumber: number, excludeTxnId?: string,
) {
  const dup = await executor.execute(sql`
    SELECT t.id FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.account_id = ${bankAccountId}
    WHERE t.tenant_id = ${tenantId}
      -- No txn_type filter: hand-written checks post as 'expense' and
      -- printed bill payments carry check numbers too — a number is
      -- taken if ANY non-void transaction on this bank account holds it.
      AND t.check_number = ${checkNumber}
      AND t.status NOT IN ('void', 'deleted')
      ${excludeTxnId ? sql`AND t.id <> ${excludeTxnId}` : sql``}
    LIMIT 1
  `);
  if (dup.rows.length > 0) {
    throw AppError.conflict(`Check #${checkNumber} already exists on this bank account.`);
  }
}

// Advance the bank account's auto counter past a manually entered number
// so the next auto-assigned check can't collide with it (never backwards).
async function advanceCounterPast(executor: DbOrTx, tenantId: string, bankAccountId: string, checkNumber: number) {
  await executor.execute(sql`
    UPDATE companies
    SET check_settings = ${setNextNumSql(
      bankAccountId,
      sql`to_jsonb(GREATEST(${nextNumFor(bankAccountId)}, ${checkNumber} + 1))`,
    )}
    WHERE tenant_id = ${tenantId}
  `);
}

// Hand-written: atomically allocate the next check number.
//
// The previous implementation read `nextCheckNumber` from the JSONB
// settings, used it, and wrote back the incremented value as separate
// statements. Two concurrent createCheck calls would both read the
// same value and assign IT to two different checks — and checks are
// literal payment instruments. Banks reject duplicates.
//
// Fix: a single UPDATE … RETURNING statement using jsonb_set to
// atomically increment the counter. Postgres serializes UPDATEs on
// the same row so each caller gets a distinct number, even with no
// application-level locking.
async function allocateCheckNumber(executor: DbOrTx, tenantId: string, bankAccountId: string): Promise<number> {
  const result = await executor.execute(sql`
    UPDATE companies
    SET check_settings = ${setNextNumSql(
      bankAccountId,
      sql`to_jsonb(${nextNumFor(bankAccountId)} + 1)`,
    )}
    WHERE tenant_id = ${tenantId}
    RETURNING (check_settings->'nextCheckNumbers'->>${bankAccountId})::int - 1 AS assigned_number
  `);
  const assigned = (result.rows[0] as { assigned_number: number | null } | undefined)?.assigned_number;
  if (assigned === null || assigned === undefined) {
    throw AppError.internal('Failed to allocate check number for tenant');
  }
  return Number(assigned);
}

/**
 * Journal lines for a check: DR each expense line, CR the bank account.
 * The line amounts must sum EXACTLY to the check amount (decimal
 * arithmetic, no tolerance) — 400 VALIDATION_ERROR otherwise. Line
 * customers and billable marks are checked too (U-49, U-50).
 */
async function buildCheckLines(tenantId: string, input: WriteCheckInput) {
  const amount = exactAmount(input.amount, 'amount');
  const lineAmounts = input.lines.map((l, i) => exactAmount(l.amount, `lines[${i}].amount`));
  const sum = lineAmounts.reduce((s, a) => s.plus(a), exactAmount('0', 'amount'));
  if (!sum.equals(amount)) {
    throw AppError.badRequest(
      `Line items (${sum.toFixed(4)}) do not sum to the check amount (${amount.toFixed(4)})`,
      'VALIDATION_ERROR',
    );
  }
  await assertLineContacts(tenantId, input.lines);

  return [
    ...input.lines.map((l, i) => ({
      accountId: l.accountId,
      debit: lineAmounts[i]!.toFixed(4),
      credit: '0',
      description: l.description,
      tagId: l.tagId,
      contactId: l.contactId ?? null,
      isBillable: l.isBillable === true,
    })),
    { accountId: input.bankAccountId, debit: '0', credit: amount.toFixed(4) },
  ];
}

export async function createCheck(tenantId: string, input: WriteCheckInput, userId?: string, companyId?: string) {
  const journalLines = await buildCheckLines(tenantId, input);

  // Determine check number
  let checkNumber: number | null = null;
  let printStatus: string;

  if (input.printLater) {
    printStatus = 'queue';
  } else if (input.checkNumber) {
    // Manual override — the physical checkbook is the source of truth
    // for hand-written checks. Refuse duplicates on the same bank
    // account (banks reject them, and a silent duplicate corrupts the
    // register), then advance the auto counter past the manual number
    // so the next auto-assigned check can't collide with it.
    await assertCheckNumberFree(db, tenantId, input.bankAccountId, input.checkNumber);
    await advanceCounterPast(db, tenantId, input.bankAccountId, input.checkNumber);
    checkNumber = input.checkNumber;
    printStatus = 'hand_written';
  } else {
    checkNumber = await allocateCheckNumber(db, tenantId, input.bankAccountId);
    printStatus = 'hand_written';
  }

  // Wrap the ledger post + check-specific header update + tag inserts
  // in a single transaction so a mid-flight failure rolls everything
  // back. Without this, a crash between the ledger commit and the
  // check-fields UPDATE would leave a transaction posted that lacks a
  // check number — orphaned check-allocation that's hard to reconcile.
  const txn = await db.transaction(async (tx) => {
    const t = await ledger.postTransaction(tenantId, {
      txnType: 'expense',
      txnDate: input.txnDate,
      contactId: input.contactId,
      memo: input.memo,
      total: input.amount,
      paymentMethod: 'check',
      lines: journalLines,
    }, userId, companyId, tx);

    // Tenant_id in WHERE for defense in depth (CLAUDE.md rule #17).
    await tx.update(transactions).set({
      checkNumber,
      printStatus,
      payeeNameOnCheck: input.payeeNameOnCheck,
      payeeAddress: input.payeeAddress || null,
      printedMemo: input.printedMemo || null,
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, t.id)));

    if (input.tagIds && input.tagIds.length > 0) {
      const { transactionTags } = await import('../db/schema/index.js');
      for (const tagId of input.tagIds) {
        await tx.insert(transactionTags).values({ transactionId: t.id, tagId, tenantId }).onConflictDoNothing();
      }
    }
    return t;
  });

  return { ...txn, checkNumber, printStatus, payeeNameOnCheck: input.payeeNameOnCheck };
}

/**
 * Edit a check (U-48): the same body as createCheck. The ledger side goes
 * through ledger.updateTransaction, so the edit gets exactly the rules of
 * PUT /transactions/:id — closing date and closing-date password (423 /
 * 403), void (400) and deleted (404) refusals, the reconciled-line guard,
 * balance reversal and the audit row with the before-image lines. The
 * check fields are written in the same database transaction.
 *
 * Numbering:
 *   - printLater: back to the print queue, number and print stamp cleared;
 *   - checkNumber given: a printed check keeping its own number stays
 *     printed; otherwise the number is checked for duplicates on the bank
 *     account (409), the counter advanced past it, status 'hand_written'
 *     (as on create);
 *   - neither: a numbered check keeps its number and status (re-checked
 *     for duplicates, the bank account may have changed); a queued check
 *     gets the next number from the counter, as on create.
 *
 * Only checks (txn_type 'expense' with a print status) are edited here:
 * anything else is 404; a check that pays bills is 400 CHECK_NOT_EDITABLE
 * (it is changed from its bill payment).
 */
export async function updateCheck(
  tenantId: string, checkId: string, input: WriteCheckInput, userId?: string, companyId?: string,
) {
  const journalLines = await buildCheckLines(tenantId, input);

  return await db.transaction(async (tx) => {
    const conds = [eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)];
    if (companyId) conds.push(eq(transactions.companyId, companyId));
    const [existing] = await tx.select().from(transactions).where(and(...conds)).for('update').limit(1);
    if (!existing || existing.printStatus === null || existing.status === 'deleted') {
      throw AppError.notFound('Check not found');
    }
    if (existing.txnType !== 'expense') {
      throw AppError.badRequest('A check that pays bills is changed from its bill payment.', 'CHECK_NOT_EDITABLE');
    }

    // Ledger first: closed-period, void and reconciliation refusals happen
    // before any check number is touched.
    await ledger.updateTransaction(tenantId, checkId, {
      txnType: 'expense',
      txnDate: input.txnDate,
      contactId: input.contactId,
      memo: input.memo,
      total: input.amount,
      paymentMethod: 'check',
      lines: journalLines,
    }, userId, companyId, tx);

    let checkNumber: number | null;
    let printStatus: string;
    let clearPrintStamp = false;
    if (input.printLater) {
      checkNumber = null;
      printStatus = 'queue';
      clearPrintStamp = true;
    } else if (input.checkNumber) {
      checkNumber = input.checkNumber;
      await assertCheckNumberFree(tx, tenantId, input.bankAccountId, checkNumber, checkId);
      if (existing.printStatus === 'printed' && existing.checkNumber === checkNumber) {
        printStatus = 'printed';
      } else {
        await advanceCounterPast(tx, tenantId, input.bankAccountId, checkNumber);
        printStatus = 'hand_written';
        clearPrintStamp = true;
      }
    } else if (existing.checkNumber !== null && existing.printStatus !== 'queue') {
      checkNumber = existing.checkNumber;
      printStatus = existing.printStatus!;
      await assertCheckNumberFree(tx, tenantId, input.bankAccountId, checkNumber, checkId);
    } else {
      checkNumber = await allocateCheckNumber(tx, tenantId, input.bankAccountId);
      printStatus = 'hand_written';
      clearPrintStamp = true;
    }

    const before = {
      checkNumber: existing.checkNumber,
      printStatus: existing.printStatus,
      payeeNameOnCheck: existing.payeeNameOnCheck,
      payeeAddress: existing.payeeAddress,
      printedMemo: existing.printedMemo,
    };
    const after = {
      checkNumber,
      printStatus,
      payeeNameOnCheck: input.payeeNameOnCheck,
      payeeAddress: input.payeeAddress || null,
      printedMemo: input.printedMemo || null,
    };
    // Tenant_id in WHERE for defense in depth (CLAUDE.md rule #17).
    await tx.update(transactions).set({
      ...after,
      ...(clearPrintStamp ? { printedAt: null, printBatchId: null, printSignatureId: null } : {}),
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)));

    if (input.tagIds && input.tagIds.length > 0) {
      const { transactionTags } = await import('../db/schema/index.js');
      for (const tagId of input.tagIds) {
        await tx.insert(transactionTags).values({ transactionId: checkId, tagId, tenantId }).onConflictDoNothing();
      }
    }

    // The ledger row above carries the before-image lines; this one the
    // check fields (number, print status, payee, printed memo).
    await auditLog(tenantId, 'update', 'check', checkId, before, after, userId, tx);

    const [txn] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId))).limit(1);
    const lines = await tx.select().from(journalLinesTable)
      .where(and(eq(journalLinesTable.tenantId, tenantId), eq(journalLinesTable.transactionId, checkId)));
    return { ...txn!, lines, checkNumber, printStatus, payeeNameOnCheck: input.payeeNameOnCheck };
  });
}

export async function listChecks(tenantId: string, filters?: {
  bankAccountId?: string; printStatus?: string; startDate?: string; endDate?: string; limit?: number; offset?: number;
}, companyId?: string) {
  const conds = [
    sql`t.tenant_id = ${tenantId}`,
    // bill_payment checks print through the same queue — without it here
    // they'd vanish from the Checks list the moment they printed.
    sql`t.txn_type IN ('expense', 'bill_payment')`,
    sql`t.print_status IS NOT NULL`,
    // Soft-deleted checks (txn-delete-v1) leave the list.
    sql`t.status <> 'deleted'`,
  ];
  if (companyId) conds.push(sql`t.company_id = ${companyId}`);
  if (filters?.bankAccountId) conds.push(sql`EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.transaction_id = t.id AND jl2.account_id = ${filters.bankAccountId} AND jl2.credit > 0)`);
  if (filters?.printStatus) conds.push(sql`t.print_status = ${filters.printStatus}`);
  if (filters?.startDate) conds.push(sql`t.txn_date >= ${filters.startDate}`);
  if (filters?.endDate) conds.push(sql`t.txn_date <= ${filters.endDate}`);

  const rows = await db.execute(sql`
    SELECT DISTINCT t.id, t.txn_date, t.total, t.memo, t.status,
      t.check_number, t.print_status, t.payee_name_on_check, t.printed_memo,
      c.display_name as contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY t.txn_date DESC, t.check_number DESC
    LIMIT ${filters?.limit || 50} OFFSET ${filters?.offset || 0}
  `);

  return { data: (rows.rows as any[]).map((r) => ({
    id: r.id,
    txnDate: r.txn_date,
    amount: r.total,
    memo: r.memo,
    status: r.status,
    checkNumber: r.check_number,
    printStatus: r.print_status,
    payeeNameOnCheck: r.payee_name_on_check,
    printedMemo: r.printed_memo,
    contactName: r.contact_name,
  }))};
}

export async function getPrintQueue(tenantId: string, bankAccountId?: string, companyId?: string) {
  const pqConds = [sql`t.tenant_id = ${tenantId}`, sql`t.print_status = 'queue'`, sql`t.status <> 'deleted'`];
  if (companyId) pqConds.push(sql`t.company_id = ${companyId}`);
  if (bankAccountId) {
    pqConds.push(sql`t.id IN (SELECT transaction_id FROM journal_lines WHERE account_id = ${bankAccountId} AND credit > 0)`);
  }

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_date, t.total, t.memo, t.payee_name_on_check, t.printed_memo,
      t.source, c.display_name as contact_name, t.created_at
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE ${sql.join(pqConds, sql` AND `)}
    ORDER BY t.created_at ASC
  `);

  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    txnDate: r.txn_date,
    amount: r.total,
    memo: r.memo,
    payeeNameOnCheck: r.payee_name_on_check,
    printedMemo: r.printed_memo,
    contactName: r.contact_name,
    createdAt: r.created_at,
    // 'client_portal' → rendered as a "Client requested" chip in the
    // print-queue UI so staff can see which checks a client triggered.
    source: r.source ?? null,
  }));
}

export async function printChecks(
  tenantId: string, bankAccountId: string, checkIds: string[],
  startingNumber: number, format: string, userId?: string,
  signature?: { id: string; maxAmount: string | null },
) {
  const batchId = crypto.randomUUID();
  let signedCount = 0;

  // Wrap the entire batch in a single database transaction. Without this,
  // a partial print run leaves some checks marked 'printed' with new
  // numbers and others still in 'queue', and the next print's starting
  // number is left in an indeterminate state. Locking each check row
  // serializes concurrent print runs that overlap on a check id.
  return await db.transaction(async (tx) => {
    // Server-side duplicate backstop: refuse to assign any check number in
    // [startingNumber .. startingNumber+n-1] that a non-void transaction on
    // THIS bank account already holds. There is no DB unique constraint on
    // check_number (uniqueness is per bank account, resolved via the journal
    // line), so this guard is what prevents a re-print — e.g. a stale manual
    // starting number — from stamping duplicate serials on real checks.
    const endNumber = startingNumber + checkIds.length - 1;
    const clash = await tx.execute(sql`
      SELECT t.check_number
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.account_id = ${bankAccountId}
      WHERE t.tenant_id = ${tenantId}
        AND t.status NOT IN ('void', 'deleted')
        AND t.check_number BETWEEN ${startingNumber} AND ${endNumber}
      ORDER BY t.check_number
      LIMIT 1
    `);
    if (clash.rows.length > 0) {
      const dupNum = (clash.rows[0] as { check_number: number }).check_number;
      throw AppError.conflict(`Check #${dupNum} already exists on this bank account. Choose a starting number past the last used check.`);
    }

    for (let i = 0; i < checkIds.length; i++) {
      const checkId = checkIds[i]!;

      // Lock the check row before reading its status, so two concurrent
      // print operations on the same set of checks can't both observe
      // status='queue' and both assign different numbers to it.
      const [txn] = await tx.select().from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)))
        .for('update')
        .limit(1);

      if (!txn) throw AppError.notFound(`Check ${checkId} not found`);
      if (txn.printStatus !== 'queue') throw AppError.badRequest(`Check ${checkId} is not in the print queue`);

      // Record which signature image this check printed with. Over-cap
      // checks in a signed batch print unsigned (bare rule) — mirror of
      // the render-side applySignature flag in check-pdf.service.
      const signed = !!signature && signatureApplies(txn.total ?? '0', signature.maxAmount);
      if (signed) signedCount++;

      await tx.update(transactions).set({
        checkNumber: startingNumber + i,
        printStatus: 'printed',
        printedAt: new Date(),
        printBatchId: batchId,
        printSignatureId: signed ? signature!.id : null,
        updatedAt: new Date(),
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)));
    }

    // Update company next check number atomically via jsonb_set so we
    // don't clobber concurrent updates to other settings keys. We use
    // GREATEST() to make this safe under concurrent print runs that
    // happen to specify overlapping starting numbers — the larger value
    // always wins, so we never roll the counter backwards.
    const newNext = startingNumber + checkIds.length;
    await tx.execute(sql`
      UPDATE companies
      SET check_settings = ${setNextNumSql(
        bankAccountId,
        sql`to_jsonb(GREATEST(${nextNumFor(bankAccountId)}, ${newNext}))`,
      )}
      WHERE tenant_id = ${tenantId}
    `);

    await auditLog(tenantId, 'create', 'check_print', batchId, null, {
      checkCount: checkIds.length,
      range: `${startingNumber}-${startingNumber + checkIds.length - 1}`,
      format,
      signatureId: signature?.id ?? null,
      signedCount,
      unsignedCount: checkIds.length - signedCount,
    }, userId, tx);

    return {
      batchId,
      checksPrinted: checkIds.length,
      checkNumberRange: `${startingNumber}–${startingNumber + checkIds.length - 1}`,
    };
  });
}

/**
 * Change the memo that will print on a check's memo line.
 *
 * Only checks still waiting in the print queue can be edited: once the memo
 * exists on paper it is a fact, and rewriting the record would make the
 * register disagree with what the payee is holding. That rules out
 * 'hand_written' as well as 'printed' — a hand-written check was written by
 * hand before it ever reached us. Reprinting a batch requeues its checks, so
 * a genuine correction is still reachable.
 */
export async function updatePrintedMemo(
  tenantId: string, checkId: string, printedMemo: string,
  userId?: string, companyId?: string,
) {
  const conds = [eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)];
  if (companyId) conds.push(eq(transactions.companyId, companyId));
  const [txn] = await db.select().from(transactions).where(and(...conds)).limit(1);

  if (!txn || txn.printStatus === null) throw AppError.notFound('Check not found');
  if (txn.status === 'void') throw AppError.badRequest('Cannot edit the memo on a voided check');
  if (txn.printStatus === 'printed') {
    throw AppError.badRequest('This check has already printed. Reprint the batch to return it to the queue before editing its memo.');
  }
  if (txn.printStatus !== 'queue') {
    throw AppError.badRequest("A hand-written check's memo can't be changed here — the check already exists on paper.");
  }

  // Empty string, not NULL: NULL means "nobody set one" and falls back to
  // the internal memo at print time, so clearing the field has to be
  // recorded as a deliberate "print no memo".
  const next = printedMemo.trim();

  // The status condition is repeated in the WHERE, not just checked above:
  // printChecks holds the row FOR UPDATE, so an edit submitted while a batch
  // is printing would otherwise land on a check that has since printed.
  const updated = await db.update(transactions)
    .set({ printedMemo: next, updatedAt: new Date() })
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.id, checkId),
      eq(transactions.printStatus, 'queue'),
    ))
    .returning({ id: transactions.id });

  if (updated.length === 0) {
    throw AppError.badRequest('This check printed while you were editing it. Reprint the batch to return it to the queue before editing its memo.');
  }

  await auditLog(tenantId, 'update', 'check', checkId,
    { printedMemo: txn.printedMemo }, { printedMemo: next }, userId);

  return { id: checkId, printedMemo: next };
}

export async function requeueChecks(tenantId: string, checkIds: string[]) {
  for (const id of checkIds) {
    await db.update(transactions).set({
      printStatus: 'queue',
      checkNumber: null,
      printedAt: null,
      printBatchId: null,
      printSignatureId: null,
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id)));
  }
}

export async function reprintBatch(tenantId: string, batchId: string) {
  await db.update(transactions).set({
    printStatus: 'queue',
    printedAt: null,
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.printBatchId, batchId)));
}
