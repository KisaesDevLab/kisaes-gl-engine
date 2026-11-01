// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Customer payments (Receive Payment). U-132 (receive-payment-v1,
 * payment-bounce-v1, idempotency-receive-payment-v1):
 *
 *   - Exact amounts (Q-P21g, Q-P21t): every amount is whole cents; an
 *     invoice's payable amount is its cent balance, round2(balance_due) half
 *     away from zero; there is no tolerance. A legacy sub-cent residue stays
 *     in the stored balance (and in A/R, where it already is) and is never
 *     posted; a stored residue whose cent balance is 0.00 is paid.
 *   - One database transaction per write: the ledger post, the application
 *     rows and the invoice headers commit together.
 *   - Lock order on every path: the deposit holding a payment (if any), then
 *     payment rows in id order, then invoices in id order.
 *   - Application rows are never deleted: a void, unapply or edit sets
 *     voided_at; a bounce sets reversed_by_txn_id. Live = both NULL.
 *   - A bounce is one dated returned_payment ('Bounced payment', Q-P21i/k/u):
 *     Cr the account that holds the money, Dr A/R; it reopens what the
 *     payment settled and changes nothing dated earlier.
 */

import { eq, and, sql, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type {
  ReceivePaymentInput, PreviewPaymentInput, BouncePaymentInput, ListPaymentsQuery, PaymentMethod, ApplyPaymentCreditInput,
  JournalLineInput,
} from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { transactions, accounts, paymentApplications, companies, contacts, journalLines } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { auditLog } from '../middleware/audit.js';
import { liveDepositsForSource } from './deposit-links.service.js';
import { getBalances } from './contacts.service.js';
import {
  computePayment, centBalance, round2, dec, money2, discountAvailable, MAX_APPLICATIONS,
  type ComputeInvoice, type ComputeProblem, type ComputeCredit,
} from './payment-compute.js';
import { assertWriteOffAccount, assertSalesDiscountAccount, companySettleSettings } from './write-off-account.js';
import { getOrCreateSystemAccount } from './system-accounts.service.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;
type TxnRow = typeof transactions.$inferSelect;

// ─── Shared helpers ─────────────────────────────────────────────────

async function systemAccountId(executor: DbOrTx, tenantId: string, tag: string): Promise<string | null> {
  const [row] = await executor.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)))
    .limit(1);
  return row?.id ?? null;
}

async function arAccountId(executor: DbOrTx, tenantId: string): Promise<string> {
  const id = await systemAccountId(executor, tenantId, 'accounts_receivable');
  if (!id) throw AppError.internal('AR account not found');
  return id;
}

/** Whole cents, for direct service callers (the route schemas check the same). */
function wholeCents(value: string, field: string): DecimalValue {
  let d: DecimalValue;
  try { d = dec(value); } catch { throw AppError.badRequest(`${field} must be a decimal amount`, 'VALIDATION_ERROR'); }
  if (!d.isFinite() || d.isNegative() || !d.equals(round2(d))) {
    throw AppError.badRequest(`${field} must be an amount with at most 2 decimal places`, 'VALIDATION_ERROR');
  }
  return d;
}

/** GET /payments/deposits-on-hand: the customer must be of this company (404). */
export async function assertCustomerInCompany(tenantId: string, customerId: string, companyId?: string) {
  await assertCustomer(db, tenantId, customerId, companyId);
}

/** The customer, in the tenant and the request's company: else 404. */
async function assertCustomer(executor: DbOrTx, tenantId: string, customerId: string, companyId?: string) {
  const [row] = await executor.select({ id: contacts.id, companyId: contacts.companyId }).from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, customerId))).limit(1);
  if (!row || ledger.inOtherCompany(row, companyId)) throw AppError.notFound('Customer not found');
}

/**
 * The account a payment is deposited to: an asset of this company, not A/R
 * and not Customer Deposits. 400 DEPOSIT_ACCOUNT_INVALID.
 */
async function assertDepositAccount(executor: DbOrTx, tenantId: string, accountId: string, companyId?: string) {
  const [acct] = await executor.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  if (!acct || ledger.inOtherCompany(acct, companyId) || acct.accountType !== 'asset'
    || acct.systemTag === 'accounts_receivable' || acct.systemTag === 'customer_deposits'
    || acct.detailType === 'accounts_receivable' || acct.detailType === 'accounts_payable') {
    throw AppError.badRequest(
      'Choose a bank account or Payments Clearing to deposit the payment to.',
      'DEPOSIT_ACCOUNT_INVALID',
      { accountId },
    );
  }
}

/** Invoices locked FOR UPDATE in id order (the lock order). */
async function lockInvoices(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, TxnRow>> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return new Map();
  const rows = await tx.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, unique)))
    .orderBy(transactions.id)
    .for('update');
  return new Map(rows.map((r) => [r.id, r]));
}

/** Payments locked FOR UPDATE in id order. */
async function lockPayments(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, TxnRow>> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return new Map();
  const rows = await tx.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, unique)))
    .orderBy(transactions.id)
    .for('update');
  return new Map(rows.map((r) => [r.id, r]));
}

/** 409 STALE: a payment's links changed while the request waited for its locks (E-B1). */
function scopeChanged(paymentId: string): AppError {
  return AppError.conflict(
    'This payment changed while it was being saved (it was deposited, applied or voided elsewhere). Reload it and try again.',
    'STALE',
    { paymentId },
  );
}

/** What a write on a payment must hold: the posted deposits holding it, then the payment rows it touches. */
interface PaymentScope { depositIds: string[]; paymentIds: string[] }

/** Read on the caller's executor: before the locks to know what to lock, and again under them. */
async function paymentScope(executor: DbOrTx, tenantId: string, paymentId: string): Promise<PaymentScope> {
  const deposits = await liveDepositsForSource(executor, tenantId, paymentId);
  // U-133: the payments its credit was applied inside (their void restores
  // those rows) and the sources of the credits applied inside it.
  const links = await executor.execute(sql`
    SELECT pa.applied_in_txn_id AS id FROM payment_applications pa
    WHERE pa.tenant_id = ${tenantId} AND pa.payment_id = ${paymentId} AND pa.applied_in_txn_id IS NOT NULL
      AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL
    UNION
    SELECT pa.payment_id FROM payment_applications pa
    WHERE pa.tenant_id = ${tenantId} AND pa.applied_in_txn_id = ${paymentId}
      AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL
    -- U-135: the held deposit a draw is made on; the draws made inside it
    -- and their held deposits; the draws on it when it is a held deposit.
    UNION
    SELECT p.from_deposit_id FROM transactions p
    WHERE p.tenant_id = ${tenantId} AND p.id = ${paymentId} AND p.from_deposit_id IS NOT NULL
    UNION
    SELECT d.id FROM transactions d
    WHERE d.tenant_id = ${tenantId} AND d.txn_type = 'customer_payment' AND d.status = 'posted'
      AND (d.source_txn_id = ${paymentId} OR d.from_deposit_id = ${paymentId})
    UNION
    SELECT d.from_deposit_id FROM transactions d
    WHERE d.tenant_id = ${tenantId} AND d.txn_type = 'customer_payment' AND d.status = 'posted'
      AND d.source_txn_id = ${paymentId} AND d.from_deposit_id IS NOT NULL
  `);
  const ids = new Set([paymentId, ...(links.rows as Array<{ id: string }>).map((r) => String(r.id))]);
  return { depositIds: [...new Set(deposits.map((d) => d.depositId))].sort(), paymentIds: [...ids].sort() };
}

interface LockedScope {
  /** The payment, locked; undefined when it doesn't exist in the tenant (the caller answers 404). */
  payment: TxnRow | undefined;
  /** The posted deposit holding it now, locked. */
  deposit: TxnRow | undefined;
  /** Every payment row locked (the payment and its scope). */
  locked: Map<string, TxnRow>;
}

/**
 * Locks a payment and what it is linked to in the one lock order (E-B1):
 * the deposits holding it (id order), then every payment row of its scope
 * plus `extra` in one id-ordered batch; invoices come after, from the
 * caller. The scope is read again under the locks: a deposit or payment row
 * that appeared meanwhile and isn't locked is 409 STALE; one that went away
 * (a deposit voided while this waited) is simply no longer in the scope.
 */
async function lockPaymentScope(tx: Tx, tenantId: string, paymentId: string, extra: string[] = []): Promise<LockedScope> {
  const before = await paymentScope(tx, tenantId, paymentId);
  const deposits = await lockPayments(tx, tenantId, before.depositIds);
  const locked = await lockPayments(tx, tenantId, [...before.paymentIds, ...extra]);
  const payment = locked.get(paymentId);
  if (!payment) return { payment: undefined, deposit: undefined, locked };
  const after = await paymentScope(tx, tenantId, paymentId);
  if (after.depositIds.some((id) => !deposits.has(id)) || after.paymentIds.some((id) => !locked.has(id))) {
    throw scopeChanged(paymentId);
  }
  const deposit = after.depositIds.map((id) => deposits.get(id)).find((d) => d?.status === 'posted');
  return { payment, deposit, locked };
}

/**
 * Locks the scope of a payment (or of the payment a bounce took back)
 * before voidTransactionInTx locks the row itself, so a void takes its
 * locks in the same order as bounce, unapply and edit (E-B1).
 */
export async function lockForVoidInTx(tx: Tx, tenantId: string, txn: { id: string; txnType: string; sourceTxnId: string | null }): Promise<void> {
  if (txn.txnType === 'customer_payment') await lockPaymentScope(tx, tenantId, txn.id);
  else if (txn.txnType === 'returned_payment' && txn.sourceTxnId) {
    // The rows the bounce reversed come back live: lock the payments they
    // belong to and were applied inside (U-133) with the bounced payment.
    const res = await tx.execute(sql`
      SELECT pa.payment_id AS id FROM payment_applications pa WHERE pa.tenant_id = ${tenantId} AND pa.reversed_by_txn_id = ${txn.id}
      UNION
      SELECT pa.applied_in_txn_id FROM payment_applications pa
      WHERE pa.tenant_id = ${tenantId} AND pa.reversed_by_txn_id = ${txn.id} AND pa.applied_in_txn_id IS NOT NULL
    `);
    await lockPaymentScope(tx, tenantId, txn.sourceTxnId, (res.rows as Array<{ id: string }>).map((r) => String(r.id)));
  }
}

/**
 * Retires a live application row: voided_at (void, unapply, edit) or
 * reversed_by_txn_id (bounce), only while it is live. False when another
 * writer retired it first; its invoice must not move then (E-B1).
 */
async function retireApplication(
  tx: Tx, tenantId: string, id: string, set: { voidedAt: Date } | { reversedByTxnId: string },
): Promise<boolean> {
  const rows = await tx.update(paymentApplications).set(set)
    .where(and(
      eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.id, id),
      sql`${paymentApplications.voidedAt} IS NULL AND ${paymentApplications.reversedByTxnId} IS NULL`,
    ))
    .returning({ id: paymentApplications.id });
  return rows.length > 0;
}

/** The cent balance a payment may still take: 0.00 for a paid or void invoice. */
function payableCents(inv: TxnRow): DecimalValue {
  if (inv.status !== 'posted' || inv.invoiceStatus === 'void' || inv.invoiceStatus === 'paid') return new Decimal(0);
  return Decimal.max(centBalance(inv.balanceDue ?? '0'), 0);
}

async function hasSendEvent(executor: DbOrTx, tenantId: string, invoiceId: string): Promise<boolean> {
  const res = await executor.execute(sql`
    SELECT 1 FROM document_send_events WHERE tenant_id = ${tenantId} AND transaction_id = ${invoiceId} LIMIT 1
  `);
  return (res.rows as unknown[]).length > 0;
}

/**
 * Moves an invoice's amount paid by `delta` (negative restores) on a locked
 * row and recomputes its status (§2.1): cent balance 0.00 or less -> paid;
 * else partial while anything is applied; else viewed / sent when it was
 * viewed or sent; else draft. balance_due = total - amount_paid, exactly.
 */
async function moveInvoicePaid(tx: Tx, tenantId: string, inv: TxnRow, delta: DecimalValue): Promise<TxnRow> {
  const newPaid = dec(inv.amountPaid).plus(delta);
  const newBalance = dec(inv.total).minus(newPaid);
  let status: string;
  if (!centBalance(newBalance.toFixed(4)).greaterThan(0)) status = 'paid';
  else if (newPaid.greaterThan(0)) status = 'partial';
  else if (inv.viewedAt) status = 'viewed';
  else if (inv.sentAt || await hasSendEvent(tx, tenantId, inv.id)) status = 'sent';
  else status = 'draft';
  const paidAt = status === 'paid' ? (inv.invoiceStatus === 'paid' && inv.paidAt ? inv.paidAt : new Date()) : null;
  const [row] = await tx.update(transactions).set({
    amountPaid: newPaid.toFixed(4),
    balanceDue: newBalance.toFixed(4),
    invoiceStatus: status,
    paidAt,
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, inv.id))).returning();
  return row!;
}

interface AppRow {
  id: string;
  paymentId: string;
  invoiceId: string;
  amount: string;
  writeOffAmount: string;
  writeOffAccountId: string | null;
  discountAmount: string;
  discountAccountId: string | null;
  appliedDate: string | null;
  appliedInTxnId: string | null;
  voidedAt: Date | null;
  reversedByTxnId: string | null;
}

const appColumns = {
  id: paymentApplications.id, paymentId: paymentApplications.paymentId, invoiceId: paymentApplications.invoiceId,
  amount: paymentApplications.amount, writeOffAmount: paymentApplications.writeOffAmount,
  writeOffAccountId: paymentApplications.writeOffAccountId, discountAmount: paymentApplications.discountAmount,
  discountAccountId: paymentApplications.discountAccountId, appliedDate: paymentApplications.appliedDate,
  appliedInTxnId: paymentApplications.appliedInTxnId, voidedAt: paymentApplications.voidedAt,
  reversedByTxnId: paymentApplications.reversedByTxnId,
};

