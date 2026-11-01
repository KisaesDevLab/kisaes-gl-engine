// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Credit memos (U-138, credit-memo-edit-v1) and sales receipts (U-143,
 * sales-receipt-lines-v1) on the invoice line model: the same line
 * resolution, price level and computeInvoice as an invoice (so preview =
 * post), one rate per document (P20 basic tax), whole cents.
 *
 *   Credit memo: Dr each income line, Dr Sales Tax Payable the tax, Cr A/R
 *   the total; stores subtotal and tax_amount; total <= 0.00 is 400
 *   CREDIT_MEMO_TOTAL_NOT_POSITIVE (Q-P22r); applications at save are
 *   written in the same database transaction (applied_date NULL, Q-P22b).
 *   Sales receipt: Dr the deposit account (default Payments Clearing) the
 *   total, Cr income, Cr Sales Tax Payable; a total below 0.00 needs a bank
 *   account (400 NEGATIVE_RECEIPT_NEEDS_BANK).
 *
 * The old POST /transactions paths are unchanged.
 */

import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type { CreditMemoInput, CreditMemoPreviewInput, SalesReceiptInput, SalesReceiptPreviewInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { accounts, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import * as documentNumbers from './document-number.service.js';
import * as formsPrint from './forms-print.service.js';
import * as invoiceTemplates from './invoice-template.service.js';
import { claimIdempotency } from './idempotency.service.js';
import { auditLog } from '../middleware/audit.js';
import { computeSalesDocument, salesDocumentJournal, salesDocumentPreviewLines, writeSalesDocumentTags } from './invoice.service.js';
import { getBalances } from './contacts.service.js';
import { liveDepositsForSource } from './deposit-links.service.js';
import { listSendHistory } from './document-send.service.js';

/** A form's send history (U-126), as GET /invoices/:id returns it; on both records since U-144 (sales-doc-email-v1). */
export type SendHistory = Awaited<ReturnType<typeof listSendHistory>>;

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;
type TxnRow = typeof transactions.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const m4 = (v: string | DecimalValue) => new Decimal(v).toFixed(4);
const m2 = (v: string | DecimalValue | null | undefined) => new Decimal(v ?? '0').toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

function notPositive(total: string): AppError {
  return AppError.badRequest('A credit memo must be for more than 0.00. Record a return with money back as a sales receipt.',
    'CREDIT_MEMO_TOTAL_NOT_POSITIVE', { total });
}

async function loadDoc(executor: DbOrTx, tenantId: string, id: string, type: 'credit_memo' | 'cash_sale', companyId?: string): Promise<TxnRow> {
  const what = type === 'credit_memo' ? 'Credit memo' : 'Sales receipt';
  if (!UUID_RE.test(id)) throw AppError.notFound(`${what} not found`);
  const [row] = await executor.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).limit(1);
  if (!row || row.txnType !== type || row.status === 'deleted' || ledger.inOtherCompany(row, companyId)) {
    throw AppError.notFound(`${what} not found`);
  }
  return row;
}

async function systemAccount(executor: DbOrTx, tenantId: string, tag: string): Promise<string | null> {
  const [row] = await executor.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag))).limit(1);
  return row?.id ?? null;
}

/** Header fields stored after the post (as an invoice stores them). */
async function writeHeader(tx: Tx, tenantId: string, row: TxnRow, input: CreditMemoInput | SalesReceiptInput, customer: { id: string } | null) {
  await invoiceTemplates.assertInvoiceLayout(tx, tenantId, input.layoutId, row.companyId, row.layoutId);
  const header = {
    customerMessage: input.customerMessage ?? row.customerMessage ?? null,
    hideZeroLines: input.hideZeroLines ?? row.hideZeroLines ?? false,
    layoutId: input.layoutId !== undefined ? input.layoutId
      : row.layoutId ?? (customer ? await invoiceTemplates.clientDefaultLayoutId(tx, tenantId, customer as never, row.companyId) : null),
  };
  await tx.update(transactions).set(header).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, row.id)));
  await writeSalesDocumentTags(tx, tenantId, row.id, row.companyId, input.tagIds);
}

