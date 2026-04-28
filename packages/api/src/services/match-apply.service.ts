// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import type { MatchCandidate } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  bankConnections,
  bankFeedItems,
  transactionClassificationState,
  transactions,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as paymentService from './payment.service.js';
import * as billPaymentService from './bill-payment.service.js';
import * as bankFeedService from './bank-feed.service.js';
import * as ledger from './ledger.service.js';
import * as classificationService from './practice-classification.service.js';

// Phase 3 §3.4 "Apply match" handler. Loads the state row, picks
// the requested candidate index, dispatches by the candidate's
// kind. Each dispatch posts the right kind of transaction via
// the existing services, then links the feed item to the new
// transaction id and stamps the classification state.
//
// All five dispatches end with the bank-feed item moving to
// `categorized` or `matched` status (whichever the underlying
// service chooses) and the state row's transaction_id back-filled
// so the bucket UI can stop showing it under Bucket 1 on the
// next refetch.

export interface ApplyMatchResult {
  appliedTransactionId: string;
  kind: MatchCandidate['kind'];
  appliedAmount: string;
  partial: boolean;
}

export async function applyMatch(
  tenantId: string,
  stateId: string,
  candidateIndex: number,
  userId: string,
): Promise<ApplyMatchResult> {
  const [state] = await db
    .select()
    .from(transactionClassificationState)
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        eq(transactionClassificationState.id, stateId),
      ),
    );
  if (!state) throw AppError.notFound('Classification state not found');

  const candidates = (state.matchCandidates as MatchCandidate[] | null) ?? [];
  const candidate = candidates[candidateIndex];
  if (!candidate) {
    throw AppError.badRequest(`No candidate at index ${candidateIndex}`, 'INVALID_CANDIDATE_INDEX');
  }

  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, state.bankFeedItemId)),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');
  if (item.status !== 'pending') {
    throw AppError.badRequest(
      `Bank feed item is not pending (current status: ${item.status})`,
      'NOT_PENDING',
    );
  }

  // The bank account that the connection's deposits/expenses post
  // through. Same lookup the existing categorize/match paths use.
  const conn = await db.query.bankConnections.findFirst({
    where: eq(bankConnections.id, item.bankConnectionId),
  });
  if (!conn) throw AppError.notFound('Bank connection not found');

  const feedAmount = parseFloat(item.amount);
  const absAmount = Math.abs(feedAmount).toFixed(4);
  const feedAmountAbs = Math.abs(feedAmount);

  switch (candidate.kind) {
    case 'invoice':
      return applyInvoiceMatch(tenantId, candidate, item, conn.accountId, absAmount, feedAmountAbs, userId, state.companyId);
    case 'bill':
      return applyBillMatch(tenantId, candidate, item, conn.accountId, absAmount, feedAmountAbs, userId, state.companyId);
    case 'journal_entry':
      return applyJournalEntryMatch(tenantId, candidate, item.id);
    case 'transfer':
      return applyTransferMatch(tenantId, candidate, item, conn.accountId, absAmount, userId, state.companyId);
    case 'recurring':
      return applyRecurringMatch(tenantId, candidate, item, absAmount, userId);
    default:
      throw AppError.badRequest(`Unknown candidate kind: ${(candidate as { kind: string }).kind}`);
  }
}

