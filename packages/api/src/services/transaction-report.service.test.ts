// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { db } from '../db/index.js';
import {
  tenants, accounts, companies, auditLog, contacts, transactions, journalLines,
  attachments, billPaymentApplications, vendorCreditApplications, paymentApplications,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as attachmentService from './attachment.service.js';
import * as billService from './bill.service.js';
import * as billPaymentService from './bill-payment.service.js';
import * as ledger from './ledger.service.js';
import * as report from './transaction-report.service.js';

let tenantId = '';
let otherTenantId = '';
let bankAccountId: string;
let utilitiesId: string;
let arAccountId: string;
let vendorId: string;
let customerId: string;

async function wipe(id: string) {
  if (!id) return;
  await db.delete(attachments).where(eq(attachments.tenantId, id));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, id));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, id));
  await db.delete(paymentApplications).where(eq(paymentApplications.tenantId, id));
  await db.delete(journalLines).where(eq(journalLines.tenantId, id));
  await db.delete(transactions).where(eq(transactions.tenantId, id));
  await db.delete(auditLog).where(eq(auditLog.tenantId, id));
  await db.delete(contacts).where(eq(contacts.tenantId, id));
  await db.delete(accounts).where(eq(accounts.tenantId, id));
  await db.delete(companies).where(eq(companies.tenantId, id));
  await db.delete(tenants).where(eq(tenants.id, id));
}

// Tenant-SCOPED cleanup — never touch another suite's rows.
async function cleanDb() {
  await wipe(tenantId);
  await wipe(otherTenantId);
  tenantId = '';
  otherTenantId = '';
}

async function setup() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [tenant] = await db.insert(tenants).values({ name: 'Txn Report Test', slug: `txn-report-${stamp}` }).returning();
  tenantId = tenant!.id;
  const [other] = await db.insert(tenants).values({ name: 'Txn Report Other', slug: `txn-report-other-${stamp}` }).returning();
  otherTenantId = other!.id;

  const bank = await accountsService.create(tenantId, { name: 'Cash in Bank - Operating', accountType: 'asset', detailType: 'bank', accountNumber: '1060' });
  bankAccountId = bank.id;
  await db.insert(accounts).values({
    tenantId, name: 'Accounts Payable', accountType: 'liability', accountNumber: '2060', systemTag: 'accounts_payable', isSystem: true,
  });
  const [ar] = await db.insert(accounts).values({
    tenantId, name: 'Accounts Receivable', accountType: 'asset', accountNumber: '1200', systemTag: 'accounts_receivable', isSystem: true,
  }).returning();
  arAccountId = ar!.id;
  const utils = await accountsService.create(tenantId, { name: 'Utilities', accountType: 'expense', accountNumber: '7021' });
  utilitiesId = utils.id;

  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Spire' }).returning();
  vendorId = vendor!.id;
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Wallace Harner' }).returning();
  customerId = customer!.id;
}

async function makeBill(amount = '68.95') {
  return billService.createBill(tenantId, {
    contactId: vendorId,
    txnDate: '2026-09-10',
    vendorInvoiceNumber: '4394722222',
    lines: [{ accountId: utilitiesId, amount, description: 'Gas service' }],
  });
}

async function payBill(billId: string, amount = '68.95') {
  const result = await billPaymentService.payBills(tenantId, {
    bankAccountId, txnDate: '2026-09-28', method: 'ach', referenceNumber: 'ACH-7781',
    bills: [{ billId, amount }],
  });
  return result.payments[0]!;
}

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

function attach(txn: { id: string }, type: string, name: string, mimetype: string, buffer: Buffer) {
  return attachmentService.upload(tenantId, { originalname: name, buffer, mimetype, size: buffer.length }, type, txn.id, { skipAutoClassify: true });
}