// ─── Records ────────────────────────────────────────────────────────

export interface SalesDocumentLineRecord {
  accountId: string; itemId: string | null; description: string | null; quantity: string | null; unitPrice: string | null;
  amount: string; isTaxable: boolean; taxRate: string; taxAmount: string; tagId: string | null; serviceDate: string | null;
}

/** The income lines of a sales document (not its head line or the Sales Tax line), as the form shows them. */
async function documentLines(executor: DbOrTx, tenantId: string, row: TxnRow, sign: 1 | -1): Promise<SalesDocumentLineRecord[]> {
  const res = await executor.execute(sql`
    SELECT jl.account_id, jl.item_id, jl.description, jl.quantity::text AS quantity, jl.unit_price::text AS unit_price,
      (jl.credit - jl.debit)::text AS net, jl.is_taxable, jl.tax_rate::text AS tax_rate, jl.tax_amount::text AS tax_amount,
      jl.tag_id, to_char(jl.service_date, 'YYYY-MM-DD') AS service_date, jl.line_order, a.system_tag
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND jl.transaction_id = ${row.id} AND jl.is_void_reversal = false
    ORDER BY jl.line_order, jl.id
  `);
  const rows = res.rows as Array<Record<string, unknown>>;
  // The head line (A/R or the deposit account) is the first; the Sales Tax line is tagged.
  return rows.slice(1).filter((r) => r['system_tag'] !== 'sales_tax_payable').map((r) => ({
    accountId: String(r['account_id']),
    itemId: (r['item_id'] as string | null) ?? null,
    description: (r['description'] as string | null) ?? null,
    quantity: r['quantity'] == null ? null : new Decimal(String(r['quantity'])).toFixed(4),
    unitPrice: r['unit_price'] == null ? null : new Decimal(String(r['unit_price'])).toFixed(4),
    amount: m2(new Decimal(String(r['net'])).times(sign)),
    isTaxable: r['is_taxable'] === true,
    taxRate: new Decimal(String(r['tax_rate'] ?? '0')).toFixed(4),
    taxAmount: m2(String(r['tax_amount'] ?? '0')),
    tagId: (r['tag_id'] as string | null) ?? null,
    serviceDate: (r['service_date'] as string | null) ?? null,
  }));
}

export interface CreditMemoRecord {
  id: string; number: string | null; date: string; customerId: string | null;
  lines: SalesDocumentLineRecord[];
  totals: { subtotal: string; taxTotal: string; total: string };
  memo: string | null; customerMessage: string | null; hideZeroLines: boolean; layoutId: string | null; printLater: boolean;
  updatedAt: string | null; status: string;
  /** appliedDate null: applied when the memo was saved (dated with the memo). */
  applications: Array<{ invoiceId: string; invoiceNumber: string | null; amount: string; appliedDate: string | null; voided: boolean }>;
  refunds: Array<{ refundId: string; date: string; amount: string; method: string | null; voided: boolean }>;
  remaining: string;
  sendHistory: SendHistory;
}

