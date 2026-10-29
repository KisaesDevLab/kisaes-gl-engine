// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, ne, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
type Decimal = InstanceType<typeof Decimal>;
import type { CreateInvoiceInput, RecordPaymentInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, accounts, companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import { addCalendarDays, isCalendarDate } from '../utils/calendar-date.js';
import * as documentNumbers from './document-number.service.js';
import * as formsPrint from './forms-print.service.js';
import { claimIdempotency } from './idempotency.service.js';

// Calendar arithmetic (U-86, review S3): the old `new Date(d).setDate(+n)`
// worked in local time, so in a US time zone a term window crossing the
// March DST change came out a day early. One helper for bills and invoices.
export function computeDueDate(txnDate: string, terms: string | undefined): string | undefined {
  if (!terms) return undefined;
  if (terms === 'due_on_receipt') return txnDate;
  // Invoice dates are not schema-checked as YYYY-MM-DD; use the calendar
  // day they start with (a date-time keeps its date, as before).
  const day = txnDate.slice(0, 10);
  if (!isCalendarDate(day)) return undefined;
  switch (terms) {
    case 'net_15': return addCalendarDays(day, 15);
    case 'net_30': return addCalendarDays(day, 30);
    case 'net_60': return addCalendarDays(day, 60);
    case 'net_90': return addCalendarDays(day, 90);
    default: return undefined;
  }
}

// Invoice numbers (U-111): the company's counter (document-number.service
// claims it with one UPDATE ... RETURNING on the request's company row; it
// used to advance every company of the tenant). A typed number leaves the
// counter alone and is checked for duplicates among the company's invoices:
// 409 DOCUMENT_NUMBER_IN_USE, or a warning with warnOnly. There is no DB
// unique index on txn_number (numbers are informational by design).

async function getSystemAccount(tenantId: string, systemTag: string): Promise<string> {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, systemTag)),
  });
  if (!account) throw AppError.internal(`System account '${systemTag}' not found. Seed COA first.`);
  return account.id;
}

async function getDefaultTaxRate(tenantId: string): Promise<Decimal> {
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  return new Decimal(company?.defaultSalesTaxRate || '0');
}

function buildTaxLines(inputLines: CreateInvoiceInput['lines'], defaultTaxRate: Decimal) {
  // Line total + tax math in Decimal — with per-line tax rates each
  // multiply compounds drift. Float here produced invoices where
  // total ≠ sum(line credits) by up to a few cents on large invoices,
  // triggering ledger.postTransaction's balance check failure.
  let subtotal = new Decimal('0');
  let totalTax = new Decimal('0');

  const revenueLines = inputLines.map((line) => {
    const qty = new Decimal(line.quantity);
    const price = new Decimal(line.unitPrice);
    // Each line amount and line tax is rounded to the ledger's 4 places
    // first; the subtotal, tax and A/R total add up the rounded values, so
    // the A/R debit equals the stored credits exactly (U-65).
    const lineTotal = ledger.round4(qty.times(price));
    subtotal = subtotal.plus(lineTotal);

    const taxable = line.isTaxable !== false; // default true
    const rate = taxable ? new Decimal(line.taxRate ?? defaultTaxRate.toString()) : new Decimal('0');
    const lineTax = taxable && rate.greaterThan(0) ? ledger.round4(lineTotal.times(rate)) : new Decimal('0');
    totalTax = totalTax.plus(lineTax);

    return {
      accountId: line.accountId,
      debit: '0',
      credit: lineTotal.toFixed(4),
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      isTaxable: taxable,
      taxRate: rate.greaterThan(0) ? rate.toString() : '0',
      taxAmount: lineTax.toFixed(4),
      // ADR 0XX — invoice revenue lines carry the user-selected tag.
      // AR and sales-tax lines below remain untagged (internal postings).
      // Pass the 3-state value; the ledger resolver fills in defaults
      // when undefined, per ADR 0XY §2.3.
      tagId: line.tagId,
    };
  });

  return { revenueLines, subtotal, totalTax, total: subtotal.plus(totalTax) };
}