// Stands in for Chromium: every HTML render is one blank page. `html` keeps
// what was rendered so tests can read the summary.
function stubRenderer() {
  const html: string[] = [];
  let closed = 0;
  return {
    html,
    get closed() { return closed; },
    deps: {
      openRenderer: async () => ({
        render: async (h: string) => { html.push(h); return new Uint8Array(await makePdf(1)); },
        close: async () => { closed++; },
      }),
    },
  };
}

describe('transaction-report.service', () => {
  beforeEach(async () => { await cleanDb(); await setup(); });
  afterEach(async () => { await cleanDb(); });

  describe('getRelatedTransactions', () => {
    it('links a bill and its payment in both directions, with the applied amount', async () => {
      const bill = await makeBill();
      const payment = await payBill(bill.id);

      const fromBill = await report.getRelatedTransactions(tenantId, bill.id);
      expect(fromBill.truncated).toBe(false);
      expect(fromBill.related).toHaveLength(1);
      expect(fromBill.related[0]).toMatchObject({
        id: payment.id, txnType: 'bill_payment', relation: 'payment', contactName: 'Spire',
        paymentMethod: 'ach', referenceNumber: 'ACH-7781',
      });
      expect(Number(fromBill.related[0]!.appliedAmount)).toBe(68.95);

      const fromPayment = await report.getRelatedTransactions(tenantId, payment.id);
      expect(fromPayment.related).toHaveLength(1);
      expect(fromPayment.related[0]).toMatchObject({ id: bill.id, relation: 'paid_bill', vendorInvoiceNumber: '4394722222' });
    });

    it('stays one hop: the other bills a payment paid are not pulled in from a bill', async () => {
      const billA = await makeBill('10.00');
      const billB = await makeBill('20.00');
      await billPaymentService.payBills(tenantId, {
        bankAccountId, txnDate: '2026-09-28', method: 'ach',
        bills: [{ billId: billA.id, amount: '10.00' }, { billId: billB.id, amount: '20.00' }],
      });
      const fromA = await report.getRelatedTransactions(tenantId, billA.id);
      expect(fromA.related.map((r) => r.txnType)).toEqual(['bill_payment']);
    });

    it('finds invoice payments through payment_applications AND the legacy applied_to_invoice_id link', async () => {
      const lines = (debit: string, credit: string) => [
        { accountId: debit, debit: '100.00', credit: '0' }, { accountId: credit, debit: '0', credit: '100.00' },
      ];
      const invoice = await ledger.postTransaction(tenantId, {
        txnType: 'invoice', txnDate: '2026-09-01', txnNumber: 'INV-1', contactId: customerId, total: '100.00', lines: lines(arAccountId, utilitiesId),
      });
      const applied = await ledger.postTransaction(tenantId, {
        txnType: 'customer_payment', txnDate: '2026-09-05', contactId: customerId, total: '60.00', lines: lines(bankAccountId, arAccountId),
      });
      await db.insert(paymentApplications).values({ tenantId, paymentId: applied.id, invoiceId: invoice.id, amount: '60.0000' });
      // Record Payment on the invoice page: no application row at all.
      const legacy = await ledger.postTransaction(tenantId, {
        txnType: 'customer_payment', txnDate: '2026-09-06', contactId: customerId, total: '40.00',
        appliedToInvoiceId: invoice.id, lines: lines(bankAccountId, arAccountId),
      });

      const fromInvoice = await report.getRelatedTransactions(tenantId, invoice.id);
      expect(fromInvoice.related.map((r) => r.id)).toEqual([applied.id, legacy.id]);
      expect(fromInvoice.related.map((r) => Number(r.appliedAmount))).toEqual([60, 40]);

      const fromLegacy = await report.getRelatedTransactions(tenantId, legacy.id);
      expect(fromLegacy.related).toHaveLength(1);
      expect(fromLegacy.related[0]).toMatchObject({ id: invoice.id, relation: 'paid_invoice' });
    });

    it('returns a voided customer payment flagged as void', async () => {
      const lines = (debit: string, credit: string) => [
        { accountId: debit, debit: '50.00', credit: '0' }, { accountId: credit, debit: '0', credit: '50.00' },
      ];
      const invoice = await ledger.postTransaction(tenantId, {
        txnType: 'invoice', txnDate: '2026-09-01', contactId: customerId, total: '50.00', lines: lines(arAccountId, utilitiesId),
      });
      const payment = await ledger.postTransaction(tenantId, {
        txnType: 'customer_payment', txnDate: '2026-09-05', contactId: customerId, total: '50.00',
        appliedToInvoiceId: invoice.id, lines: lines(bankAccountId, arAccountId),
      });
      await ledger.voidTransaction(tenantId, payment.id, 'entered twice');
      const { related } = await report.getRelatedTransactions(tenantId, invoice.id);
      expect(related[0]).toMatchObject({ id: payment.id, status: 'void' });
    });

    it('is tenant-scoped and honours the active company', async () => {
      const bill = await makeBill();
      await expect(report.getRelatedTransactions(otherTenantId, bill.id)).rejects.toThrow(/not found/i);

      const [company] = await db.insert(companies).values({ tenantId, businessName: 'Company A' }).returning();
      await db.update(transactions).set({ companyId: company!.id }).where(eq(transactions.id, bill.id));
      await expect(report.getRelatedTransactions(tenantId, bill.id, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(/not found/i);
      // NULL-company rows are legacy single-company data: a payment without a
      // company still belongs to the bill's chain.
      const payment = await payBill(bill.id);
      const { related } = await report.getRelatedTransactions(tenantId, bill.id, company!.id);
      expect(related.map((r) => r.id)).toEqual([payment.id]);
    });

    it('has nothing to say about a journal entry', async () => {
      const je = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-09-01',
        lines: [{ accountId: utilitiesId, debit: '5.00', credit: '0' }, { accountId: bankAccountId, debit: '0', credit: '5.00' }],
      });
      expect(await report.getRelatedTransactions(tenantId, je.id)).toEqual({ related: [], truncated: false });
    });
  });

  describe('getTransactionDetail', () => {
    it('names the bank account a bill payment was paid from', async () => {
      const bill = await makeBill();
      const payment = await payBill(bill.id);
      const detail = await report.getTransactionDetail(tenantId, payment.id);
      expect(detail.contactName).toBe('Spire');
      expect(detail.paymentMethod).toBe('ach');
      expect(detail.referenceNumber).toBe('ACH-7781');
      expect(detail.bankAccounts).toEqual([{ accountId: bankAccountId, name: 'Cash in Bank - Operating', accountNumber: '1060', side: 'from' }]);
    });
  });

  describe('generateTransactionRangeReportPdf', () => {
    it('reports every transaction in the range in one summary, with attachments in transaction order', async () => {
      const bill = await makeBill();            // 2026-09-10
      const payment = await payBill(bill.id);   // 2026-09-28
      await ledger.postTransaction(tenantId, {
        txnType: 'expense', txnDate: '2026-10-02', memo: 'Outside the range',
        lines: [
          { accountId: utilitiesId, debit: '10.00', credit: '0' },
          { accountId: bankAccountId, debit: '0', credit: '10.00' },
        ],
      });
      await attach(payment, 'bill_payment', 'confirmation.pdf', 'application/pdf', await makePdf(1));
      await attach(bill, 'bill', 'spire-statement.pdf', 'application/pdf', await makePdf(2));

      const stub = stubRenderer();
      const result = await report.generateTransactionRangeReportPdf(
        tenantId, { startDate: '2026-09-01', endDate: '2026-09-30' }, { includeAttachments: true }, stub.deps,
      );

      // summary (1, stubbed) + statement (2) + confirmation (1)
      expect(result.pageCount).toBe(4);
      expect(result.warnings).toEqual([]);
      expect(result.fileName).toBe('transaction-report-2026-09-01-to-2026-09-30.pdf');
      expect(stub.closed).toBe(1);

      const summary = stub.html[stub.html.length - 1]!;
      expect(summary).toContain('09/01/2026 to 09/30/2026');
      expect(summary).toContain('2 transactions');
      expect(summary).not.toContain('Outside the range');
      // Every block is a whole unit that refuses to split across pages, so a
      // page holds as many as fit.
      expect(summary).toContain('.txn{margin-bottom:18px;break-inside:avoid;page-break-inside:avoid}');
      // Date order: the bill's attachment comes first, so it is ordinal 1.
      expect(summary.indexOf('Vendor: Spire')).toBeGreaterThan(-1);
      expect(summary).toContain('1. spire-statement.pdf');
      expect(summary).toContain('2. confirmation.pdf');
      // Links are a one-line note per block, not expanded blocks.
      expect(summary).toContain('Linked:');
      expect(summary).toContain('Payment applied');
      expect(summary).toContain('Bill paid');
      expect(summary).not.toContain('Linked transactions</h3>');
    });

    it('applies the type / name lenses and leaves voided transactions out unless asked', async () => {
      const bill = await makeBill();
      const payment = await payBill(bill.id);
      const [other] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Other Co' }).returning();
      const voided = await ledger.postTransaction(tenantId, {
        txnType: 'expense', txnDate: '2026-09-15', memo: 'Voided later', contactId: other!.id,
        lines: [
          { accountId: utilitiesId, debit: '5.00', credit: '0' },
          { accountId: bankAccountId, debit: '0', credit: '5.00' },
        ],
      });
      await ledger.voidTransaction(tenantId, voided.id, 'mistake');

      const range = { startDate: '2026-09-01', endDate: '2026-09-30' };
      let stub = stubRenderer();
      await report.generateTransactionRangeReportPdf(tenantId, range, { includeAttachments: false }, stub.deps);
      let summary = stub.html[stub.html.length - 1]!;
      expect(summary).toContain('2 transactions');
      expect(summary).not.toContain('Voided later');
      expect(summary).toContain('Attachments are not included');

      stub = stubRenderer();
      await report.generateTransactionRangeReportPdf(tenantId, { ...range, includeVoid: true }, { includeAttachments: false }, stub.deps);
      summary = stub.html[stub.html.length - 1]!;
      expect(summary).toContain('3 transactions');
      expect(summary).toContain('Voided later');
      expect(summary).toContain('including voided');

      stub = stubRenderer();
      await report.generateTransactionRangeReportPdf(tenantId, { ...range, txnType: 'bill_payment' }, { includeAttachments: false }, stub.deps);
      summary = stub.html[stub.html.length - 1]!;
      expect(summary).toContain('1 transaction<');
      expect(summary).toContain('· Bill Payment');
      expect(summary).toContain('ACH-7781');
      expect(summary).not.toContain('4394722222');
      void payment;

      stub = stubRenderer();
      await report.generateTransactionRangeReportPdf(tenantId, { ...range, contactId: other!.id }, { includeAttachments: false }, stub.deps);
      summary = stub.html[stub.html.length - 1]!;
      expect(summary).toContain('· Other Co');
      expect(summary).toContain('No transactions match');
    });

    it('stays inside its own tenant', async () => {
      await makeBill();
      const stub = stubRenderer();
      const result = await report.generateTransactionRangeReportPdf(
        otherTenantId, { startDate: '2026-01-01', endDate: '2026-12-31' }, { includeAttachments: true }, stub.deps,
      );
      expect(result.pageCount).toBe(1);
      expect(stub.html[stub.html.length - 1]!).toContain('No transactions match');
    });
  });

  describe('generateTransactionReportPdf', () => {
    it('merges the summary, a PDF attachment page-for-page and an image attachment', async () => {
      const bill = await makeBill();
      const payment = await payBill(bill.id);
      await attach(bill, 'bill', 'spire-statement.pdf', 'application/pdf', await makePdf(2));
      await attach(payment, 'bill_payment', 'confirmation.png', 'image/png', Buffer.from('not-really-a-png'));

      const stub = stubRenderer();
      const result = await report.generateTransactionReportPdf(tenantId, bill.id, { includeAttachments: true }, stub.deps);

      // summary (1) + statement (2) + image page (1)
      expect(result.pageCount).toBe(4);
      expect(result.warnings).toEqual([]);
      expect(result.fileName).toMatch(/^transaction-report-bill-.*\.pdf$/);
      expect((await PDFDocument.load(result.buffer)).getPageCount()).toBe(4);
      expect(stub.closed).toBe(1);

      const summary = stub.html[stub.html.length - 1]!;
      expect(summary).toContain('Vendor: Spire');
      expect(summary).toContain('4394722222');
      expect(summary).toContain('ACH-7781');
      expect(summary).toContain('Linked transactions');
      expect(summary).toContain('1. spire-statement.pdf');
      expect(summary).toContain('2. confirmation.png');
    });

    it('notes an unreadable or unsupported attachment instead of failing', async () => {
      const bill = await makeBill();
      await attach(bill, 'bill', 'good.pdf', 'application/pdf', await makePdf(1));
      await attach(bill, 'bill', 'broken.pdf', 'application/pdf', Buffer.from('%PDF-1.4 this is not a pdf'));
      await attach(bill, 'bill', 'notes.csv', 'text/csv', Buffer.from('a,b\n1,2\n'));

      const stub = stubRenderer();
      const result = await report.generateTransactionReportPdf(tenantId, bill.id, { includeAttachments: true }, stub.deps);

      expect(result.pageCount).toBe(2);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings.join('\n')).toMatch(/broken\.pdf: could not be included/);
      expect(result.warnings.join('\n')).toMatch(/notes\.csv: not included/);
      expect(stub.html[0]).toContain('broken.pdf');
    });

    it('caps a long PDF at its first 50 pages and says so', async () => {
      const bill = await makeBill();
      await attach(bill, 'bill', 'long.pdf', 'application/pdf', await makePdf(53));
      const stub = stubRenderer();
      const result = await report.generateTransactionReportPdf(tenantId, bill.id, { includeAttachments: true }, stub.deps);
      expect(result.pageCount).toBe(51);
      expect(stub.html[0]).toContain('first 50 of 53 pages');
    });

    it('is summary-only when the caller may not read attachments', async () => {
      const bill = await makeBill();
      await attach(bill, 'bill', 'statement.pdf', 'application/pdf', await makePdf(2));
      const stub = stubRenderer();
      const result = await report.generateTransactionReportPdf(tenantId, bill.id, { includeAttachments: false }, stub.deps);
      expect(result.pageCount).toBe(1);
      expect(stub.html[0]).toContain('Attachments are not included');
      expect(stub.html[0]).not.toContain('statement.pdf');
    });

    it('lists a voided linked payment without printing its details', async () => {
      const lines = (debit: string, credit: string) => [
        { accountId: debit, debit: '50.00', credit: '0' }, { accountId: credit, debit: '0', credit: '50.00' },
      ];
      const invoice = await ledger.postTransaction(tenantId, {
        txnType: 'invoice', txnDate: '2026-09-01', txnNumber: 'INV-9', contactId: customerId, total: '50.00', lines: lines(arAccountId, utilitiesId),
      });
      const payment = await ledger.postTransaction(tenantId, {
        txnType: 'customer_payment', txnDate: '2026-09-05', contactId: customerId, total: '50.00', referenceNumber: 'VOIDED-REF',
        appliedToInvoiceId: invoice.id, lines: lines(bankAccountId, arAccountId),
      });
      await ledger.voidTransaction(tenantId, payment.id, 'entered twice');

      const stub = stubRenderer();
      await report.generateTransactionReportPdf(tenantId, invoice.id, { includeAttachments: true }, stub.deps);
      const summary = stub.html[0]!;
      expect(summary).toContain('Voided transactions are listed for reference');
      // One block (the invoice) — the voided payment gets a table row only.
      expect(summary.match(/<section class="txn">/g)).toHaveLength(1);
    });
  });
});
