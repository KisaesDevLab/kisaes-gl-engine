// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * A posted transaction as a template draft (U-62): "Save as Template" from
 * a saved transaction, POST /recurring with a templateTransactionId (web,
 * API v2) and the lazy conversion of 'legacy' templates.
 *
 *   expense with a print status -> check; other expense -> expense;
 *   deposit -> deposit (line 0 is the bank line, a debit line is a fee
 *   (negative), the cash_back line is cashBack; a line that deposits an
 *   item (source_transaction_id) can't be held);
 *   transfer -> transfer; journal_entry -> journal_entry;
 *   anything else (invoice, bill, cash sale...) stays 'legacy' and is
 *   replayed by the old clone path.
 *
 * Only the document's own lines count (void-reversal lines are skipped).
 * Amounts are carried as the stored decimal strings.
 */

import { and, asc, eq } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type { TemplateDraft } from '@kis-books/shared';
import type { DbOrTx } from '../../db/index.js';
import { journalLines, transactionTags, transactions } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { depositGroupingRefused, validateDraft } from './draft.js';

const Decimal = DecimalLib.default || DecimalLib;

export type SnapshotResult =
  | { kind: 'draft'; draft: TemplateDraft; txnType: string }
  | { kind: 'legacy'; txnType: string; reason: 'UNSUPPORTED_TYPE' | 'UNSUPPORTED_SHAPE' | 'DEPOSIT_GROUPING' };

const pos = (v: string | null | undefined) => new Decimal(v ?? '0').greaterThan(0);
const s4 = (v: string | null | undefined) => new Decimal(v ?? '0').toFixed(4);
const optStr = (v: string | null | undefined) => (v === null || v === undefined ? {} : { description: v });

export interface SourceTxn {
  id: string;
  companyId: string | null;
  status: string | null;
  txnType: string;
}

/**
 * Loads a transaction of this tenant (and of exactly this company, when
 * given: a company-less transaction is not the company's); null when not
 * found. companyId null (tenant-wide callers) reads any.
 */
export async function loadSource(exec: DbOrTx, tenantId: string, companyId: string | null, txnId: string) {
  const [txn] = await exec.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId))).limit(1);
  if (!txn) return null;
  if (companyId && txn.companyId !== companyId) return null;
  return txn;
}

/**
 * The draft of a posted transaction, or 'legacy' when templates can't hold
 * it. Throws nothing for a shape it can't read; the caller decides.
 */
