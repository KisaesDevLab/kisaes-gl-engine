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
  ReceivePaymentInput, PreviewPaymentInput, BouncePaymentInput, ListPaymentsQuery, PaymentMethod,
} from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { transactions, accounts, paymentApplications, companies, contacts, journalLines } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { auditLog } from '../middleware/audit.js';
import { liveDepositsForSource } from './deposit-links.service.js';
import { getBalances } from './contacts.service.js';
import {
  computePayment, centBalance, round2, dec, money2, MAX_APPLICATIONS, type ComputeInvoice, type ComputeProblem,
} from './payment-compute.js';

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
  voidedAt: Date | null;
  reversedByTxnId: string | null;
}

async function liveApplications(executor: DbOrTx, tenantId: string, paymentId: string): Promise<AppRow[]> {
  return executor.select({
    id: paymentApplications.id, paymentId: paymentApplications.paymentId, invoiceId: paymentApplications.invoiceId,
    amount: paymentApplications.amount, voidedAt: paymentApplications.voidedAt, reversedByTxnId: paymentApplications.reversedByTxnId,
  }).from(paymentApplications)
    .where(and(
      eq(paymentApplications.tenantId, tenantId),
      eq(paymentApplications.paymentId, paymentId),
      sql`${paymentApplications.voidedAt} IS NULL AND ${paymentApplications.reversedByTxnId} IS NULL`,
    ))
    .orderBy(paymentApplications.invoiceId, paymentApplications.id);
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

export interface ReceiveApplication { invoiceId: string; amount: string; expectedBalanceDue?: string }

export interface ReceiveOptions {
  /** Stripe and bank-feed paths: applications may be empty (all unapplied). */
  allowUnapplied?: boolean;
  /** POST /invoices/:id/payment: stamp applied_to_invoice_id as before. */
  appliedToInvoiceId?: string;
}

interface ValidatedApplication { inv: TxnRow; amount: DecimalValue }

/** Validates applications against locked invoices: customer, company, expected balance, exact overapply. */
function validateApplications(
  apps: ReceiveApplication[],
  invoices: Map<string, TxnRow>,
  customerId: string,
  companyId: string | undefined,
): ValidatedApplication[] {
  const out: ValidatedApplication[] = [];
  for (const app of apps) {
    const inv = invoices.get(app.invoiceId);
    if (!inv || inv.txnType !== 'invoice' || inv.status === 'deleted' || ledger.inOtherCompany(inv, companyId)) {
      throw AppError.notFound(`Invoice ${app.invoiceId} not found`);
    }
    if (inv.contactId !== customerId) {
      throw AppError.badRequest('That invoice belongs to another client.', 'INVOICE_NOT_FOR_CUSTOMER', { invoiceId: inv.id });
    }
    if (app.expectedBalanceDue !== undefined && !dec(app.expectedBalanceDue).equals(dec(inv.balanceDue))) {
      throw balanceChanged(inv);
    }
    const c = wholeCents(app.amount, 'applications[].amount');
    const cap = payableCents(inv);
    if (c.greaterThan(cap)) {
      throw AppError.badRequest(
        `The payment on invoice ${inv.txnNumber || inv.id} (${money2(c)}) is more than its balance due (${money2(cap)}).`,
        'OVERAPPLIED',
        { invoiceId: inv.id, balanceDue: money2(cap) },
      );
    }
    if (c.greaterThan(0)) out.push({ inv, amount: c });
  }
  return out;
}

function checkApplicationShape(apps: ReceiveApplication[]) {
  if (apps.length > MAX_APPLICATIONS) {
    throw AppError.badRequest(`At most ${MAX_APPLICATIONS} invoices per payment.`, 'TOO_MANY_APPLICATIONS', { max: MAX_APPLICATIONS });
  }
  const seen = new Set<string>();
  for (const a of apps) {
    if (seen.has(a.invoiceId)) throw AppError.badRequest('An invoice is listed twice.', 'VALIDATION_ERROR', { invoiceId: a.invoiceId });
    seen.add(a.invoiceId);
  }
}

async function writeApplications(
  tx: Tx, tenantId: string, companyId: string | undefined, paymentId: string, apps: ValidatedApplication[],
): Promise<void> {
  for (const { inv, amount } of apps) {
    await tx.insert(paymentApplications).values({
      tenantId, companyId: companyId ?? inv.companyId ?? null, paymentId, invoiceId: inv.id, amount: amount.toFixed(4),
    });
    const updated = await moveInvoicePaid(tx, tenantId, inv, amount);
    Object.assign(inv, updated);
  }
}

/**
 * Receives a payment in the caller's database transaction: validation,
 * the ledger post (Dr depositTo, Cr A/R) and the applications, atomically.
 * Σ applications <= amount; the rest stays an A/R credit on the client.
 */
export async function receivePaymentInTx(
  tx: Tx,
  tenantId: string,
  input: ReceivePaymentInput,
  userId?: string,
  companyId?: string,
  opts: ReceiveOptions = {},
) {
  const amount = wholeCents(input.amount, 'amount');
  if (!amount.greaterThan(0)) throw AppError.badRequest('Enter the amount received.', 'AMOUNT_REQUIRED');
  const apps = (input.applications ?? []) as ReceiveApplication[];
  if (apps.length === 0 && !opts.allowUnapplied) {
    throw AppError.badRequest('Choose at least one invoice to apply the payment to.', 'VALIDATION_ERROR');
  }
  checkApplicationShape(apps);
  const applied = apps.reduce((s, a) => s.plus(wholeCents(a.amount, 'applications[].amount')), new Decimal(0));
  if (applied.greaterThan(amount)) {
    throw AppError.badRequest(
      `The amounts applied (${money2(applied)}) are more than the payment (${money2(amount)}).`,
      'APPLICATIONS_EXCEED_AMOUNT',
      { applied: money2(applied), amount: money2(amount) },
    );
  }
  await assertCustomer(tx, tenantId, input.customerId, companyId);
  await assertDepositAccount(tx, tenantId, input.depositTo, companyId);
  const ar = await arAccountId(tx, tenantId);

  const invoices = await lockInvoices(tx, tenantId, apps.map((a) => a.invoiceId));
  const valid = validateApplications(apps, invoices, input.customerId, companyId);

  const amountStr = amount.toFixed(4);
  const payment = await ledger.postTransaction(tenantId, {
    txnType: 'customer_payment',
    txnDate: input.date,
    contactId: input.customerId,
    memo: input.memo,
    total: amountStr,
    paymentMethod: input.paymentMethod,
    referenceNumber: input.refNo,
    appliedToInvoiceId: opts.appliedToInvoiceId && valid.length > 0 ? opts.appliedToInvoiceId : undefined,
    lines: [
      { accountId: input.depositTo, debit: amountStr, credit: '0' },
      { accountId: ar, debit: '0', credit: amountStr, contactId: input.customerId },
    ],
  }, userId, companyId, tx);

  await writeApplications(tx, tenantId, companyId, payment.id, valid);
  return payment;
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
  voided: boolean;
  reversed: boolean;
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
  unappliedRemaining: string;
  holdsDeposit: boolean;
  depositRemaining: string;
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

/** The account a payment was deposited to: its debit line that is not A/R. */
async function depositToOf(executor: DbOrTx, tenantId: string, paymentId: string): Promise<string | null> {
  const res = await executor.execute(sql`
    SELECT jl.account_id FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND jl.transaction_id = ${paymentId} AND jl.is_void_reversal = false
      AND jl.debit > 0 AND a.system_tag IS DISTINCT FROM 'accounts_receivable'
    ORDER BY jl.line_order LIMIT 1
  `);
  return (res.rows as Array<{ account_id: string }>)[0]?.account_id ?? null;
}

export async function getPaymentRecord(executor: DbOrTx, tenantId: string, paymentId: string, companyId?: string): Promise<PaymentRecord> {
  const p = await loadPayment(executor, tenantId, paymentId, companyId);
  const appsRes = await executor.execute(sql`
    SELECT pa.invoice_id, inv.txn_number, pa.amount, pa.voided_at, pa.reversed_by_txn_id
    FROM payment_applications pa
    LEFT JOIN transactions inv ON inv.id = pa.invoice_id AND inv.tenant_id = pa.tenant_id
    WHERE pa.tenant_id = ${tenantId} AND pa.payment_id = ${paymentId}
    ORDER BY pa.created_at, inv.txn_date, inv.txn_number, pa.id
  `);
  const apps = (appsRes.rows as Array<Record<string, unknown>>).map((r) => ({
    invoiceId: String(r['invoice_id']),
    invoiceNumber: (r['txn_number'] as string | null) ?? null,
    amount: money2(round2(String(r['amount']))),
    discount: '0.00',
    writeOff: '0.00',
    appliedDate: p.txnDate,
    voided: r['voided_at'] != null,
    reversed: r['reversed_by_txn_id'] != null,
  }));
  const deposits = await liveDepositsForSource(executor, tenantId, paymentId);
  let depositedIn: PaymentRecord['depositedIn'];
  if (deposits[0]) {
    const [d] = await executor.select({ id: transactions.id, txnDate: transactions.txnDate }).from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, deposits[0].depositId))).limit(1);
    if (d) depositedIn = { depositId: d.id, date: d.txnDate };
  }
  const bounce = await liveBounce(executor, tenantId, paymentId);
  const liveSum = (await liveApplications(executor, tenantId, paymentId)).reduce((s, a) => s.plus(a.amount), new Decimal(0));
  const remaining = p.status !== 'posted' || bounce ? new Decimal(0) : Decimal.max(dec(p.total).minus(liveSum), 0);
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
    unappliedRemaining: money2(round2(remaining)),
    holdsDeposit: false,
    depositRemaining: '0.00',
  };
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
                AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL), 0)::text AS applied
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
    const remaining = posted && !bounced ? Decimal.max(dec(String(r['total'] ?? '0')).minus(String(r['applied'])), 0) : new Decimal(0);
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
export async function getOpenInvoicesForCustomer(tenantId: string, customerId: string, companyId?: string) {
  await assertCustomer(db, tenantId, customerId, companyId);
  const rows = await openInvoiceRows(db, tenantId, customerId, companyId);
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
           total, amount_paid, balance_due, invoice_status
    FROM transactions
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
      SELECT inv.txn_date AS inv_date, MAX(p.txn_date) AS cleared
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
  let ownAmount = new Decimal(0);
  if (input.editingPaymentId) {
    const p = await loadPayment(db, tenantId, input.editingPaymentId, companyId);
    if (p.status === 'posted') {
      ownAmount = dec(p.total);
      for (const a of await liveApplications(db, tenantId, p.id)) own.set(a.invoiceId, (own.get(a.invoiceId) ?? new Decimal(0)).plus(a.amount));
      if (await liveBounce(db, tenantId, p.id)) problems.push({ code: 'PAYMENT_BOUNCED' });
    }
  }
  const rows = await openInvoiceRows(db, tenantId, input.customerId, companyId, [...own.keys()]);
  const compute: ComputeInvoice[] = rows.map((r) => {
    const share = own.get(r.invoiceId);
    return share ? { ...r, balanceDueExact: dec(r.balanceDueExact).plus(share).toFixed(4) } : r;
  });
  const result = computePayment(compute, {
    amount: input.amount ?? null,
    applications: input.applications ?? null,
  });
  problems.unshift(...result.problems);
  if ((input.applications?.length ?? 0) > MAX_APPLICATIONS) problems.push({ code: 'TOO_MANY_APPLICATIONS' });

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
    contactBalanceAfter: money2(round2(before.minus(amount))),
    amount: result.amount,
    amountSource: result.amountSource,
    invoices: result.invoices,
    totals: result.totals,
    shortfalls: result.shortfalls,
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
  const apps = await liveApplications(tx, tenantId, payment.id);
  if (apps.length === 0) return;
  const invoices = await lockInvoices(tx, tenantId, apps.map((a) => a.invoiceId));
  const now = new Date();
  for (const a of apps) {
    const inv = invoices.get(a.invoiceId);
    if (inv) Object.assign(inv, await moveInvoicePaid(tx, tenantId, inv, dec(a.amount).negated()));
    await tx.update(paymentApplications).set({ voidedAt: now })
      .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.id, a.id)));
  }
  await auditLog(tenantId, 'update', 'payment_applications', payment.id,
    { applications: apps.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) },
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
    const deposits = await liveDepositsForSource(tx, tenantId, paymentId);
    if (deposits[0]) await lockPayments(tx, tenantId, [deposits[0].depositId]);
    const payment = (await lockPayments(tx, tenantId, [paymentId])).get(paymentId);
    if (!payment || payment.txnType !== 'customer_payment' || payment.status === 'deleted' || ledger.inOtherCompany(payment, opts.companyId)) {
      throw AppError.notFound('Payment not found');
    }
    if (payment.status !== 'posted') throw AppError.badRequest('This payment is void.');
    ledger.assertNotStale(payment, opts.expectedUpdatedAt, 'This payment');
    if (await liveBounce(tx, tenantId, paymentId)) throw paymentBounced(paymentId);
    const app = (await liveApplications(tx, tenantId, paymentId)).find((a) => a.invoiceId === invoiceId);
    if (!app) throw AppError.notFound('Payment application not found');
    await ledger.checkLockDate(tx, tenantId, payment.txnDate, payment.companyId, undefined, {
      txnId: payment.id, oldDate: payment.txnDate, newDate: payment.txnDate,
    });
    const inv = (await lockInvoices(tx, tenantId, [invoiceId])).get(invoiceId);
    if (inv) await moveInvoicePaid(tx, tenantId, inv, dec(app.amount).negated());
    await tx.update(paymentApplications).set({ voidedAt: new Date() })
      .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.id, app.id)));
    await tx.update(transactions).set({ updatedAt: new Date() })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));
    await auditLog(tenantId, 'update', 'payment_applications', paymentId,
      { applications: [{ invoiceId, amount: app.amount }] }, { applications: [], via: 'unapply', invoiceId }, opts.userId, tx);
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
  if (!to) throw AppError.internal('Payment has no deposit line');
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
  return db.transaction(async (tx) => {
    // Lock order: the deposit holding the payment, the payment, its invoices.
    const deposits = await liveDepositsForSource(tx, tenantId, paymentId);
    const depositId = deposits[0]?.depositId ?? null;
    const depositRow = depositId ? (await lockPayments(tx, tenantId, [depositId])).get(depositId) : undefined;
    const payment = (await lockPayments(tx, tenantId, [paymentId])).get(paymentId);
    if (!payment || payment.txnType !== 'customer_payment' || payment.status === 'deleted' || ledger.inOtherCompany(payment, companyId)) {
      throw AppError.notFound('Payment not found');
    }
    if (payment.status !== 'posted') throw AppError.badRequest('This payment is void.');
    ledger.assertNotStale(payment, input.expectedUpdatedAt, 'This payment');
    if (await liveBounce(tx, tenantId, paymentId)) throw paymentBounced(paymentId);
    if (input.date < payment.txnDate || (depositRow && input.date < depositRow.txnDate)) {
      throw AppError.badRequest(
        'The bounce date can’t be before the payment date or the date it was deposited.',
        'BOUNCE_DATE_INVALID',
        { paymentDate: payment.txnDate, depositDate: depositRow?.txnDate ?? null },
      );
    }

    const held = await heldIn(tx, tenantId, paymentId, depositRow ? depositId : null);
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
      await assertFeeAccount(tx, tenantId, feeAccount, companyId ?? payment.companyId, [held.accountId]);
      if (held.kind === 'bank') feeBank = held.accountId;
      else {
        if (!input.bankFeeBankAccountId) {
          throw AppError.badRequest('Choose the bank account the bank took its fee from.', 'FEE_BANK_REQUIRED');
        }
        await assertDepositAccount(tx, tenantId, input.bankFeeBankAccountId, companyId ?? payment.companyId ?? undefined);
        feeBank = input.bankFeeBankAccountId;
      }
    }

    const apps = await liveApplications(tx, tenantId, paymentId);
    const invoices = await lockInvoices(tx, tenantId, apps.map((a) => a.invoiceId));
    const ar = await arAccountId(tx, tenantId);
    const amount = dec(payment.total).toFixed(4);
    const scope = companyId ?? payment.companyId ?? undefined;

    const ret = await ledger.postTransaction(tenantId, {
      txnType: 'returned_payment',
      txnDate: input.date,
      contactId: payment.contactId ?? undefined,
      memo: input.memo ?? `Bounced payment${payment.referenceNumber ? ` ${payment.referenceNumber}` : ''}`,
      total: amount,
      referenceNumber: payment.referenceNumber ?? undefined,
      paymentMethod: (payment.paymentMethod ?? undefined) as PaymentMethod | undefined,
      sourceTxnId: paymentId,
      lines: [
        { accountId: ar, debit: amount, credit: '0', contactId: payment.contactId ?? undefined },
        { accountId: held.accountId, debit: '0', credit: amount },
      ],
    }, userId, scope, tx);

    const reopened: BounceResult['reopened'] = [];
    for (const a of apps) {
      const inv = invoices.get(a.invoiceId);
      if (inv) {
        const updated = await moveInvoicePaid(tx, tenantId, inv, dec(a.amount).negated());
        Object.assign(inv, updated);
        reopened.push({ invoiceId: inv.id, balanceDue: money2(centBalance(updated.balanceDue ?? '0')) });
      }
      await tx.update(paymentApplications).set({ reversedByTxnId: ret.id })
        .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.id, a.id)));
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
  });
}

