import { eq, and, sql } from 'drizzle-orm';
import type { ReceivePaymentInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, accounts, paymentApplications, depositLines } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { auditLog } from '../middleware/audit.js';

export async function receivePayment(tenantId: string, input: ReceivePaymentInput, userId?: string) {
  // Get AR account
  const arAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')),
  });
  if (!arAccount) throw AppError.internal('AR account not found');

  // Create payment transaction
  const payment = await ledger.postTransaction(tenantId, {
    txnType: 'customer_payment',
    txnDate: input.date,
    contactId: input.customerId,
    memo: input.memo,
    total: input.amount,
    lines: [
      { accountId: input.depositTo, debit: input.amount, credit: '0' },
      { accountId: arAccount.id, debit: '0', credit: input.amount },
    ],
  }, userId);

  // Create payment applications
  for (const app of input.applications) {
    await db.insert(paymentApplications).values({
      tenantId,
      paymentId: payment.id,
      invoiceId: app.invoiceId,
      amount: app.amount,
    });

    // Update invoice
    const invoice = await db.query.transactions.findFirst({
      where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, app.invoiceId)),
    });
    if (invoice) {
      const newPaid = parseFloat(invoice.amountPaid || '0') + parseFloat(app.amount);
      const invoiceTotal = parseFloat(invoice.total || '0');
      const newBalance = Math.max(0, invoiceTotal - newPaid);
      const invoiceStatus = newBalance <= 0.001 ? 'paid' : 'partial';

      await db.update(transactions).set({
        amountPaid: newPaid.toFixed(4),
        balanceDue: newBalance.toFixed(4),
        invoiceStatus,
        paidAt: invoiceStatus === 'paid' ? new Date() : null,
        updatedAt: new Date(),
      }).where(eq(transactions.id, app.invoiceId));
    }
  }

  return payment;
}

export async function getOpenInvoicesForCustomer(tenantId: string, customerId: string) {
  const rows = await db.execute(sql`
    SELECT id, txn_number, txn_date, due_date, total, amount_paid, balance_due, invoice_status
    FROM transactions
    WHERE tenant_id = ${tenantId} AND txn_type = 'invoice' AND status = 'posted'
      AND contact_id = ${customerId}
      AND invoice_status NOT IN ('paid', 'void')
      AND CAST(balance_due AS DECIMAL) > 0
    ORDER BY txn_date ASC
  `);
  return rows.rows;
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

export async function getPendingDeposits(tenantId: string) {
  // Find all payments/cash sales that went to Payments Clearing and haven't been deposited yet
  const pcAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'payments_clearing')),
  });
  if (!pcAccount) return { paymentsClearingBalance: 0, items: [] };

  const rows = await db.execute(sql`
    SELECT t.id as transaction_id, t.txn_type, t.txn_date as date, t.txn_number as ref_no, t.memo,
      c.display_name as customer_name,
      jl.debit as amount
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${pcAccount.id}
      AND jl.debit > 0 AND t.status = 'posted'
      AND t.id NOT IN (SELECT source_transaction_id FROM deposit_lines)
    ORDER BY t.txn_date ASC
  `);

  const items = (rows.rows as any[]).map((r) => ({
    transactionId: r.transaction_id,
    txnType: r.txn_type,
    date: r.date,
    customerName: r.customer_name,
    refNo: r.ref_no,
    paymentMethod: null,
    amount: parseFloat(r.amount),
  }));

  return {
    paymentsClearingBalance: items.reduce((s, i) => s + i.amount, 0),
    items,
  };
}

export async function unapplyPayment(tenantId: string, paymentId: string, invoiceId: string) {
  const app = await db.query.paymentApplications.findFirst({
    where: and(eq(paymentApplications.tenantId, tenantId), eq(paymentApplications.paymentId, paymentId), eq(paymentApplications.invoiceId, invoiceId)),
  });
  if (!app) throw AppError.notFound('Payment application not found');

  // Restore invoice balance
  const invoice = await db.query.transactions.findFirst({ where: eq(transactions.id, invoiceId) });
  if (invoice) {
    const restoredPaid = Math.max(0, parseFloat(invoice.amountPaid || '0') - parseFloat(app.amount));
    const invoiceTotal = parseFloat(invoice.total || '0');
    const newBalance = invoiceTotal - restoredPaid;
    const status = restoredPaid <= 0.001 ? 'sent' : 'partial';

    await db.update(transactions).set({
      amountPaid: restoredPaid.toFixed(4),
      balanceDue: newBalance.toFixed(4),
      invoiceStatus: status,
      paidAt: null,
      updatedAt: new Date(),
    }).where(eq(transactions.id, invoiceId));
  }

  await db.delete(paymentApplications).where(eq(paymentApplications.id, app.id));
}
