// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
type Decimal = InstanceType<typeof Decimal>;
import type { CreateInvoiceInput, RecordPaymentInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, accounts, companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';

function computeDueDate(txnDate: string, terms: string | undefined): string | undefined {
  if (!terms) return undefined;
  const date = new Date(txnDate);
  switch (terms) {
    case 'due_on_receipt': return txnDate;
    case 'net_15': date.setDate(date.getDate() + 15); break;
    case 'net_30': date.setDate(date.getDate() + 30); break;
    case 'net_60': date.setDate(date.getDate() + 60); break;
    case 'net_90': date.setDate(date.getDate() + 90); break;
    default: return undefined;
  }
  return date.toISOString().split('T')[0]!;
}

async function getNextInvoiceNumber(tenantId: string): Promise<string> {
  // Atomically reserve the next number with a single UPDATE…RETURNING.
  // Postgres serializes concurrent UPDATEs on the same row, so two
  // simultaneous invoice creations always get distinct numbers — unlike
  // the previous read-then-update pattern, which could hand the same
  // number to two different invoices.
  const [updated] = await db.update(companies)
    .set({
      invoiceNextNumber: sql`${companies.invoiceNextNumber} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(companies.tenantId, tenantId))
    .returning({
      // Returning the post-increment value; the number we just "claimed"
      // is one less than that.
      newNext: companies.invoiceNextNumber,
      prefix: companies.invoicePrefix,
    });

  if (!updated || updated.newNext === null) {
    throw AppError.internal('Company row not found or invoice number not initialized for this tenant');
  }
  const claimed = updated.newNext - 1;
  return `${updated.prefix || 'INV-'}${claimed}`;
}

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
    const lineTotal = qty.times(price);
    subtotal = subtotal.plus(lineTotal);

    const taxable = line.isTaxable !== false; // default true
    const rate = taxable ? new Decimal(line.taxRate ?? defaultTaxRate.toString()) : new Decimal('0');
    const lineTax = taxable && rate.greaterThan(0) ? lineTotal.times(rate) : new Decimal('0');
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
    };
  });

  return { revenueLines, subtotal, totalTax, total: subtotal.plus(totalTax) };
}

export async function createInvoice(tenantId: string, input: CreateInvoiceInput, userId?: string, companyId?: string) {
  const arAccountId = await getSystemAccount(tenantId, 'accounts_receivable');
  const defaultTaxRate = await getDefaultTaxRate(tenantId);
  const { revenueLines, subtotal, totalTax, total } = buildTaxLines(input.lines, defaultTaxRate);

  const txnNumber = await getNextInvoiceNumber(tenantId);
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

  return ledger.postTransaction(tenantId, {
    txnType: 'invoice',
    txnNumber,
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
  }, userId, companyId);
}

export async function updateInvoice(tenantId: string, invoiceId: string, input: CreateInvoiceInput, userId?: string, companyId?: string) {
  const existing = await ledger.getTransaction(tenantId, invoiceId);
  if (existing.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
  if (existing.status === 'void') throw AppError.badRequest('Cannot edit a void invoice');
  if (existing.invoiceStatus === 'paid') throw AppError.badRequest('Cannot edit a paid invoice');

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

  return ledger.updateTransaction(tenantId, invoiceId, {
    txnType: 'invoice',
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
  }, userId, companyId);
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

export async function generateShareLink(tenantId: string, invoiceId: string, userId?: string): Promise<string> {
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

  const { env } = await import('../config/env.js');
  return `${env.CORS_ORIGIN}/pay/${token}`;
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

  // Create payment transaction
  const payment = await ledger.postTransaction(tenantId, {
    txnType: 'customer_payment',
    txnDate: input.txnDate,
    contactId: invoice.contactId || undefined,
    memo: input.memo || `Payment for invoice ${invoice.txnNumber || invoice.id}`,
    total: input.amount,
    appliedToInvoiceId: invoiceId,
    lines: [
      { accountId: input.depositToAccountId, debit: input.amount, credit: '0' },
      { accountId: arAccountId, debit: '0', credit: input.amount },
    ],
  }, userId, companyId);

  // Update invoice — tolerance of 1¢ matches the rest of the money
  // paths. `Math.max(0, ...)` replaced with a Decimal clamp.
  const tolerance = new Decimal('0.01');
  const invoiceStatus = newBalance.lessThanOrEqualTo(tolerance) ? 'paid' : 'partial';
  const clampedBalance = newBalance.isNegative() ? new Decimal('0') : newBalance;
  await db.update(transactions).set({
    amountPaid: newPaid.toFixed(4),
    balanceDue: clampedBalance.toFixed(4),
    invoiceStatus,
    paidAt: invoiceStatus === 'paid' ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(transactions.id, invoiceId));

  return payment;
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