export async function getCreditMemoRecord(executor: DbOrTx, tenantId: string, id: string, companyId?: string): Promise<CreditMemoRecord> {
  const row = await loadDoc(executor, tenantId, id, 'credit_memo', companyId);
  const apps = await executor.execute(sql`
    SELECT pa.invoice_id, inv.txn_number, pa.amount::text AS amount, to_char(pa.applied_date, 'YYYY-MM-DD') AS d,
      (pa.voided_at IS NOT NULL OR pa.reversed_by_txn_id IS NOT NULL) AS voided
    FROM payment_applications pa LEFT JOIN transactions inv ON inv.id = pa.invoice_id AND inv.tenant_id = pa.tenant_id
    WHERE pa.tenant_id = ${tenantId} AND pa.payment_id = ${id}
    ORDER BY pa.created_at, inv.txn_date NULLS LAST, inv.txn_number NULLS LAST, pa.invoice_id, pa.id
  `);
  const refunds = await executor.execute(sql`
    SELECT r.id, to_char(r.txn_date, 'YYYY-MM-DD') AS d, r.total::text AS total, r.payment_method, r.status
    FROM transactions r WHERE r.tenant_id = ${tenantId} AND r.source_payment_id = ${id} AND r.txn_type = 'customer_refund'
      AND r.status <> 'deleted'
    ORDER BY r.txn_date, r.created_at
  `);
  const appRows = (apps.rows as Array<Record<string, unknown>>).map((r) => ({
    invoiceId: String(r['invoice_id']), invoiceNumber: (r['txn_number'] as string | null) ?? null,
    amount: m2(String(r['amount'])), appliedDate: (r['d'] as string | null) ?? null, voided: r['voided'] === true,
  }));
  const refundRows = (refunds.rows as Array<Record<string, unknown>>).map((r) => ({
    refundId: String(r['id']), date: String(r['d']), amount: m2(String(r['total'])),
    method: (r['payment_method'] as string | null) ?? null, voided: r['status'] !== 'posted',
  }));
  const used = appRows.filter((a) => !a.voided).reduce((s, a) => s.plus(a.amount), new Decimal(0))
    .plus(refundRows.filter((r) => !r.voided).reduce((s, r) => s.plus(r.amount), new Decimal(0)));
  const total = new Decimal(row.total ?? '0');
  const lines = await documentLines(executor, tenantId, row, -1);
  return {
    id: row.id, number: row.txnNumber, date: row.txnDate, customerId: row.contactId,
    lines,
    totals: {
      subtotal: m2(row.subtotal ?? lines.reduce((s, l) => s.plus(l.amount), new Decimal(0))),
      taxTotal: m2(row.taxAmount ?? '0'),
      total: m2(total),
    },
    memo: row.memo, customerMessage: row.customerMessage ?? null, hideZeroLines: row.hideZeroLines === true,
    layoutId: row.layoutId ?? null, printLater: row.printStatus === 'queue',
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null, status: row.status,
    applications: appRows, refunds: refundRows,
    remaining: row.status === 'posted' ? m2(Decimal.max(total.minus(used), 0)) : '0.00',
    sendHistory: await listSendHistory(executor, tenantId, id),
  };
}

export interface SalesReceiptRecord {
  id: string; number: string | null; date: string; customerId: string | null; depositToAccountId: string | null;
  paymentMethod: string | null; refNo: string | null;
  lines: SalesDocumentLineRecord[];
  totals: { subtotal: string; taxTotal: string; total: string };
  memo: string | null; customerMessage: string | null; hideZeroLines: boolean; layoutId: string | null; printLater: boolean;
  updatedAt: string | null; status: string; deposited: boolean;
  sendHistory: SendHistory;
}

async function headAccount(executor: DbOrTx, tenantId: string, id: string): Promise<string | null> {
  const res = await executor.execute(sql`
    SELECT account_id FROM journal_lines WHERE tenant_id = ${tenantId} AND transaction_id = ${id} AND is_void_reversal = false
    ORDER BY line_order, id LIMIT 1
  `);
  return (res.rows as Array<{ account_id: string }>)[0]?.account_id ?? null;
}