/** What a row takes off its invoice: cash (or credit) + discount + write-off. */
const settledBy = (a: Pick<AppRow, 'amount' | 'discountAmount' | 'writeOffAmount'>) =>
  dec(a.amount).plus(a.discountAmount ?? '0').plus(a.writeOffAmount ?? '0');

/** Live rows of a payment: its own applications and its credit applied later (U-133). */
async function liveApplications(executor: DbOrTx, tenantId: string, paymentId: string): Promise<AppRow[]> {
  return executor.select(appColumns).from(paymentApplications)
    .where(and(
      eq(paymentApplications.tenantId, tenantId),
      eq(paymentApplications.paymentId, paymentId),
      sql`${paymentApplications.voidedAt} IS NULL AND ${paymentApplications.reversedByTxnId} IS NULL`,
    ))
    .orderBy(paymentApplications.invoiceId, paymentApplications.id);
}

/** Live credit rows applied inside a payment (other payments' credits; U-133). */
async function creditsAppliedIn(executor: DbOrTx, tenantId: string, paymentId: string): Promise<AppRow[]> {
  return executor.select(appColumns).from(paymentApplications)
    .where(and(
      eq(paymentApplications.tenantId, tenantId),
      eq(paymentApplications.appliedInTxnId, paymentId),
      sql`${paymentApplications.voidedAt} IS NULL AND ${paymentApplications.reversedByTxnId} IS NULL`,
    ))
    .orderBy(paymentApplications.invoiceId, paymentApplications.id);
}

/** Posted refunds drawn on a payment's credit (U-133). */
async function liveRefundTotal(executor: DbOrTx, tenantId: string, paymentId: string): Promise<DecimalValue> {
  const res = await executor.execute(sql`
    SELECT COALESCE(SUM(r.total), 0)::text AS total FROM transactions r
    WHERE r.tenant_id = ${tenantId} AND r.source_payment_id = ${paymentId}
      AND r.txn_type = 'customer_refund' AND r.status = 'posted'
  `);
  return dec((res.rows as Array<{ total: string }>)[0]?.total ?? '0');
}

/**
 * What is left of a payment's credit (U-133): amount - live applications
 * (its own and credits applied later) - live refunds; 0.00 for a void or
 * bounced payment. Read on the caller's executor (under the row lock when
 * it writes).
 */
export async function creditRemaining(executor: DbOrTx, tenantId: string, p: TxnRow): Promise<DecimalValue> {
  if (p.status !== 'posted' || await liveBounce(executor, tenantId, p.id)) return new Decimal(0);
  if (p.holdsDeposit) return depositRemaining(executor, tenantId, p);
  const applied = (await liveApplications(executor, tenantId, p.id)).reduce((s, a) => s.plus(a.amount), new Decimal(0));
  return Decimal.max(dec(p.total).minus(applied).minus(await liveRefundTotal(executor, tenantId, p.id)), 0);
}

/** Posted draws on a held deposit (U-135). */
async function liveDraws(executor: DbOrTx, tenantId: string, depositId: string): Promise<TxnRow[]> {
  return executor.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.fromDepositId, depositId), eq(transactions.status, 'posted')))
    .orderBy(transactions.id);
}

/**
 * What is left of a held deposit (U-135): amount - posted draws - live
 * refunds; 0.00 for a void or bounced deposit.
 */
export async function depositRemaining(executor: DbOrTx, tenantId: string, p: TxnRow): Promise<DecimalValue> {
  if (!p.holdsDeposit || p.status !== 'posted' || await liveBounce(executor, tenantId, p.id)) return new Decimal(0);
  const drawn = (await liveDraws(executor, tenantId, p.id)).reduce((t, d) => t.plus(d.total ?? '0'), new Decimal(0));
  return Decimal.max(dec(p.total).minus(drawn).minus(await liveRefundTotal(executor, tenantId, p.id)), 0);
}

/** Customer Deposits, created in the caller's transaction when missing (review nit: a rollback creates nothing). */
async function customerDepositsAccount(tx: Tx, tenantId: string, companyId?: string | null): Promise<string> {
  return getOrCreateSystemAccount(tenantId, 'customer_deposits', companyId ?? undefined, undefined, tx);
}

function depositApplied(paymentId: string): AppError {
  return AppError.conflict(
    'Part of this deposit was applied to invoices. Void those first.',
    'DEPOSIT_APPLIED',
    { paymentId },
  );
}

function paymentRefunded(paymentId: string): AppError {
  return AppError.conflict(
    'Part of this payment’s credit was refunded. Void the refund first.',
    'PAYMENT_REFUNDED',
    { paymentId },
  );
}

/** The posted returned_payment of a payment, if one is live. */
async function liveBounce(executor: DbOrTx, tenantId: string, paymentId: string): Promise<TxnRow | null> {
  const [row] = await executor.select().from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.sourceTxnId, paymentId),
      eq(transactions.txnType, 'returned_payment'),
      eq(transactions.status, 'posted'),
    )).limit(1);
  return row ?? null;
}

function paymentBounced(paymentId: string): AppError {
  return AppError.conflict(
    'This payment bounced, so it can’t be changed. Void the bounced-payment entry first.',
    'PAYMENT_BOUNCED',
    { paymentId },
  );
}

/** 409 PAYMENT_BOUNCED when any of these payments has a live bounce (deposit void / edit / source). */
export async function assertNoBouncedPayments(executor: DbOrTx, tenantId: string, paymentIds: string[]): Promise<void> {
  if (paymentIds.length === 0) return;
  const res = await executor.execute(sql`
    SELECT r.source_txn_id FROM transactions r
    WHERE r.tenant_id = ${tenantId} AND r.txn_type = 'returned_payment' AND r.status = 'posted'
      AND r.source_txn_id IN (${sql.join(paymentIds.map((id) => sql`${id}::uuid`), sql`, `)})
    LIMIT 1
  `);
  const hit = (res.rows as Array<{ source_txn_id: string }>)[0];
  if (hit) throw paymentBounced(hit.source_txn_id);
}

/** A deposit's sources with a live bounce block voiding or editing it (U-132). */
export async function assertDepositSourcesNotBounced(executor: DbOrTx, tenantId: string, depositId: string): Promise<void> {
  const res = await executor.execute(sql`
    SELECT dl.source_transaction_id AS id FROM deposit_lines dl
    WHERE dl.deposit_id = ${depositId}
      AND EXISTS (SELECT 1 FROM transactions d WHERE d.id = ${depositId} AND d.tenant_id = ${tenantId})
  `);
  await assertNoBouncedPayments(executor, tenantId, (res.rows as Array<{ id: string }>).map((r) => r.id));
}

function balanceChanged(inv: TxnRow): AppError {
  return AppError.conflict(
    `Invoice ${inv.txnNumber || inv.id} changed since you opened it. Reload the open invoices and try again.`,
    'INVOICE_BALANCE_CHANGED',
    { invoiceId: inv.id, balanceDue: money2(centBalance(inv.balanceDue ?? '0')), balanceDueExact: dec(inv.balanceDue).toFixed(4) },
  );
}

// ─── Receive ────────────────────────────────────────────────────────

export interface ReceiveApplication {
  invoiceId: string;
  amount: string;
  expectedBalanceDue?: string;
  /** U-134 */
  discountAmount?: string;
  /** U-133 */
  writeOffAmount?: string;
}

export interface ReceiveCreditApplication { sourcePaymentId: string; invoiceId: string; amount: string; expectedBalanceDue?: string }

export interface ReceiveOptions {
  /** Kept for callers (Stripe, bank feed, recordPayment); applications may be empty since U-133. */
  allowUnapplied?: boolean;
  /** POST /invoices/:id/payment: stamp applied_to_invoice_id as before. */
  appliedToInvoiceId?: string;
}

interface ParsedApp { invoiceId: string; amount: DecimalValue; discount: DecimalValue; writeOff: DecimalValue; expectedBalanceDue?: string }
interface ParsedCredit { sourcePaymentId: string; invoiceId: string; amount: DecimalValue; expectedBalanceDue?: string }

interface Parsed {
  amount: DecimalValue;
  cash: DecimalValue;
  discounts: DecimalValue;
  writeOffs: DecimalValue;
  apps: ParsedApp[];
  credits: ParsedCredit[];
}

/**
 * The amounts of a receive / edit body, checked without the database:
 * whole cents, at most 1,000 rows, no invoice twice, cash applied <= the
 * amount (the rest stays an A/R credit, U-133), an amount of 0.00 only with
 * a discount or write-off (no deposit line then).
 */
function parseSettlement(input: ReceivePaymentInput): Parsed {
  const amount = wholeCents(input.amount, 'amount');
  const rawApps = (input.applications ?? []) as ReceiveApplication[];
  const rawCredits = (input.creditApplications ?? []) as ReceiveCreditApplication[];
  if (rawApps.length + rawCredits.length > MAX_APPLICATIONS) {
    throw AppError.badRequest(`At most ${MAX_APPLICATIONS} invoices per payment.`, 'TOO_MANY_APPLICATIONS', { max: MAX_APPLICATIONS });
  }
  const seen = new Set<string>();
  const apps = rawApps.map((a) => {
    if (seen.has(a.invoiceId)) throw AppError.badRequest('An invoice is listed twice.', 'VALIDATION_ERROR', { invoiceId: a.invoiceId });
    seen.add(a.invoiceId);
    return {
      invoiceId: a.invoiceId,
      amount: wholeCents(a.amount, 'applications[].amount'),
      discount: wholeCents(a.discountAmount ?? '0', 'applications[].discountAmount'),
      writeOff: wholeCents(a.writeOffAmount ?? '0', 'applications[].writeOffAmount'),
      expectedBalanceDue: a.expectedBalanceDue,
    };
  });
  const credits = rawCredits.map((c) => ({
    sourcePaymentId: c.sourcePaymentId, invoiceId: c.invoiceId,
    amount: wholeCents(c.amount, 'creditApplications[].amount'), expectedBalanceDue: c.expectedBalanceDue,
  }));
  const sum = (xs: DecimalValue[]) => xs.reduce((t, x) => t.plus(x), new Decimal(0));
  const cash = sum(apps.map((a) => a.amount));
  const discounts = sum(apps.map((a) => a.discount));
  const writeOffs = sum(apps.map((a) => a.writeOff));
  if (cash.greaterThan(amount)) {
    throw AppError.badRequest(
      `The amounts applied (${money2(cash)}) are more than the payment (${money2(amount)}).`,
      'APPLICATIONS_EXCEED_AMOUNT',
      { applied: money2(cash), amount: money2(amount) },
    );
  }
  if (!amount.greaterThan(0) && !discounts.greaterThan(0) && !writeOffs.greaterThan(0)) {
    throw AppError.badRequest('Enter the amount received.', 'AMOUNT_REQUIRED');
  }
  return { amount, cash, discounts, writeOffs, apps, credits };
}

interface SettleAccounts { writeOffAccountId: string | null; discountAccountId: string | null }

/** The write-off and discount accounts (request, else company setting); checked only when used. */
async function resolveSettleAccounts(
  tx: Tx, tenantId: string, companyId: string | undefined, input: ReceivePaymentInput, parsed: Parsed,
): Promise<SettleAccounts> {
  const settings = await companySettleSettings(tx, tenantId, companyId);
  let writeOffAccountId: string | null = null;
  let discountAccountId: string | null = null;
  if (parsed.writeOffs.greaterThan(0)) {
    writeOffAccountId = input.writeOffAccountId ?? settings.writeOffAccountId;
    if (!writeOffAccountId) {
      throw AppError.badRequest('Choose the account for the write-off, or set one in Preferences.', 'WRITE_OFF_ACCOUNT_REQUIRED');
    }
    await assertWriteOffAccount(tx, tenantId, companyId, writeOffAccountId, input.depositTo);
  }
  if (parsed.discounts.greaterThan(0)) {
    discountAccountId = input.discountAccountId ?? settings.salesDiscountAccountId;
    if (!discountAccountId) {
      throw AppError.badRequest('Choose the account for the discount, or set one in Preferences.', 'DISCOUNT_ACCOUNT_REQUIRED');
    }
    await assertSalesDiscountAccount(tx, tenantId, companyId, discountAccountId, input.depositTo);
  }
  return { writeOffAccountId, discountAccountId };
}

/**
 * Credits applied in a payment (U-133), on locked source payments: a posted
 * customer payment of the same client and company, not bounced (409
 * PAYMENT_BOUNCED), each source's rows within what is left of it (409
 * CREDIT_NOT_AVAILABLE {sourcePaymentId, remaining}).
 */
async function validateSources(
  tx: Tx, tenantId: string, sources: Map<string, TxnRow>, credits: ParsedCredit[], customerId: string, companyId: string | undefined,
): Promise<void> {
  const want = new Map<string, DecimalValue>();
  for (const c of credits) want.set(c.sourcePaymentId, (want.get(c.sourcePaymentId) ?? new Decimal(0)).plus(c.amount));
  for (const [id, total] of want) {
    const src = sources.get(id);
    if (!src || src.txnType !== 'customer_payment' || src.status === 'deleted' || ledger.inOtherCompany(src, companyId)) {
      throw AppError.notFound('Credit not found');
    }
    if (src.contactId !== customerId) {
      throw AppError.badRequest('That credit belongs to another client.', 'CREDIT_NOT_FOR_CUSTOMER', { sourcePaymentId: id });
    }
    if (await liveBounce(tx, tenantId, id)) throw paymentBounced(id);
    if (src.fromDepositId) throw AppError.notFound('Credit not found');
    const remaining = await creditRemaining(tx, tenantId, src);
    if (total.greaterThan(remaining)) {
      throw AppError.conflict(
        `Only ${money2(remaining)} of that ${src.holdsDeposit ? 'deposit' : 'credit'} is left.`,
        src.holdsDeposit ? 'DEPOSIT_NOT_AVAILABLE' : 'CREDIT_NOT_AVAILABLE',
        { sourcePaymentId: id, remaining: money2(remaining) },
      );
    }
  }
}

