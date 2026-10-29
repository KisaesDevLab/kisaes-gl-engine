// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql, count, inArray } from 'drizzle-orm';
import type { WriteCheckInput, UpdateCheckInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import {
  transactions, companies, journalLines as journalLinesTable, tags, transactionTags, spoiledCheckNumbers,
} from '../db/schema/index.js';
import type { SpoiledCheckReason } from '../db/schema/spoiled-check-numbers.js';
import { checkPayeeAddressLines } from './check-address.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { auditLog } from '../middleware/audit.js';
import { signatureApplies } from './check-signature.service.js';
import { assertLineContacts, assertBillableLinesHaveContact } from './line-contacts.service.js';
import { exactAmount } from '../utils/money.js';
import { env } from '../config/env.js';
import { deriveHeaderTags } from './tags/derive-header-tags.js';
import { claimAndRecord } from './idempotency.service.js';
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

// Refuse a check number that a non-deleted transaction on this bank account
// already holds (409). A void check keeps its number (owner decision Q-PR2a,
// 2026-10-29): the paper exists, so the number is never handed out again. `excludeTxnId` skips the check being
// edited, so re-saving a check with its own number is not a clash. A number
// spoiled by a reprint (U-106) may be used again (owner decision 2026-10-29).
async function assertCheckNumberFree(
  executor: DbOrTx, tenantId: string, bankAccountId: string, checkNumber: number, excludeTxnId?: string,
) {
  const dup = await executor.execute(sql`
    SELECT t.id FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.account_id = ${bankAccountId}
    WHERE t.tenant_id = ${tenantId}
      -- No txn_type filter: hand-written checks post as 'expense' and
      -- printed bill payments carry check numbers too — a number is
      -- taken if ANY non-deleted transaction (void included) on this bank account holds it.
      AND t.check_number = ${checkNumber}
      AND t.status <> 'deleted'
      ${excludeTxnId ? sql`AND t.id <> ${excludeTxnId}` : sql``}
    LIMIT 1
  `);
  if (dup.rows.length > 0) {
    throw AppError.conflict(`Check #${checkNumber} already exists on this bank account.`);
  }
}

/**
 * Pay Bills check numbers (U-103, bill-payment-check-number-v1): refuse the
 * range first..last when any number in it is held by a non-deleted
 * transaction on this bank account, void ones included (Q-PR2a): 409 CHECK_NUMBER_IN_USE,
 * details.checkNumber the lowest one taken. Call after lockCheckCounter.
 */
export async function assertCheckNumberRangeFree(
  executor: DbOrTx, tenantId: string, bankAccountId: string, first: number, last: number,
) {
  const clash = await executor.execute(sql`
    SELECT t.check_number FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.account_id = ${bankAccountId}
    WHERE t.tenant_id = ${tenantId}
      AND t.check_number BETWEEN ${first} AND ${last}
      AND t.status <> 'deleted'
    ORDER BY t.check_number
    LIMIT 1
  `);
  if (clash.rows.length > 0) {
    const n = Number((clash.rows[0] as { check_number: number }).check_number);
    throw AppError.conflict(`Check #${n} already exists on this bank account.`, 'CHECK_NUMBER_IN_USE', { checkNumber: String(n) });
  }
}

/** Move the bank account's check counter past `checkNumber` (never back). Exported for Pay Bills (U-103). */
export async function advanceCheckCounterPast(
  executor: DbOrTx, tenantId: string, bankAccountId: string, checkNumber: number, companyId: string | undefined,
) {
  await advanceCounterPast(executor, tenantId, bankAccountId, checkNumber, companyId);
}

// The companies row(s) holding the counter: the active company when the
// caller knows it (every route does), else every company of the tenant
// (legacy callers without a company context, e.g. the MCP tool).
function counterScope(tenantId: string, companyId: string | undefined) {
  return companyId ? sql`tenant_id = ${tenantId} AND id = ${companyId}` : sql`tenant_id = ${tenantId}`;
}

/**
 * Row-lock the counter's companies row(s) until the end of the
 * transaction. Taken BEFORE assertCheckNumberFree on the manual paths, so
 * two concurrent saves of the same number serialize: the second one sees
 * the first one's check once it commits and is refused (409).
 */
export async function lockCheckCounter(executor: DbOrTx, tenantId: string, companyId: string | undefined) {
  await executor.execute(sql`SELECT 1 FROM companies WHERE ${counterScope(tenantId, companyId)} FOR UPDATE`);
}

// Advance the bank account's auto counter past a manually entered number
// so the next auto-assigned check can't collide with it (never backwards).
// The UPDATE row-locks the counter until the transaction ends.
async function advanceCounterPast(
  executor: DbOrTx, tenantId: string, bankAccountId: string, checkNumber: number, companyId: string | undefined,
) {
  await executor.execute(sql`
    UPDATE companies
    SET check_settings = ${setNextNumSql(
      bankAccountId,
      sql`to_jsonb(GREATEST(${nextNumFor(bankAccountId)}, ${checkNumber} + 1))`,
    )}
    WHERE ${counterScope(tenantId, companyId)}
  `);
}

/**
 * The next number the counter would hand out for a bank account, without
 * taking it (batch validation simulates the counter with it).
 */
export async function peekNextCheckNumber(
  executor: DbOrTx, tenantId: string, bankAccountId: string, companyId: string,
): Promise<number> {
  const res = await executor.execute(sql`
    SELECT ${nextNumFor(bankAccountId)} AS next FROM companies WHERE ${counterScope(tenantId, companyId)}
  `);
  const next = (res.rows[0] as { next: number | string | null } | undefined)?.next;
  return next === null || next === undefined ? 1001 : Number(next);
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
async function allocateCheckNumber(
  executor: DbOrTx, tenantId: string, bankAccountId: string, companyId: string | undefined,
): Promise<number> {
  const result = await executor.execute(sql`
    UPDATE companies
    SET check_settings = ${setNextNumSql(
      bankAccountId,
      sql`to_jsonb(${nextNumFor(bankAccountId)} + 1)`,
    )}
    WHERE ${counterScope(tenantId, companyId)}
    RETURNING (check_settings->'nextCheckNumbers'->>${bankAccountId})::int - 1 AS assigned_number
  `);
  const assigned = (result.rows[0] as { assigned_number: number | null } | undefined)?.assigned_number;
  if (assigned === null || assigned === undefined) {
    throw AppError.internal('Failed to allocate check number for tenant');
  }
  return Number(assigned);
}

/** The next number from the bank account's counter, on xecutor (Pay Bills hand-written checks, Q-PR2b). Call after lockCheckCounter. */
export async function allocateNextCheckNumber(
  executor: DbOrTx, tenantId: string, bankAccountId: string, companyId: string | undefined,
): Promise<number> {
  return allocateCheckNumber(executor, tenantId, bankAccountId, companyId);
}

type CheckBody = Pick<WriteCheckInput, 'amount' | 'lines' | 'bankAccountId'>;

/**
 * Journal lines for a check: DR each expense line, CR the bank account.
 * In-memory rules only (400 VALIDATION_ERROR): the check amount must be
 * greater than zero, the line amounts must sum EXACTLY to it (decimal
 * arithmetic, no tolerance), and a billable line needs a customer. The
 * database-backed scope checks (line customers, header tags) run inside
 * the posting transaction — assertCheckRefsInScope.
 */
export function buildCheckLines(input: CheckBody) {
  const amount = exactAmount(input.amount, 'amount');
  if (!amount.greaterThan(0)) {
    throw AppError.badRequest('The check amount must be greater than zero', 'VALIDATION_ERROR');
  }
  const lineAmounts = input.lines.map((l, i) => exactAmount(l.amount, `lines[${i}].amount`));
  const sum = lineAmounts.reduce((s, a) => s.plus(a), exactAmount('0', 'amount'));
  if (!sum.equals(amount)) {
    throw AppError.badRequest(
      `Line items (${sum.toFixed(4)}) do not sum to the check amount (${amount.toFixed(4)})`,
      'VALIDATION_ERROR',
    );
  }
  assertBillableLinesHaveContact(input.lines);

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

/**
 * Scope checks for a check's references, run on the posting transaction:
 * line customers must be this tenant's (and in the company scope), and so
 * must the header tagIds — 400 VALIDATION_ERROR otherwise. Line accounts
 * and the bank account are checked by the ledger (assertAccountsInScope).
 */
export async function assertCheckRefsInScope(
  tx: DbOrTx, tenantId: string, companyId: string | undefined,
  input: { lines: WriteCheckInput['lines']; tagIds?: string[] },
) {
  await assertLineContacts(tenantId, input.lines, tx, companyId);
  const tagIds = [...new Set(input.tagIds ?? [])];
  if (tagIds.length === 0) return;
  const rows = await tx.select({ id: tags.id, companyId: tags.companyId }).from(tags)
    .where(and(eq(tags.tenantId, tenantId), inArray(tags.id, tagIds)));
  if (rows.length !== tagIds.length
    || (companyId && rows.some((r) => r.companyId !== null && r.companyId !== companyId))) {
    throw AppError.badRequest('One or more tags do not belong to this company', 'VALIDATION_ERROR');
  }
}

/**
 * `outerTx` (templates, U-62): post inside the caller's transaction. The
 * check number is then allocated on that transaction too, so a rollback of
 * the caller's work leaves the counter where it was.
 */
export async function createCheck(
  tenantId: string, input: WriteCheckInput, userId?: string, companyId?: string, outerTx?: Tx,
) {
  const journalLines = buildCheckLines(input);
  const numbering: DbOrTx = outerTx ?? db;

  // Determine check number
  let checkNumber: number | null = null;
  let printStatus: string;

  const manualNumber = !input.printLater && input.checkNumber ? input.checkNumber : null;
  if (input.printLater) {
    printStatus = 'queue';
  } else if (manualNumber !== null) {
    // Manual override: numbered inside the posting transaction (below).
    checkNumber = manualNumber;
    printStatus = 'hand_written';
  } else {
    checkNumber = await allocateCheckNumber(numbering, tenantId, input.bankAccountId, companyId);
    printStatus = 'hand_written';
  }

  // Wrap the ledger post + check-specific header update + tag inserts
  // in a single transaction so a mid-flight failure rolls everything
  // back. Without this, a crash between the ledger commit and the
  // check-fields UPDATE would leave a transaction posted that lacks a
  // check number — orphaned check-allocation that's hard to reconcile.
  const post = async (tx: Tx) => {
    if (manualNumber !== null) {
      // Manual override — the physical checkbook is the source of truth
      // for hand-written checks. Advance the auto counter past the manual
      // number first: that UPDATE row-locks the counter until commit, so a
      // concurrent save of the same number waits, then sees this check.
      // Then refuse duplicates on the same bank account (banks reject
      // them, and a silent duplicate corrupts the register).
      await advanceCounterPast(tx, tenantId, input.bankAccountId, manualNumber, companyId);
      await assertCheckNumberFree(tx, tenantId, input.bankAccountId, manualNumber);
    }
    await assertCheckRefsInScope(tx, tenantId, companyId, input);
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
      isCheck: true,
      payeeNameOnCheck: input.payeeNameOnCheck,
      payeeAddress: input.payeeAddress || null,
      printedMemo: input.printedMemo || null,
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, t.id)));

    if (input.tagIds && input.tagIds.length > 0) {
      for (const tagId of input.tagIds) {
        await tx.insert(transactionTags).values({ transactionId: t.id, tagId, tenantId }).onConflictDoNothing();
      }
    }
    return t;
  };
  const txn = outerTx ? await post(outerTx) : await db.transaction(post);

  return { ...txn, checkNumber, printStatus, payeeNameOnCheck: input.payeeNameOnCheck };
}

