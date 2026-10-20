// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import type { ReceivePaymentInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, accounts, paymentApplications } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { auditLog } from '../middleware/audit.js';

// Tolerance for overapplication / paid-off checks. Covers tax rounding
// at 4 decimal places (0.0001) × a few lines, plus the historic 1¢
// grace that bookkeepers expect.
const OVERAPPLY_TOLERANCE = new Decimal('0.01');

export async function receivePayment(tenantId: string, input: ReceivePaymentInput, userId?: string, companyId?: string) {
  // Get AR account (read outside tx — it's a stable lookup)
  const arAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')),
  });
  if (!arAccount) throw AppError.internal('AR account not found');

  // Create the payment transaction first (its own atomic ledger tx).
  // If the application/allocation step below fails, the payment header
  // remains posted but with zero applications — recoverable by editing.
  // The previous version had the same property. The critical fix here is
  // making the application step ITSELF atomic so concurrent payments to
  // the same invoice can't both read+write the same balance.
  const payment = await ledger.postTransaction(tenantId, {
    txnType: 'customer_payment',
    txnDate: input.date,
    contactId: input.customerId,
    memo: input.memo,
    total: input.amount,
    paymentMethod: input.paymentMethod,
    referenceNumber: input.refNo,
    lines: [
      { accountId: input.depositTo, debit: input.amount, credit: '0' },
      { accountId: arAccount.id, debit: '0', credit: input.amount },
    ],
  }, userId, companyId);

  // Apply the payment to invoices atomically. For each application:
  //   1. Lock the invoice row (SELECT … FOR UPDATE) so no other
  //      receivePayment / unapplyPayment / updateTransaction can
  //      interleave with our read-then-write of amountPaid.
  //   2. Re-check that the application doesn't overapply. The previous
  //      version had no overapplication guard at all — two concurrent
  //      partial payments could each individually validate and combined
  //      exceed the invoice total, leaving balance_due negative.
  //   3. Insert the payment_applications row and update the invoice
  //      header in the same database transaction.
  await db.transaction(async (tx) => {
    for (const app of input.applications) {
      const [invoice] = await tx.select().from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, app.invoiceId)))
        .for('update')
        .limit(1);

      if (!invoice) {
        throw AppError.notFound(`Invoice ${app.invoiceId} not found`);
      }

      const currentPaid = new Decimal(invoice.amountPaid || '0');
      const invoiceTotal = new Decimal(invoice.total || '0');
      const applyAmount = new Decimal(app.amount);
      const newPaid = currentPaid.plus(applyAmount);

      // Overapplication guard (Decimal math — no IEEE754 slop across
      // repeated partial payments).
      if (newPaid.minus(invoiceTotal).greaterThan(OVERAPPLY_TOLERANCE)) {
        throw AppError.badRequest(
          `Payment of ${applyAmount.toFixed(2)} would overapply invoice ` +
          `${invoice.txnNumber || invoice.id}: current paid ${currentPaid.toFixed(2)}, ` +
          `total ${invoiceTotal.toFixed(2)}, max remaining ${invoiceTotal.minus(currentPaid).toFixed(2)}`,
        );
      }

      let newBalance = invoiceTotal.minus(newPaid);
      if (newBalance.isNegative()) newBalance = new Decimal('0');
      const invoiceStatus = newBalance.lessThanOrEqualTo(OVERAPPLY_TOLERANCE) ? 'paid' : 'partial';

      await tx.insert(paymentApplications).values({
        tenantId,
        paymentId: payment.id,
        invoiceId: app.invoiceId,
        amount: app.amount,
      });

      await tx.update(transactions).set({
        amountPaid: newPaid.toFixed(4),
        balanceDue: newBalance.toFixed(4),
        invoiceStatus,
        paidAt: invoiceStatus === 'paid' ? new Date() : null,
        updatedAt: new Date(),
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, app.invoiceId)));
    }
  });

  return payment;
}