export async function getSalesReceiptRecord(executor: DbOrTx, tenantId: string, id: string, companyId?: string): Promise<SalesReceiptRecord> {
  const row = await loadDoc(executor, tenantId, id, 'cash_sale', companyId);
  const lines = await documentLines(executor, tenantId, row, 1);
  return {
    id: row.id, number: row.txnNumber, date: row.txnDate, customerId: row.contactId,
    depositToAccountId: await headAccount(executor, tenantId, id),
    paymentMethod: row.paymentMethod ?? null, refNo: row.referenceNumber ?? null,
    lines,
    totals: {
      subtotal: m2(row.subtotal ?? lines.reduce((s, l) => s.plus(l.amount), new Decimal(0))),
      taxTotal: m2(row.taxAmount ?? '0'), total: m2(row.total ?? '0'),
    },
    memo: row.memo, customerMessage: row.customerMessage ?? null, hideZeroLines: row.hideZeroLines === true,
    layoutId: row.layoutId ?? null, printLater: row.printStatus === 'queue',
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null, status: row.status,
    deposited: (await liveDepositsForSource(executor, tenantId, id)).length > 0,
    sendHistory: await listSendHistory(executor, tenantId, id),
  };
}

// ─── Credit memos ───────────────────────────────────────────────────

/** POST /credit-memos/preview: every figure of the form, posting nothing. Problems in problems[], never 4xx. */
export async function previewCreditMemo(tenantId: string, input: CreditMemoPreviewInput, companyId?: string) {
  let existing: TxnRow | undefined;
  if (input.editingId) existing = await loadDoc(db, tenantId, input.editingId, 'credit_memo', companyId);
  const doc = await computeSalesDocument(db, tenantId, input, companyId);
  const problems: Array<{ code: string }> = [];
  const total = new Decimal(doc.computed.total);
  if (!total.greaterThan(0)) problems.push({ code: 'CREDIT_MEMO_TOTAL_NOT_POSITIVE' });

  // Open invoices of the client, oldest first; an edited memo's own applications count as open again.
  const own = new Map<string, DecimalValue>();
  if (existing && existing.status === 'posted') {
    const res = await db.execute(sql`
      SELECT invoice_id, SUM(amount)::text AS amount FROM payment_applications
      WHERE tenant_id = ${tenantId} AND payment_id = ${existing.id} AND voided_at IS NULL AND reversed_by_txn_id IS NULL
      GROUP BY invoice_id`);
    for (const r of res.rows as Array<{ invoice_id: string; amount: string }>) own.set(r.invoice_id, new Decimal(r.amount));
  }
  const scope = companyId ? sql`AND (t.company_id = ${companyId} OR t.company_id IS NULL)` : sql``;
  const invRes = await db.execute(sql`
    SELECT t.id, t.txn_number, to_char(t.txn_date, 'YYYY-MM-DD') AS d, to_char(t.due_date, 'YYYY-MM-DD') AS due, t.balance_due::text AS bal
    FROM transactions t
    WHERE t.tenant_id = ${tenantId} AND t.txn_type = 'invoice' AND t.status = 'posted' AND t.contact_id = ${input.contactId} ${scope}
      AND t.invoice_status IS DISTINCT FROM 'void'
    ORDER BY t.txn_date, t.txn_number NULLS FIRST, t.id
  `);
  const openInvoices = (invRes.rows as Array<Record<string, unknown>>).map((r) => {
    const exact = new Decimal(String(r['bal'] ?? '0')).plus(own.get(String(r['id'])) ?? 0);
    return {
      invoiceId: String(r['id']), number: (r['txn_number'] as string | null) ?? null, date: String(r['d']),
      dueDate: (r['due'] as string | null) ?? String(r['d']),
      balanceDue: m2(exact), balanceDueExact: exact.toFixed(4),
    };
  }).filter((i) => new Decimal(i.balanceDue).greaterThan(0));
  let left = Decimal.max(total, 0);
  const suggestedApplications: Array<{ invoiceId: string; amount: string }> = [];
  for (const inv of openInvoices) {
    if (!left.greaterThan(0)) break;
    const x = Decimal.min(left, inv.balanceDue);
    suggestedApplications.push({ invoiceId: inv.invoiceId, amount: x.toFixed(2) });
    left = left.minus(x);
  }
  const balances = await getBalances(tenantId, [input.contactId], companyId);
  let before = new Decimal(balances.get(input.contactId)?.openBalance ?? '0');
  if (existing && existing.status === 'posted' && existing.contactId === input.contactId) before = before.plus(existing.total ?? '0');
  return {
    lines: salesDocumentPreviewLines(doc),
    subtotal: doc.computed.subtotal,
    taxableBase: doc.computed.taxableBase,
    taxRate: new Decimal(doc.company?.defaultSalesTaxRate || '0').toFixed(4),
    taxTotal: doc.computed.taxTotal,
    total: doc.computed.total,
    taxGroups: doc.computed.taxGroups,
    contactBalanceBefore: before.toFixed(2),
    contactBalanceAfter: before.minus(total).toFixed(2),
    openInvoices,
    suggestedApplications,
    remainingCredit: Decimal.max(left, 0).toFixed(2),
    problems,
  };
}

