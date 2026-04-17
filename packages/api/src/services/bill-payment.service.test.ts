// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
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
  billPaymentApplications,
  vendorCreditApplications,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as billService from './bill.service.js';
import * as vendorCreditService from './vendor-credit.service.js';
import * as billPaymentService from './bill-payment.service.js';
import * as ledger from './ledger.service.js';

let tenantId: string;
let bankAccountId: string;
let apAccountId: string;
let officeSuppliesId: string;
let utilitiesId: string;
let vendorId: string;
let vendorBId: string;

async function cleanDb() {
  await db.delete(billPaymentApplications);
  await db.delete(vendorCreditApplications);
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

async function setup() {
  const [tenant] = await db.insert(tenants).values({
    name: 'AP Test',
    slug: 'ap-test-' + Date.now(),
  }).returning();
  tenantId = tenant!.id;

  // Bank account (asset)
  const bank = await accountsService.create(tenantId, {
    name: 'Operating Cash',
    accountType: 'asset',
    accountNumber: '1000',
  });
  bankAccountId = bank.id;

  // AP account — must have system_tag = 'accounts_payable' for the bill service to find it
  const [ap] = await db.insert(accounts).values({
    tenantId,
    name: 'Accounts Payable',
    accountType: 'liability',
    accountNumber: '2000',
    systemTag: 'accounts_payable',
    isSystem: true,
  }).returning();
  apAccountId = ap!.id;

  // Expense accounts
  const office = await accountsService.create(tenantId, {
    name: 'Office Supplies',
    accountType: 'expense',
    accountNumber: '6000',
  });
  officeSuppliesId = office.id;

  const utils = await accountsService.create(tenantId, {
    name: 'Utilities',
    accountType: 'expense',
    accountNumber: '6100',
  });
  utilitiesId = utils.id;

  // Vendors
  const [vendor] = await db.insert(contacts).values({
    tenantId,
    contactType: 'vendor',
    displayName: 'ABC Supply',
    defaultPaymentTerms: 'net_30',
  }).returning();
  vendorId = vendor!.id;

  const [vendorB] = await db.insert(contacts).values({
    tenantId,
    contactType: 'vendor',
    displayName: 'XYZ Corp',
  }).returning();
  vendorBId = vendorB!.id;
}

describe('Bill Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await setup();
  });

  afterEach(async () => {
    await cleanDb();
  });

  describe('createBill', () => {
    it('posts the correct journal: DR Expense, CR AP', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [
          { accountId: officeSuppliesId, amount: '500.00', description: 'Paper and pens' },
        ],
      });

      expect(bill.txnType).toBe('bill');
      expect(bill.billStatus).toBe('unpaid');
      expect(parseFloat(bill.total ?? '0')).toBe(500);
      expect(parseFloat(bill.balanceDue ?? '0')).toBe(500);

      // Inspect journal lines
      const lines = await db.select().from(journalLines)
        .where(eq(journalLines.transactionId, bill.id));
      expect(lines.length).toBe(2);

      const expenseLine = lines.find((l) => l.accountId === officeSuppliesId)!;
      expect(parseFloat(expenseLine.debit)).toBe(500);
      expect(parseFloat(expenseLine.credit)).toBe(0);

      const apLine = lines.find((l) => l.accountId === apAccountId)!;
      expect(parseFloat(apLine.debit)).toBe(0);
      expect(parseFloat(apLine.credit)).toBe(500);

      // Account balances
      const apAccount = await accountsService.getById(tenantId, apAccountId);
      expect(parseFloat(apAccount.balance ?? '0')).toBe(-500); // credit balance shows negative

      const officeAccount = await accountsService.getById(tenantId, officeSuppliesId);
      expect(parseFloat(officeAccount.balance ?? '0')).toBe(500);
    });

    it('handles split lines summing to total', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [
          { accountId: officeSuppliesId, amount: '300.00' },
          { accountId: utilitiesId, amount: '200.00' },
        ],
      });

      expect(parseFloat(bill.total ?? '0')).toBe(500);

      const validation = await ledger.validateBalance(tenantId);
      expect(validation.valid).toBe(true);
    });

    it('auto-calculates due date from net_30 terms', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        paymentTerms: 'net_30',
        lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
      });

      expect(bill.dueDate).toBe('2026-05-01');
    });

    it('auto-applies vendor default payment terms', async () => {
      // Vendor has default net_30
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        // no paymentTerms passed — should pick up vendor default
        lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
      });

      expect(bill.paymentTerms).toBe('net_30');
      expect(bill.dueDate).toBe('2026-05-01');
    });

    it('supports custom term days', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        paymentTerms: 'custom',
        termsDays: 45,
        lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
      });

      expect(bill.dueDate).toBe('2026-05-16');
    });

    it('rejects bill with zero total', async () => {
      await expect(
        billService.createBill(tenantId, {
          contactId: vendorId,
          txnDate: '2026-04-01',
          lines: [{ accountId: officeSuppliesId, amount: '0' }],
        }),
      ).rejects.toThrow('positive');
    });

    it('rejects bill for unknown vendor', async () => {
      await expect(
        billService.createBill(tenantId, {
          contactId: '00000000-0000-0000-0000-000000000000',
          txnDate: '2026-04-01',
          lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
        }),
      ).rejects.toThrow('Vendor not found');
    });
  });

  describe('updateBill / voidBill', () => {
    it('blocks changing the total on a paid bill', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
      });

      await billPaymentService.payBills(tenantId, {
        bankAccountId,
        txnDate: '2026-04-02',
        method: 'check',
        printLater: true,
        bills: [{ billId: bill.id, amount: '100.00' }],
      });

      // Changing total from $100 → $200 on a paid bill must fail.
      // The expense lines can be reallocated but the total is locked
      // because payment applications already reference it.
      await expect(
        billService.updateBill(tenantId, bill.id, {
          contactId: vendorId,
          txnDate: '2026-04-01',
          lines: [{ accountId: officeSuppliesId, amount: '200.00' }],
        }),
      ).rejects.toThrow('Cannot change the total');
    });

    it('blocks changing the vendor on a paid bill', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
      });

      await billPaymentService.payBills(tenantId, {
        bankAccountId,
        txnDate: '2026-04-02',
        method: 'check',
        printLater: true,
        bills: [{ billId: bill.id, amount: '100.00' }],
      });

      await expect(
        billService.updateBill(tenantId, bill.id, {
          contactId: vendorBId,
          txnDate: '2026-04-01',
          lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
        }),
      ).rejects.toThrow('Cannot change the vendor');
    });

    it('blocks changing the bill date on a paid bill', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
      });

      await billPaymentService.payBills(tenantId, {
        bankAccountId,
        txnDate: '2026-04-02',
        method: 'check',
        printLater: true,
        bills: [{ billId: bill.id, amount: '100.00' }],
      });

      await expect(
        billService.updateBill(tenantId, bill.id, {
          contactId: vendorId,
          txnDate: '2026-04-03',
          lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
        }),
      ).rejects.toThrow('Cannot change the bill date');
    });

    it('allows reallocating expense lines on a paid bill without changing the total', async () => {
      // Single $100 line on Office Supplies, fully paid
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
      });

      await billPaymentService.payBills(tenantId, {
        bankAccountId,
        txnDate: '2026-04-02',
        method: 'check',
        printLater: true,
        bills: [{ billId: bill.id, amount: '100.00' }],
      });

      // Reallocate: split into $60 Office Supplies + $40 Utilities.
      // Total stays at $100, payment applications remain valid, bill
      // stays 'paid'.
      await billService.updateBill(tenantId, bill.id, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [
          { accountId: officeSuppliesId, amount: '60.00', description: 'Office (reallocated)' },
          { accountId: utilitiesId, amount: '40.00', description: 'Utilities (reallocated)' },
        ],
      });

      // Bill is still fully paid
      const updated = await billService.getBill(tenantId, bill.id);
      expect(updated.billStatus).toBe('paid');
      expect(parseFloat(updated.total || '0')).toBe(100);
      expect(parseFloat(updated.amountPaid || '0')).toBe(100);
      expect(parseFloat(updated.balanceDue || '0')).toBe(0);

      // Expense lines reflect the reallocation
      const expenseLines = (updated.lines || []).filter((l: any) => parseFloat(l.debit) > 0);
      expect(expenseLines).toHaveLength(2);
      const totalsByAccount = new Map<string, number>();
      for (const l of expenseLines as any[]) {
        totalsByAccount.set(l.accountId, (totalsByAccount.get(l.accountId) || 0) + parseFloat(l.debit));
      }
      expect(totalsByAccount.get(officeSuppliesId)).toBe(60);
      expect(totalsByAccount.get(utilitiesId)).toBe(40);

      // Account balances moved correspondingly
      const office = await accountsService.getById(tenantId, officeSuppliesId);
      const utils = await accountsService.getById(tenantId, utilitiesId);
      expect(parseFloat(office.balance || '0')).toBe(60);
      expect(parseFloat(utils.balance || '0')).toBe(40);
    });

    it('allows reallocation on a partially paid bill', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [{ accountId: officeSuppliesId, amount: '500.00' }],
      });

      await billPaymentService.payBills(tenantId, {
        bankAccountId,
        txnDate: '2026-04-02',
        method: 'ach',
        bills: [{ billId: bill.id, amount: '200.00' }],
      });

      await billService.updateBill(tenantId, bill.id, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [
          { accountId: officeSuppliesId, amount: '300.00' },
          { accountId: utilitiesId, amount: '200.00' },
        ],
      });

      const updated = await billService.getBill(tenantId, bill.id);
      expect(updated.billStatus).toBe('partial');
      expect(parseFloat(updated.total || '0')).toBe(500);
      expect(parseFloat(updated.amountPaid || '0')).toBe(200);
      expect(parseFloat(updated.balanceDue || '0')).toBe(300);
    });

    it('blocks void on a partially paid bill', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [{ accountId: officeSuppliesId, amount: '500.00' }],
      });

      await billPaymentService.payBills(tenantId, {
        bankAccountId,
        txnDate: '2026-04-02',
        method: 'ach',
        bills: [{ billId: bill.id, amount: '200.00' }],
      });

      await expect(
        billService.voidBill(tenantId, bill.id, 'test'),
      ).rejects.toThrow('payments applied');
    });

    it('allows void on an unpaid bill and reverses balances', async () => {
      const bill = await billService.createBill(tenantId, {
        contactId: vendorId,
        txnDate: '2026-04-01',
        lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
      });

      await billService.voidBill(tenantId, bill.id, 'duplicate');

      const apAccount = await accountsService.getById(tenantId, apAccountId);
      expect(parseFloat(apAccount.balance ?? '0')).toBe(0);
    });
  });
});