interface ValidatedApplication { inv: TxnRow; amount: DecimalValue; discount: DecimalValue; writeOff: DecimalValue }
interface ValidatedCredit { sourcePaymentId: string; inv: TxnRow; amount: DecimalValue }

/** One locked invoice of this client and company, its stored balance as expected. */
function checkInvoice(inv: TxnRow | undefined, invoiceId: string, expected: string | undefined, customerId: string, companyId: string | undefined): TxnRow {
  if (!inv || inv.txnType !== 'invoice' || inv.status === 'deleted' || ledger.inOtherCompany(inv, companyId)) {
    throw AppError.notFound(`Invoice ${invoiceId} not found`);
  }
  if (inv.contactId !== customerId) {
    throw AppError.badRequest('That invoice belongs to another client.', 'INVOICE_NOT_FOR_CUSTOMER', { invoiceId: inv.id });
  }
  if (expected !== undefined && !dec(expected).equals(dec(inv.balanceDue))) throw balanceChanged(inv);
  return inv;
}

/** Applications and credits against locked invoices: cash + discount + write-off + credits <= the cent balance, exactly. */
function validateInvoices(
  parsed: Parsed, invoices: Map<string, TxnRow>, customerId: string, companyId: string | undefined,
): { apps: ValidatedApplication[]; credits: ValidatedCredit[] } {
  const settled = new Map<string, DecimalValue>();
  const add = (id: string, x: DecimalValue) => settled.set(id, (settled.get(id) ?? new Decimal(0)).plus(x));
  const apps: ValidatedApplication[] = [];
  const credits: ValidatedCredit[] = [];
  for (const a of parsed.apps) {
    const inv = checkInvoice(invoices.get(a.invoiceId), a.invoiceId, a.expectedBalanceDue, customerId, companyId);
    const total = a.amount.plus(a.discount).plus(a.writeOff);
    add(inv.id, total);
    if (total.greaterThan(0)) apps.push({ inv, amount: a.amount, discount: a.discount, writeOff: a.writeOff });
  }
  for (const c of parsed.credits) {
    const inv = checkInvoice(invoices.get(c.invoiceId), c.invoiceId, c.expectedBalanceDue, customerId, companyId);
    add(inv.id, c.amount);
    if (c.amount.greaterThan(0)) credits.push({ sourcePaymentId: c.sourcePaymentId, inv, amount: c.amount });
  }
  for (const [id, total] of settled) {
    const inv = invoices.get(id)!;
    const cap = payableCents(inv);
    if (total.greaterThan(cap)) {
      throw AppError.badRequest(
        `The amounts on invoice ${inv.txnNumber || inv.id} (${money2(total)}) are more than its balance due (${money2(cap)}).`,
        'OVERAPPLIED',
        { invoiceId: inv.id, balanceDue: money2(cap) },
      );
    }
  }
  return { apps, credits };
}

/** Dr depositTo amount (none at 0.00), Dr write-off, Dr discount, Cr A/R the sum. */
function paymentLines(
  depositTo: string, ar: string, customerId: string, parsed: Parsed, accounts: SettleAccounts,
): JournalLineInput[] {
  const lines: JournalLineInput[] = [];
  if (parsed.amount.greaterThan(0)) lines.push({ accountId: depositTo, debit: parsed.amount.toFixed(4), credit: '0' });
  if (parsed.writeOffs.greaterThan(0)) lines.push({ accountId: accounts.writeOffAccountId!, debit: parsed.writeOffs.toFixed(4), credit: '0' });
  if (parsed.discounts.greaterThan(0)) lines.push({ accountId: accounts.discountAccountId!, debit: parsed.discounts.toFixed(4), credit: '0' });
  const arCredit = parsed.amount.plus(parsed.writeOffs).plus(parsed.discounts);
  lines.push({ accountId: ar, debit: '0', credit: arCredit.toFixed(4), contactId: customerId });
  return lines;
}

async function writeSettlement(
  tx: Tx, tenantId: string, companyId: string | undefined, paymentId: string, date: string,
  v: { apps: ValidatedApplication[]; credits: ValidatedCredit[] }, accounts: SettleAccounts,
  sources: Map<string, TxnRow> = new Map(), userId?: string,
): Promise<void> {
  // Draws on held deposits (U-135): one customer payment per deposit,
  // Dr Customer Deposits / Cr A/R, carrying those applications; posted
  // inside this payment (source_txn_id), voided and replayed with it.
  const byDeposit = new Map<string, ValidatedCredit[]>();
  for (const c of v.credits) {
    if (sources.get(c.sourcePaymentId)?.holdsDeposit) byDeposit.set(c.sourcePaymentId, [...(byDeposit.get(c.sourcePaymentId) ?? []), c]);
  }
  for (const [depositId, rows] of byDeposit) {
    await postDraw(tx, tenantId, sources.get(depositId)!, date, rows.map((r) => ({ inv: r.inv, amount: r.amount })), paymentId, userId, companyId);
  }
  v = { apps: v.apps, credits: v.credits.filter((c) => !byDeposit.has(c.sourcePaymentId)) };
  for (const a of v.apps) {
    await tx.insert(paymentApplications).values({
      tenantId, companyId: companyId ?? a.inv.companyId ?? null, paymentId, invoiceId: a.inv.id, amount: a.amount.toFixed(4),
      writeOffAmount: a.writeOff.toFixed(4), writeOffAccountId: a.writeOff.greaterThan(0) ? accounts.writeOffAccountId : null,
      discountAmount: a.discount.toFixed(4), discountAccountId: a.discount.greaterThan(0) ? accounts.discountAccountId : null,
    });
    Object.assign(a.inv, await moveInvoicePaid(tx, tenantId, a.inv, a.amount.plus(a.discount).plus(a.writeOff)));
  }
  const touched = new Set<string>();
  for (const c of v.credits) {
    await tx.insert(paymentApplications).values({
      tenantId, companyId: companyId ?? c.inv.companyId ?? null, paymentId: c.sourcePaymentId, invoiceId: c.inv.id,
      amount: c.amount.toFixed(4), appliedDate: date, appliedInTxnId: paymentId,
    });
    Object.assign(c.inv, await moveInvoicePaid(tx, tenantId, c.inv, c.amount));
    touched.add(c.sourcePaymentId);
  }
  for (const id of touched) {
    await tx.update(transactions).set({ updatedAt: new Date() }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id)));
  }
}

/**
 * A draw on a held deposit (U-135): Dr Customer Deposits / Cr A/R for the
 * sum, with the applications; insideOf = the payment it was made inside.
 */
async function postDraw(
  tx: Tx, tenantId: string, deposit: TxnRow, date: string, rows: Array<{ inv: TxnRow; amount: DecimalValue }>,
  insideOf: string | null, userId?: string, companyId?: string,
): Promise<string> {
  const cd = await customerDepositsAccount(tx, tenantId, companyId ?? deposit.companyId);
  const ar = await arAccountId(tx, tenantId);
  const total = rows.reduce((t, r) => t.plus(r.amount), new Decimal(0)).toFixed(4);
  const draw = await ledger.postTransaction(tenantId, {
    txnType: 'customer_payment',
    txnDate: date,
    contactId: deposit.contactId ?? undefined,
    memo: `Applied from deposit${deposit.referenceNumber ? ` ${deposit.referenceNumber}` : ''}`,
    total,
    fromDepositId: deposit.id,
    ...(insideOf ? { sourceTxnId: insideOf } : {}),
    lines: [
      { accountId: cd, debit: total, credit: '0' },
      { accountId: ar, debit: '0', credit: total, contactId: deposit.contactId ?? undefined },
    ],
  }, userId, companyId ?? deposit.companyId ?? undefined, tx);
  for (const r of rows) {
    await tx.insert(paymentApplications).values({
      tenantId, companyId: companyId ?? r.inv.companyId ?? null, paymentId: draw.id, invoiceId: r.inv.id, amount: r.amount.toFixed(4),
    });
    Object.assign(r.inv, await moveInvoicePaid(tx, tenantId, r.inv, r.amount));
  }
  await tx.update(transactions).set({ updatedAt: new Date() })
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, deposit.id)));
  return draw.id;
}

/**
 * Receives a payment in the caller's database transaction: validation, the
 * ledger post (Dr depositTo, Dr write-off, Dr discount, Cr A/R) and the
 * applications and credits, atomically, in the lock order (credit sources,
 * then invoices). Cash applied <= amount; the rest stays an A/R credit.
 */
export async function receivePaymentInTx(
  tx: Tx,
  tenantId: string,
  input: ReceivePaymentInput,
  userId?: string,
  companyId?: string,
  opts: ReceiveOptions = {},
) {
  const parsed = parseSettlement(input);
  await assertCustomer(tx, tenantId, input.customerId, companyId);
  await assertDepositAccount(tx, tenantId, input.depositTo, companyId);
  if (input.holdAsDeposit) return receiveDepositInTx(tx, tenantId, input, parsed, userId, companyId);
  const accounts = await resolveSettleAccounts(tx, tenantId, companyId, input, parsed);
  const ar = await arAccountId(tx, tenantId);

  const sources = await lockPayments(tx, tenantId, parsed.credits.map((c) => c.sourcePaymentId));
  await validateSources(tx, tenantId, sources, parsed.credits, input.customerId, companyId);
  const invoices = await lockInvoices(tx, tenantId, [...parsed.apps.map((a) => a.invoiceId), ...parsed.credits.map((c) => c.invoiceId)]);
  const valid = validateInvoices(parsed, invoices, input.customerId, companyId);

  const payment = await ledger.postTransaction(tenantId, {
    txnType: 'customer_payment',
    txnDate: input.date,
    contactId: input.customerId,
    memo: input.memo,
    total: parsed.amount.toFixed(4),
    paymentMethod: input.paymentMethod,
    referenceNumber: input.refNo,
    appliedToInvoiceId: opts.appliedToInvoiceId && valid.apps.length > 0 ? opts.appliedToInvoiceId : undefined,
    lines: paymentLines(input.depositTo, ar, input.customerId, parsed, accounts),
  }, userId, companyId, tx);

  await writeSettlement(tx, tenantId, companyId, payment.id, input.date, valid, accounts, sources, userId);
  return payment;
}

/** A hold (U-135): Dr depositTo / Cr Customer Deposits; no applications or credits (400 DEPOSIT_WITH_APPLICATIONS). */
async function receiveDepositInTx(
  tx: Tx, tenantId: string, input: ReceivePaymentInput, parsed: Parsed, userId?: string, companyId?: string,
) {
  if (parsed.apps.length > 0 || parsed.credits.length > 0) {
    throw AppError.badRequest('A deposit holds the whole amount: leave the invoices and credits out.', 'DEPOSIT_WITH_APPLICATIONS');
  }
  if (!parsed.amount.greaterThan(0)) throw AppError.badRequest('Enter the amount received.', 'AMOUNT_REQUIRED');
  const cd = await customerDepositsAccount(tx, tenantId, companyId);
  const amount = parsed.amount.toFixed(4);
  return ledger.postTransaction(tenantId, {
    txnType: 'customer_payment',
    txnDate: input.date,
    contactId: input.customerId,
    memo: input.memo,
    total: amount,
    paymentMethod: input.paymentMethod,
    referenceNumber: input.refNo,
    holdsDeposit: true,
    lines: [
      { accountId: input.depositTo, debit: amount, credit: '0' },
      { accountId: cd, debit: '0', credit: amount, contactId: input.customerId },
    ],
  }, userId, companyId, tx);
}

/** Receives a payment in its own database transaction (routes, api-v2, MCP, Stripe, bank feed). */
export async function receivePayment(
  tenantId: string, input: ReceivePaymentInput, userId?: string, companyId?: string, opts: ReceiveOptions = {},
) {
  return db.transaction((tx) => receivePaymentInTx(tx, tenantId, input, userId, companyId, opts));
}

// ─── Read ───────────────────────────────────────────────────────────

export interface PaymentApplicationRecord {
  invoiceId: string;
  invoiceNumber: string | null;
  amount: string;
  discount: string;
  writeOff: string;
  appliedDate: string;
  /** review E-B2 / D-SF1: true for its credit applied after it was saved (/apply or inside another payment). */
  appliedLater: boolean;
  /** The payment this credit row was applied inside; null for its own rows and /apply. */
  appliedInTxnId: string | null;
  voided: boolean;
  reversed: boolean;
}

/** A live credit applied inside this payment (review E-B2): send it back on PUT to keep it. */
export interface PaymentCreditRecord {
  sourcePaymentId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amount: string;
  /** True when the source is a held customer deposit (U-135). */
  fromDeposit: boolean;
}

export interface PaymentRecord {
  id: string;
  txnType: 'customer_payment';
  txnNumber: string | null;
  customerId: string | null;
  date: string;
  amount: string;
  depositTo: string | null;
  paymentMethod: string | null;
  refNo: string | null;
  memo: string | null;
  updatedAt: string | null;
  status: string;
  depositedIn?: { depositId: string; date: string };
  bounce?: { returnId: string; date: string };
  applications: PaymentApplicationRecord[];
  /** review E-B2: the live credits applied inside it. */
  creditApplications: PaymentCreditRecord[];
  /** The write-off and discount accounts its live rows use (null when none). */
  writeOffAccountId: string | null;
  discountAccountId: string | null;
  unappliedRemaining: string;
  holdsDeposit: boolean;
  depositRemaining: string;
  /** U-135: the held deposit this payment draws on. */
  fromDepositId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadPayment(executor: DbOrTx, tenantId: string, paymentId: string, companyId?: string): Promise<TxnRow> {
  if (!UUID_RE.test(paymentId)) throw AppError.notFound('Payment not found');
  const [row] = await executor.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId))).limit(1);
  if (!row || row.txnType !== 'customer_payment' || row.status === 'deleted' || ledger.inOtherCompany(row, companyId)) {
    throw AppError.notFound('Payment not found');
  }
  return row;
}