/** POST /credit-memos (U-138): figures, number, posting and applications at save in one database transaction. */
export async function createCreditMemoDocument(tenantId: string, input: CreditMemoInput, userId?: string, companyId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const doc = await computeSalesDocument(tx, tenantId, input, companyId);
    if (!new Decimal(doc.computed.total).greaterThan(0)) throw notPositive(doc.computed.total);
    const { txnNumber, warnings } = await documentNumbers.numberForNew(tenantId, 'credit_memo', input.txnNumber, {
      companyId, warnOnly: input.warnOnly === true, executor: tx,
    });
    const posted = await ledger.postTransaction(tenantId, {
      txnType: 'credit_memo', txnNumber, printLater: input.printLater === true, txnDate: input.txnDate,
      contactId: input.contactId, memo: input.memo,
      subtotal: m4(doc.computed.subtotal), taxAmount: m4(doc.computed.taxTotal), total: m4(doc.computed.total),
      lines: await salesDocumentJournal(tx, tenantId, doc, { reverse: true }),
    } as ledger.PostTransactionInput, userId, companyId, tx);
    const [row] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, posted.id))).for('update').limit(1);
    await writeHeader(tx, tenantId, row!, input, doc.customer);
    if (input.applications && input.applications.length > 0) {
      const payments = await import('./payment.service.js');
      await payments.applyCreditInTx(tx, tenantId, row!, { date: input.txnDate, applications: input.applications }, userId, companyId, { withSource: true });
    }
    return { creditMemo: await getCreditMemoRecord(tx, tenantId, posted.id, companyId), warnings };
  });
}

/**
 * PUT /credit-memos/:id (U-138): expectedUpdatedAt (409 STALE); the
 * closing date meets the old date, the new date and every live refund's
 * date (rule 3b books memo lines at refund dates, S7). 409 CREDIT_IN_USE
 * {inUse} when the new total is below what is applied and refunded, or
 * the client changes while an application or refund is live; 400
 * SOURCE_DATE_AFTER_USE when the new date is after its first use. Live
 * applications stay; applications in the body are 400 VALIDATION_ERROR
 * (apply with /credit-memos/:id/apply), never dropped silently.
 */