describe('Vendor Credit Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await setup();
  });
  afterEach(async () => {
    await cleanDb();
  });

  it('posts the correct journal: DR AP, CR Expense', async () => {
    const credit = await vendorCreditService.createVendorCredit(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '50.00', description: 'Returned' }],
    });

    expect(credit.txnType).toBe('vendor_credit');
    expect(parseFloat(credit.total ?? '0')).toBe(50);

    const lines = await db.select().from(journalLines)
      .where(eq(journalLines.transactionId, credit.id));
    const apLine = lines.find((l) => l.accountId === apAccountId)!;
    expect(parseFloat(apLine.debit)).toBe(50);

    const expLine = lines.find((l) => l.accountId === officeSuppliesId)!;
    expect(parseFloat(expLine.credit)).toBe(50);
  });

  it('blocks void if applications exist', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
    });
    const credit = await vendorCreditService.createVendorCredit(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '50.00' }],
    });

    await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-02',
      method: 'ach',
      bills: [{ billId: bill.id, amount: '100.00' }],
      credits: [{ creditId: credit.id, billId: bill.id, amount: '50.00' }],
    });

    await expect(
      vendorCreditService.voidVendorCredit(tenantId, credit.id, 'test'),
    ).rejects.toThrow('applied to bills');
  });
});

