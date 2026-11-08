// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bank feed deposits (U-171, feed-match-post-v1; review S1, owner Q-P26t).
//
// POST /banking/feed/:id/deposit {sourceTransactionIds, feeLines?} records a
// bank deposit for a money-in feed line from payments waiting in Payments
// Clearing, net of processor fees, and matches the line to it, in one
// database transaction.
//
//   - The client sends ids only for the payments. The engine reads each
//     payment's live Payments Clearing amount (locked FOR UPDATE inside the
//     posting) and posts exactly that, so Payments Clearing is cleared to the
//     cent (the deposit links each line to its payment, U-52).
//   - Fee lines {accountId, amount, memo?} (at most 10) are what the
//     processor kept, typed by the owner: amounts ^\d{1,12}(\.\d{1,2})?$ and
//     more than zero. Σpayments − Σfees must equal the bank amount exactly,
//     else 400 FEED_ITEM_MISMATCH {difference = bank − (payments − fees)}.
//   - A fee account must be in the company and must not be a bank or card
//     account, Payments Clearing, A/R or A/P (owner Q-P26w): 400
//     FEE_ACCOUNT_INVALID {accountId}.
//   - A payment that isn't waiting in Payments Clearing (not found in the
//     company, not posted, already in a deposit, nothing left in Clearing) is
//     400 PAYMENT_NOT_PENDING_DEPOSIT {id}; a bounced one 409 PAYMENT_BOUNCED.
//   - One deposit: Dr bank (net), Cr Payments Clearing per payment, Dr each
//     fee account (deposit.service posts a negative line as a debit, Q-84).
//     Dated on the feed line's date (the closing date is checked against it),
//     source bank_feed, source id = the feed item.
//   - Voiding or deleting the deposit releases the payments back to Payments
//     Clearing (deposit-links), fee lines included.

import { and, eq, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type { CreateDepositInput } from '@kis-books/shared';
import { db, type Tx } from '../db/index.js';
import { accounts, bankConnections, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { assertNoBouncedPayments } from './payment.service.js';
import { liveDepositsForSource } from './deposit-links.service.js';
import { clearingAmount, createDepositWithWarnings, systemAccountId } from './deposit.service.js';
import { feedAccountOf, linkFeedItemToEntry, lockOpenFeedItems } from './bank-feed-transfer.service.js';
import { recordAcceptGroup } from './bank-feed-accept-records.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

export const MAX_DEPOSIT_PAYMENTS = 100;
export const MAX_FEE_LINES = 10;

export interface FeeLineInput { accountId: string; amount: string; memo?: string }
export interface FeedDepositInput { sourceTransactionIds: string[]; feeLines?: FeeLineInput[] }

export interface FeedDepositResult {
  transaction: Awaited<ReturnType<typeof createDepositWithWarnings>>['transaction'];
  /** The matched feed item and the deposit's line on its bank account. */
  items: Array<{ feedItemId: string; journalLineId: string }>;
  /** U-169 (feed-undo-v1): POST /banking/feed/undo {undoGroupId} takes it back. */
  undoGroupId: string;
  /** Each payment and the exact amount the deposit took out of Payments Clearing. */
  payments: Array<{ id: string; amount: string }>;
}

/** Account detail types that are bank or card accounts (the cash-position set). */
const BANK_DETAIL_TYPES = ['bank', 'checking', 'savings', 'cash', 'petty_cash'];
const FEE_REFUSED_TAGS = ['payments_clearing', 'accounts_receivable', 'accounts_payable'];

/** A decimal string with at least 2 places, more when the value has them (4 at most in the books). */
function wire(d: DecimalValue): string {
  return d.toFixed(Math.max(2, Math.min(4, d.decimalPlaces())));
}

function notPending(id: string): AppError {
  return new AppError(400, 'This payment isn’t waiting to be deposited (it may be in another deposit, void or not found).',
    'PAYMENT_NOT_PENDING_DEPOSIT', { id });
}

function feeInvalid(accountId: string): AppError {
  return new AppError(400,
    'A fee line needs an expense or other account of this company, not a bank or card account, Payments Clearing, '
      + 'Accounts Receivable or Accounts Payable.',
    'FEE_ACCOUNT_INVALID', { accountId });
}

async function assertFeeAccounts(tx: Tx, tenantId: string, companyId: string | undefined, feeLines: FeeLineInput[]) {
  const ids = [...new Set(feeLines.map((f) => f.accountId))].sort();
  if (ids.length === 0) return;
  const rows = await tx.select({
    id: accounts.id, companyId: accounts.companyId, accountType: accounts.accountType,
    detailType: accounts.detailType, systemTag: accounts.systemTag,
  }).from(accounts).where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, ids)));
  const linked = await tx.select({ accountId: bankConnections.accountId }).from(bankConnections)
    .where(and(eq(bankConnections.tenantId, tenantId), inArray(bankConnections.accountId, ids)));
  const linkedIds = new Set(linked.map((l) => l.accountId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const a = byId.get(id);
    if (!a || (companyId && a.companyId && a.companyId !== companyId)) throw feeInvalid(id);
    const bankOrCard = (a.accountType === 'asset' && BANK_DETAIL_TYPES.includes(a.detailType ?? ''))
      || (a.accountType === 'liability' && a.detailType === 'credit_card')
      || linkedIds.has(id);
    if (bankOrCard || (a.systemTag && FEE_REFUSED_TAGS.includes(a.systemTag))) throw feeInvalid(id);
  }
}