export async function updateCreditMemoDocument(tenantId: string, id: string, input: CreditMemoInput, userId?: string, companyId?: string) {
  if (input.applications && input.applications.length > 0) {
    throw AppError.badRequest('A credit memo edit doesn’t apply credit. Apply it with POST /credit-memos/:id/apply.', 'VALIDATION_ERROR',
      { field: 'applications' });
  }
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const payments = await import('./payment.service.js');
    await payments.lockForVoidInTx(tx, tenantId, { id, txnType: 'credit_memo', sourceTxnId: null });
    const [row] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).for('update').limit(1);
    if (!row || row.txnType !== 'credit_memo' || row.status === 'deleted' || ledger.inOtherCompany(row, companyId)) {
      throw AppError.notFound('Credit memo not found');
    }
    if (row.status !== 'posted') throw AppError.badRequest('Cannot update a void transaction');
    ledger.assertNotStale(row, input.expectedUpdatedAt, 'This credit memo');
    const doc = await computeSalesDocument(tx, tenantId, input, companyId);
    const total = new Decimal(doc.computed.total);
    if (!total.greaterThan(0)) throw notPositive(doc.computed.total);
    const used = await tx.execute(sql`
      SELECT
        COALESCE((SELECT SUM(amount) FROM payment_applications WHERE tenant_id = ${tenantId} AND payment_id = ${id}
          AND voided_at IS NULL AND reversed_by_txn_id IS NULL), 0)::text AS applied,
        COALESCE((SELECT SUM(total) FROM transactions WHERE tenant_id = ${tenantId} AND source_payment_id = ${id}
          AND txn_type = 'customer_refund' AND status = 'posted'), 0)::text AS refunded
    `);
    const u = (used.rows as Array<{ applied: string; refunded: string }>)[0]!;
    const inUse = new Decimal(u.applied).plus(u.refunded);
    if (inUse.greaterThan(0) && input.contactId !== row.contactId) {
      throw AppError.conflict(`${m2(inUse)} of this credit is applied or refunded, so it can't move to another client. Unapply it first.`,
        'CREDIT_IN_USE', { inUse: m2(inUse) });
    }
    if (total.lessThan(inUse)) {
      throw AppError.conflict(`This credit is applied to invoices or refunded. Unapply it first, or keep the total at least ${m2(inUse)}.`,
        'CREDIT_IN_USE', { inUse: m2(inUse) });
    }
    if (input.txnDate !== row.txnDate) await payments.assertSourceDate(tx, tenantId, id, input.txnDate);
    const refundDates = await tx.execute(sql`
      SELECT DISTINCT to_char(txn_date, 'YYYY-MM-DD') AS d FROM transactions WHERE tenant_id = ${tenantId}
        AND source_payment_id = ${id} AND txn_type = 'customer_refund' AND status = 'posted' ORDER BY 1`);
    for (const r of refundDates.rows as Array<{ d: string }>) {
      await ledger.checkLockDate(tx, tenantId, r.d, row.companyId, undefined, { txnId: id, oldDate: r.d, newDate: r.d });
    }
    const newNumber = input.txnNumber?.trim();
    let warnings: documentNumbers.DocumentNumberWarning[] = [];
    if (newNumber && newNumber !== row.txnNumber) {
      warnings = await documentNumbers.checkDuplicate(tenantId, 'credit_memo', newNumber, {
        companyId, excludeId: id, warnOnly: input.warnOnly === true, executor: tx,
      });
    }
    await ledger.updateTransaction(tenantId, id, {
      txnType: 'credit_memo', txnDate: input.txnDate, contactId: input.contactId, memo: input.memo,
      ...(newNumber ? { txnNumber: newNumber } : {}),
      subtotal: m4(doc.computed.subtotal), taxAmount: m4(doc.computed.taxTotal), total: m4(doc.computed.total),
      lines: await salesDocumentJournal(tx, tenantId, doc, { reverse: true }),
    } as ledger.PostTransactionInput, userId, companyId, tx);
    if (input.printLater !== undefined) await formsPrint.setPrintLater(tx, tenantId, id, input.printLater, companyId);
    const [fresh] = await tx.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).limit(1);
    await writeHeader(tx, tenantId, fresh!, input, doc.customer);
    await tx.update(transactions).set({ updatedAt: new Date() }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id)));
    await auditLog(tenantId, 'update', 'credit_memo', id, { total: row.total, txnDate: row.txnDate }, { total: m4(total), txnDate: input.txnDate, via: 'edit' }, userId, tx);
    return { creditMemo: await getCreditMemoRecord(tx, tenantId, id, companyId), warnings };
  });
}

// ─── Sales receipts ─────────────────────────────────────────────────