/**
 * The account a payment was deposited to: its asset debit line that is not
 * A/R. Null when it received no money (a payment of 0.00 that only settles
 * a discount or write-off has no asset debit; review SF6).
 */
async function depositToOf(executor: DbOrTx, tenantId: string, paymentId: string): Promise<string | null> {
  const res = await executor.execute(sql`
    SELECT jl.account_id FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND jl.transaction_id = ${paymentId} AND jl.is_void_reversal = false
      AND jl.debit > 0 AND a.account_type = 'asset' AND a.system_tag IS DISTINCT FROM 'accounts_receivable'
    ORDER BY jl.line_order LIMIT 1
  `);
  return (res.rows as Array<{ account_id: string }>)[0]?.account_id ?? null;
}

/** 400 NO_MONEY_RECEIVED: a payment that took in no money can't be bounced or edited (review SF6). */
function noMoneyReceived(paymentId: string): AppError {
  return AppError.badRequest(
    'This payment received no money (it only settles a discount or write-off), so it can’t be bounced or edited. Void it and enter it again.',
    'NO_MONEY_RECEIVED',
    { paymentId },
  );
}

export async function getPaymentRecord(executor: DbOrTx, tenantId: string, paymentId: string, companyId?: string): Promise<PaymentRecord> {
  const p = await loadPayment(executor, tenantId, paymentId, companyId);
  const appsRes = await executor.execute(sql`
    SELECT pa.invoice_id, inv.txn_number, pa.amount, pa.discount_amount, pa.write_off_amount,
      to_char(pa.applied_date, 'YYYY-MM-DD') AS applied_date, pa.applied_in_txn_id, pa.voided_at, pa.reversed_by_txn_id,
      pa.write_off_account_id, pa.discount_account_id
    FROM payment_applications pa
    LEFT JOIN transactions inv ON inv.id = pa.invoice_id AND inv.tenant_id = pa.tenant_id
    WHERE pa.tenant_id = ${tenantId} AND pa.payment_id = ${paymentId}
    ORDER BY pa.created_at, inv.txn_date, inv.txn_number, pa.id
  `);
  const appRows = appsRes.rows as Array<Record<string, unknown>>;
  const apps = appRows.map((r) => ({
    invoiceId: String(r['invoice_id']),
    invoiceNumber: (r['txn_number'] as string | null) ?? null,
    amount: money2(round2(String(r['amount']))),
    discount: money2(round2(String(r['discount_amount'] ?? '0'))),
    writeOff: money2(round2(String(r['write_off_amount'] ?? '0'))),
    appliedDate: (r['applied_date'] as string | null) ?? p.txnDate,
    appliedLater: r['applied_date'] != null,
    appliedInTxnId: (r['applied_in_txn_id'] as string | null) ?? null,
    voided: r['voided_at'] != null,
    reversed: r['reversed_by_txn_id'] != null,
  }));
  const liveOwn = appRows.filter((r) => r['applied_date'] == null && r['voided_at'] == null && r['reversed_by_txn_id'] == null);
  const accountOf = (col: string) => (liveOwn.map((r) => r[col] as string | null).find((x) => x != null) ?? null);
  const creditApplications = await creditsInsideRecord(executor, tenantId, paymentId);
  const deposits = await liveDepositsForSource(executor, tenantId, paymentId);
  let depositedIn: PaymentRecord['depositedIn'];
  if (deposits[0]) {
    const [d] = await executor.select({ id: transactions.id, txnDate: transactions.txnDate }).from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, deposits[0].depositId))).limit(1);
    if (d) depositedIn = { depositId: d.id, date: d.txnDate };
  }
  const bounce = await liveBounce(executor, tenantId, paymentId);
  const remaining = p.holdsDeposit ? new Decimal(0) : await creditRemaining(executor, tenantId, p);
  return {
    id: p.id,
    txnType: 'customer_payment',
    txnNumber: p.txnNumber,
    customerId: p.contactId,
    date: p.txnDate,
    amount: money2(round2(p.total ?? '0')),
    depositTo: await depositToOf(executor, tenantId, paymentId),
    paymentMethod: p.paymentMethod,
    refNo: p.referenceNumber,
    memo: p.memo,
    updatedAt: p.updatedAt ? p.updatedAt.toISOString() : null,
    status: p.status,
    ...(depositedIn ? { depositedIn } : {}),
    ...(bounce ? { bounce: { returnId: bounce.id, date: bounce.txnDate } } : {}),
    applications: apps,
    creditApplications,
    writeOffAccountId: accountOf('write_off_account_id'),
    discountAccountId: accountOf('discount_account_id'),
    unappliedRemaining: money2(round2(remaining)),
    holdsDeposit: p.holdsDeposit,
    depositRemaining: money2(round2(await depositRemaining(executor, tenantId, p))),
    ...(p.fromDepositId ? { fromDepositId: p.fromDepositId } : {}),
  };
}

/**
 * The live credits applied inside a payment (review E-B2), in the shape PUT
 * takes back as creditApplications: other payments' rows applied inside it.
 */
async function creditsInsideRecord(executor: DbOrTx, tenantId: string, paymentId: string): Promise<PaymentCreditRecord[]> {
  const res = await executor.execute(sql`
    SELECT * FROM (
      SELECT pa.payment_id AS source_id, pa.invoice_id, inv.txn_number, pa.amount, false AS from_deposit, pa.created_at, pa.id
      FROM payment_applications pa
      LEFT JOIN transactions inv ON inv.id = pa.invoice_id AND inv.tenant_id = pa.tenant_id
      WHERE pa.tenant_id = ${tenantId} AND pa.applied_in_txn_id = ${paymentId}
        AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL
      UNION ALL
      -- U-135: a draw on a held deposit made inside it lists as that deposit's credit.
      SELECT d.from_deposit_id, pa.invoice_id, inv.txn_number, pa.amount, true, pa.created_at, pa.id
      FROM transactions d
      JOIN payment_applications pa ON pa.payment_id = d.id AND pa.tenant_id = d.tenant_id
      LEFT JOIN transactions inv ON inv.id = pa.invoice_id AND inv.tenant_id = pa.tenant_id
      WHERE d.tenant_id = ${tenantId} AND d.source_txn_id = ${paymentId} AND d.txn_type = 'customer_payment'
        AND d.status = 'posted' AND d.from_deposit_id IS NOT NULL
        AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL
    ) x
    ORDER BY x.created_at, x.id
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    sourcePaymentId: String(r['source_id']),
    invoiceId: String(r['invoice_id']),
    invoiceNumber: (r['txn_number'] as string | null) ?? null,
    amount: money2(round2(String(r['amount']))),
    fromDeposit: r['from_deposit'] === true,
  }));
}

export async function getPayment(tenantId: string, paymentId: string, companyId?: string) {
  return getPaymentRecord(db, tenantId, paymentId, companyId);
}

export async function listPayments(tenantId: string, q: ListPaymentsQuery, companyId?: string) {
  const conds = [sql`t.tenant_id = ${tenantId}`, sql`t.txn_type = 'customer_payment'`, sql`t.status <> 'deleted'`];
  if (companyId) conds.push(sql`(t.company_id = ${companyId} OR t.company_id IS NULL)`);
  if (q.contactId) conds.push(sql`t.contact_id = ${q.contactId}`);
  if (q.from) conds.push(sql`t.txn_date >= ${q.from}`);
  if (q.to) conds.push(sql`t.txn_date <= ${q.to}`);
  const where = sql.join(conds, sql` AND `);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const rows = await db.execute(sql`
    SELECT t.id, t.contact_id, c.display_name, to_char(t.txn_date, 'YYYY-MM-DD') AS date, t.total, t.payment_method,
      t.reference_number, t.memo, t.status, t.updated_at,
      EXISTS (SELECT 1 FROM transactions r WHERE r.tenant_id = t.tenant_id AND r.source_txn_id = t.id
              AND r.txn_type = 'returned_payment' AND r.status = 'posted') AS bounced,
      EXISTS (SELECT 1 FROM deposit_lines dl JOIN transactions d ON d.id = dl.deposit_id
              WHERE dl.source_transaction_id = t.id AND d.tenant_id = t.tenant_id AND d.status = 'posted') AS deposited,
      COALESCE((SELECT SUM(pa.amount) FROM payment_applications pa WHERE pa.tenant_id = t.tenant_id AND pa.payment_id = t.id
                AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL), 0)::text AS applied,
      COALESCE((SELECT SUM(r.total) FROM transactions r WHERE r.tenant_id = t.tenant_id AND r.source_payment_id = t.id
                AND r.txn_type = 'customer_refund' AND r.status = 'posted'), 0)::text AS refunded,
      t.holds_deposit,
      COALESCE((SELECT SUM(d.total) FROM transactions d WHERE d.tenant_id = t.tenant_id AND d.from_deposit_id = t.id
                AND d.status = 'posted'), 0)::text AS drawn
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = t.tenant_id
    WHERE ${where}
    ORDER BY t.txn_date DESC, t.created_at DESC, t.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  const totalRes = await db.execute(sql`SELECT COUNT(*)::int AS n FROM transactions t WHERE ${where}`);
  const data = (rows.rows as Array<Record<string, unknown>>).map((r) => {
    const bounced = r['bounced'] === true;
    const posted = r['status'] === 'posted';
    // A held deposit (U-135, review SF9) has no A/R credit; what is left of it
    // is depositRemaining (amount - posted draws - live refunds), as on the record.
    const holds = r['holds_deposit'] === true;
    const left = posted && !bounced
      ? Decimal.max(dec(String(r['total'] ?? '0')).minus(String(holds ? r['drawn'] : r['applied'])).minus(String(r['refunded'])), 0)
      : new Decimal(0);
    const remaining = holds ? new Decimal(0) : left;
    return {
      id: String(r['id']),
      customerId: (r['contact_id'] as string | null) ?? null,
      customerName: (r['display_name'] as string | null) ?? null,
      date: String(r['date']),
      amount: money2(round2(String(r['total'] ?? '0'))),
      paymentMethod: (r['payment_method'] as string | null) ?? null,
      refNo: (r['reference_number'] as string | null) ?? null,
      memo: (r['memo'] as string | null) ?? null,
      status: String(r['status']),
      bounced,
      deposited: r['deposited'] === true,
      unappliedRemaining: money2(round2(remaining)),
      holdsDeposit: holds,
      depositRemaining: money2(round2(holds ? left : new Decimal(0))),
      updatedAt: r['updated_at'] ? new Date(r['updated_at'] as string).toISOString() : null,
    };
  });
  return { data, total: (totalRes.rows as Array<{ n: number }>)[0]?.n ?? 0 };
}

/**
 * Open invoices of a customer (posted, not paid or void, cent balance above
 * 0.00), oldest first. balanceDue is the cent balance (2 places);
 * balanceDueExact the stored balance, echoed back as expectedBalanceDue.
 * A customer of another company is 404 (U-104 class).
 */
export async function getOpenInvoicesForCustomer(tenantId: string, customerId: string, companyId?: string, date?: string) {
  await assertCustomer(db, tenantId, customerId, companyId);
  const rows = await openInvoiceRows(db, tenantId, customerId, companyId);
  const on = date ?? new Date().toISOString().slice(0, 10);
  return rows.map((r) => ({
    id: r.invoiceId,
    invoiceNumber: r.invoiceNumber,
    txnDate: r.txnDate,
    dueDate: r.dueDate,
    total: r.total,
    amountPaid: r.amountPaid,
    balanceDue: money2(centBalance(r.balanceDueExact)),
    balanceDueExact: r.balanceDueExact,
    invoiceStatus: r.invoiceStatus,
    // U-134: the invoice's discount terms and what they give on `date` (default today).
    discountPercent: r.discountPercent ?? null,
    discountDate: r.discountDate ?? null,
    discountAvailable: money2(discountAvailable(r, on)),
  }));
}

interface OpenInvoiceRow extends ComputeInvoice { amountPaid: string; invoiceStatus: string | null }

async function openInvoiceRows(
  executor: DbOrTx, tenantId: string, customerId: string, companyId?: string, includeIds: string[] = [],
): Promise<OpenInvoiceRow[]> {
  const scope = companyId ? sql`AND (company_id = ${companyId} OR company_id IS NULL)` : sql``;
  const include = includeIds.length
    ? sql`OR id IN (${sql.join(includeIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``;
  // Dates are cast to text in SQL so the raw driver returns 'YYYY-MM-DD'
  // strings (no timezone shift from date -> JS Date parsing).
  const rows = await executor.execute(sql`
    SELECT id, txn_number, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, to_char(due_date, 'YYYY-MM-DD') AS due_date,
           total, amount_paid, balance_due, invoice_status, discount_percent, to_char(discount_date, 'YYYY-MM-DD') AS discount_date,
           EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.tenant_id = t.tenant_id AND pa.invoice_id = t.id
                   AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL AND pa.discount_amount > 0) AS discount_taken
    FROM transactions t
    WHERE tenant_id = ${tenantId} AND txn_type = 'invoice' AND status = 'posted'
      AND contact_id = ${customerId} ${scope}
      AND ((invoice_status IS DISTINCT FROM 'paid' AND invoice_status IS DISTINCT FROM 'void'
            AND ROUND(COALESCE(balance_due, 0), 2) > 0) ${include})
    ORDER BY txn_date ASC, txn_number ASC NULLS FIRST, id ASC
  `);
  return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
    invoiceId: String(r['id']),
    invoiceNumber: (r['txn_number'] as string | null) ?? '',
    txnDate: String(r['txn_date'] ?? ''),
    dueDate: (r['due_date'] as string | null) ?? null,
    total: dec(String(r['total'] ?? '0')).toFixed(4),
    amountPaid: dec(String(r['amount_paid'] ?? '0')).toFixed(4),
    balanceDueExact: dec(String(r['balance_due'] ?? '0')).toFixed(4),
    invoiceStatus: (r['invoice_status'] as string | null) ?? null,
    discountPercent: r['discount_percent'] == null ? null : String(r['discount_percent']),
    discountDate: (r['discount_date'] as string | null) ?? null,
    discountTaken: r['discount_taken'] === true,
  }));
}

/** Live payments applied to an invoice (company-scoped: another company's invoice is 404). */
export async function getPaymentsForInvoice(tenantId: string, invoiceId: string, companyId?: string) {
  const [inv] = await db.select({ id: transactions.id, companyId: transactions.companyId }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId))).limit(1);
  if (!inv || ledger.inOtherCompany(inv, companyId)) throw AppError.notFound('Invoice not found');
  const rows = await db.execute(sql`
    SELECT pa.id, pa.payment_id, pa.amount, pa.created_at,
      t.txn_date, t.txn_number, t.memo
    FROM payment_applications pa
    JOIN transactions t ON t.id = pa.payment_id AND t.tenant_id = pa.tenant_id
    WHERE pa.tenant_id = ${tenantId} AND pa.invoice_id = ${invoiceId}
      AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL AND t.status = 'posted'
    ORDER BY t.txn_date ASC
  `);
  return rows.rows;
}

// ─── Preview ────────────────────────────────────────────────────────

export interface PaymentPreview {
  contactBalanceBefore: string;
  contactBalanceAfter: string;
  amount: string;
  amountSource: 'typed' | 'from_applications';
  invoices: Array<ReturnType<typeof computePayment>['invoices'][number]>;
  totals: ReturnType<typeof computePayment>['totals'];
  shortfalls: ReturnType<typeof computePayment>['shortfalls'];
  overpayment: string;
  credits: ComputeCredit[];
  depositsOnHand: DepositOnHand[];
  holdAsDepositOffered: boolean;
  /** The credits this preview applied, amounts filled (the save plan copies them). */
  creditApplications: ReturnType<typeof computePayment>['creditApplications'];
  pendingDeposits: { count: number; total: string };
  averageDaysToPay: number | null;
  problems: Array<ComputeProblem | { code: string; invoiceId?: string }>;
}

/**
 * Days to pay (Q-P21r): for each of the client's invoices fully paid in the
 * 12 months up to `date`, the days from its date to the date of the payment
 * that cleared it (not paidAt, the wall clock). The mean, rounded half up;
 * null below 3 invoices.
 */
async function averageDaysToPay(tenantId: string, customerId: string, date: string, companyId?: string): Promise<number | null> {
  const scope = companyId ? sql`AND (inv.company_id = ${companyId} OR inv.company_id IS NULL)` : sql``;
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(cleared - inv_date), 0)::text AS days FROM (
      SELECT inv.txn_date AS inv_date, MAX(COALESCE(pa.applied_date, p.txn_date)) AS cleared
      FROM transactions inv
      JOIN payment_applications pa ON pa.invoice_id = inv.id AND pa.tenant_id = inv.tenant_id
        AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL
      JOIN transactions p ON p.id = pa.payment_id AND p.tenant_id = pa.tenant_id AND p.status = 'posted'
      WHERE inv.tenant_id = ${tenantId} AND inv.txn_type = 'invoice' AND inv.status = 'posted'
        AND inv.invoice_status = 'paid' AND inv.contact_id = ${customerId} ${scope}
      GROUP BY inv.id, inv.txn_date
    ) x
    WHERE cleared <= ${date}::date AND cleared > (${date}::date - INTERVAL '12 months')
  `);
  const row = (res.rows as Array<{ n: number; days: string }>)[0];
  if (!row || row.n < 3) return null;
  return dec(row.days).dividedBy(row.n).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** Credits applied in a compute result. */