export async function createInvoice(tenantId: string, input: CreateInvoiceInput, userId?: string, companyId?: string) {
  return (await createInvoiceWithWarnings(tenantId, input, userId, companyId)).invoice;
}

/** createInvoice plus the duplicate-number warnings of a warnOnly request (U-111). */
export async function createInvoiceWithWarnings(
  tenantId: string, input: CreateInvoiceInput, userId?: string, companyId?: string,
) {
  const arAccountId = await getSystemAccount(tenantId, 'accounts_receivable');
  const defaultTaxRate = await getDefaultTaxRate(tenantId);
  const { revenueLines, subtotal, totalTax, total } = buildTaxLines(input.lines, defaultTaxRate);

  const dueDate = input.dueDate || computeDueDate(input.txnDate, input.paymentTerms);

  const journalLines: any[] = [
    { accountId: arAccountId, debit: total.toFixed(4), credit: '0' },
    ...revenueLines,
  ];

  // Post tax to Sales Tax Payable liability account
  if (totalTax.greaterThan(0)) {
    const taxAccountId = await getSystemAccount(tenantId, 'sales_tax_payable');
    journalLines.push({ accountId: taxAccountId, debit: '0', credit: totalTax.toFixed(4), description: 'Sales Tax' });
  }

  // One transaction: the number is claimed (or a typed one checked) and the
  // invoice posted together, so a refused post does not use up a number.
  // The idempotency key is claimed first, so a replay takes no counter lock.
  return await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    // A typed number skips the counter, so a one-off custom number doesn't
    // advance the sequence; otherwise the next free number is claimed.
    const { txnNumber, warnings } = await documentNumbers.numberForNew(tenantId, 'invoice', input.txnNumber, {
      companyId, warnOnly: input.warnOnly === true, executor: tx,
    });
    const invoice = await ledger.postTransaction(tenantId, {
      txnType: 'invoice',
      txnNumber,
      printLater: input.printLater === true,
      txnDate: input.txnDate,
      dueDate,
      contactId: input.contactId,
      memo: input.memo,
      internalNotes: input.internalNotes,
      paymentTerms: input.paymentTerms,
      subtotal: subtotal.toFixed(4),
      taxAmount: totalTax.toFixed(4),
      total: total.toFixed(4),
      balanceDue: total.toFixed(4),
      amountPaid: '0',
      status: 'posted',
      invoiceStatus: 'draft',
      lines: journalLines,
    }, userId, companyId, tx);
    return { invoice, warnings };
  });
}

export async function updateInvoice(tenantId: string, invoiceId: string, input: CreateInvoiceInput, userId?: string, companyId?: string) {
  return (await updateInvoiceWithWarnings(tenantId, invoiceId, input, userId, companyId)).invoice;
}