async function applyInvoiceMatch(
  tenantId: string,
  candidate: MatchCandidate,
  item: typeof bankFeedItems.$inferSelect,
  bankAccountId: string,
  applyAmount: string,
  applyAmountNum: number,
  userId: string,
  companyId: string | null,
): Promise<ApplyMatchResult> {
  // Need the invoice's customerId for receivePayment.
  const invoice = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, candidate.targetId)),
  });
  if (!invoice || invoice.txnType !== 'invoice') {
    throw AppError.notFound('Invoice candidate no longer exists');
  }
  if (!invoice.contactId) {
    throw AppError.badRequest('Invoice has no customer attached');
  }

  // Apply amount is min(feedAmount, balanceDue) — partial payment
  // when feed is short, paid-in-full when feed equals or exceeds.
  const balanceDue = parseFloat(invoice.balanceDue ?? '0');
  const application = Math.min(applyAmountNum, balanceDue).toFixed(4);
  const partial = applyAmountNum < balanceDue;

  const payment = await paymentService.receivePayment(
    tenantId,
    {
      customerId: invoice.contactId,
      date: item.feedDate,
      amount: applyAmount,
      depositTo: bankAccountId,
      memo: item.description ?? undefined,
      applications: [{ invoiceId: invoice.id, amount: application }],
    },
    userId,
    companyId ?? undefined,
  );

  await bankFeedService.match(tenantId, item.id, payment.id);
  await classificationService.stampTransactionId(tenantId, item.id, payment.id);

  return {
    appliedTransactionId: payment.id,
    kind: 'invoice',
    appliedAmount: application,
    partial,
  };
}

async function applyBillMatch(
  tenantId: string,
  candidate: MatchCandidate,
  item: typeof bankFeedItems.$inferSelect,
  bankAccountId: string,
  applyAmount: string,
  applyAmountNum: number,
  userId: string,
  companyId: string | null,
): Promise<ApplyMatchResult> {
  const bill = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, candidate.targetId)),
  });
  if (!bill || bill.txnType !== 'bill') {
    throw AppError.notFound('Bill candidate no longer exists');
  }
  const balanceDue = parseFloat(bill.balanceDue ?? '0');
  const application = Math.min(applyAmountNum, balanceDue).toFixed(4);
  const partial = applyAmountNum < balanceDue;

  const result = await billPaymentService.payBills(
    tenantId,
    {
      bankAccountId,
      txnDate: item.feedDate,
      method: 'check',
      memo: item.description ?? undefined,
      bills: [{ billId: bill.id, amount: application }],
    },
    userId,
    companyId ?? undefined,
  );

  // payBills returns either a single payment txn or a per-vendor
  // group. The exact return shape varies; we read the id off the
  // first posted payment so the link to the feed item works for
  // the common single-bill case.
  const paymentId =
    (result as { paymentTransactionIds?: string[] }).paymentTransactionIds?.[0] ??
    (result as { transactionId?: string }).transactionId ??
    (Array.isArray(result) ? (result as Array<{ id: string }>)[0]?.id : undefined);
  if (!paymentId) {
    throw AppError.internal('payBills did not return a payment transaction id');
  }

  await bankFeedService.match(tenantId, item.id, paymentId);
  await classificationService.stampTransactionId(tenantId, item.id, paymentId);

  return {
    appliedTransactionId: paymentId,
    kind: 'bill',
    appliedAmount: application,
    partial,
  };
}

async function applyJournalEntryMatch(
  tenantId: string,
  candidate: MatchCandidate,
  feedItemId: string,
): Promise<ApplyMatchResult> {
  // No new transaction; the JE already exists. Just link.
  await bankFeedService.match(tenantId, feedItemId, candidate.targetId);
  await classificationService.stampTransactionId(tenantId, feedItemId, candidate.targetId);
  return {
    appliedTransactionId: candidate.targetId,
    kind: 'journal_entry',
    appliedAmount: candidate.amount,
    partial: false,
  };
}