function creditsUsed(result: ReturnType<typeof computePayment>): DecimalValue {
  return result.creditApplications.reduce((t, c) => t.plus(c.amount), new Decimal(0));
}

/**
 * The client's open credits (U-133): posted customer payments with credit
 * left, not bounced, oldest first; the payment being edited is left out.
 */
async function openCredits(
  tenantId: string, customerId: string, companyId: string | undefined, exceptId?: string,
  /** Edit preview (review E-B2): what the edited payment uses of each source counts as left, as PUT sets it aside first. */
  usedInside: Map<string, DecimalValue> = new Map(),
): Promise<ComputeCredit[]> {
  const scope = companyId ? sql`AND (t.company_id = ${companyId} OR t.company_id IS NULL)` : sql``;
  const except = exceptId ? sql`AND t.id <> ${exceptId}` : sql``;
  const rows = await db.execute(sql`
    SELECT t.id, to_char(t.txn_date, 'YYYY-MM-DD') AS date, t.reference_number,
      (t.total
        - COALESCE((SELECT SUM(pa.amount) FROM payment_applications pa WHERE pa.tenant_id = t.tenant_id AND pa.payment_id = t.id
                    AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL), 0)
        - COALESCE((SELECT SUM(r.total) FROM transactions r WHERE r.tenant_id = t.tenant_id AND r.source_payment_id = t.id
                    AND r.txn_type = 'customer_refund' AND r.status = 'posted'), 0))::text AS remaining
    FROM transactions t
    WHERE t.tenant_id = ${tenantId} AND t.txn_type = 'customer_payment' AND t.status = 'posted'
      AND t.contact_id = ${customerId} ${scope} ${except}
      AND t.holds_deposit = false AND t.from_deposit_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM transactions b WHERE b.tenant_id = t.tenant_id AND b.source_txn_id = t.id
                      AND b.txn_type = 'returned_payment' AND b.status = 'posted')
    ORDER BY t.txn_date, t.created_at, t.id
  `);
  return (rows.rows as Array<Record<string, unknown>>)
    .map((r) => ({
      sourcePaymentId: String(r['id']), date: String(r['date']), refNo: (r['reference_number'] as string | null) ?? null,
      remaining: money2(round2(dec(String(r['remaining'])).plus(usedInside.get(String(r['id'])) ?? 0))),
    }))
    .filter((c) => dec(c.remaining).greaterThan(0));
}

export interface DepositOnHand { paymentId: string; date: string; refNo: string | null; amount: string; remaining: string }

/**
 * Held customer deposits with money left (U-135): posted, not bounced,
 * amount - posted draws - live refunds above 0.00; oldest first.
 */
export async function depositsOnHand(
  tenantId: string, customerId: string, companyId?: string,
  /** Edit preview: what the edited payment draws on each deposit counts as left (PUT re-makes those draws). */
  usedInside: Map<string, DecimalValue> = new Map(),
): Promise<DepositOnHand[]> {
  const scope = companyId ? sql`AND (t.company_id = ${companyId} OR t.company_id IS NULL)` : sql``;
  const rows = await db.execute(sql`
    SELECT t.id, to_char(t.txn_date, 'YYYY-MM-DD') AS date, t.reference_number, t.total::text AS total,
      (t.total
        - COALESCE((SELECT SUM(d.total) FROM transactions d WHERE d.tenant_id = t.tenant_id AND d.from_deposit_id = t.id
                    AND d.status = 'posted'), 0)
        - COALESCE((SELECT SUM(r.total) FROM transactions r WHERE r.tenant_id = t.tenant_id AND r.source_payment_id = t.id
                    AND r.txn_type = 'customer_refund' AND r.status = 'posted'), 0))::text AS remaining
    FROM transactions t
    WHERE t.tenant_id = ${tenantId} AND t.txn_type = 'customer_payment' AND t.status = 'posted' AND t.holds_deposit = true
      AND t.contact_id = ${customerId} ${scope}
      AND NOT EXISTS (SELECT 1 FROM transactions b WHERE b.tenant_id = t.tenant_id AND b.source_txn_id = t.id
                      AND b.txn_type = 'returned_payment' AND b.status = 'posted')
    ORDER BY t.txn_date, t.created_at, t.id
  `);
  return (rows.rows as Array<Record<string, unknown>>)
    .map((r) => ({
      paymentId: String(r['id']), date: String(r['date']), refNo: (r['reference_number'] as string | null) ?? null,
      amount: money2(round2(String(r['total']))),
      remaining: money2(round2(dec(String(r['remaining'])).plus(usedInside.get(String(r['id'])) ?? 0))),
    }))
    .filter((d) => dec(d.remaining).greaterThan(0));
}

async function pendingDepositTotals(tenantId: string, companyId: string | undefined, exceptId?: string) {
  const items = (await listPendingDepositItems(tenantId, { companyId })).filter((i) => i.transactionId !== exceptId);
  return { count: items.length, total: items.reduce((s, i) => s.plus(i.amount), new Decimal(0)) };
}

/**
 * POST /payments/preview: every figure of the Receive Payment form, posting
 * nothing. Business problems come back in problems[], never as 4xx.
 * With editingPaymentId the payment's own live applications are added back
 * to its invoices (balanceDueExact = stored + own share, the value PUT
 * expects) and invoices it paid in full are listed.
 */
export async function previewPayment(tenantId: string, input: PreviewPaymentInput, companyId?: string): Promise<PaymentPreview> {
  await assertCustomer(db, tenantId, input.customerId, companyId);
  const problems: PaymentPreview['problems'] = [];
  const own = new Map<string, DecimalValue>();
  const addOwn = (id: string, x: DecimalValue) => own.set(id, (own.get(id) ?? new Decimal(0)).plus(x));
  let ownAmount = new Decimal(0);
  const usedInside = new Map<string, DecimalValue>();
  if (input.editingPaymentId) {
    const p = await loadPayment(db, tenantId, input.editingPaymentId, companyId);
    if (p.status === 'posted') {
      ownAmount = dec(p.total);
      // Its own rows (not its credit applied later elsewhere) and the credits applied inside it.
      for (const a of await liveApplications(db, tenantId, p.id)) {
        if (a.appliedDate === null) { addOwn(a.invoiceId, settledBy(a)); ownAmount = ownAmount.plus(a.discountAmount).plus(a.writeOffAmount); }
      }
      for (const a of await creditsAppliedIn(db, tenantId, p.id)) {
        addOwn(a.invoiceId, dec(a.amount));
        usedInside.set(a.paymentId, (usedInside.get(a.paymentId) ?? new Decimal(0)).plus(a.amount));
      }
      // Draws on held deposits made inside it (U-135): PUT voids and re-makes
      // them, so their share is back on the invoices and the deposits, and
      // their A/R credit is out of the balance before (review nit).
      for (const d of (await creditsInsideRecord(db, tenantId, p.id)).filter((x) => x.fromDeposit)) {
        addOwn(d.invoiceId, dec(d.amount));
        usedInside.set(d.sourcePaymentId, (usedInside.get(d.sourcePaymentId) ?? new Decimal(0)).plus(d.amount));
        ownAmount = ownAmount.plus(d.amount);
      }
      if (await liveBounce(db, tenantId, p.id)) problems.push({ code: 'PAYMENT_BOUNCED' });
    }
  }
  const rows = await openInvoiceRows(db, tenantId, input.customerId, companyId, [...own.keys()]);
  const compute: ComputeInvoice[] = rows.map((r) => {
    const share = own.get(r.invoiceId);
    return share ? { ...r, balanceDueExact: dec(r.balanceDueExact).plus(share).toFixed(4) } : r;
  });
  const credits = await openCredits(tenantId, input.customerId, companyId, input.editingPaymentId, usedInside);
  const onHand = (await depositsOnHand(tenantId, input.customerId, companyId, usedInside)).filter((d) => d.paymentId !== input.editingPaymentId);
  const sourcesForCompute: ComputeCredit[] = [
    ...credits,
    ...onHand.map((d) => ({ sourcePaymentId: d.paymentId, date: d.date, refNo: d.refNo, remaining: d.remaining })),
  ];
  const settings = await companySettleSettings(db, tenantId, companyId);
  const result = computePayment(compute, {
    date: input.date,
    amount: input.amount ?? null,
    applications: input.applications ?? null,
    creditApplications: input.creditApplications ?? null,
    writeOffThreshold: settings.writeOffThreshold === null ? null : money2(round2(settings.writeOffThreshold)),
  }, sourcesForCompute);
  problems.unshift(...result.problems);
  // Receive and PUT refuse 0.00 without a discount or write-off, credits or
  // not (400 AMOUNT_REQUIRED); the preview says so too (review SF1). Credits
  // alone are applied with POST /payments/:id/apply.
  const discountsOnly = dec(result.totals.discountsAndCredits).minus(creditsUsed(result));
  if (!dec(result.amount).greaterThan(0) && !discountsOnly.greaterThan(0) && !dec(result.totals.writeOffs).greaterThan(0)
    && !problems.some((x) => x.code === 'AMOUNT_REQUIRED')) {
    problems.push({ code: 'AMOUNT_REQUIRED' });
  }
  if (input.holdAsDeposit && ((input.applications?.length ?? 0) > 0 || (input.creditApplications?.length ?? 0) > 0)) {
    problems.push({ code: 'DEPOSIT_WITH_APPLICATIONS' });
  }
  const onHandIds = new Set(onHand.map((d) => d.paymentId));
  const drawsUsed = result.creditApplications.filter((c) => onHandIds.has(c.sourcePaymentId))
    .reduce((t, c) => t.plus(c.amount), new Decimal(0));
  if ((input.applications?.length ?? 0) + (input.creditApplications?.length ?? 0) > MAX_APPLICATIONS) problems.push({ code: 'TOO_MANY_APPLICATIONS' });

  let pcId: string | null = null;
  if (input.depositTo) {
    try {
      await assertDepositAccount(db, tenantId, input.depositTo, companyId);
    } catch (e) {
      if (e instanceof AppError && e.code === 'DEPOSIT_ACCOUNT_INVALID') problems.push({ code: 'DEPOSIT_ACCOUNT_INVALID' });
      else throw e;
    }
    pcId = await systemAccountId(db, tenantId, 'payments_clearing');
  }

  const balances = await getBalances(tenantId, [input.customerId], companyId);
  const before = dec(balances.get(input.customerId)?.openBalance).plus(ownAmount);
  const amount = dec(result.amount);
  const pending = await pendingDepositTotals(tenantId, companyId, input.editingPaymentId);
  const counts = pcId && input.depositTo === pcId && amount.greaterThan(0);

  return {
    contactBalanceBefore: money2(round2(before)),
    // Credits are in A/R already; discounts and write-offs take it down too.
    // Credits are in A/R already; draws on deposits take A/R down (U-135); a hold leaves it alone.
    contactBalanceAfter: input.holdAsDeposit ? money2(round2(before)) : money2(round2(before.minus(amount)
      .minus(dec(result.totals.discountsAndCredits).minus(creditsUsed(result))).minus(result.totals.writeOffs).minus(drawsUsed))),
    amount: result.amount,
    amountSource: result.amountSource,
    invoices: result.invoices,
    totals: result.totals,
    shortfalls: result.shortfalls,
    overpayment: result.overpayment,
    credits,
    depositsOnHand: onHand,
    holdAsDepositOffered: amount.greaterThan(0) && !dec(result.totals.applied).greaterThan(0)
      && result.creditApplications.length === 0 && !dec(result.totals.writeOffs).greaterThan(0),
    creditApplications: result.creditApplications,
    pendingDeposits: {
      count: pending.count + (counts ? 1 : 0),
      total: money2(round2(pending.total.plus(counts ? amount : 0))),
    },
    averageDaysToPay: await averageDaysToPay(tenantId, input.customerId, input.date, companyId),
    problems,
  };
}

