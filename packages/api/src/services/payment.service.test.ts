// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Customer payment service tests. Covers the read-modify-write
// invariants around invoice.amountPaid (held in a FOR UPDATE lock
// during receivePayment + unapplyPayment), the overapplication guard,
// the Decimal-arithmetic status transitions (partial→paid), and
// pending-deposit aggregation from the Payments Clearing holding
// account. A race here can leave an invoice with a negative balance
// or with cents stuck outside any of {paid, partial} status.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants,
  users,
  sessions,
  accounts,
  companies,
  auditLog,
  contacts,
  transactions,
  journalLines,
  tags,
  transactionTags,
  paymentApplications,
  depositLines,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as contactService from './contacts.service.js';
import * as invoiceService from './invoice.service.js';
import * as paymentService from './payment.service.js';

let tenantId: string;
let bankAccountId: string;
let arAccountId: string;
let clearingAccountId: string;
let revenueAccountId: string;
let customerId: string;

async function cleanDb(): Promise<void> {
  await db.delete(depositLines);
  await db.delete(paymentApplications);
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function setup(): Promise<void> {
  const [tenant] = await db.insert(tenants).values({
    name: 'Payment Test',
    slug: 'pay-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = tenant!.id;

  // Company row — invoice.service reads it for numbering + default tax
  // rate.
  await db.insert(companies).values({
    tenantId,
    businessName: 'Test Co',
    invoicePrefix: 'INV-',
    invoiceNextNumber: 1,
    defaultSalesTaxRate: '0',
  });

  const bank = await accountsService.create(tenantId, {
    name: 'Checking', accountType: 'asset', accountNumber: '1010',
  });
  bankAccountId = bank.id;

  // AR and Payments Clearing need the system_tag so the service can
  // find them by tag rather than by name.
  const [ar] = await db.insert(accounts).values({
    tenantId, name: 'Accounts Receivable', accountType: 'asset',
    accountNumber: '1100', systemTag: 'accounts_receivable', isSystem: true,
  }).returning();
  arAccountId = ar!.id;

  const [clearing] = await db.insert(accounts).values({
    tenantId, name: 'Payments Clearing', accountType: 'asset',
    accountNumber: '1050', systemTag: 'payments_clearing', isSystem: true,
  }).returning();
  clearingAccountId = clearing!.id;

  const revenue = await accountsService.create(tenantId, {
    name: 'Revenue', accountType: 'revenue', accountNumber: '4000',
  });
  revenueAccountId = revenue.id;

  const customer = await contactService.create(tenantId, {
    displayName: 'Acme Corp', contactType: 'customer',
  });
  customerId = customer.id;
}

async function createTestInvoice(total: string, date = '2026-04-01'): Promise<{ id: string; total: string }> {
  const inv = await invoiceService.createInvoice(tenantId, {
    contactId: customerId,
    txnDate: date,
    lines: [
      { accountId: revenueAccountId, description: 'Services', quantity: '1', unitPrice: total, isTaxable: false },
    ],
  });
  return { id: inv.id, total: inv.total || '0' };
}

describe('Payment Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await setup();
  });

  afterEach(async () => {
    await cleanDb();
  });

  describe('receivePayment', () => {
    it('applies full payment and marks invoice as paid', async () => {
      const invoice = await createTestInvoice('500.00');

      const payment = await paymentService.receivePayment(tenantId, {
        customerId,
        date: '2026-04-15',
        amount: '500.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '500.00' }],
      });

      expect(payment.txnType).toBe('customer_payment');

      // Invoice should now be paid in full
      const updated = await db.query.transactions.findFirst({
        where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoice.id)),
      });
      expect(updated?.invoiceStatus).toBe('paid');
      expect(parseFloat(updated?.amountPaid || '0')).toBe(500);
      expect(parseFloat(updated?.balanceDue || '0')).toBe(0);
      expect(updated?.paidAt).not.toBeNull();
    });

    it('applies partial payment and sets status=partial with correct balance', async () => {
      const invoice = await createTestInvoice('1000.00');

      await paymentService.receivePayment(tenantId, {
        customerId,
        date: '2026-04-15',
        amount: '400.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '400.00' }],
      });

      const updated = await db.query.transactions.findFirst({
        where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoice.id)),
      });
      expect(updated?.invoiceStatus).toBe('partial');
      expect(parseFloat(updated?.amountPaid || '0')).toBe(400);
      expect(parseFloat(updated?.balanceDue || '0')).toBe(600);
      expect(updated?.paidAt).toBeNull();
    });

    it('rejects overapplication beyond 1¢ tolerance', async () => {
      const invoice = await createTestInvoice('100.00');

      await expect(
        paymentService.receivePayment(tenantId, {
          customerId,
          date: '2026-04-15',
          amount: '150.00',
          depositTo: bankAccountId,
          applications: [{ invoiceId: invoice.id, amount: '150.00' }],
        }),
      ).rejects.toThrow(/overapply/);
    });

    it('accepts application within the 1¢ rounding tolerance', async () => {
      const invoice = await createTestInvoice('100.00');

      // 100.005 > 100.00 by 0.5¢ — should land inside tolerance and
      // mark invoice paid-in-full rather than raising.
      await paymentService.receivePayment(tenantId, {
        customerId,
        date: '2026-04-15',
        amount: '100.005',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '100.005' }],
      });

      const updated = await db.query.transactions.findFirst({
        where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoice.id)),
      });
      expect(updated?.invoiceStatus).toBe('paid');
      // balanceDue clamps at 0 per service logic (newBalance.isNegative() → '0')
      expect(parseFloat(updated?.balanceDue || '0')).toBe(0);
    });

    it('applies a single payment across multiple invoices', async () => {
      const inv1 = await createTestInvoice('300.00', '2026-04-01');
      const inv2 = await createTestInvoice('200.00', '2026-04-02');

      await paymentService.receivePayment(tenantId, {
        customerId,
        date: '2026-04-15',
        amount: '500.00',
        depositTo: bankAccountId,
        applications: [
          { invoiceId: inv1.id, amount: '300.00' },
          { invoiceId: inv2.id, amount: '200.00' },
        ],
      });

      const updated1 = await db.query.transactions.findFirst({
        where: eq(transactions.id, inv1.id),
      });
      const updated2 = await db.query.transactions.findFirst({
        where: eq(transactions.id, inv2.id),
      });
      expect(updated1?.invoiceStatus).toBe('paid');
      expect(updated2?.invoiceStatus).toBe('paid');
    });

    it('sequential partial payments correctly sum and flip status to paid', async () => {
      const invoice = await createTestInvoice('300.00');

      await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-10', amount: '100.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '100.00' }],
      });
      await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-20', amount: '100.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '100.00' }],
      });
      await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-30', amount: '100.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '100.00' }],
      });

      const updated = await db.query.transactions.findFirst({
        where: eq(transactions.id, invoice.id),
      });
      expect(updated?.invoiceStatus).toBe('paid');
      expect(parseFloat(updated?.amountPaid || '0')).toBe(300);
    });

    it('rejects a second payment that would push total over the invoice total', async () => {
      const invoice = await createTestInvoice('100.00');

      await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-10', amount: '80.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '80.00' }],
      });

      // $80 + $50 = $130 against a $100 invoice → overapply.
      await expect(
        paymentService.receivePayment(tenantId, {
          customerId, date: '2026-04-20', amount: '50.00',
          depositTo: bankAccountId,
          applications: [{ invoiceId: invoice.id, amount: '50.00' }],
        }),
      ).rejects.toThrow(/overapply/);

      // First payment still intact.
      const updated = await db.query.transactions.findFirst({
        where: eq(transactions.id, invoice.id),
      });
      expect(parseFloat(updated?.amountPaid || '0')).toBe(80);
    });

    it('throws when an invoice id is not found in this tenant', async () => {
      const invoice = await createTestInvoice('100.00');

      const [other] = await db.insert(tenants).values({
        name: 'Other', slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      }).returning();
      // Request uses otherTenant scope but references this tenant's invoice id.
      await expect(
        paymentService.receivePayment(other!.id, {
          customerId,
          date: '2026-04-15',
          amount: '100.00',
          depositTo: bankAccountId,
          applications: [{ invoiceId: invoice.id, amount: '100.00' }],
        }),
      ).rejects.toThrow();
    });

    it('posts the payment as a balanced journal entry (debit bank, credit AR)', async () => {
      const invoice = await createTestInvoice('250.00');
      const payment = await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-15', amount: '250.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '250.00' }],
      });

      const lines = await db.query.journalLines.findMany({
        where: eq(journalLines.transactionId, payment.id),
      });
      expect(lines.length).toBe(2);
      const bankLine = lines.find((l) => l.accountId === bankAccountId);
      const arLine = lines.find((l) => l.accountId === arAccountId);
      expect(parseFloat(bankLine?.debit || '0')).toBe(250);
      expect(parseFloat(bankLine?.credit || '0')).toBe(0);
      expect(parseFloat(arLine?.debit || '0')).toBe(0);
      expect(parseFloat(arLine?.credit || '0')).toBe(250);
    });
  });

  describe('unapplyPayment', () => {
    it('restores invoice balance and sets status back to sent when fully unapplied', async () => {
      const invoice = await createTestInvoice('500.00');
      const payment = await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-15', amount: '500.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '500.00' }],
      });

      await paymentService.unapplyPayment(tenantId, payment.id, invoice.id);

      const updated = await db.query.transactions.findFirst({
        where: eq(transactions.id, invoice.id),
      });
      expect(updated?.invoiceStatus).toBe('sent');
      expect(parseFloat(updated?.amountPaid || '0')).toBe(0);
      expect(parseFloat(updated?.balanceDue || '0')).toBe(500);
      expect(updated?.paidAt).toBeNull();

      // Application row is deleted.
      const remaining = await db.query.paymentApplications.findFirst({
        where: and(
          eq(paymentApplications.paymentId, payment.id),
          eq(paymentApplications.invoiceId, invoice.id),
        ),
      });
      expect(remaining).toBeUndefined();
    });

    it('throws when the payment application does not exist', async () => {
      const invoice = await createTestInvoice('100.00');
      await expect(
        paymentService.unapplyPayment(tenantId, '00000000-0000-0000-0000-000000000000', invoice.id),
      ).rejects.toThrow('not found');
    });

    it('scopes the unapply operation by tenant (cannot touch another tenant\'s application)', async () => {
      const invoice = await createTestInvoice('100.00');
      const payment = await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-15', amount: '100.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '100.00' }],
      });

      const [other] = await db.insert(tenants).values({
        name: 'Other', slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      }).returning();
      await expect(
        paymentService.unapplyPayment(other!.id, payment.id, invoice.id),
      ).rejects.toThrow('not found');

      // Original tenant's data is untouched.
      const updated = await db.query.transactions.findFirst({ where: eq(transactions.id, invoice.id) });
      expect(updated?.invoiceStatus).toBe('paid');
    });
  });

  describe('getOpenInvoicesForCustomer', () => {
    it('returns invoices with positive balance and excludes paid ones', async () => {
      const paid = await createTestInvoice('100.00', '2026-04-01');
      const open = await createTestInvoice('200.00', '2026-04-02');

      await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-15', amount: '100.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: paid.id, amount: '100.00' }],
      });

      const rows = await paymentService.getOpenInvoicesForCustomer(tenantId, customerId);
      const ids = (rows as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(open.id);
      expect(ids).not.toContain(paid.id);
    });

    it('returns empty array when the customer has no open invoices', async () => {
      const rows = await paymentService.getOpenInvoicesForCustomer(tenantId, customerId);
      expect(rows.length).toBe(0);
    });
  });

  describe('getPaymentsForInvoice', () => {
    it('returns applications across all payments against the invoice, in date order', async () => {
      const invoice = await createTestInvoice('500.00');
      await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-01', amount: '200.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '200.00' }],
      });
      await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-15', amount: '300.00',
        depositTo: bankAccountId,
        applications: [{ invoiceId: invoice.id, amount: '300.00' }],
      });

      const rows = await paymentService.getPaymentsForInvoice(tenantId, invoice.id);
      expect(rows.length).toBe(2);
      expect(parseFloat((rows[0] as { amount: string }).amount)).toBe(200);
      expect(parseFloat((rows[1] as { amount: string }).amount)).toBe(300);
    });
  });

  describe('getPendingDeposits', () => {
    it('aggregates payments posted to Payments Clearing (using depositTo=clearing)', async () => {
      const invoice = await createTestInvoice('300.00');
      await paymentService.receivePayment(tenantId, {
        customerId, date: '2026-04-15', amount: '300.00',
        depositTo: clearingAccountId, // Deposit to PC instead of bank.
        applications: [{ invoiceId: invoice.id, amount: '300.00' }],
      });

      const result = await paymentService.getPendingDeposits(tenantId);
      expect(result.paymentsClearingBalance).toBe(300);
      expect(result.items.length).toBe(1);
      expect(result.items[0]?.amount).toBe(300);
    });

    it('returns zero balance when no Payments Clearing account is configured', async () => {
      // Remove the system tag → service returns empty fast-path.
      await db.update(accounts).set({ systemTag: null }).where(eq(accounts.id, clearingAccountId));
      const result = await paymentService.getPendingDeposits(tenantId);
      expect(result.paymentsClearingBalance).toBe(0);
      expect(result.items.length).toBe(0);
    });
  });
});