async function applyTransferMatch(
  tenantId: string,
  candidate: MatchCandidate,
  item: typeof bankFeedItems.$inferSelect,
  bankAccountIdA: string,
  amountStr: string,
  userId: string,
  companyId: string | null,
): Promise<ApplyMatchResult> {
  // The candidate's targetId is the OTHER feed item we paired
  // with. Pull it, verify it's still pending, and post a single
  // transfer txn against both bank accounts.
  const otherItem = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, candidate.targetId)),
  });
  if (!otherItem) throw AppError.notFound('Transfer pair no longer exists');
  if (otherItem.status !== 'pending') {
    throw AppError.badRequest(
      `Transfer pair is not pending (status: ${otherItem.status})`,
      'PAIR_NOT_PENDING',
    );
  }

  const otherConn = await db.query.bankConnections.findFirst({
    where: eq(bankConnections.id, otherItem.bankConnectionId),
  });
  if (!otherConn) throw AppError.notFound('Other bank connection not found');

  // Direction: positive feedAmount = money out → debit the other
  // account, credit this account. Negative feedAmount = money in
  // here → debit this account, credit the other.
  const thisIsExpense = parseFloat(item.amount) > 0;
  const debitAccountId = thisIsExpense ? otherConn.accountId : bankAccountIdA;
  const creditAccountId = thisIsExpense ? bankAccountIdA : otherConn.accountId;

  const txn = await ledger.postTransaction(
    tenantId,
    {
      txnType: 'transfer',
      txnDate: item.feedDate,
      memo: `Transfer: ${item.description ?? otherItem.description ?? ''}`.trim(),
      total: amountStr,
      lines: [
        { accountId: debitAccountId, debit: amountStr, credit: '0' },
        { accountId: creditAccountId, debit: '0', credit: amountStr },
      ],
    },
    userId,
    companyId ?? undefined,
  );

  // Link both feed items.
  await bankFeedService.match(tenantId, item.id, txn.id);
  await bankFeedService.match(tenantId, otherItem.id, txn.id);
  await classificationService.stampTransactionId(tenantId, item.id, txn.id);

  // The other side's classification state may not have an entry
  // yet (it could've been re-ingested separately). Best-effort:
  // try stamping it, ignore not-found.
  try {
    await classificationService.stampTransactionId(tenantId, otherItem.id, txn.id);
  } catch {
    // The other side's state row will be rebuilt on the next
    // categorization sweep with transaction_id already linked.
  }

  return {
    appliedTransactionId: txn.id,
    kind: 'transfer',
    appliedAmount: amountStr,
    partial: false,
  };
}

async function applyRecurringMatch(
  tenantId: string,
  candidate: MatchCandidate,
  item: typeof bankFeedItems.$inferSelect,
  amountStr: string,
  _userId: string,
): Promise<ApplyMatchResult> {
  // Materialize the next occurrence of the schedule. Returns a
  // posted transaction that we then link the feed item to.
  const recurringService = await import('./recurring.service.js');
  const result = await recurringService.postNext(tenantId, candidate.targetId);
  // postNext may return either { transactionId } or the txn row
  // itself; normalize.
  const txnId =
    (result as { transactionId?: string }).transactionId ??
    (result as { id?: string }).id ??
    null;
  if (!txnId) {
    throw AppError.internal('Recurring template materialization did not return a transaction id');
  }

  await bankFeedService.match(tenantId, item.id, txnId);
  await classificationService.stampTransactionId(tenantId, item.id, txnId);
  return {
    appliedTransactionId: txnId,
    kind: 'recurring',
    appliedAmount: amountStr,
    partial: false,
  };
}

// "Not a match" — drop the candidate from the persisted array.
// If the array becomes empty, the next bucket assignment moves
// the row out of Bucket 1.
export async function dropCandidate(
  tenantId: string,
  stateId: string,
  candidateIndex: number,
): Promise<{ remaining: number }> {
  const [state] = await db
    .select()
    .from(transactionClassificationState)
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        eq(transactionClassificationState.id, stateId),
      ),
    );
  if (!state) throw AppError.notFound('Classification state not found');

  const candidates = (state.matchCandidates as MatchCandidate[] | null) ?? [];
  if (candidateIndex < 0 || candidateIndex >= candidates.length) {
    throw AppError.badRequest('Candidate index out of range', 'INVALID_CANDIDATE_INDEX');
  }
  const remaining = candidates.filter((_, i) => i !== candidateIndex);

  // Re-run upsert with the truncated candidate set so bucket
  // assignment recomputes (may demote to needs_review, auto_*,
  // etc. depending on confidence).
  await classificationService.upsertStateForFeedItem(tenantId, state.bankFeedItemId, {
    matchCandidates: remaining,
  });
  return { remaining: remaining.length };
}