/** The printed face of a check: what a PRINTED check carries on paper. */
const PRINTED_FACE_FIELDS = [
  'amount', 'contactId', 'payeeNameOnCheck', 'payeeAddress', 'printedMemo', 'bankAccountId', 'txnDate', 'checkNumber',
] as const;
type PrintedFaceField = (typeof PRINTED_FACE_FIELDS)[number];

/**
 * Which printed-face fields an edit changes, compared the way the check
 * prints: the amount exactly (decimal), the memo line as check-pdf picks it
 * (printed memo, else the internal memo), the bank account from the check's
 * bank (credit) line, and the number only when one is sent.
 */
async function printedFaceChanges(
  tx: DbOrTx, tenantId: string, existing: typeof transactions.$inferSelect, input: UpdateCheckInput,
): Promise<PrintedFaceField[]> {
  const bankLines = await tx.select({ accountId: journalLinesTable.accountId }).from(journalLinesTable).where(and(
    eq(journalLinesTable.tenantId, tenantId),
    eq(journalLinesTable.transactionId, existing.id),
    eq(journalLinesTable.isVoidReversal, false),
    sql`${journalLinesTable.credit} > 0`,
  ));
  const oldMemoLine = existing.printedMemo ?? existing.memo ?? '';
  const newMemoLine = (input.printedMemo || null) ?? (input.memo || null) ?? '';
  const changed: Record<PrintedFaceField, boolean> = {
    amount: !exactAmount(input.amount, 'amount').equals(existing.total ?? '0'),
    contactId: (input.contactId ?? null) !== (existing.contactId ?? null),
    payeeNameOnCheck: input.payeeNameOnCheck !== existing.payeeNameOnCheck,
    payeeAddress: (input.payeeAddress || null) !== (existing.payeeAddress || null),
    printedMemo: newMemoLine !== oldMemoLine,
    bankAccountId: bankLines.length !== 1 || bankLines[0]!.accountId !== input.bankAccountId,
    txnDate: input.txnDate !== existing.txnDate,
    checkNumber: input.checkNumber !== undefined && input.checkNumber !== existing.checkNumber,
  };
  return PRINTED_FACE_FIELDS.filter((f) => changed[f]);
}