/** updateInvoice plus the duplicate-number warnings of a warnOnly request (U-111). */
export async function updateInvoiceWithWarnings(
  tenantId: string, invoiceId: string, input: CreateInvoiceInput, userId?: string, companyId?: string,
) {
  const existing = await ledger.getTransaction(tenantId, invoiceId);
  if (existing.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
  if (existing.status === 'void') throw AppError.badRequest('Cannot edit a void invoice');
  if (existing.invoiceStatus === 'paid') throw AppError.badRequest('Cannot edit a paid invoice');

  // Allow editing the invoice number on an unpaid invoice. Only re-check
  // uniqueness when it actually changed, excluding this invoice itself.
  const newNumber = input.txnNumber?.trim();

  const arAccountId = await getSystemAccount(tenantId, 'accounts_receivable');
  const defaultTaxRate = await getDefaultTaxRate(tenantId);
  const { revenueLines, subtotal, totalTax, total } = buildTaxLines(input.lines, defaultTaxRate);

  const amountPaid = new Decimal(existing.amountPaid || '0');
  const balanceDue = total.minus(amountPaid);

  const journalLines: any[] = [
    { accountId: arAccountId, debit: total.toFixed(4), credit: '0' },
    ...revenueLines,
  ];

  if (totalTax.greaterThan(0)) {
    const taxAccountId = await getSystemAccount(tenantId, 'sales_tax_payable');
    journalLines.push({ accountId: taxAccountId, debit: '0', credit: totalTax.toFixed(4), description: 'Sales Tax' });
  }

  // The ledger edit and the print-later mark commit together (U-113).
  return await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    let warnings: documentNumbers.DocumentNumberWarning[] = [];
    if (newNumber && newNumber !== existing.txnNumber) {
      warnings = await documentNumbers.checkDuplicate(tenantId, 'invoice', newNumber, {
        companyId: companyId ?? existing.companyId ?? undefined, excludeId: invoiceId, warnOnly: input.warnOnly === true,
        executor: tx,
      });
    }
    const invoice = await ledger.updateTransaction(tenantId, invoiceId, {
      txnType: 'invoice',
      ...(newNumber ? { txnNumber: newNumber } : {}),
      txnDate: input.txnDate,
      dueDate: input.dueDate,
      contactId: input.contactId,
      memo: input.memo,
      internalNotes: input.internalNotes,
      paymentTerms: input.paymentTerms,
      subtotal: subtotal.toFixed(4),
      taxAmount: totalTax.toFixed(4),
      total: total.toFixed(4),
      balanceDue: balanceDue.toFixed(4),
      lines: journalLines,
    }, userId, companyId, tx);
    if (input.printLater !== undefined) {
      await formsPrint.setPrintLater(tx, tenantId, invoiceId, input.printLater, companyId ?? existing.companyId ?? undefined);
    }
    return { invoice: { ...invoice, ...(input.printLater !== undefined ? { printLater: input.printLater } : {}) }, warnings };
  });
}

export async function markAsSent(tenantId: string, invoiceId: string, userId?: string) {
  const txn = await ledger.getTransaction(tenantId, invoiceId);
  if (txn.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
  if (txn.invoiceStatus !== 'draft') throw AppError.badRequest('Only draft invoices can be marked as sent');

  await db.update(transactions).set({
    invoiceStatus: 'sent',
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)));
  await auditLog(tenantId, 'update', 'invoice', invoiceId,
    { invoiceStatus: 'draft' }, { invoiceStatus: 'sent', via: 'mark_sent' }, userId);
}

export async function generateShareLink(tenantId: string, invoiceId: string, userId?: string, baseUrl?: string): Promise<string> {
  const txn = await ledger.getTransaction(tenantId, invoiceId);
  if (txn.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');

  const { generatePublicToken } = await import('./public-invoice.service.js');
  const token = await generatePublicToken(tenantId, invoiceId);

  // Auto-mark draft as sent when generating a share link
  if (txn.invoiceStatus === 'draft') {
    await db.update(transactions).set({
      invoiceStatus: 'sent',
      sentAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)));
  }

  // Audit share-link generation: it grants anonymous read + pay access to
  // the invoice, so we want a trail for who issued it and when.
  await auditLog(tenantId, 'create', 'invoice_share_link', invoiceId, null,
    { via: 'generate_share_link', previousStatus: txn.invoiceStatus }, userId);

  // Prefer the request-derived origin (issue #32): the merchant sees a
  // link matching the URL they're on, so mDNS / IP-port fallback users
  // get a link they can follow in their own clients. Falls back to
  // CORS_ORIGIN's first entry when called outside a request context
  // (e.g. scheduled jobs).
  const { firstConfiguredOrigin } = await import('../utils/base-url.js');
  const origin = baseUrl || firstConfiguredOrigin();
  return `${origin}/pay/${token}`;
}

export async function sendInvoice(tenantId: string, invoiceId: string, userId?: string) {
  const txn = await ledger.getTransaction(tenantId, invoiceId);
  if (txn.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');

  await db.update(transactions).set({
    invoiceStatus: 'sent',
    sentAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)));
  await auditLog(tenantId, 'update', 'invoice', invoiceId,
    { invoiceStatus: txn.invoiceStatus }, { invoiceStatus: 'sent', via: 'send_invoice' }, userId);
}