/**
 * The deposit account of a receipt: sent, else Payments Clearing. An asset
 * of this company, not A/R or Customer Deposits (400 DEPOSIT_ACCOUNT_INVALID).
 * A total below 0.00 (a return with money back) needs a bank account: 400
 * NEGATIVE_RECEIPT_NEEDS_BANK on Payments Clearing.
 */
async function receiptDepositTo(
  executor: DbOrTx, tenantId: string, companyId: string | undefined, sent: string | undefined, total: DecimalValue,
): Promise<{ accountId: string; problem: string | null }> {
  const pc = await systemAccount(executor, tenantId, 'payments_clearing');
  const accountId = sent ?? pc;
  if (!accountId) throw AppError.internal('Payments Clearing account not found');
  const [acct] = await executor.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  if (!acct || ledger.inOtherCompany(acct, companyId) || acct.accountType !== 'asset'
    || acct.systemTag === 'accounts_receivable' || acct.systemTag === 'customer_deposits' || acct.detailType === 'accounts_receivable') {
    return { accountId, problem: 'DEPOSIT_ACCOUNT_INVALID' };
  }
  if (total.isNegative() && acct.systemTag === 'payments_clearing') return { accountId, problem: 'NEGATIVE_RECEIPT_NEEDS_BANK' };
  return { accountId, problem: null };
}

function receiptProblem(code: string, accountId: string): AppError {
  return code === 'NEGATIVE_RECEIPT_NEEDS_BANK'
    ? AppError.badRequest('A sales receipt below 0.00 pays money back: choose the bank account it comes from, not Payments Clearing.',
      'NEGATIVE_RECEIPT_NEEDS_BANK', { accountId })
    : AppError.badRequest('Choose a bank account or Payments Clearing to deposit the sale to.', 'DEPOSIT_ACCOUNT_INVALID', { accountId });
}

/** POST /sales-receipts/preview: every figure, posting nothing; problems[] (NEGATIVE_RECEIPT_NEEDS_BANK, DEPOSIT_ACCOUNT_INVALID). */
export async function previewSalesReceipt(tenantId: string, input: SalesReceiptPreviewInput, companyId?: string) {
  if (input.editingId) await loadDoc(db, tenantId, input.editingId, 'cash_sale', companyId);
  const doc = await computeSalesDocument(db, tenantId, input, companyId);
  const dep = await receiptDepositTo(db, tenantId, companyId, input.depositToAccountId, new Decimal(doc.computed.total));
  let before = new Decimal(0);
  if (input.contactId) {
    const balances = await getBalances(tenantId, [input.contactId], companyId);
    before = new Decimal(balances.get(input.contactId)?.openBalance ?? '0');
  }
  return {
    lines: salesDocumentPreviewLines(doc),
    subtotal: doc.computed.subtotal,
    taxableBase: doc.computed.taxableBase,
    taxRate: new Decimal(doc.company?.defaultSalesTaxRate || '0').toFixed(4),
    taxTotal: doc.computed.taxTotal,
    total: doc.computed.total,
    taxGroups: doc.computed.taxGroups,
    depositToAccountId: dep.accountId,
    contactBalanceBefore: before.toFixed(2),
    contactBalanceAfter: before.toFixed(2),
    problems: dep.problem ? [{ code: dep.problem }] : [],
  };
}