// ─── Void / unapply ─────────────────────────────────────────────────

/**
 * The customer_payment branch of voidTransactionInTx (every void path:
 * /payments/:id/void, /transactions/:id/void, api-v2, MCP, duplicate merge),
 * after the closing, reconciliation and TXN_DEPOSITED guards: 409
 * PAYMENT_BOUNCED while a bounce is live; otherwise the live applications
 * are restored onto their invoices and marked voided.
 */
export async function releasePaymentForVoidInTx(tx: Tx, tenantId: string, payment: TxnRow, userId?: string): Promise<void> {
  if (await liveBounce(tx, tenantId, payment.id)) throw paymentBounced(payment.id);
  // U-135: a deposit with live draws stays; a draw on a bounced deposit stays.
  if (payment.holdsDeposit && (await liveDraws(tx, tenantId, payment.id)).length > 0) throw depositApplied(payment.id);
  if (payment.fromDepositId && await liveBounce(tx, tenantId, payment.fromDepositId)) throw paymentBounced(payment.fromDepositId);
  // Draws made inside this payment are voided with it.
  const inner = await tx.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.sourceTxnId, payment.id),
      eq(transactions.txnType, 'customer_payment'), eq(transactions.status, 'posted')))
    .orderBy(transactions.id);
  for (const d of inner) await ledger.voidTransactionInTx(tx, tenantId, d.id, 'Voided with the payment it was applied in', userId);
  // A refund drew on its credit (Q-P21j): void the refund first.
  if ((await liveRefundTotal(tx, tenantId, payment.id)).greaterThan(0)) throw paymentRefunded(payment.id);
  // Its own rows and credit applied later, plus other credits applied inside
  // it (U-133). voidTransactionInTx locked the credit sources with the
  // payment (lockForVoidInTx) before any invoice (E-B1, review SF8).
  const apps = [...await liveApplications(tx, tenantId, payment.id), ...await creditsAppliedIn(tx, tenantId, payment.id)];
  if (apps.length === 0) return;
  const invoices = await lockInvoices(tx, tenantId, apps.map((a) => a.invoiceId));
  const now = new Date();
  for (const a of apps) {
    if (!await retireApplication(tx, tenantId, a.id, { voidedAt: now })) continue;
    const inv = invoices.get(a.invoiceId);
    if (inv) Object.assign(inv, await moveInvoicePaid(tx, tenantId, inv, settledBy(a).negated()));
  }
  await auditLog(tenantId, 'update', 'payment_applications', payment.id,
    { applications: apps.map((a) => ({ paymentId: a.paymentId, invoiceId: a.invoiceId, amount: a.amount, discount: a.discountAmount, writeOff: a.writeOffAmount })) },
    { applications: [], via: 'void' }, userId, tx);
}

/** POST /payments/:id/void. */
export async function voidPayment(
  tenantId: string, paymentId: string, reason: string | undefined, userId?: string,
  opts: { expectedUpdatedAt?: string; companyId?: string } = {},
) {
  await db.transaction(async (tx) => {
    await ledger.voidTransactionInTx(tx, tenantId, paymentId, reason ?? 'Voided', userId, {
      expectedUpdatedAt: opts.expectedUpdatedAt, companyId: opts.companyId, expectType: 'customer_payment',
    });
  });
}

/**
 * Takes one invoice off a payment (the money stays an A/R credit). The
 * payment row is locked first, then the live application is read under the
 * lock, then the invoice. Closed period on the payment's date; audited.
 */
export async function unapplyPayment(
  tenantId: string, paymentId: string, invoiceId: string,
  opts: { expectedUpdatedAt?: string; companyId?: string; userId?: string } = {},
) {
  await db.transaction(async (tx) => {
    const { claimAndRecord } = await import('./idempotency.service.js');
    await claimAndRecord(tx, 'transaction', paymentId);
    const { payment } = await lockPaymentScope(tx, tenantId, paymentId);
    if (!payment || payment.txnType !== 'customer_payment' || payment.status === 'deleted' || ledger.inOtherCompany(payment, opts.companyId)) {
      throw AppError.notFound('Payment not found');
    }
    if (payment.status !== 'posted') throw AppError.badRequest('This payment is void.');
    ledger.assertNotStale(payment, opts.expectedUpdatedAt, 'This payment');
    if (await liveBounce(tx, tenantId, paymentId)) throw paymentBounced(paymentId);
    // A draw's money is the deposit's: taken off the invoice it would be an
    // A/R credit nobody can use (review SF2). Voiding the draw gives it back.
    if (payment.fromDepositId) {
      throw AppError.badRequest(
        'This was applied from a customer deposit. Void it to give the money back to the deposit.',
        'APPLIED_FROM_DEPOSIT', { paymentId, depositId: payment.fromDepositId },
      );
    }
    const app = (await liveApplications(tx, tenantId, paymentId)).find((a) => a.invoiceId === invoiceId);
    if (!app) throw AppError.notFound('Payment application not found');
    // Cash basis books a credit applied later on its applied date, so that is
    // the date the closing date meets (review SF3).
    const booked = app.appliedDate ?? payment.txnDate;
    await ledger.checkLockDate(tx, tenantId, booked, payment.companyId, undefined, {
      txnId: payment.id, oldDate: booked, newDate: booked,
    });
    const inv = (await lockInvoices(tx, tenantId, [invoiceId])).get(invoiceId);
    if (!await retireApplication(tx, tenantId, app.id, { voidedAt: new Date() })) throw scopeChanged(paymentId);
    if (inv) await moveInvoicePaid(tx, tenantId, inv, settledBy(app).negated());
    await tx.update(transactions).set({ updatedAt: new Date() })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));
    await auditLog(tenantId, 'update', 'payment_applications', paymentId,
      { applications: [{ invoiceId, amount: app.amount, discount: app.discountAmount, writeOff: app.writeOffAmount, appliedDate: app.appliedDate }] },
      { applications: [], via: 'unapply', invoiceId }, opts.userId, tx);
  });
}

// ─── Bounce ─────────────────────────────────────────────────────────

export interface BounceResult {
  returnId: string;
  feeId?: string;
  heldIn: { accountId: string; kind: 'bank' | 'payments_clearing' };
  reopened: Array<{ invoiceId: string; balanceDue: string }>;
}

/** Where the money of a payment is now: its live deposit's bank, else depositTo. */
async function heldIn(
  executor: DbOrTx, tenantId: string, paymentId: string, depositId: string | null,
): Promise<BounceResult['heldIn']> {
  const pc = await systemAccountId(executor, tenantId, 'payments_clearing');
  if (depositId) {
    const [bank] = await executor.select({ accountId: journalLines.accountId }).from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, depositId),
        eq(journalLines.isVoidReversal, false), sql`${journalLines.debit} > 0`))
      .orderBy(journalLines.lineOrder).limit(1);
    if (bank) return { accountId: bank.accountId, kind: 'bank' };
  }
  const to = await depositToOf(executor, tenantId, paymentId);
  if (!to) throw noMoneyReceived(paymentId);
  return { accountId: to, kind: to === pc ? 'payments_clearing' : 'bank' };
}

async function assertFeeAccount(
  executor: DbOrTx, tenantId: string, accountId: string, companyId: string | null | undefined, forbidden: string[],
) {
  const [acct] = await executor.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  if (!acct || ledger.inOtherCompany(acct, companyId) || acct.isActive === false || forbidden.includes(acct.id)
    || ['accounts_receivable', 'accounts_payable', 'customer_deposits', 'payments_clearing'].includes(acct.systemTag ?? '')
    || acct.detailType === 'accounts_receivable' || acct.detailType === 'accounts_payable') {
    throw AppError.badRequest('Choose an expense account for the bank fee.', 'FEE_ACCOUNT_INVALID', { accountId });
  }
}

/**
 * POST /payments/:id/bounce: one dated returned_payment (Q-P21i/k/u) in one
 * database transaction. Cr the account holding the money (the deposit's
 * bank, the bank it went to, or Payments Clearing), Dr A/R for the
 * customer; every live application is restored and marked reversed. No
 * deposit is voided and nothing dated earlier changes, so only the bounce
 * date meets the closing date. An optional bank fee posts as an expense
 * (source_txn_id = the bounce) in the same transaction.
 */
export async function bouncePayment(
  tenantId: string, paymentId: string, input: BouncePaymentInput, userId?: string, companyId?: string,
): Promise<BounceResult> {
  return db.transaction((tx) => bouncePaymentInTx(tx, tenantId, paymentId, input, userId, companyId));
}

