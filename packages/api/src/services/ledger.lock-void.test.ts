// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Lock-date enforcement + rule-23 void semantics. Pins the GL-review
// fixes:
//   - checkLockDate is COMPANY-scoped (one company's lock no longer
//     governs — or fails to protect — its siblings)
//   - payBills / voidBillPayment enforce the lock like every other path
//   - voidTransaction PERSISTS reversing journal_lines (marked
//     is_void_reversal) and getTransaction filters them out

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
  billPaymentApplications,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';
import * as billService from './bill.service.js';
import * as billPaymentService from './bill-payment.service.js';

let tenantId: string;

// Tenant-scoped cleanup — unscoped deletes would nuke concurrently-
// running suites' data (and trip over their FKs). Only touch our tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  // sessions has no tenant column — key it off this tenant's users
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function mkCompany(name: string, lockDate: string | null) {
  const [c] = await db.insert(companies).values({
    tenantId, businessName: name, entityType: 'sole_prop', setupComplete: true, lockDate,
  }).returning();
  return c!;
}

async function mkAccount(name: string, accountType: string, accountNumber: string, systemTag?: string) {
  const [a] = await db.insert(accounts).values({
    tenantId, name, accountNumber, accountType,
    isSystem: !!systemTag, systemTag: systemTag ?? null,
  }).returning();
  return a!;
}

function je(cashId: string, revId: string, amount: string, date: string) {
  return {
    txnType: 'journal_entry' as const,
    txnDate: date,
    memo: 'test',
    lines: [
      { accountId: cashId, debit: amount, credit: '0' },
      { accountId: revId, debit: '0', credit: amount },
    ],
  };
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'Lock Test', slug: `lock-${Date.now()}` }).returning();
  tenantId = tenant!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('company-scoped lock date', () => {
  it('locked company blocks, unlocked sibling posts', async () => {
    const lockedCo = await mkCompany('Locked Co', '2025-12-31');
    const openCo = await mkCompany('Open Co', null);
    const cash = await mkAccount('Cash', 'asset', '1000');
    const rev = await mkAccount('Sales', 'revenue', '4000');

    await expect(
      ledger.postTransaction(tenantId, je(cash.id, rev.id, '100.00', '2025-06-15'), undefined, lockedCo.id),
    ).rejects.toThrow(/lock date/i);

    const txn = await ledger.postTransaction(tenantId, je(cash.id, rev.id, '100.00', '2025-06-15'), undefined, openCo.id);
    expect(txn.id).toBeTruthy();
  });

  it('scope-less posting is held to the strictest lock in the tenant', async () => {
    await mkCompany('Locked Co', '2025-12-31');
    await mkCompany('Open Co', null);
    const cash = await mkAccount('Cash', 'asset', '1000');
    const rev = await mkAccount('Sales', 'revenue', '4000');

    await expect(
      ledger.postTransaction(tenantId, je(cash.id, rev.id, '100.00', '2025-06-15')),
    ).rejects.toThrow(/lock date/i);
  });
});

describe('bill payment lock enforcement', () => {
  async function seedApWorld(lockDate: string | null) {
    const co = await mkCompany('Co', lockDate);
    const cash = await mkAccount('Checking', 'asset', '1000');
    const ap = await mkAccount('Accounts Payable', 'liability', '20100', 'accounts_payable');
    const exp = await mkAccount('Supplies', 'expense', '6000');
    const [vendor] = await db.insert(contacts).values({ tenantId, displayName: 'Vendor', contactType: 'vendor' }).returning();
    return { co, cash, ap, exp, vendor: vendor! };
  }

  it('payBills refuses a payment dated in a locked period', async () => {
    const { co, cash, exp, vendor } = await seedApWorld(null);
    const bill = await billService.createBill(tenantId, {
      contactId: vendor.id, txnDate: '2026-01-10',
      lines: [{ accountId: exp.id, amount: '500.00' }],
    }, undefined, co.id);
    // Lock the prior year AFTER the bill exists
    await db.update(companies).set({ lockDate: '2025-12-31' }).where(eq(companies.id, co.id));

    await expect(billPaymentService.payBills(tenantId, {
      bankAccountId: cash.id,
      txnDate: '2025-06-15', // inside the locked year
      bills: [{ billId: bill.id, amount: '500.00' }],
    } as any, undefined, co.id)).rejects.toThrow(/lock date/i);
  });

  it('voidBillPayment refuses when the payment is in a locked period', async () => {
    const { co, cash, exp, vendor } = await seedApWorld(null);
    const bill = await billService.createBill(tenantId, {
      contactId: vendor.id, txnDate: '2026-01-10',
      lines: [{ accountId: exp.id, amount: '500.00' }],
    }, undefined, co.id);
    const result = await billPaymentService.payBills(tenantId, {
      bankAccountId: cash.id,
      txnDate: '2026-01-20',
      bills: [{ billId: bill.id, amount: '500.00' }],
    } as any, undefined, co.id);
    const paymentId = (result as any).payments?.[0]?.id ?? (result as any)[0]?.id ?? (result as any).paymentIds?.[0];
    expect(paymentId).toBeTruthy();

    // Close the period containing the payment, then attempt the void.
    await db.update(companies).set({ lockDate: '2026-01-31' }).where(eq(companies.id, co.id));
    await expect(
      billPaymentService.voidBillPayment(tenantId, paymentId, 'oops'),
    ).rejects.toThrow(/lock date/i);
  });
});

describe('void persists reversing lines (rule 23)', () => {
  it('inserts is_void_reversal lines that net the transaction to zero, and filters them from getTransaction', async () => {
    await mkCompany('Co', null);
    const cash = await mkAccount('Cash', 'asset', '1000');
    const rev = await mkAccount('Sales', 'revenue', '4000');
    const txn = await ledger.postTransaction(tenantId, je(cash.id, rev.id, '250.00', '2026-03-01'));

    await ledger.voidTransaction(tenantId, txn.id, 'test void');

    const allLines = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txn.id)));
    expect(allLines.length).toBe(4); // 2 original + 2 reversing
    const reversals = allLines.filter((l) => l.isVoidReversal);
    expect(reversals.length).toBe(2);
    // Per-transaction line sums net to zero
    const netDebit = allLines.reduce((s, l) => s + parseFloat(l.debit) - parseFloat(l.credit), 0);
    expect(netDebit).toBeCloseTo(0, 4);

    // Document view keeps showing the transaction as entered
    const detail = await ledger.getTransaction(tenantId, txn.id);
    expect(detail.lines.length).toBe(2);
    expect(detail.lines.every((l: any) => !l.description?.startsWith('Void:'))).toBe(true);
  });
});
