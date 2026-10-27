// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// A voided bill-payment check must release the bills (and vendor credits) it
// settled so they can be paid again:
//   - voiding from the check register / transaction detail
//     (ledger.voidTransaction) goes through the bill-payment void;
//   - migration 0235 repairs payments voided before that routing existed,
//     whose application rows were left behind and kept the bills "paid".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, billPaymentApplications, vendorCreditApplications,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as billService from './bill.service.js';
import * as vendorCreditService from './vendor-credit.service.js';
import * as billPaymentService from './bill-payment.service.js';
import * as ledger from './ledger.service.js';

let tenantId = '';
let bankAccountId = '';
let expenseId = '';
let vendorId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const [tenant] = await db.insert(tenants).values({
    name: 'Void Release Test',
    slug: `void-release-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }).returning();
  tenantId = tenant!.id;
  bankAccountId = (await accountsService.create(tenantId, { name: 'Operating Cash', accountType: 'asset', accountNumber: '1000' })).id;
  await db.insert(accounts).values({
    tenantId, name: 'Accounts Payable', accountType: 'liability', accountNumber: '2000',
    systemTag: 'accounts_payable', isSystem: true,
  });
  expenseId = (await accountsService.create(tenantId, { name: 'Office Supplies', accountType: 'expense', accountNumber: '6000' })).id;
  // Hand-written checks take their number from the company's check settings.
  await db.insert(companies).values({ tenantId, businessName: 'Void Release Co', checkSettings: { nextCheckNumber: 1001 } });
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'ABC Supply' }).returning();
  vendorId = vendor!.id;
}

async function billAndCreditPaidByCheck() {
  const bill = await billService.createBill(tenantId, {
    contactId: vendorId, txnDate: '2026-04-01', lines: [{ accountId: expenseId, amount: '500.00' }],
  });
  const credit = await vendorCreditService.createVendorCredit(tenantId, {
    contactId: vendorId, txnDate: '2026-04-02', lines: [{ accountId: expenseId, amount: '100.00' }],
  });
  const result = await billPaymentService.payBills(tenantId, {
    bankAccountId, txnDate: '2026-04-15', method: 'check_handwritten',
    bills: [{ billId: bill.id, amount: '500.00' }],
    credits: [{ creditId: credit.id, billId: bill.id, amount: '100.00' }],
  });
  return { billId: bill.id, creditId: credit.id, paymentId: result.payments[0]!.id };
}

async function expectReleased(billId: string, creditId: string) {
  const bill = await ledger.getTransaction(tenantId, billId);
  expect(bill.billStatus).toBe('unpaid');
  expect(parseFloat(bill.balanceDue ?? '0')).toBe(500);
  expect(parseFloat(bill.amountPaid ?? '0')).toBe(0);
  expect(parseFloat(bill.creditsApplied ?? '0')).toBe(0);
  const credit = await ledger.getTransaction(tenantId, creditId);
  expect(parseFloat(credit.balanceDue ?? '0')).toBe(100);
}

// Runs migration 0235 the way the migrator does: one statement per breakpoint.
async function runRepairMigration() {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../db/migrations/0235_release_voided_bill_payments.sql');
  for (const stmt of readFileSync(file, 'utf8').split('--> statement-breakpoint')) {
    if (stmt.replace(/--.*$/gm, '').trim()) await db.execute(sql.raw(stmt));
  }
}

beforeEach(async () => {
  await cleanDb();
  await setup();
});

afterEach(async () => {
  await cleanDb();
});

describe('voiding a bill-payment check', () => {
  it('from the register releases the bill and credit, and the bill can be paid again', async () => {
    const { billId, creditId, paymentId } = await billAndCreditPaidByCheck();

    await ledger.voidTransaction(tenantId, paymentId, 'check lost');

    await expectReleased(billId, creditId);
    const apps = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, paymentId));
    expect(apps).toHaveLength(0);

    const again = await billPaymentService.payBills(tenantId, {
      bankAccountId, txnDate: '2026-04-20', method: 'check_handwritten',
      bills: [{ billId, amount: '500.00' }],
    });
    expect(again.payments).toHaveLength(1);
    expect((await ledger.getTransaction(tenantId, billId)).billStatus).toBe('paid');
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });
});

describe('migration 0235 — payments voided before the fix', () => {
  // The pre-fix register void: payment marked void, journal reversed, but
  // its application rows left in place.
  async function voidTheOldWay(paymentId: string) {
    await db.update(transactions).set({ status: 'void', voidReason: 'old path', voidedAt: new Date() })
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentId)));
  }

  it('reopens the bill and credit, removes the stale applications, and allows a new payment', async () => {
    const { billId, creditId, paymentId } = await billAndCreditPaidByCheck();
    await voidTheOldWay(paymentId);
    // The reported symptom: still paid, nothing left to pay.
    expect((await ledger.getTransaction(tenantId, billId)).billStatus).toBe('paid');

    await runRepairMigration();

    await expectReleased(billId, creditId);
    expect(await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, paymentId))).toHaveLength(0);
    expect(await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.paymentId, paymentId))).toHaveLength(0);

    const again = await billPaymentService.payBills(tenantId, {
      bankAccountId, txnDate: '2026-04-20', method: 'check_handwritten',
      bills: [{ billId, amount: '500.00' }],
    });
    expect(again.payments).toHaveLength(1);
  });

  it('keeps what live payments still cover', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId, txnDate: '2026-04-01', lines: [{ accountId: expenseId, amount: '500.00' }],
    });
    const first = await billPaymentService.payBills(tenantId, {
      bankAccountId, txnDate: '2026-04-10', method: 'check_handwritten', bills: [{ billId: bill.id, amount: '200.00' }],
    });
    const second = await billPaymentService.payBills(tenantId, {
      bankAccountId, txnDate: '2026-04-11', method: 'check_handwritten', bills: [{ billId: bill.id, amount: '300.00' }],
    });
    expect((await ledger.getTransaction(tenantId, bill.id)).billStatus).toBe('paid');
    await voidTheOldWay(second.payments[0]!.id);

    await runRepairMigration();

    const after = await ledger.getTransaction(tenantId, bill.id);
    expect(after.billStatus).toBe('partial');
    expect(parseFloat(after.amountPaid ?? '0')).toBe(200);
    expect(parseFloat(after.balanceDue ?? '0')).toBe(300);
    const kept = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, first.payments[0]!.id));
    expect(kept).toHaveLength(1);
  });

  it('is idempotent and leaves bills without void payments alone', async () => {
    const { billId, paymentId } = await billAndCreditPaidByCheck();
    const before = await ledger.getTransaction(tenantId, billId);

    await runRepairMigration();
    await runRepairMigration();

    const after = await ledger.getTransaction(tenantId, billId);
    expect(after.billStatus).toBe('paid');
    expect(after.balanceDue).toBe(before.balanceDue);
    expect(await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, paymentId))).toHaveLength(1);
  });
});