/**
 * The printed-check rule for PUT /transactions/:id as an expense (U-80,
 * ledger-guards-v1). That route has no printedCheckChange answer, so an edit
 * of a PRINTED check that changes its printed face is 409 CHECK_PRINTED
 * (details as on PUT /checks/:id) and nothing changes; the caller edits it
 * with PUT /checks/:id instead. The face is compared exactly as updateCheck
 * compares it. The expense route never writes the check's own fields (name
 * and address on the check, printed memo, number), so those keep their
 * stored values; the memo line changes only when no printed memo is set and
 * the internal memo changes. Checks that have not printed, and expenses
 * without a print status, pass untouched.
 */
export async function assertPrintedFaceKeptOnExpenseEdit(
  tx: Tx, tenantId: string, txnId: string,
  edit: { total: string; contactId?: string | null; memo?: string | null; payFromAccountId: string; txnDate: string },
  companyId?: string,
) {
  const [existing] = await tx.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
    .for('update')
    .limit(1);
  // Anything the ledger edit refuses anyway (missing, another company's,
  // void, deleted) is left to its 404 / 400.
  if (!existing || existing.printStatus !== 'printed' || existing.status !== 'posted'
    || (companyId && existing.companyId && existing.companyId !== companyId)) return;
  const changedFields = await printedFaceChanges(tx, tenantId, existing, {
    amount: edit.total,
    contactId: edit.contactId ?? undefined,
    memo: edit.memo ?? undefined,
    // Not sent by the expense route: the stored values stay.
    payeeNameOnCheck: existing.payeeNameOnCheck,
    payeeAddress: existing.payeeAddress ?? undefined,
    printedMemo: existing.printedMemo ?? undefined,
    bankAccountId: edit.payFromAccountId,
    txnDate: edit.txnDate,
  } as unknown as UpdateCheckInput);
  // An empty printed memo is a deliberate "print no memo" (updatePrintedMemo)
  // and stays on paper whatever the internal memo becomes.
  const fields = existing.printedMemo === '' ? changedFields.filter((f) => f !== 'printedMemo') : changedFields;
  if (fields.length === 0) return;
  throw AppError.conflict(
    'This check has already been printed. Edit it as a check to say whether to reprint it or keep its check number before changing what is printed on it.',
    'CHECK_PRINTED',
    { checkNumber: existing.checkNumber, printedAt: existing.printedAt, changedFields: fields },
  );
}