/** bouncePayment inside the caller's database transaction. */
export async function bouncePaymentInTx(
  tx: Tx, tenantId: string, paymentId: string, input: BouncePaymentInput, userId?: string, companyId?: string,
): Promise<BounceResult> {
  {
    // Lock order: the deposit holding the payment, the payment and the
    // payments its credit was applied inside, its invoices; the links are
    // read again under the locks (E-B1).
    const { payment, deposit: depositRow } = await lockPaymentScope(tx, tenantId, paymentId);
    const depositId = depositRow?.id ?? null;
    if (!payment || payment.txnType !== 'customer_payment' || payment.status === 'deleted' || ledger.inOtherCompany(payment, companyId)) {
      throw AppError.notFound('Payment not found');
    }
    if (payment.status !== 'posted') throw AppError.badRequest('This payment is void.');
    ledger.assertNotStale(payment, input.expectedUpdatedAt, 'This payment');
    if (await liveBounce(tx, tenantId, paymentId)) throw paymentBounced(paymentId);
    if ((await liveRefundTotal(tx, tenantId, paymentId)).greaterThan(0)) throw paymentRefunded(paymentId);
    if (input.date < payment.txnDate || (depositRow && input.date < depositRow.txnDate)) {
      throw AppError.badRequest(
        'The bounce date can’t be before the payment date or the date it was deposited.',
        'BOUNCE_DATE_INVALID',
        { paymentDate: payment.txnDate, depositDate: depositRow?.txnDate ?? null },
      );
    }

    const held = await heldIn(tx, tenantId, paymentId, depositId);
    const fee = input.bankFeeAmount ? wholeCents(input.bankFeeAmount, 'bankFeeAmount') : new Decimal(0);
    let feeAccount: string | null = null;
    let feeBank: string | null = null;
    if (fee.greaterThan(0)) {
      const [co] = companyId || payment.companyId
        ? await tx.select({ nsf: companies.nsfBankFeeAccountId }).from(companies)
          .where(and(eq(companies.tenantId, tenantId), eq(companies.id, (companyId || payment.companyId)!))).limit(1)
        : [];
      feeAccount = input.bankFeeAccountId ?? co?.nsf ?? null;
      if (!feeAccount) {
        throw AppError.badRequest('Choose the account for the bank fee, or set one in Preferences.', 'FEE_ACCOUNT_REQUIRED');
      }
      if (held.kind === 'bank') feeBank = held.accountId;
      else {
        if (!input.bankFeeBankAccountId) {
          throw AppError.badRequest('Choose the bank account the bank took its fee from.', 'FEE_BANK_REQUIRED');
        }
        await assertDepositAccount(tx, tenantId, input.bankFeeBankAccountId, companyId ?? payment.companyId ?? undefined);
        feeBank = input.bankFeeBankAccountId;
      }
      // Never the account the fee is paid from (Dr X / Cr X).
      await assertFeeAccount(tx, tenantId, feeAccount, companyId ?? payment.companyId, [held.accountId, feeBank]);
    }

    if (payment.fromDepositId) {
      throw AppError.badRequest('This payment was applied from a deposit; record the bounce on the deposit.', 'VALIDATION_ERROR');
    }
    // A held deposit (U-135): its draws' applications are reversed, A/R
    // debited for what was drawn, Customer Deposits for the rest; no draw is
    // voided, so nothing dated earlier changes.
    // Read under the hold's lock; its draws were locked with it (E-B1).
    const draws = payment.holdsDeposit ? await liveDraws(tx, tenantId, paymentId) : [];
    const drawn = draws.reduce((t, d) => t.plus(d.total ?? '0'), new Decimal(0));
    const apps = payment.holdsDeposit
      ? (await Promise.all(draws.map((d) => liveApplications(tx, tenantId, d.id)))).flat()
      : await liveApplications(tx, tenantId, paymentId);
    const invoices = await lockInvoices(tx, tenantId, apps.map((a) => a.invoiceId));
    const ar = await arAccountId(tx, tenantId);
    const amount = dec(payment.total).toFixed(4);
    const holdLines = payment.holdsDeposit
      ? [
        ...(drawn.greaterThan(0) ? [{ accountId: ar, debit: drawn.toFixed(4), credit: '0', contactId: payment.contactId ?? undefined }] : []),
        ...(dec(payment.total).minus(drawn).greaterThan(0)
          ? [{ accountId: await customerDepositsAccount(tx, tenantId, payment.companyId), debit: dec(payment.total).minus(drawn).toFixed(4), credit: '0' }]
          : []),
        { accountId: held.accountId, debit: '0', credit: amount },
      ]
      : null;
    const scope = companyId ?? payment.companyId ?? undefined;

    // Discounts and write-offs it settled come back too (U-133, U-134).
    const back = new Map<string, DecimalValue>();
    const addBack = (acct: string | null, x: string) => {
      if (!acct || !dec(x).greaterThan(0)) return;
      back.set(acct, (back.get(acct) ?? new Decimal(0)).plus(x));
    };
    for (const a of apps) { addBack(a.discountAccountId, a.discountAmount); addBack(a.writeOffAccountId, a.writeOffAmount); }
    const backTotal = [...back.values()].reduce((t, x) => t.plus(x), new Decimal(0));
    const arDebit = dec(payment.total).plus(backTotal).toFixed(4);
    const ret = await ledger.postTransaction(tenantId, {
      txnType: 'returned_payment',
      txnDate: input.date,
      contactId: payment.contactId ?? undefined,
      memo: input.memo ?? `Bounced payment${payment.referenceNumber ? ` ${payment.referenceNumber}` : ''}`,
      total: amount,
      referenceNumber: payment.referenceNumber ?? undefined,
      paymentMethod: (payment.paymentMethod ?? undefined) as PaymentMethod | undefined,
      sourceTxnId: paymentId,
      lines: holdLines ?? [
        { accountId: ar, debit: arDebit, credit: '0', contactId: payment.contactId ?? undefined },
        { accountId: held.accountId, debit: '0', credit: amount },
        ...[...back.entries()].sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([accountId, x]) => ({ accountId, debit: '0', credit: x.toFixed(4) })),
      ],
    }, userId, scope, tx);

    const reopened: BounceResult['reopened'] = [];
    for (const a of apps) {
      // Read under the payment's lock; a row retired meanwhile would mean the
      // posted amounts are wrong, so the whole bounce rolls back (E-B1).
      if (!await retireApplication(tx, tenantId, a.id, { reversedByTxnId: ret.id })) throw scopeChanged(paymentId);
      const inv = invoices.get(a.invoiceId);
      if (inv) {
        const updated = await moveInvoicePaid(tx, tenantId, inv, settledBy(a).negated());
        Object.assign(inv, updated);
        reopened.push({ invoiceId: inv.id, balanceDue: money2(centBalance(updated.balanceDue ?? '0')) });
      }
    }
    await tx.update(transactions).set({ updatedAt: new Date() })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));

    let feeId: string | undefined;
    if (fee.greaterThan(0) && feeAccount && feeBank) {
      const feeStr = fee.toFixed(4);
      const feeTxn = await ledger.postTransaction(tenantId, {
        txnType: 'expense',
        txnDate: input.date,
        memo: 'Bank fee for a bounced payment',
        total: feeStr,
        sourceTxnId: ret.id,
        lines: [
          { accountId: feeAccount, debit: feeStr, credit: '0' },
          { accountId: feeBank, debit: '0', credit: feeStr },
        ],
      }, userId, scope, tx);
      feeId = feeTxn.id;
    }

    await auditLog(tenantId, 'update', 'payment_applications', paymentId,
      { applications: apps.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) },
      { applications: [], via: 'bounce', returnId: ret.id, feeId: feeId ?? null }, userId, tx);

    return { returnId: ret.id, ...(feeId ? { feeId } : {}), heldIn: held, reopened };
  }
}

/** Rebuilds a bounce's response from its returned_payment (Idempotency-Key replay). */
export async function bounceResult(tenantId: string, returnId: string, companyId?: string): Promise<BounceResult> {
  const [ret] = await db.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, returnId))).limit(1);
  if (!ret || ret.txnType !== 'returned_payment' || ledger.inOtherCompany(ret, companyId)) throw AppError.notFound('Bounce not found');
  const [fee] = await db.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.sourceTxnId, returnId))).limit(1);
  // The bounce posts the held account as its first credit line; discounts and
  // write-offs it reverses come after it (review SF7).
  const [credit] = await db.select({ accountId: journalLines.accountId }).from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, returnId),
      eq(journalLines.isVoidReversal, false), sql`${journalLines.credit} > 0`))
    .orderBy(journalLines.lineOrder).limit(1);
  const pc = await systemAccountId(db, tenantId, 'payments_clearing');
  const res = await db.execute(sql`
    SELECT pa.invoice_id, inv.balance_due FROM payment_applications pa
    JOIN transactions inv ON inv.id = pa.invoice_id AND inv.tenant_id = pa.tenant_id
    WHERE pa.tenant_id = ${tenantId} AND pa.reversed_by_txn_id = ${returnId}
    ORDER BY pa.invoice_id
  `);
  return {
    returnId,
    ...(fee ? { feeId: fee.id } : {}),
    heldIn: { accountId: credit!.accountId, kind: credit!.accountId === pc ? 'payments_clearing' : 'bank' },
    reopened: (res.rows as Array<{ invoice_id: string; balance_due: string }>).map((r) => ({
      invoiceId: r.invoice_id, balanceDue: money2(centBalance(String(r.balance_due))),
    })),
  };
}

/**
 * The returned_payment branch of voidTransactionInTx: re-applies the rows
 * the bounce reversed, under lock (the payment, then its invoices). 409
 * INVOICE_VOIDED when an invoice was voided meanwhile; 409
 * INVOICE_BALANCE_CHANGED when an invoice's balance no longer takes the row
 * back. The bank fee is left alone (its id is returned so a client can
 * offer to void it).
 */
export async function reapplyBounceForVoidInTx(tx: Tx, tenantId: string, ret: TxnRow, userId?: string): Promise<{ feeId: string | null }> {
  if (ret.sourceTxnId) await lockPayments(tx, tenantId, [ret.sourceTxnId]);
  const res0 = await tx.select({ paymentId: paymentApplications.paymentId }).from(paymentApplications)
    .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.reversedByTxnId, ret.id)));
  await lockPayments(tx, tenantId, res0.map((r) => r.paymentId).filter((id) => id !== ret.sourceTxnId));
  const res = await tx.select().from(paymentApplications)
    .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.reversedByTxnId, ret.id)))
    .orderBy(paymentApplications.invoiceId, paymentApplications.id);
  const invoices = await lockInvoices(tx, tenantId, res.map((a) => a.invoiceId));
  for (const a of res) {
    const inv = invoices.get(a.invoiceId);
    if (!inv || inv.status !== 'posted') {
      throw AppError.conflict('An invoice this payment paid was voided since it bounced.', 'INVOICE_VOIDED', { invoiceId: a.invoiceId });
    }
    // A credit row applied inside another payment that is void now (U-133).
    if (a.appliedInTxnId) {
      const [inside] = await tx.select({ status: transactions.status }).from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, a.appliedInTxnId))).limit(1);
      if (!inside || inside.status !== 'posted') {
        throw AppError.conflict('A payment that used this credit was voided since it bounced.', 'CREDIT_SOURCE_CHANGED', { invoiceId: a.invoiceId });
      }
    }
    if (settledBy(a).greaterThan(payableCents(inv))) throw balanceChanged(inv);
    // Only a row this bounce still holds comes back (E-B1).
    const back = await tx.update(paymentApplications).set({ reversedByTxnId: null })
      .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.id, a.id),
        eq(paymentApplications.reversedByTxnId, ret.id), sql`${paymentApplications.voidedAt} IS NULL`))
      .returning({ id: paymentApplications.id });
    if (back.length > 0) Object.assign(inv, await moveInvoicePaid(tx, tenantId, inv, settledBy(a)));
  }
  if (ret.sourceTxnId) {
    await tx.update(transactions).set({ updatedAt: new Date() })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, ret.sourceTxnId)));
  }
  const [fee] = await tx.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.sourceTxnId, ret.id), eq(transactions.status, 'posted'))).limit(1);
  await auditLog(tenantId, 'update', 'payment_applications', ret.sourceTxnId,
    { applications: [], returnId: ret.id }, { applications: res.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })), via: 'void_bounce' },
    userId, tx);
  return { feeId: fee?.id ?? null };
}

// ─── Edit ───────────────────────────────────────────────────────────

/**
 * PUT /payments/:id (Q-P21o), one transaction in the lock order (its
 * deposit, then the payment and credit sources by id, then invoices): the
 * closing date on the old and the new date (updateTransaction), its own
 * live applications and the credits applied inside it set aside and their
 * invoices restored, the header and lines rewritten, the new applications
 * and credits validated and written. Its credit applied later elsewhere
 * stays; the new amount must leave room for it and for refunds (409
 * CREDIT_IN_USE). expectedBalanceDue is the invoice's balance with this
 * payment's own share added back (preview with editingPaymentId returns
 * exactly that). A deposited payment takes memo and refNo only (409
 * TXN_DEPOSITED); a bounced one is read-only (409 PAYMENT_BOUNCED).
 */