export async function snapshotTransaction(
  exec: DbOrTx, tenantId: string, txn: typeof transactions.$inferSelect,
): Promise<SnapshotResult> {
  const lines = await exec.select().from(journalLines).where(and(
    eq(journalLines.tenantId, tenantId),
    eq(journalLines.transactionId, txn.id),
    eq(journalLines.isVoidReversal, false),
  )).orderBy(asc(journalLines.lineOrder));
  const headerTags = (await exec.select({ tagId: transactionTags.tagId }).from(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, txn.id))))
    .map((r) => r.tagId);
  const unique = [...new Set(headerTags)].sort();
  const shape = (): SnapshotResult => ({ kind: 'legacy', txnType: txn.txnType, reason: 'UNSUPPORTED_SHAPE' });

  let td: TemplateDraft | null = null;
  switch (txn.txnType) {
    case 'expense': {
      const credits = lines.filter((l) => pos(l.credit));
      const debits = lines.filter((l) => pos(l.debit));
      if (credits.length !== 1 || debits.length + credits.length !== lines.length) return shape();
      const bank = credits[0]!;
      const items = debits.map((l) => ({
        amount: s4(l.debit), ...optStr(l.description), tagId: l.tagId ?? null,
        ...(l.contactId ? { contactId: l.contactId } : {}), isBillable: l.isBillable === true,
      }));
      if (txn.printStatus) {
        const payee = txn.payeeNameOnCheck?.trim();
        if (!payee) return shape();
        td = {
          kind: 'check',
          draft: {
            bankAccountId: bank.accountId,
            ...(txn.contactId ? { contactId: txn.contactId } : {}),
            payeeNameOnCheck: payee,
            ...(txn.payeeAddress ? { payeeAddress: txn.payeeAddress } : {}),
            ...(txn.printedMemo ? { printedMemo: txn.printedMemo } : {}),
            ...(txn.memo ? { memo: txn.memo } : {}),
            amount: s4(bank.credit),
            printLater: txn.printStatus === 'queue',
            tagIds: unique,
            lines: debits.map((l, i) => ({ accountId: l.accountId, ...items[i]! })),
          },
        };
      } else {
        td = {
          kind: 'expense',
          draft: {
            payFromAccountId: bank.accountId,
            ...(txn.contactId ? { contactId: txn.contactId } : {}),
            ...(txn.memo ? { memo: txn.memo } : {}),
            tagIds: unique,
            lines: debits.map((l, i) => ({ expenseAccountId: l.accountId, ...items[i]! })),
          },
        };
      }
      break;
    }
    case 'deposit': {
      if (lines.some((l) => l.sourceTransactionId)) {
        return { kind: 'legacy', txnType: txn.txnType, reason: 'DEPOSIT_GROUPING' };
      }
      const [bank, ...rest] = lines;
      if (!bank || bank.lineOrder !== 0 || !pos(bank.debit)) return shape();
      const cashBack = rest.filter((l) => l.lineRole === 'cash_back');
      if (cashBack.length > 1) return shape();
      const plain = rest.filter((l) => l.lineRole !== 'cash_back');
      td = {
        kind: 'deposit',
        draft: {
          depositToAccountId: bank.accountId,
          ...(txn.memo ? { memo: txn.memo } : {}),
          lines: plain.map((l) => ({
            accountId: l.accountId,
            // A debit line on a deposit is a fee taken out of it (Q-84).
            amount: pos(l.debit) ? new Decimal(l.debit).negated().toFixed(4) : s4(l.credit),
            ...optStr(l.description),
            tagId: l.tagId ?? null,
            ...(l.contactId ? { contactId: l.contactId } : {}),
          })),
          ...(cashBack[0]
            ? { cashBack: { accountId: cashBack[0].accountId, amount: s4(cashBack[0].debit), ...(cashBack[0].description ? { memo: cashBack[0].description } : {}) } }
            : {}),
        },
      };
      break;
    }
    case 'transfer': {
      const to = lines.filter((l) => pos(l.debit));
      const from = lines.filter((l) => pos(l.credit));
      if (lines.length !== 2 || to.length !== 1 || from.length !== 1) return shape();
      td = {
        kind: 'transfer',
        draft: {
          fromAccountId: from[0]!.accountId, toAccountId: to[0]!.accountId, amount: s4(from[0]!.credit),
          ...(txn.memo ? { memo: txn.memo } : {}),
        },
      };
      break;
    }
    case 'journal_entry': {
      td = {
        kind: 'journal_entry',
        draft: {
          ...(txn.memo ? { memo: txn.memo } : {}),
          basis: (txn.basis as 'cash' | 'accrual' | 'both' | null) ?? 'both',
          ...(txn.isAdjusting ? { isAdjusting: true } : {}),
          lines: lines.map((l) => ({
            accountId: l.accountId, debit: s4(l.debit), credit: s4(l.credit), ...optStr(l.description),
            tagId: l.tagId ?? null, ...(l.contactId ? { contactId: l.contactId } : {}),
          })),
        },
      };
      break;
    }
    default:
      return { kind: 'legacy', txnType: txn.txnType, reason: 'UNSUPPORTED_TYPE' };
  }
  try {
    validateDraft(td);
  } catch {
    return shape();
  }
  return { kind: 'draft', draft: td, txnType: txn.txnType };
}

/**
 * "Save as Template" from a transaction: refuses a void / deleted source
 * (400 TEMPLATE_SOURCE_INVALID) and a deposit that groups items (400
 * TEMPLATE_DEPOSIT_GROUPING); 404 for another tenant's or company's.
 */
export async function snapshotForCreate(exec: DbOrTx, tenantId: string, companyId: string | null, txnId: string) {
  const txn = await loadSource(exec, tenantId, companyId, txnId);
  if (!txn) throw AppError.notFound('Transaction not found');
  if (txn.status !== 'posted') {
    throw new AppError(400, 'A void or deleted transaction can’t be saved as a template.', 'TEMPLATE_SOURCE_INVALID');
  }
  const snap = await snapshotTransaction(exec, tenantId, txn);
  if (snap.kind === 'legacy' && snap.reason === 'DEPOSIT_GROUPING') throw depositGroupingRefused();
  return { txn, snap };
}