describe('Bill Payment Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await setup();
  });
  afterEach(async () => {
    await cleanDb();
  });

  it('pays a single bill in full and marks it paid', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '500.00' }],
    });

    const result = await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-15',
      method: 'check',
      printLater: true,
      bills: [{ billId: bill.id, amount: '500.00' }],
    });

    expect(result.payments.length).toBe(1);
    expect(result.payments[0]!.netPayment).toBe('500.0000');

    // Bill is now paid
    const updated = await ledger.getTransaction(tenantId, bill.id);
    expect(updated.billStatus).toBe('paid');
    expect(parseFloat(updated.balanceDue ?? '0')).toBe(0);
    expect(parseFloat(updated.amountPaid ?? '0')).toBe(500);

    // AP cleared, bank reduced
    const apAccount = await accountsService.getById(tenantId, apAccountId);
    expect(parseFloat(apAccount.balance ?? '0')).toBe(0);
    const bankAccount = await accountsService.getById(tenantId, bankAccountId);
    expect(parseFloat(bankAccount.balance ?? '0')).toBe(-500);

    // Check is queued
    expect(result.payments[0]!.printStatus).toBe('queue');

    const validation = await ledger.validateBalance(tenantId);
    expect(validation.valid).toBe(true);
  });

  it('handles partial payment', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '1000.00' }],
    });

    await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-15',
      method: 'ach',
      bills: [{ billId: bill.id, amount: '400.00' }],
    });

    const updated = await ledger.getTransaction(tenantId, bill.id);
    expect(updated.billStatus).toBe('partial');
    expect(parseFloat(updated.balanceDue ?? '0')).toBe(600);
    expect(parseFloat(updated.amountPaid ?? '0')).toBe(400);
  });

  it('combines multiple bills for the same vendor into one payment', async () => {
    const bill1 = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '300.00' }],
    });
    const bill2 = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-02',
      lines: [{ accountId: utilitiesId, amount: '200.00' }],
    });

    const result = await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-15',
      method: 'check',
      printLater: true,
      bills: [
        { billId: bill1.id, amount: '300.00' },
        { billId: bill2.id, amount: '200.00' },
      ],
    });

    expect(result.payments.length).toBe(1); // one consolidated payment
    expect(result.payments[0]!.netPayment).toBe('500.0000');
    expect(result.payments[0]!.billsPaid).toBe(2);

    const apAccount = await accountsService.getById(tenantId, apAccountId);
    expect(parseFloat(apAccount.balance ?? '0')).toBe(0);
  });

  it('creates separate payments per vendor when paying multi-vendor', async () => {
    const billA = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
    });
    const billB = await billService.createBill(tenantId, {
      contactId: vendorBId,
      txnDate: '2026-04-01',
      lines: [{ accountId: utilitiesId, amount: '200.00' }],
    });

    const result = await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-15',
      method: 'ach',
      bills: [
        { billId: billA.id, amount: '100.00' },
        { billId: billB.id, amount: '200.00' },
      ],
    });

    expect(result.payments.length).toBe(2);
  });

  it('applies a vendor credit to reduce the check amount', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '500.00' }],
    });
    const credit = await vendorCreditService.createVendorCredit(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-02',
      lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
    });

    const result = await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-15',
      method: 'check',
      printLater: true,
      bills: [{ billId: bill.id, amount: '500.00' }],
      credits: [{ creditId: credit.id, billId: bill.id, amount: '100.00' }],
    });

    // Net payment should be 500 - 100 = 400
    expect(result.payments[0]!.netPayment).toBe('400.0000');

    // Bill is fully paid (500 covered = 400 cash + 100 credit)
    const updatedBill = await ledger.getTransaction(tenantId, bill.id);
    expect(updatedBill.billStatus).toBe('paid');
    expect(parseFloat(updatedBill.balanceDue ?? '0')).toBe(0);
    expect(parseFloat(updatedBill.amountPaid ?? '0')).toBe(400);
    expect(parseFloat(updatedBill.creditsApplied ?? '0')).toBe(100);

    // Credit is consumed
    const updatedCredit = await ledger.getTransaction(tenantId, credit.id);
    expect(parseFloat(updatedCredit.balanceDue ?? '0')).toBe(0);

    // Bank only reduced by net 400
    const bankAccount = await accountsService.getById(tenantId, bankAccountId);
    expect(parseFloat(bankAccount.balance ?? '0')).toBe(-400);

    // AP should net to zero across all txns
    const apAccount = await accountsService.getById(tenantId, apAccountId);
    expect(parseFloat(apAccount.balance ?? '0')).toBe(0);

    const validation = await ledger.validateBalance(tenantId);
    expect(validation.valid).toBe(true);
  });

  it('handles credits-only payment ($0 cash)', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '200.00' }],
    });
    const credit = await vendorCreditService.createVendorCredit(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-02',
      lines: [{ accountId: officeSuppliesId, amount: '200.00' }],
    });

    const result = await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-15',
      method: 'other',
      bills: [{ billId: bill.id, amount: '200.00' }],
      credits: [{ creditId: credit.id, billId: bill.id, amount: '200.00' }],
    });

    expect(result.payments[0]!.netPayment).toBe('0.0000');

    const bankAccount = await accountsService.getById(tenantId, bankAccountId);
    expect(parseFloat(bankAccount.balance ?? '0')).toBe(0); // no cash moved

    const updatedBill = await ledger.getTransaction(tenantId, bill.id);
    expect(updatedBill.billStatus).toBe('paid');

    const validation = await ledger.validateBalance(tenantId);
    expect(validation.valid).toBe(true);
  });

  it('rejects credits applied to wrong vendor', async () => {
    const billA = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
    });
    // credit is for vendorB
    const credit = await vendorCreditService.createVendorCredit(tenantId, {
      contactId: vendorBId,
      txnDate: '2026-04-02',
      lines: [{ accountId: officeSuppliesId, amount: '50.00' }],
    });

    await expect(
      billPaymentService.payBills(tenantId, {
        bankAccountId,
        txnDate: '2026-04-15',
        method: 'ach',
        bills: [{ billId: billA.id, amount: '100.00' }],
        credits: [{ creditId: credit.id, billId: billA.id, amount: '50.00' }],
      }),
    ).rejects.toThrow('same vendor');
  });

  it('rejects payment exceeding balance due', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
    });

    await expect(
      billPaymentService.payBills(tenantId, {
        bankAccountId,
        txnDate: '2026-04-02',
        method: 'ach',
        bills: [{ billId: bill.id, amount: '200.00' }],
      }),
    ).rejects.toThrow('exceeds balance due');
  });

  it('voiding a payment restores bill and credit balances', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '500.00' }],
    });
    const credit = await vendorCreditService.createVendorCredit(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-02',
      lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
    });

    const result = await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-15',
      method: 'ach',
      bills: [{ billId: bill.id, amount: '500.00' }],
      credits: [{ creditId: credit.id, billId: bill.id, amount: '100.00' }],
    });
    const paymentId = result.payments[0]!.id;

    // Bill paid, credit consumed, bank -400
    const beforeBank = await accountsService.getById(tenantId, bankAccountId);
    expect(parseFloat(beforeBank.balance ?? '0')).toBe(-400);

    // Void
    await billPaymentService.voidBillPayment(tenantId, paymentId, 'wrong');

    // Bill back to unpaid
    const restoredBill = await ledger.getTransaction(tenantId, bill.id);
    expect(restoredBill.billStatus).toBe('unpaid');
    expect(parseFloat(restoredBill.balanceDue ?? '0')).toBe(500);
    expect(parseFloat(restoredBill.amountPaid ?? '0')).toBe(0);
    expect(parseFloat(restoredBill.creditsApplied ?? '0')).toBe(0);

    // Credit balance restored
    const restoredCredit = await ledger.getTransaction(tenantId, credit.id);
    expect(parseFloat(restoredCredit.balanceDue ?? '0')).toBe(100);

    // Bank restored
    const afterBank = await accountsService.getById(tenantId, bankAccountId);
    expect(parseFloat(afterBank.balance ?? '0')).toBe(0);

    const validation = await ledger.validateBalance(tenantId);
    expect(validation.valid).toBe(true);
  });

  it('hand-written check allocates a check number', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId,
      txnDate: '2026-04-01',
      lines: [{ accountId: officeSuppliesId, amount: '100.00' }],
    });

    // Need a company row for nextCheckNumber to work
    await db.insert(companies).values({
      tenantId,
      businessName: 'Test Co',
      checkSettings: { nextCheckNumber: 1042 },
    });

    const result = await billPaymentService.payBills(tenantId, {
      bankAccountId,
      txnDate: '2026-04-02',
      method: 'check_handwritten',
      bills: [{ billId: bill.id, amount: '100.00' }],
    });

    expect(result.payments[0]!.checkNumber).toBe(1042);
    expect(result.payments[0]!.printStatus).toBe('hand_written');
  });
});