/**
 * Locks the payments (sorted, FOR UPDATE, like deposit.service) and reads
 * each one's live Payments Clearing amount. Any payment not waiting there is
 * PAYMENT_NOT_PENDING_DEPOSIT; a bounced one PAYMENT_BOUNCED.
 */
async function pendingPayments(
  tx: Tx, tenantId: string, companyId: string | undefined, ids: string[],
): Promise<Array<{ id: string; amount: DecimalValue }>> {
  const sorted = [...ids].sort();
  const rows = await tx.select({ id: transactions.id, companyId: transactions.companyId, status: transactions.status })
    .from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, sorted)))
    .orderBy(transactions.id)
    .for('update');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const clearingId = await systemAccountId(tx, tenantId, 'payments_clearing');
  const out: Array<{ id: string; amount: DecimalValue }> = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || (companyId && row.companyId && row.companyId !== companyId) || row.status !== 'posted' || !clearingId) {
      throw notPending(id);
    }
    if ((await liveDepositsForSource(tx, tenantId, id)).length > 0) throw notPending(id);
    const amount = await clearingAmount(tx, tenantId, id, clearingId);
    if (!amount.greaterThan(0)) throw notPending(id);
    out.push({ id, amount });
  }
  await assertNoBouncedPayments(tx, tenantId, sorted);
  return out;
}

export async function postFeedDepositInTx(
  tx: Tx, tenantId: string, companyId: string | undefined, feedItemId: string, input: FeedDepositInput, userId?: string,
): Promise<FeedDepositResult> {
  const feeLines = input.feeLines ?? [];
  const locked = await lockOpenFeedItems(tx, tenantId, companyId, [feedItemId]);
  const item = locked.get(feedItemId)!;
  const signed = new Decimal(item.amount);
  if (!signed.isNegative()) {
    throw new AppError(400, 'Only money coming in can be matched to a deposit.', 'FEED_ITEM_MISMATCH',
      { reason: 'not_money_in' });
  }
  const bank = signed.abs();
  const bankAccount = await feedAccountOf(tx, tenantId, item);

  await assertFeeAccounts(tx, tenantId, companyId, feeLines);
  const payments = await pendingPayments(tx, tenantId, companyId, input.sourceTransactionIds);
  const paid = payments.reduce((s, p) => s.plus(p.amount), new Decimal(0));
  const fees = feeLines.reduce((s, f) => s.plus(f.amount), new Decimal(0));
  const difference = bank.minus(paid.minus(fees));
  if (!difference.isZero()) {
    throw new AppError(400,
      `The payments less the fees (${paid.minus(fees).toFixed(2)}) must equal the bank amount (${bank.toFixed(2)}).`,
      'FEED_ITEM_MISMATCH',
      {
        difference: wire(difference),
        paymentsTotal: paid.toFixed(2), feesTotal: fees.toFixed(2), amount: bank.toFixed(2),
      });
  }

  const clearingId = (await systemAccountId(tx, tenantId, 'payments_clearing'))!;
  const depositInput: CreateDepositInput = {
    txnDate: item.feedDate,
    depositToAccountId: bankAccount.id,
    memo: item.description ?? undefined,
    strictAmounts: true,
    lines: [
      ...payments.map((p) => ({ accountId: clearingId, amount: p.amount.toFixed(4), sourceTransactionId: p.id })),
      ...feeLines.map((f) => ({
        accountId: f.accountId,
        amount: new Decimal(f.amount).neg().toFixed(4),
        description: f.memo ?? undefined,
      })),
    ],
  } as CreateDepositInput;
  const { transaction } = await createDepositWithWarnings(tenantId, depositInput, userId, companyId, tx,
    { source: 'bank_feed', sourceId: item.id });

  const bankLine = transaction.lines.find((l) => l.accountId === bankAccount.id && new Decimal(l.debit ?? '0').greaterThan(0));
  if (!bankLine) throw AppError.internal('Deposit bank line missing');
  await linkFeedItemToEntry(tx, tenantId, item.id, transaction.id, bankLine.id);
  await auditLog(tenantId, 'update', 'bank_feed', item.id,
    { status: item.status, matchedTransactionId: item.matchedTransactionId },
    { status: 'matched', matchedTransactionId: transaction.id, kind: 'deposit', journalLineId: bankLine.id },
    userId, tx);

  // U-169: the accept record Undo works from (deletes the deposit, the payments go back to Payments Clearing).
  const undoGroupId = await recordAcceptGroup(tx, {
    tenantId, companyId, userId, source: 'deposit',
    items: [{ kind: 'deposit', before: item, transactionId: transaction.id, journalLineId: bankLine.id }],
  });

  return {
    transaction,
    items: [{ feedItemId: item.id, journalLineId: bankLine.id }],
    payments: payments.map((p) => ({ id: p.id, amount: wire(p.amount) })),
    undoGroupId,
  };
}

/** POST /banking/feed/:id/deposit: one database transaction (see header). */
export async function postFeedDeposit(
  tenantId: string, companyId: string | undefined, feedItemId: string, input: FeedDepositInput, userId?: string,
): Promise<FeedDepositResult> {
  return db.transaction((tx) => postFeedDepositInTx(tx, tenantId, companyId, feedItemId, input, userId));
}