/** Rebuilds a bounce's response from its returned_payment (Idempotency-Key replay). */
export async function bounceResult(tenantId: string, returnId: string, companyId?: string): Promise<BounceResult> {
  const [ret] = await db.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, returnId))).limit(1);
  if (!ret || ret.txnType !== 'returned_payment' || ledger.inOtherCompany(ret, companyId)) throw AppError.notFound('Bounce not found');
  const [fee] = await db.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.sourceTxnId, returnId))).limit(1);
  const [credit] = await db.select({ accountId: journalLines.accountId }).from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, returnId),
      eq(journalLines.isVoidReversal, false), sql`${journalLines.credit} > 0`)).limit(1);
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
  const res = await tx.select().from(paymentApplications)
    .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.reversedByTxnId, ret.id)))
    .orderBy(paymentApplications.invoiceId, paymentApplications.id);
  const invoices = await lockInvoices(tx, tenantId, res.map((a) => a.invoiceId));
  for (const a of res) {
    const inv = invoices.get(a.invoiceId);
    if (!inv || inv.status !== 'posted') {
      throw AppError.conflict('An invoice this payment paid was voided since it bounced.', 'INVOICE_VOIDED', { invoiceId: a.invoiceId });
    }
    if (dec(a.amount).greaterThan(payableCents(inv))) throw balanceChanged(inv);
    Object.assign(inv, await moveInvoicePaid(tx, tenantId, inv, dec(a.amount)));
    await tx.update(paymentApplications).set({ reversedByTxnId: null })
      .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.id, a.id)));
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
 * PUT /payments/:id (Q-P21o), one transaction in the lock order: closing
 * date on the old and the new date (updateTransaction), the old live
 * applications voided and their invoices restored, the header and lines
 * rewritten, the new applications validated and written.
 * expectedBalanceDue is the invoice's balance with this payment's own share
 * added back (preview with editingPaymentId returns exactly that).
 * A deposited payment takes memo and refNo only (409 TXN_DEPOSITED); a
 * bounced one is read-only (409 PAYMENT_BOUNCED).
 */