export async function updatePayment(
  tenantId: string, paymentId: string, input: ReceivePaymentInput & { expectedUpdatedAt?: string },
  userId?: string, companyId?: string,
): Promise<PaymentRecord> {
  return db.transaction(async (tx) => {
    const parsed = parseSettlement(input);
    // The deposit holding it, then the payment, its credit links and the new
    // credit sources in one batch, read again under the locks (E-B1).
    const { payment, deposit, locked } = await lockPaymentScope(tx, tenantId, paymentId, parsed.credits.map((c) => c.sourcePaymentId));
    if (!payment || payment.txnType !== 'customer_payment' || payment.status === 'deleted' || ledger.inOtherCompany(payment, companyId)) {
      throw AppError.notFound('Payment not found');
    }
    const deposits = deposit ? [{ depositId: deposit.id }] : [];
    if (payment.status !== 'posted') throw AppError.badRequest('Cannot update a void transaction');
    ledger.assertNotStale(payment, input.expectedUpdatedAt, 'This payment');
    if (await liveBounce(tx, tenantId, paymentId)) throw paymentBounced(paymentId);
    if (payment.fromDepositId) {
      throw AppError.badRequest('This payment was applied from a deposit; void it and apply the deposit again.', 'VALIDATION_ERROR');
    }
    if (payment.holdsDeposit !== !!input.holdAsDeposit) {
      throw AppError.badRequest('holdAsDeposit can’t change on an edit; void the payment and enter it again.', 'VALIDATION_ERROR');
    }
    if (payment.holdsDeposit && (await liveDraws(tx, tenantId, paymentId)).length > 0) throw depositApplied(paymentId);
    if (parsed.credits.some((c) => c.sourcePaymentId === paymentId)) {
      throw AppError.badRequest('A payment can’t use its own credit.', 'VALIDATION_ERROR');
    }

    const all = await liveApplications(tx, tenantId, paymentId);
    const own = all.filter((a) => a.appliedDate === null);
    const later = all.filter((a) => a.appliedDate !== null);
    const inside = await creditsAppliedIn(tx, tenantId, paymentId);
    const oldDepositTo = await depositToOf(tx, tenantId, paymentId);
    // A payment that took in no money has nothing to edit against (review SF6).
    if (oldDepositTo === null) throw noMoneyReceived(paymentId);
    const header = { memo: input.memo ?? null, referenceNumber: input.refNo?.trim() || null };
    // Everything but memo and refNo as saved (review E-B2): its own rows with
    // their discount and write-off accounts, the credits applied inside it.
    const newApps = parsed.apps.filter((a) => a.amount.plus(a.discount).plus(a.writeOff).greaterThan(0));
    const sameApps = own.length === newApps.length && newApps.every((a) => own.some((o) => o.invoiceId === a.invoiceId
      && dec(o.amount).equals(a.amount) && dec(o.discountAmount).equals(a.discount) && dec(o.writeOffAmount).equals(a.writeOff)
      && (!a.writeOff.greaterThan(0) || (input.writeOffAccountId ?? o.writeOffAccountId) === o.writeOffAccountId)
      && (!a.discount.greaterThan(0) || (input.discountAccountId ?? o.discountAccountId) === o.discountAccountId)));
    // The credits and the draws on held deposits made inside it, as the record lists them (U-135).
    const insideNow = await creditsInsideRecord(tx, tenantId, paymentId);
    const innerDraws = await tx.select({ id: transactions.id }).from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.sourceTxnId, paymentId),
        eq(transactions.txnType, 'customer_payment'), eq(transactions.status, 'posted')))
      .orderBy(transactions.id);
    const newCredits = parsed.credits.filter((c) => c.amount.greaterThan(0));
    const sameCredits = insideNow.length === newCredits.length && newCredits.every((c) => insideNow.some((o) =>
      o.sourcePaymentId === c.sourcePaymentId && o.invoiceId === c.invoiceId && dec(o.amount).equals(c.amount)));
    const unchanged = dec(payment.total).equals(parsed.amount) && oldDepositTo === input.depositTo && sameApps && sameCredits
      && payment.txnDate === input.date && payment.contactId === input.customerId
      && (input.paymentMethod ?? payment.paymentMethod) === payment.paymentMethod;
    if (deposits.length > 0 && !unchanged) {
      throw AppError.conflict(
        'This payment is in a deposit. Remove it from the deposit first, or record a bounced check.',
        'TXN_DEPOSITED', { depositIds: [...new Set(deposits.map((d) => d.depositId))] },
      );
    }
    if (unchanged) {
      // Memo and refNo only: nothing is set aside, no invoice reopens (review
      // E-B2). It still changes the payment, so its date meets the closing
      // date (review SF4).
      await ledger.checkLockDate(tx, tenantId, payment.txnDate, payment.companyId, undefined, {
        txnId: paymentId, oldDate: payment.txnDate, newDate: payment.txnDate,
      });
      await tx.update(transactions).set({ ...header, updatedAt: new Date() })
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));
      await auditLog(tenantId, 'update', 'transaction', paymentId,
        { memo: payment.memo, referenceNumber: payment.referenceNumber }, header, userId, tx);
      return getPaymentRecord(tx, tenantId, paymentId, companyId);
    }

    // Its credit used elsewhere and refunded stays covered (U-133).
    const drawn = later.reduce((t, a) => t.plus(a.amount), new Decimal(0)).plus(await liveRefundTotal(tx, tenantId, paymentId));
    // ...and stays this client's: no other client while any of it is in use (review SF5).
    if (input.customerId !== payment.contactId && drawn.greaterThan(0)) {
      throw AppError.conflict(
        `${money2(drawn)} of this payment's credit is in use, so it can't move to another client. Unapply or void those first.`,
        'CREDIT_IN_USE', { inUse: money2(drawn) },
      );
    }
    if (parsed.amount.minus(parsed.cash).lessThan(drawn)) {
      throw AppError.conflict(
        `${money2(drawn)} of this payment's credit is in use elsewhere, so the amount can't leave less than that unapplied.`,
        'CREDIT_IN_USE', { inUse: money2(drawn) },
      );
    }

    await assertCustomer(tx, tenantId, input.customerId, companyId);
    await assertDepositAccount(tx, tenantId, input.depositTo, companyId);
    const accounts = await resolveSettleAccounts(tx, tenantId, companyId, input, parsed);
    // The draws made inside it (locked with it, review SF8) are voided before
    // the invoices are read, so the rows below see what the voids restored.
    for (const d of innerDraws) await ledger.voidTransactionInTx(tx, tenantId, d.id, 'Re-made with the edited payment', userId);
    const invoices = await lockInvoices(tx, tenantId, [
      ...own.map((a) => a.invoiceId), ...inside.map((a) => a.invoiceId),
      ...parsed.apps.map((a) => a.invoiceId), ...parsed.credits.map((c) => c.invoiceId),
    ]);
    const now = new Date();
    for (const a of [...own, ...inside]) {
      if (!await retireApplication(tx, tenantId, a.id, { voidedAt: now })) throw scopeChanged(paymentId);
      const inv = invoices.get(a.invoiceId);
      if (inv) Object.assign(inv, await moveInvoicePaid(tx, tenantId, inv, settledBy(a).negated()));
    }
    await validateSources(tx, tenantId, locked, parsed.credits, input.customerId, companyId);
    const valid = validateInvoices(parsed, invoices, input.customerId, companyId);

    const ar = await arAccountId(tx, tenantId);
    if (payment.holdsDeposit && (parsed.apps.length > 0 || parsed.credits.length > 0)) {
      throw AppError.badRequest('A deposit holds the whole amount: leave the invoices and credits out.', 'DEPOSIT_WITH_APPLICATIONS');
    }
    await ledger.updateTransaction(tenantId, paymentId, {
      txnType: 'customer_payment',
      txnDate: input.date,
      contactId: input.customerId,
      memo: input.memo,
      total: parsed.amount.toFixed(4),
      paymentMethod: input.paymentMethod,
      referenceNumber: input.refNo,
      lines: payment.holdsDeposit
        ? [
          { accountId: input.depositTo, debit: parsed.amount.toFixed(4), credit: '0' },
          { accountId: await customerDepositsAccount(tx, tenantId, companyId), debit: '0', credit: parsed.amount.toFixed(4), contactId: input.customerId },
        ]
        : paymentLines(input.depositTo, ar, input.customerId, parsed, accounts),
    }, userId, companyId, tx);
    await writeSettlement(tx, tenantId, companyId, paymentId, input.date, valid, accounts, locked, userId);
    await auditLog(tenantId, 'update', 'payment_applications', paymentId,
      { applications: [...own, ...inside].map((a) => ({ paymentId: a.paymentId, invoiceId: a.invoiceId, amount: a.amount, discount: a.discountAmount, writeOff: a.writeOffAmount })) },
      {
        applications: valid.apps.map((v) => ({ invoiceId: v.inv.id, amount: v.amount.toFixed(4), discount: v.discount.toFixed(4), writeOff: v.writeOff.toFixed(4) })),
        credits: valid.credits.map((c) => ({ sourcePaymentId: c.sourcePaymentId, invoiceId: c.inv.id, amount: c.amount.toFixed(4) })),
        via: 'edit',
      }, userId, tx);
    return getPaymentRecord(tx, tenantId, paymentId, companyId);
  });
}

// ─── Apply a credit later ───────────────────────────────────────────

export interface ApplyCreditResult { applied: Array<{ invoiceId: string; amount: string }>; remaining: string; drawId?: string }

/**
 * POST /payments/:id/apply (U-133): applies a payment's unapplied credit to
 * the same client's invoices on `date`, with no GL effect (the A/R credit
 * meets the invoice's A/R debit). The payment is locked, then the invoices;
 * a row without an amount fills min(credit left, cent balance). Over the
 * credit is 409 CREDIT_NOT_AVAILABLE; a bounced payment 409 PAYMENT_BOUNCED;
 * the closing date applies to `date`. Audited.
 */
export async function applyCredit(
  tenantId: string, paymentId: string, input: ApplyPaymentCreditInput, userId?: string, companyId?: string,
): Promise<ApplyCreditResult> {
  return db.transaction(async (tx) => {
    const { claimAndRecord } = await import('./idempotency.service.js');
    await claimAndRecord(tx, 'transaction', paymentId);
    const payment = (await lockPayments(tx, tenantId, [paymentId])).get(paymentId);
    if (!payment || payment.txnType !== 'customer_payment' || payment.status === 'deleted' || ledger.inOtherCompany(payment, companyId)) {
      throw AppError.notFound('Payment not found');
    }
    if (payment.status !== 'posted') throw AppError.badRequest('This payment is void.');
    ledger.assertNotStale(payment, input.expectedUpdatedAt, 'This payment');
    if (await liveBounce(tx, tenantId, paymentId)) throw paymentBounced(paymentId);
    if (input.applications.length > MAX_APPLICATIONS) {
      throw AppError.badRequest(`At most ${MAX_APPLICATIONS} invoices per payment.`, 'TOO_MANY_APPLICATIONS', { max: MAX_APPLICATIONS });
    }
    await ledger.checkLockDate(tx, tenantId, input.date, payment.companyId, undefined, { txnId: paymentId, oldDate: null, newDate: input.date });
    if (payment.fromDepositId) throw AppError.badRequest('This payment was applied from a deposit already.', 'VALIDATION_ERROR');
    let left = await creditRemaining(tx, tenantId, payment);
    const invoices = await lockInvoices(tx, tenantId, input.applications.map((a) => a.invoiceId));
    const drawRows: Array<{ inv: TxnRow; amount: DecimalValue }> = [];
    const seen = new Set<string>();
    const applied: ApplyCreditResult['applied'] = [];
    for (const a of input.applications) {
      if (seen.has(a.invoiceId)) throw AppError.badRequest('An invoice is listed twice.', 'VALIDATION_ERROR', { invoiceId: a.invoiceId });
      seen.add(a.invoiceId);
      const inv = checkInvoice(invoices.get(a.invoiceId), a.invoiceId, a.expectedBalanceDue, payment.contactId ?? '', companyId);
      const cap = payableCents(inv);
      const x = a.amount === undefined ? Decimal.min(left, cap) : wholeCents(a.amount, 'applications[].amount');
      if (x.greaterThan(cap)) {
        throw AppError.badRequest(
          `The credit on invoice ${inv.txnNumber || inv.id} (${money2(x)}) is more than its balance due (${money2(cap)}).`,
          'OVERAPPLIED', { invoiceId: inv.id, balanceDue: money2(cap) },
        );
      }
      if (x.greaterThan(left)) {
        throw AppError.conflict(`Only ${money2(left)} of this ${payment.holdsDeposit ? 'deposit' : 'credit'} is left.`,
          payment.holdsDeposit ? 'DEPOSIT_NOT_AVAILABLE' : 'CREDIT_NOT_AVAILABLE',
          { sourcePaymentId: paymentId, remaining: money2(left) });
      }
      if (!x.greaterThan(0)) continue;
      if (payment.holdsDeposit) {
        drawRows.push({ inv, amount: x });
        left = left.minus(x);
        applied.push({ invoiceId: inv.id, amount: money2(x) });
        continue;
      }
      await tx.insert(paymentApplications).values({
        tenantId, companyId: companyId ?? inv.companyId ?? null, paymentId, invoiceId: inv.id,
        amount: x.toFixed(4), appliedDate: input.date,
      });
      Object.assign(inv, await moveInvoicePaid(tx, tenantId, inv, x));
      left = left.minus(x);
      applied.push({ invoiceId: inv.id, amount: money2(x) });
    }
    let drawId: string | undefined;
    if (drawRows.length > 0) drawId = await postDraw(tx, tenantId, payment, input.date, drawRows, null, userId, companyId);
    await tx.update(transactions).set({ updatedAt: new Date() })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));
    await auditLog(tenantId, 'update', 'payment_applications', paymentId,
      { applications: [] }, { applications: applied, via: payment.holdsDeposit ? 'apply_deposit' : 'apply_credit', date: input.date, drawId: drawId ?? null }, userId, tx);
    return { applied, remaining: money2(left), ...(drawId ? { drawId } : {}) };
  });
}

// ─── Pending deposits ───────────────────────────────────────────────

/**
 * Items waiting in Payments Clearing to be deposited (U-52): every posted
 * transaction whose lines hold a net debit on the Payments Clearing account
 * and that no posted deposit settles yet. One row per transaction, its
 * amount the net clearing debit (what a grouped deposit line must equal).
 * Void and deleted transactions are left out, and so is a payment with a
 * live bounce (U-132: its returned_payment took the money back out of
 * Payments Clearing); with a company, items of another company are too
 * (legacy rows without a company stay visible).
 *
 * Amounts are numbers by default (the web page); `exact` returns them as
 * 4-place decimal strings (deposit-grouping-v1).
 */
export async function getPendingDeposits(
  tenantId: string,
  opts: { companyId?: string; exact?: boolean } = {},
) {
  const items = await listPendingDepositItems(tenantId, { companyId: opts.companyId });
  const balance = items.reduce((s, i) => s.plus(i.amount), new Decimal('0'));
  if (opts.exact) {
    return { paymentsClearingBalance: balance.toFixed(4), items };
  }
  // Keep amounts as numbers for the existing web contract, summed through
  // Decimal so the Payments Clearing tile doesn't drift.
  return {
    paymentsClearingBalance: Number(balance.toFixed(4)),
    items: items.map((i) => ({ ...i, amount: Number(i.amount) })),
  };
}

export interface PendingDepositRow {
  transactionId: string;
  txnType: string;
  date: string;
  customerName: string | null;
  contactId: string | null;
  refNo: string | null;
  paymentMethod: string | null;
  memo: string | null;
  /** Undeposited amount, 4-place decimal string. */
  amount: string;
}

/** Shared by the pending list and the bank-feed deposit suggestions (U-56). */
export async function listPendingDepositItems(
  tenantId: string,
  opts: { companyId?: string; from?: string; to?: string } = {},
): Promise<PendingDepositRow[]> {
  const pcAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'payments_clearing')),
  });
  if (!pcAccount) return [];

  const companyCond = opts.companyId
    ? sql`AND (t.company_id = ${opts.companyId} OR t.company_id IS NULL)`
    : sql``;
  const fromCond = opts.from ? sql`AND t.txn_date >= ${opts.from}` : sql``;
  const toCond = opts.to ? sql`AND t.txn_date <= ${opts.to}` : sql``;
  const rows = await db.execute(sql`
    SELECT t.id AS transaction_id, t.txn_type,
      to_char(t.txn_date, 'YYYY-MM-DD') AS date,
      COALESCE(t.reference_number, t.txn_number) AS ref_no, t.payment_method, t.memo,
      t.contact_id, c.display_name AS customer_name,
      net.amount
    FROM (
      SELECT jl.transaction_id, SUM(jl.debit - jl.credit) AS amount
      FROM journal_lines jl
      WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${pcAccount.id}
        AND jl.is_void_reversal = false
      GROUP BY jl.transaction_id
      HAVING SUM(jl.debit - jl.credit) > 0
    ) net
    JOIN transactions t ON t.id = net.transaction_id AND t.tenant_id = ${tenantId}
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE t.status = 'posted'
      ${companyCond} ${fromCond} ${toCond}
      AND NOT EXISTS (
        SELECT 1 FROM deposit_lines dl
        JOIN transactions d ON d.id = dl.deposit_id
        WHERE dl.source_transaction_id = t.id
          AND d.tenant_id = ${tenantId} AND d.status = 'posted'
      )
      AND NOT EXISTS (
        SELECT 1 FROM transactions r
        WHERE r.tenant_id = ${tenantId} AND r.source_txn_id = t.id
          AND r.txn_type = 'returned_payment' AND r.status = 'posted'
      )
    ORDER BY t.txn_date ASC, t.created_at ASC, t.id ASC
  `);

  return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
    transactionId: String(r['transaction_id']),
    txnType: String(r['txn_type']),
    date: String(r['date']),
    customerName: (r['customer_name'] as string | null) ?? null,
    contactId: (r['contact_id'] as string | null) ?? null,
    refNo: (r['ref_no'] as string | null) ?? null,
    paymentMethod: (r['payment_method'] as string | null) ?? null,
    memo: (r['memo'] as string | null) ?? null,
    amount: new Decimal(String(r['amount'] ?? '0')).toFixed(4),
  }));
}