/**
 * Edit a check (U-48). The ledger side goes through
 * ledger.updateTransaction, so the edit gets exactly the rules of
 * PUT /transactions/:id — closing date and closing-date password (423 /
 * 403), void (400) and deleted (404) refusals, the reconciled-line guard,
 * the billed-line guard (409 LINE_BILLED), balance reversal and the audit
 * row with the before-image lines. The check fields, the header tags and
 * the scope checks run in the same database transaction.
 *
 * A PRINTED check is a piece of paper the payee may already hold. If the
 * edit changes its printed face (amount, payee contact, name or address on
 * the check, memo line, bank account, date, number) or sends printLater:
 * true, the caller must say what happens to the paper —
 * printedCheckChange 'reprint' (back to the queue, number and print stamp
 * cleared) or 'keep_number' (stays numbered as 'hand_written', print stamp
 * cleared; printLater: true needs 'reprint'). Without it: 409
 * CHECK_PRINTED, nothing changes. Edits that leave the face alone (line
 * accounts, descriptions, tags, customers, billable marks with the same
 * amount) keep the check printed and need no flag.
 *
 * Numbering for checks that are not printed:
 *   - printLater true: back to the print queue, number and stamp cleared;
 *   - checkNumber given: checked for duplicates on the bank account (409),
 *     counter advanced past it, status 'hand_written' (as on create);
 *   - otherwise a numbered check keeps its number and status (re-checked
 *     for duplicates, the bank account may have changed); a queued check
 *     stays queued unless printLater is false, which gives it the next
 *     number from the counter, as on create.
 *
 * Header tagIds, when sent, REPLACE the check's header tags (an empty array
 * clears them); absent leaves them as the ledger edit leaves them (unchanged;
 * with TAGS_SPLIT_LEVEL_V2 on, the line-derived ones follow the new lines and
 * the check's own header tags stay — U-80, as on PUT /transactions/:id).
 *
 * Only checks (txn_type 'expense' with a print status) are edited here:
 * anything else is 404; a check that pays bills is 400 CHECK_NOT_EDITABLE
 * (it is changed from its bill payment).
 */