export async function getOpenInvoicesForCustomer(tenantId: string, customerId: string) {
  // Dates are cast to text in SQL so the raw driver returns clean
  // 'YYYY-MM-DD' strings (no timezone shift from date→JS Date parsing).
  const rows = await db.execute(sql`
    SELECT id,
           txn_number,
           to_char(txn_date, 'YYYY-MM-DD') AS txn_date,
           to_char(due_date, 'YYYY-MM-DD') AS due_date,
           total, amount_paid, balance_due, invoice_status
    FROM transactions
    WHERE tenant_id = ${tenantId} AND txn_type = 'invoice' AND status = 'posted'
      AND contact_id = ${customerId}
      AND invoice_status NOT IN ('paid', 'void')
      AND CAST(balance_due AS DECIMAL) > 0
    ORDER BY txn_date ASC
  `);
  // Map the raw snake_case columns to the camelCase shape the API contract
  // (and the web OpenInvoice type) expects — otherwise every field reads as
  // undefined on the client (blank invoice #, "$NaN" amount due).
  return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
    id: r['id'] as string,
    invoiceNumber: (r['txn_number'] as string | null) ?? '',
    txnDate: (r['txn_date'] as string | null) ?? '',
    dueDate: (r['due_date'] as string | null) ?? null,
    total: String(r['total'] ?? '0'),
    amountPaid: String(r['amount_paid'] ?? '0'),
    balanceDue: String(r['balance_due'] ?? '0'),
    invoiceStatus: (r['invoice_status'] as string | null) ?? null,
  }));
}

export async function getPaymentsForInvoice(tenantId: string, invoiceId: string) {
  const rows = await db.execute(sql`
    SELECT pa.id, pa.amount, pa.created_at,
      t.txn_date, t.txn_number, t.memo
    FROM payment_applications pa
    JOIN transactions t ON t.id = pa.payment_id
    WHERE pa.tenant_id = ${tenantId} AND pa.invoice_id = ${invoiceId}
    ORDER BY t.txn_date ASC
  `);
  return rows.rows;
}

/**
 * Items waiting in Payments Clearing to be deposited (U-52): every posted
 * transaction whose lines hold a net debit on the Payments Clearing account
 * and that no posted deposit settles yet. One row per transaction, its
 * amount the net clearing debit (what a grouped deposit line must equal).
 * Void and deleted transactions are left out; with a company, items of
 * another company are too (legacy rows without a company stay visible).
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

export async function unapplyPayment(tenantId: string, paymentId: string, invoiceId: string) {
  // Wrap in a database transaction and lock the invoice row before
  // recomputing its balance. The previous version:
  //   - Read the invoice WITHOUT a tenant_id filter (CLAUDE.md #17)
  //   - Did read-modify-write on amountPaid with no locking
  //   - UPDATEd / DELETEd without tenant_id scoping
  // Two unapply calls (or an unapply concurrent with a receivePayment)
  // could clobber each other's invoice balance updates.
  await db.transaction(async (tx) => {
    const app = await tx.query.paymentApplications.findFirst({
      where: and(
        eq(paymentApplications.tenantId, tenantId),
        eq(paymentApplications.paymentId, paymentId),
        eq(paymentApplications.invoiceId, invoiceId),
      ),
    });
    if (!app) throw AppError.notFound('Payment application not found');

    // Lock the invoice row so the read-modify-write is atomic.
    const [invoice] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)))
      .for('update')
      .limit(1);

    if (invoice) {
      let restoredPaid = new Decimal(invoice.amountPaid || '0').minus(app.amount);
      if (restoredPaid.isNegative()) restoredPaid = new Decimal('0');
      const invoiceTotal = new Decimal(invoice.total || '0');
      const newBalance = invoiceTotal.minus(restoredPaid);
      const status = restoredPaid.lessThanOrEqualTo(OVERAPPLY_TOLERANCE) ? 'sent' : 'partial';

      await tx.update(transactions).set({
        amountPaid: restoredPaid.toFixed(4),
        balanceDue: newBalance.toFixed(4),
        invoiceStatus: status,
        paidAt: null,
        updatedAt: new Date(),
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)));
    }

    await tx.delete(paymentApplications)
      .where(and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.id, app.id)));
  });
}