export async function updatePayment(
  tenantId: string, paymentId: string, input: ReceivePaymentInput & { expectedUpdatedAt?: string },
  userId?: string, companyId?: string,
): Promise<PaymentRecord> {
  return db.transaction(async (tx) => {
    const deposits = await liveDepositsForSource(tx, tenantId, paymentId);
    if (deposits[0]) await lockPayments(tx, tenantId, [deposits[0].depositId]);
    const payment = (await lockPayments(tx, tenantId, [paymentId])).get(paymentId);
    if (!payment || payment.txnType !== 'customer_payment' || payment.status === 'deleted' || ledger.inOtherCompany(payment, companyId)) {
      throw AppError.notFound('Payment not found');
    }
    if (payment.status !== 'posted') throw AppError.badRequest('Cannot update a void transaction');
    ledger.assertNotStale(payment, input.expectedUpdatedAt, 'This payment');
    if (await liveBounce(tx, tenantId, paymentId)) throw paymentBounced(paymentId);

    const amount = wholeCents(input.amount, 'amount');
    if (!amount.greaterThan(0)) throw AppError.badRequest('Enter the amount received.', 'AMOUNT_REQUIRED');
    const apps = (input.applications ?? []) as ReceiveApplication[];
    if (apps.length === 0) throw AppError.badRequest('Choose at least one invoice to apply the payment to.', 'VALIDATION_ERROR');
    checkApplicationShape(apps);
    const applied = apps.reduce((s, a) => s.plus(wholeCents(a.amount, 'applications[].amount')), new Decimal(0));
    if (applied.greaterThan(amount)) {
      throw AppError.badRequest(
        `The amounts applied (${money2(applied)}) are more than the payment (${money2(amount)}).`,
        'APPLICATIONS_EXCEED_AMOUNT', { applied: money2(applied), amount: money2(amount) },
      );
    }

    const old = await liveApplications(tx, tenantId, paymentId);
    const oldDepositTo = await depositToOf(tx, tenantId, paymentId);
    const header = { memo: input.memo ?? null, referenceNumber: input.refNo?.trim() || null };
    if (deposits.length > 0) {
      const sameApps = old.length === apps.filter((a) => dec(a.amount).greaterThan(0)).length
        && apps.every((a) => !dec(a.amount).greaterThan(0) || old.some((o) => o.invoiceId === a.invoiceId && dec(o.amount).equals(a.amount)));
      const unchanged = dec(payment.total).equals(amount) && oldDepositTo === input.depositTo && sameApps
        && payment.txnDate === input.date && payment.contactId === input.customerId
        && (input.paymentMethod ?? payment.paymentMethod) === payment.paymentMethod;
      if (!unchanged) {
        throw AppError.conflict(
          'This payment is in a deposit. Remove it from the deposit first, or record a bounced check.',
          'TXN_DEPOSITED', { depositIds: [...new Set(deposits.map((d) => d.depositId))] },
        );
      }
      await tx.update(transactions).set({ ...header, updatedAt: new Date() })
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));
      await auditLog(tenantId, 'update', 'transaction', paymentId,
        { memo: payment.memo, referenceNumber: payment.referenceNumber }, header, userId, tx);
      return getPaymentRecord(tx, tenantId, paymentId, companyId);
    }

    await assertCustomer(tx, tenantId, input.customerId, companyId);
    await assertDepositAccount(tx, tenantId, input.depositTo, companyId);
    const invoices = await lockInvoices(tx, tenantId, [...old.map((a) => a.invoiceId), ...apps.map((a) => a.invoiceId)]);
    const now = new Date();
    for (const a of old) {
      const inv = invoices.get(a.invoiceId);
      if (inv) Object.assign(inv, await moveInvoicePaid(tx, tenantId, inv, dec(a.amount).negated()));
      await tx.update(paymentApplications).set({ voidedAt: now })
        .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.id, a.id)));
    }
    const valid = validateApplications(apps, invoices, input.customerId, companyId);

    const ar = await arAccountId(tx, tenantId);
    const amountStr = amount.toFixed(4);
    await ledger.updateTransaction(tenantId, paymentId, {
      txnType: 'customer_payment',
      txnDate: input.date,
      contactId: input.customerId,
      memo: input.memo,
      total: amountStr,
      paymentMethod: input.paymentMethod,
      referenceNumber: input.refNo,
      lines: [
        { accountId: input.depositTo, debit: amountStr, credit: '0' },
        { accountId: ar, debit: '0', credit: amountStr, contactId: input.customerId },
      ],
    }, userId, companyId, tx);
    await writeApplications(tx, tenantId, companyId, paymentId, valid);
    await auditLog(tenantId, 'update', 'payment_applications', paymentId,
      { applications: old.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) },
      { applications: valid.map((v) => ({ invoiceId: v.inv.id, amount: v.amount.toFixed(4) })), via: 'edit' }, userId, tx);
    return getPaymentRecord(tx, tenantId, paymentId, companyId);
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