export async function recordPayment(tenantId: string, invoiceId: string, input: RecordPaymentInput, userId?: string, companyId?: string) {
  const invoice = await ledger.getTransaction(tenantId, invoiceId);
  if (invoice.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
  if (invoice.status === 'void') throw AppError.badRequest('Cannot pay a void invoice');

  const arAccountId = await getSystemAccount(tenantId, 'accounts_receivable');
  const paymentAmount = new Decimal(input.amount);
  const currentPaid = new Decimal(invoice.amountPaid || '0');
  const invoiceTotal = new Decimal(invoice.total || '0');
  const newPaid = currentPaid.plus(paymentAmount);
  const newBalance = invoiceTotal.minus(newPaid);

  // Both writes — the payment ledger post AND the invoice-header update
  // — run in a single outer transaction. postTransaction accepts our tx
  // and reuses it instead of opening its own, so a mid-flight crash
  // rolls back BOTH or COMMITS BOTH atomically. The prior implementation
  // committed the payment first and then performed a separate UPDATE;
  // a crash in the gap left the invoice header stale (amountPaid /
  // balanceDue / invoiceStatus out of sync with the journal).
  const tolerance = new Decimal('0.01');
  const invoiceStatus = newBalance.lessThanOrEqualTo(tolerance) ? 'paid' : 'partial';
  const clampedBalance = newBalance.isNegative() ? new Decimal('0') : newBalance;

  return await db.transaction(async (tx) => {
    const payment = await ledger.postTransaction(tenantId, {
      txnType: 'customer_payment',
      txnDate: input.txnDate,
      contactId: invoice.contactId || undefined,
      memo: input.memo || `Payment for invoice ${invoice.txnNumber || invoice.id}`,
      total: input.amount,
      appliedToInvoiceId: invoiceId,
      paymentMethod: input.paymentMethod,
      referenceNumber: input.refNo,
      lines: [
        { accountId: input.depositToAccountId, debit: input.amount, credit: '0' },
        { accountId: arAccountId, debit: '0', credit: input.amount },
      ],
    }, userId, companyId, tx);

    await tx.update(transactions).set({
      amountPaid: newPaid.toFixed(4),
      balanceDue: clampedBalance.toFixed(4),
      invoiceStatus,
      paidAt: invoiceStatus === 'paid' ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(transactions.id, invoiceId));

    return payment;
  });
}

export async function voidInvoice(tenantId: string, invoiceId: string, reason: string, userId?: string) {
  const invoice = await ledger.getTransaction(tenantId, invoiceId);
  if (invoice.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
  return ledger.voidTransaction(tenantId, invoiceId, reason, userId);
}

export async function duplicateInvoice(tenantId: string, invoiceId: string, userId?: string, companyId?: string) {
  const original = await ledger.getTransaction(tenantId, invoiceId);
  if (original.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');

  const lines = original.lines.map((line) => ({
    accountId: line.accountId,
    debit: line.debit,
    credit: line.credit,
    description: line.description || undefined,
    quantity: line.quantity || undefined,
    unitPrice: line.unitPrice || undefined,
    isTaxable: line.isTaxable ?? false,
    taxRate: line.taxRate || undefined,
    taxAmount: line.taxAmount || undefined,
  }));

  return ledger.postTransaction(tenantId, {
    txnType: 'invoice',
    txnDate: new Date().toISOString().split('T')[0]!,
    contactId: original.contactId || undefined,
    memo: original.memo || undefined,
    paymentTerms: original.paymentTerms || undefined,
    subtotal: original.subtotal || undefined,
    taxAmount: original.taxAmount || undefined,
    total: original.total || undefined,
    balanceDue: original.total || undefined,
    amountPaid: '0',
    invoiceStatus: 'draft',
    lines,
  }, userId, companyId);
}