export async function createSalesReceipt(tenantId: string, input: SalesReceiptInput, userId?: string, companyId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const doc = await computeSalesDocument(tx, tenantId, input, companyId);
    const dep = await receiptDepositTo(tx, tenantId, companyId, input.depositToAccountId, new Decimal(doc.computed.total));
    if (dep.problem) throw receiptProblem(dep.problem, dep.accountId);
    const { txnNumber, warnings } = await documentNumbers.numberForNew(tenantId, 'cash_sale', input.txnNumber, {
      companyId, warnOnly: input.warnOnly === true, executor: tx,
    });
    const posted = await ledger.postTransaction(tenantId, {
      txnType: 'cash_sale', txnNumber, printLater: input.printLater === true, txnDate: input.txnDate,
      contactId: input.contactId ?? undefined, memo: input.memo, paymentMethod: input.paymentMethod, referenceNumber: input.refNo,
      subtotal: m4(doc.computed.subtotal), taxAmount: m4(doc.computed.taxTotal), total: m4(doc.computed.total),
      lines: await salesDocumentJournal(tx, tenantId, doc, { headAccountId: dep.accountId }),
    } as ledger.PostTransactionInput, userId, companyId, tx);
    const [row] = await tx.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, posted.id))).limit(1);
    await writeHeader(tx, tenantId, row!, input, doc.customer);
    return { salesReceipt: await getSalesReceiptRecord(tx, tenantId, posted.id, companyId), warnings };
  });
}

/** PUT /sales-receipts/:id: STALE; closing on both dates (updateTransaction); deposited: depositTo and amount can't change (409 TXN_DEPOSITED). */
export async function updateSalesReceipt(tenantId: string, id: string, input: SalesReceiptInput, userId?: string, companyId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const [row] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).for('update').limit(1);
    if (!row || row.txnType !== 'cash_sale' || row.status === 'deleted' || ledger.inOtherCompany(row, companyId)) {
      throw AppError.notFound('Sales receipt not found');
    }
    if (row.status !== 'posted') throw AppError.badRequest('Cannot update a void transaction');
    ledger.assertNotStale(row, input.expectedUpdatedAt, 'This sales receipt');
    const doc = await computeSalesDocument(tx, tenantId, input, companyId);
    const dep = await receiptDepositTo(tx, tenantId, companyId, input.depositToAccountId ?? (await headAccount(tx, tenantId, id)) ?? undefined,
      new Decimal(doc.computed.total));
    if (dep.problem) throw receiptProblem(dep.problem, dep.accountId);
    const deposits = await liveDepositsForSource(tx, tenantId, id);
    if (deposits.length > 0 && (dep.accountId !== await headAccount(tx, tenantId, id) || !new Decimal(row.total ?? '0').equals(doc.computed.total))) {
      throw AppError.conflict('This sales receipt is in a deposit. Remove it from the deposit first.', 'TXN_DEPOSITED',
        { depositIds: [...new Set(deposits.map((d) => d.depositId))] });
    }
    const newNumber = input.txnNumber?.trim();
    let warnings: documentNumbers.DocumentNumberWarning[] = [];
    if (newNumber && newNumber !== row.txnNumber) {
      warnings = await documentNumbers.checkDuplicate(tenantId, 'cash_sale', newNumber, {
        companyId, excludeId: id, warnOnly: input.warnOnly === true, executor: tx,
      });
    }
    await ledger.updateTransaction(tenantId, id, {
      txnType: 'cash_sale', txnDate: input.txnDate, contactId: input.contactId ?? undefined, memo: input.memo,
      paymentMethod: input.paymentMethod, referenceNumber: input.refNo,
      ...(newNumber ? { txnNumber: newNumber } : {}),
      subtotal: m4(doc.computed.subtotal), taxAmount: m4(doc.computed.taxTotal), total: m4(doc.computed.total),
      lines: await salesDocumentJournal(tx, tenantId, doc, { headAccountId: dep.accountId }),
    } as ledger.PostTransactionInput, userId, companyId, tx);
    if (input.printLater !== undefined) await formsPrint.setPrintLater(tx, tenantId, id, input.printLater, companyId);
    const [fresh] = await tx.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).limit(1);
    await writeHeader(tx, tenantId, fresh!, input, doc.customer);
    await tx.update(transactions).set({ updatedAt: new Date() }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id)));
    return { salesReceipt: await getSalesReceiptRecord(tx, tenantId, id, companyId), warnings };
  });
}