export async function updateCheck(
  tenantId: string, checkId: string, input: UpdateCheckInput, userId?: string, companyId?: string,
) {
  const journalLines = buildCheckLines(input);

  return await db.transaction(async (tx) => {
    // Lock order (U-117 S4): the check counter's companies row BEFORE the
    // check row, as printChecks does. Every numbering branch below locks the
    // counter; taking it after the check row deadlocked against a print run
    // holding the counter and waiting for this check.
    await lockCheckCounter(tx, tenantId, companyId);
    const conds = [eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)];
    if (companyId) conds.push(eq(transactions.companyId, companyId));
    const [existing] = await tx.select().from(transactions).where(and(...conds)).for('update').limit(1);
    if (!existing || !isCheckRow(existing) || existing.status === 'deleted') {
      throw AppError.notFound('Check not found');
    }
    if (existing.txnType !== 'expense') {
      throw AppError.badRequest('A check that pays bills is changed from its bill payment.', 'CHECK_NOT_EDITABLE');
    }

    // A printed check's face may only change with an explicit answer to
    // "reprint it, or keep its number?" — refused before anything moves.
    const wasPrinted = existing.printStatus === 'printed';
    let printedChange: 'reprint' | 'keep_number' | null = null;
    let changedFields: PrintedFaceField[] = [];
    if (wasPrinted) {
      changedFields = await printedFaceChanges(tx, tenantId, existing, input);
      if (changedFields.length > 0 || input.printLater === true) {
        const choice = input.printedCheckChange;
        if (!choice || (input.printLater === true && choice !== 'reprint')) {
          throw AppError.conflict(
            'This check has already been printed. Say whether to reprint it or keep its check number before changing what is printed on it.',
            'CHECK_PRINTED',
            { checkNumber: existing.checkNumber, printedAt: existing.printedAt, changedFields },
          );
        }
        printedChange = choice;
      }
    }

    await assertCheckRefsInScope(tx, tenantId, companyId, input);

    // The bank account the current number was issued on, read before the
    // ledger edit moves the bank line: a number cleared by sending the check
    // back to the queue is spoiled there (U-106).
    const sendsToQueue = printedChange === 'reprint' || (!wasPrinted && input.printLater === true);
    const spoiledBank = sendsToQueue && existing.checkNumber !== null
      ? await checkBankAccountId(tx, tenantId, checkId) : null;

    // Ledger first: closed-period, void, reconciliation and billed-line
    // refusals happen before any check number is touched.
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
    if (sendsToQueue) {
      checkNumber = null;
      printStatus = 'queue';
      clearPrintStamp = true;
    } else if (printedChange === 'keep_number') {
      checkNumber = input.checkNumber ?? existing.checkNumber;
      if (checkNumber === null) {
        checkNumber = await allocateCheckNumber(tx, tenantId, input.bankAccountId, companyId);
      } else {
        await advanceCounterPast(tx, tenantId, input.bankAccountId, checkNumber, companyId);
        await assertCheckNumberFree(tx, tenantId, input.bankAccountId, checkNumber, checkId);
      }
      printStatus = 'hand_written';
      clearPrintStamp = true;
    } else if (wasPrinted) {
      // Printed face unchanged (same number, bank account, amount, ...).
      checkNumber = existing.checkNumber;
      printStatus = 'printed';
    } else if (input.checkNumber) {
      checkNumber = input.checkNumber;
      await advanceCounterPast(tx, tenantId, input.bankAccountId, checkNumber, companyId);
      await assertCheckNumberFree(tx, tenantId, input.bankAccountId, checkNumber, checkId);
      printStatus = 'hand_written';
      clearPrintStamp = true;
    } else if (existing.checkNumber !== null && existing.printStatus !== 'queue') {
      checkNumber = existing.checkNumber;
      printStatus = existing.printStatus!;
      await lockCheckCounter(tx, tenantId, companyId);
      await assertCheckNumberFree(tx, tenantId, input.bankAccountId, checkNumber, checkId);
    } else if (input.printLater === false) {
      checkNumber = await allocateCheckNumber(tx, tenantId, input.bankAccountId, companyId);
      printStatus = 'hand_written';
      clearPrintStamp = true;
    } else {
      // Queued check, printLater absent: stays in the queue.
      checkNumber = null;
      printStatus = 'queue';
    }

    const before = {
      checkNumber: existing.checkNumber,
      printStatus: existing.printStatus,
      printedAt: existing.printedAt,
      payeeNameOnCheck: existing.payeeNameOnCheck,
      payeeAddress: existing.payeeAddress,
      printedMemo: existing.printedMemo,
    };
    const fields = {
      checkNumber,
      printStatus,
      payeeNameOnCheck: input.payeeNameOnCheck,
      payeeAddress: input.payeeAddress || null,
      printedMemo: input.printedMemo || null,
    };
    // Tenant_id in WHERE for defense in depth (CLAUDE.md rule #17).
    await tx.update(transactions).set({
      ...fields,
      ...(clearPrintStamp ? { printedAt: null, printBatchId: null, printSignatureId: null } : {}),
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)));

    let spoiledCheckNumber: number | null = null;
    if (spoiledBank && existing.checkNumber !== null) {
      spoiledCheckNumber = existing.checkNumber;
      await recordSpoiledNumber(tx, {
        tenantId, companyId: existing.companyId, bankAccountId: spoiledBank,
        checkNumber: existing.checkNumber, transactionId: checkId, reason: 'edit_reprint', userId,
      });
    }

    const lines = await tx.select().from(journalLinesTable)
      .where(and(eq(journalLinesTable.tenantId, tenantId), eq(journalLinesTable.transactionId, checkId)));

    // Header tags: sent → the set is replaced (with TAGS_SPLIT_LEVEL_V2 the
    // line-derived tags the ledger just wrote stay in it); absent → as the
    // ledger edit left it.
    if (input.tagIds !== undefined) {
      const keep = new Set<string>(input.tagIds);
      if (env.TAGS_SPLIT_LEVEL_V2) {
        for (const tagId of deriveHeaderTags(lines.filter((l) => !l.isVoidReversal))) keep.add(tagId);
      }
      await tx.delete(transactionTags)
        .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, checkId)));
      if (keep.size > 0) {
        await tx.insert(transactionTags).values([...keep].map((tagId) => ({
          transactionId: checkId, tagId, tenantId, companyId: existing.companyId ?? null,
        })));
      }
    }

    // The ledger row above carries the before-image lines; this one the
    // check fields and, for a printed check, the reprint / keep-number choice.
    await auditLog(tenantId, 'update', 'check', checkId, before, {
      ...fields,
      printedCheckChange: printedChange,
      ...(printedChange ? { changedFields } : {}),
      ...(spoiledCheckNumber !== null ? { spoiledCheckNumber, bankAccountId: spoiledBank } : {}),
    }, userId, tx);

    const [txn] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId))).limit(1);
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
    // Created as checks only, voided or not (U-117, Q-PR2e): a void check
    // whose queue status the void cleared (U-115) stays listed; a plain
    // Expense paid "by check" is not a check.
    sql`(t.is_check OR t.print_status IS NOT NULL)`,
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
  // Only posted checks print (U-115): a void (or deleted) check never shows
  // up here, even one voided before voids cleared the queue status.
  const pqConds = [sql`t.tenant_id = ${tenantId}`, sql`t.print_status = 'queue'`, sql`t.status = 'posted'`];
  if (companyId) pqConds.push(sql`t.company_id = ${companyId}`);
  if (bankAccountId) {
    pqConds.push(sql`t.id IN (SELECT transaction_id FROM journal_lines WHERE account_id = ${bankAccountId} AND credit > 0)`);
  }

  // U-107: the bank account (scalar subselect, so a check with several
  // credit lines — a bill payment with a discount — is still one row), the
  // transaction type and the payee address rows, so a client can lay out a
  // window envelope without reading each check.
  const rows = await db.execute(sql`
    SELECT t.id, t.txn_date, t.total, t.memo, t.payee_name_on_check, t.printed_memo,
      t.source, c.display_name as contact_name, t.created_at, t.txn_type, t.payee_address,
      c.billing_line1, c.billing_line2, c.billing_city, c.billing_state, c.billing_zip,
      ${bankAccountSubselect(sql`t`)} AS bank_account_id
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = t.tenant_id
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
    txnType: r.txn_type,
    bankAccountId: r.bank_account_id ?? null,
    payeeAddress: checkPayeeAddressLines(r.txn_type, r.payee_address, {
      line1: r.billing_line1, line2: r.billing_line2, city: r.billing_city, state: r.billing_state, zip: r.billing_zip,
    }),
  }));
}

/**
 * SQL: the bank account a check is drawn on — its credit line on an asset
 * account (a bill payment's discount credit is on an income account), not a
 * void reversal. `t` is the transactions alias.
 */
function bankAccountSubselect(t: ReturnType<typeof sql>) {
  return sql`(
    SELECT jl.account_id FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    WHERE jl.transaction_id = ${t}.id AND jl.tenant_id = ${t}.tenant_id
      AND jl.credit > 0 AND COALESCE(jl.is_void_reversal, false) = false
    ORDER BY (a.account_type = 'asset') DESC, (a.detail_type = 'bank') DESC, jl.credit DESC, jl.account_id
    LIMIT 1
  )`;
}

/** The bank account a check is drawn on (see bankAccountSubselect), or null. */
async function checkBankAccountId(executor: DbOrTx, tenantId: string, txnId: string): Promise<string | null> {
  const res = await executor.execute(sql`
    SELECT ${bankAccountSubselect(sql`t`)} AS bank_account_id
    FROM transactions t WHERE t.tenant_id = ${tenantId} AND t.id = ${txnId}
  `);
  return (res.rows[0] as { bank_account_id: string | null } | undefined)?.bank_account_id ?? null;
}

/**
 * A check: created as one (is_check: Write Checks, or a Pay Bills payment
 * by check that pays cash), voided or not (U-117, Q-PR2e). A void check
 * whose queue status the void cleared (U-115) is still a check; a plain
 * Expense paid "by check" never is.
 */
function isCheckRow(r: { printStatus: string | null; isCheck: boolean }) {
  return r.isCheck || r.printStatus !== null;
}

/** Record a spoiled number (U-106). Listing only: the number may be used again (owner decision 2026-10-29). */
async function recordSpoiledNumber(tx: DbOrTx, s: {
  tenantId: string; companyId: string | null | undefined; bankAccountId: string; checkNumber: number;
  transactionId: string; reason: SpoiledCheckReason; userId: string | undefined;
}) {
  await tx.insert(spoiledCheckNumbers).values({
    tenantId: s.tenantId,
    companyId: s.companyId ?? null,
    bankAccountId: s.bankAccountId,
    checkNumber: s.checkNumber,
    transactionId: s.transactionId,
    reason: s.reason,
    spoiledBy: s.userId ?? null,
  });
}

/**
 * GET /checks/spoiled (U-106): the numbers spoiled by reprints, newest
 * first, for the request's company (rows without a company included) and
 * optionally one bank account. A register shows them as void checks.
 */
export async function listSpoiledCheckNumbers(tenantId: string, bankAccountId?: string, companyId?: string) {
  const conds = [sql`s.tenant_id = ${tenantId}`];
  if (companyId) conds.push(sql`(s.company_id = ${companyId} OR s.company_id IS NULL)`);
  if (bankAccountId) conds.push(sql`s.bank_account_id = ${bankAccountId}`);
  const rows = await db.execute(sql`
    SELECT s.check_number, s.transaction_id, s.bank_account_id, s.reason, s.spoiled_at, s.spoiled_by,
      u.display_name AS spoiled_by_name, t.txn_date
    FROM spoiled_check_numbers s
    LEFT JOIN users u ON u.id = s.spoiled_by
    LEFT JOIN transactions t ON t.id = s.transaction_id AND t.tenant_id = s.tenant_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY s.spoiled_at DESC, s.check_number DESC
  `);
  type SpoiledRow = {
    check_number: number | string; transaction_id: string; bank_account_id: string; reason: SpoiledCheckReason;
    spoiled_at: Date | string; spoiled_by: string | null; spoiled_by_name: string | null; txn_date: Date | string | null;
  };
  return (rows.rows as SpoiledRow[]).map((r) => ({
    checkNumber: Number(r.check_number),
    checkId: r.transaction_id,
    bankAccountId: r.bank_account_id,
    reason: r.reason,
    spoiledAt: r.spoiled_at instanceof Date ? r.spoiled_at.toISOString() : String(r.spoiled_at),
    spoiledBy: r.spoiled_by ?? null,
    spoiledByName: r.spoiled_by_name ?? null,
    txnDate: r.txn_date instanceof Date ? r.txn_date.toISOString().slice(0, 10) : (r.txn_date ?? null),
  }));
}

export async function printChecks(
  tenantId: string, bankAccountId: string, checkIds: string[],
  startingNumber: number, format: string, userId?: string,
  signature?: { id: string; maxAmount: string | null },
  companyId?: string,
) {
  const batchId = crypto.randomUUID();
  let signedCount = 0;

  // Wrap the entire batch in a single database transaction. Without this,
  // a partial print run leaves some checks marked 'printed' with new
  // numbers and others still in 'queue', and the next print's starting
  // number is left in an indeterminate state. Locking each check row
  // serializes concurrent print runs that overlap on a check id.
  return await db.transaction(async (tx) => {
    // Idempotency-Key (U-116, idempotency-check-print-v1): claimed first, on
    // this transaction, so a replay takes no counter lock; the batch is the
    // recorded entity. A no-op without a key.
    await claimAndRecord(tx, 'check_print', batchId);

    // Lock the counter's companies row first, before the range query below:
    // two print runs of different checks from the same starting number then
    // serialize, and the second one's range query sees the first one's
    // committed numbers and is refused (409) instead of printing duplicates.
    await lockCheckCounter(tx, tenantId, companyId);

    // Server-side duplicate backstop: refuse to assign any check number in
    // [startingNumber .. startingNumber+n-1] that a non-deleted transaction (a void check keeps its number, Q-PR2a) on
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
        AND t.status <> 'deleted'
        AND t.check_number BETWEEN ${startingNumber} AND ${endNumber}
      ORDER BY t.check_number
      LIMIT 1
    `);
    if (clash.rows.length > 0) {
      const dupNum = (clash.rows[0] as { check_number: number }).check_number;
      throw AppError.conflict(
        `Check #${dupNum} already exists on this bank account. Choose a starting number past the last used check.`,
        'CHECK_NUMBER_IN_USE',
        { checkNumber: String(dupNum) },
      );
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

      // Company scope (U-106): another company's check is not found.
      if (!txn || txn.status === 'deleted' || (companyId && txn.companyId && txn.companyId !== companyId)) {
        throw AppError.notFound(`Check ${checkId} not found`);
      }
      // A void (or otherwise not posted) check never takes a number (U-115).
      if (txn.status !== 'posted') {
        throw AppError.badRequest(`Check ${checkId} is void and cannot be printed.`, 'CHECK_VOID', { checkId });
      }
      if (txn.printStatus !== 'queue') throw AppError.badRequest(`Check ${checkId} is not in the print queue`);
      // The numbers belong to bankAccountId's checkbook: a check drawn on
      // another account is refused (U-106), nothing prints.
      if (await checkBankAccountId(tx, tenantId, checkId) !== bankAccountId) {
        throw AppError.badRequest(
          `Check ${checkId} is not drawn on the bank account being printed.`,
          'CHECK_NOT_ON_BANK_ACCOUNT',
          { checkId },
        );
      }
      // Printing numbers the check: a closed-period change (U-81).
      await assertCheckPeriodOpen(tx, tenantId, txn);

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
      WHERE ${counterScope(tenantId, companyId)}
    `);

    await auditLog(tenantId, 'create', 'check_print', batchId, null, {
      checkCount: checkIds.length,
      range: `${startingNumber}-${startingNumber + checkIds.length - 1}`,
      format,
      signatureId: signature?.id ?? null,
      signedCount,
      unsignedCount: checkIds.length - signedCount,
      // Each check and the number it took (U-117 N2).
      checks: checkIds.map((id, i) => ({ id, checkNumber: startingNumber + i })),
    }, userId, tx);

    return {
      batchId,
      checksPrinted: checkIds.length,
      checkNumberRange: `${startingNumber}–${startingNumber + checkIds.length - 1}`,
    };
  });
}

/**
 * The POST /checks/print response of a batch, rebuilt from its checks: the
 * replay reader of a keyed print (U-116) when no stored response is left.
 * 404 when no check of the request's company carries the batch any more
 * (sent back to the queue by a reprint).
 */
export async function printBatchResult(tenantId: string, batchId: string, companyId?: string) {
  const conds = [sql`tenant_id = ${tenantId}`, sql`print_batch_id = ${batchId}`];
  if (companyId) conds.push(sql`(company_id = ${companyId} OR company_id IS NULL)`);
  const res = await db.execute(sql`
    SELECT count(*)::int AS n, min(check_number)::int AS lo, max(check_number)::int AS hi
    FROM transactions WHERE ${sql.join(conds, sql` AND `)}
  `);
  const r = res.rows[0] as { n: number; lo: number | null; hi: number | null } | undefined;
  if (!r || r.n === 0 || r.lo === null || r.hi === null) throw AppError.notFound('Print batch not found');
  return { batchId, checksPrinted: r.n, checkNumberRange: `${r.lo}–${r.hi}` };
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
  return db.transaction((tx) => updatePrintedMemoInTx(tx, tenantId, checkId, printedMemo, userId, companyId));
}

/**
 * Closed-period rule for the print routes (U-81): printing, re-queueing and
 * the printed memo change a check's record (number, print status, memo line),
 * so a check dated on or before the closing date takes the closing-date
 * password (or a staff override) exactly like PUT /checks/:id — 423
 * TB_PERIOD_LOCKED / 403 CLOSING_PASSWORD_INVALID otherwise, nothing changes.
 * A permitted override writes its closing_date_override audit row.
 */
async function assertCheckPeriodOpen(
  tx: Tx, tenantId: string, txn: { id: string; txnDate: string; companyId: string | null },
) {
  await ledger.checkLockDate(tx, tenantId, txn.txnDate, txn.companyId, undefined, {
    txnId: txn.id, oldDate: txn.txnDate, newDate: txn.txnDate,
  });
}

async function updatePrintedMemoInTx(
  tx: Tx, tenantId: string, checkId: string, printedMemo: string,
  userId?: string, companyId?: string,
) {
  const conds = [eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)];
  if (companyId) conds.push(eq(transactions.companyId, companyId));
  const [txn] = await tx.select().from(transactions).where(and(...conds)).limit(1);

  if (!txn || !isCheckRow(txn)) throw AppError.notFound('Check not found');
  if (txn.status === 'void') throw AppError.badRequest('Cannot edit the memo on a voided check');
  if (txn.printStatus === 'printed') {
    throw AppError.badRequest('This check has already printed. Reprint the batch to return it to the queue before editing its memo.');
  }
  if (txn.printStatus !== 'queue') {
    throw AppError.badRequest("A hand-written check's memo can't be changed here — the check already exists on paper.");
  }
  await assertCheckPeriodOpen(tx, tenantId, txn);

  // Empty string, not NULL: NULL means "nobody set one" and falls back to
  // the internal memo at print time, so clearing the field has to be
  // recorded as a deliberate "print no memo".
  const next = printedMemo.trim();

  // The status condition is repeated in the WHERE, not just checked above:
  // printChecks holds the row FOR UPDATE, so an edit submitted while a batch
  // is printing would otherwise land on a check that has since printed.
  const updated = await tx.update(transactions)
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
    { printedMemo: txn.printedMemo }, { printedMemo: next }, userId, tx);

  return { id: checkId, printedMemo: next };
}

/** One check a requeue or reprint sent back to the queue (U-106). */
export interface RequeuedCheck {
  id: string;
  /** The number the check carried, now spoiled on bankAccountId; null when it had none. */
  spoiledCheckNumber: number | null;
  bankAccountId: string | null;
}

type RequeueRow = {
  id: string; txnDate: string; companyId: string | null; checkNumber: number | null;
  printStatus: string | null; printBatchId: string | null; status: string | null;
};

/**
 * Send locked check rows back to the print queue (U-106): number, print
 * stamp, batch and signature cleared; the number each carried is recorded as
 * spoiled on the check's bank account; one audit row per check with the
 * before state. The payment itself (ledger lines, bill applications,
 * balances) is never touched: a reprint is not a void (Q-P19b).
 */
async function sendBackToQueue(
  tx: Tx, tenantId: string, rows: RequeueRow[], reason: 'requeue' | 'reprint', userId: string | undefined,
  batchId?: string,
): Promise<RequeuedCheck[]> {
  for (const row of rows) await assertCheckPeriodOpen(tx, tenantId, row);
  const out: RequeuedCheck[] = [];
  for (const row of rows) {
    const bankAccountId = await checkBankAccountId(tx, tenantId, row.id);
    // A numbered check whose bank account can't be resolved (no bank line)
    // would lose its number without a spoiled row: refused, nothing changes.
    if (row.checkNumber !== null && !bankAccountId) {
      throw AppError.badRequest(
        `Check ${row.id} has no bank account, so its number can't be recorded as spoiled. Fix the check's bank account first.`,
        'CHECK_BANK_ACCOUNT_UNKNOWN',
        { checkId: row.id },
      );
    }
    let spoiled: number | null = null;
    if (row.checkNumber !== null && bankAccountId) {
      spoiled = row.checkNumber;
      await recordSpoiledNumber(tx, {
        tenantId, companyId: row.companyId, bankAccountId, checkNumber: row.checkNumber,
        transactionId: row.id, reason, userId,
      });
    }
    await tx.update(transactions).set({
      printStatus: 'queue',
      checkNumber: null,
      printedAt: null,
      printBatchId: null,
      printSignatureId: null,
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, row.id)));
    await auditLog(tenantId, 'update', 'check', row.id,
      { checkNumber: row.checkNumber, printStatus: row.printStatus, printBatchId: row.printBatchId },
      {
        checkNumber: null, printStatus: 'queue', printBatchId: null,
        spoiledCheckNumber: spoiled, bankAccountId, reason, ...(batchId ? { batchId } : {}),
      },
      userId, tx);
    out.push({ id: row.id, spoiledCheckNumber: spoiled, bankAccountId });
  }
  return out;
}

const requeueColumns = {
  id: transactions.id, txnDate: transactions.txnDate, companyId: transactions.companyId,
  checkNumber: transactions.checkNumber, printStatus: transactions.printStatus,
  printBatchId: transactions.printBatchId, status: transactions.status, txnType: transactions.txnType,
  paymentMethod: transactions.paymentMethod, isCheck: transactions.isCheck,
};

/** Another company's row (rows without a company belong to every company, as in Pay Bills). */
function inOtherCompany(row: { companyId: string | null }, companyId: string | undefined) {
  return !!companyId && row.companyId !== null && row.companyId !== companyId;
}

/** A check a requeue or reprint left as it is (U-117 S2): void or deleted checks never go back to the queue. */
export interface SkippedCheck {
  id: string;
  reason: 'void' | 'deleted';
}

/** What a requeue or reprint did: the checks sent back and the ones skipped. */
export interface RequeueResult {
  checks: RequeuedCheck[];
  skipped: SkippedCheck[];
}

function skipReason(row: { status: string | null }): SkippedCheck['reason'] | null {
  if (row.status === 'void') return 'void';
  if (row.status === 'deleted') return 'deleted';
  return null;
}

/**
 * Back to the print queue, number and print stamp cleared, the old number
 * spoiled and audited (U-106, check-reprint-audit-v1). A check dated in a
 * closed period needs the closing-date password (U-81). Every id must be a
 * check of the request's company (404 otherwise); a void or deleted check is
 * skipped and listed in `skipped` while the others go back (U-117 S2); a
 * hand-written check is 400 CHECK_NOT_PRINTED. The whole request is one
 * database transaction, so a refusal changes none of the checks.
 */
export async function requeueChecks(
  tenantId: string, checkIds: string[], userId?: string, companyId?: string,
): Promise<RequeueResult> {
  if (!Array.isArray(checkIds) || checkIds.length === 0) return { checks: [], skipped: [] };
  const ids = [...new Set(checkIds)];
  return await db.transaction(async (tx) => {
    const rows = await tx.select(requeueColumns)
      .from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, ids)))
      .orderBy(transactions.id)
      .for('update');
    const found = rows.filter((r) => !inOtherCompany(r, companyId) && isCheckRow(r));
    if (found.length !== ids.length) throw AppError.notFound('Check not found');
    const byId = new Map(found.map((r) => [r.id, r]));
    const skipped: SkippedCheck[] = [];
    const usable: RequeueRow[] = [];
    for (const id of ids) {
      const r = byId.get(id)!;
      const reason = skipReason(r);
      if (reason) skipped.push({ id, reason });
      else usable.push(r);
    }
    // Only a printed check goes back (a queued one is a no-op): a
    // hand-written check exists on paper with its number, never printed here.
    const notPrinted = usable.find((r) => r.printStatus !== 'printed' && r.printStatus !== 'queue');
    if (notPrinted) {
      throw AppError.badRequest(
        'Only a printed check can go back to the print queue. A hand-written check keeps its number.',
        'CHECK_NOT_PRINTED',
        { checkId: notPrinted.id },
      );
    }
    const checks = await sendBackToQueue(tx, tenantId, usable, 'requeue', userId);
    return { checks, skipped };
  });
}

/**
 * A printed batch back to the queue (U-106): as requeueChecks for every
 * check of the batch in the request's company; 404 when there is none (an
 * unknown batch, another company's, or one already sent back). The payments
 * stay posted. Void and deleted checks of the batch stay as they are and are
 * listed in `skipped`.
 */
export async function reprintBatch(
  tenantId: string, batchId: string, userId?: string, companyId?: string,
): Promise<RequeueResult> {
  return await db.transaction(async (tx) => {
    const rows = await tx.select(requeueColumns)
      .from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.printBatchId, batchId)))
      .orderBy(transactions.checkNumber, transactions.id)
      .for('update');
    if (rows.length === 0 || rows.some((r) => inOtherCompany(r, companyId))) {
      throw AppError.notFound('Print batch not found');
    }
    // A voided or deleted check of the batch stays as it is.
    const skipped: SkippedCheck[] = [];
    const live: RequeueRow[] = [];
    for (const r of rows) {
      const reason = skipReason(r);
      if (reason) skipped.push({ id: r.id, reason });
      else live.push(r);
    }
    const checks = await sendBackToQueue(tx, tenantId, live, 'reprint', userId, batchId);
    return { checks, skipped };
  });
}