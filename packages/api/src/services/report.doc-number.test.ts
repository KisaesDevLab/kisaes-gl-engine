// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-209 (ClientLedger P28 QA-4): General Ledger and Transaction List rows
// show a check's number (stored in check_number, txn_number empty), on
// both bases, as the Check Register does; other documents keep their own
// number.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, billPaymentApplications,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reportService from './report.service.js';

let tenantId: string;
let cash: any, ap: any, repairs: any;

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tenantId));
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

async function mk(name: string, accountType: string, accountNumber: string, detailType: string | null, systemTag: string | null = null) {
  const [a] = await db.insert(accounts).values({
    tenantId, name, accountNumber, accountType, detailType, isSystem: !!systemTag, systemTag,
  }).returning();
  return a!;
}

async function post(txnType: string, date: string, lines: Array<{ accountId: string; debit: string; credit: string }>, extra: Record<string, unknown> = {}) {
  return ledger.postTransaction(tenantId, { txnType: txnType as any, txnDate: date, memo: txnType, lines, ...extra } as any);
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'DN', slug: `dn-${Date.now()}` }).returning();
  tenantId = t!.id;
  cash = await mk('Checking', 'asset', '1000', 'checking');
  ap = await mk('Accounts Payable', 'liability', '2000', 'accounts_payable', 'accounts_payable');
  repairs = await mk('Repairs and Maintenance', 'expense', '6350', 'repairs_maintenance');
});

afterEach(async () => {
  await cleanDb();
});

describe('report rows carry the check number (U-209)', () => {
  it('General Ledger and Transaction List show a check by its number on both bases', async () => {
    const check = await post('check', '2026-10-05', [
      { accountId: repairs.id, debit: '49.00', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '49.00' },
    ], { total: '49.00' });
    await db.update(transactions).set({ checkNumber: 4402 }).where(eq(transactions.id, check.id));
    // A bill with its own number, paid by check 4403: cash basis shows the
    // expense on the payment, so with the payment's check number.
    const bill = await post('bill', '2026-10-01', [
      { accountId: repairs.id, debit: '100.00', credit: '0' },
      { accountId: ap.id, debit: '0', credit: '100.00' },
    ], { total: '100.00', txnNumber: 'B-17' });
    const pay = await post('bill_payment', '2026-10-20', [
      { accountId: ap.id, debit: '100.00', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '100.00' },
    ], { total: '100.00' });
    await db.update(transactions).set({ checkNumber: 4403 }).where(eq(transactions.id, pay.id));
    await db.insert(billPaymentApplications).values({ tenantId, paymentId: pay.id, billId: bill.id, amount: '100.00' });

    for (const basis of ['accrual', 'cash'] as const) {
      const gl = await reportService.buildGeneralLedger(tenantId, '2026-10-01', '2026-10-31', null, null, basis);
      const lines = (gl.accounts as any[]).find((a) => a.id === repairs.id || a.accountId === repairs.id)!.lines as any[];
      const ofCheck = lines.find((l) => l.transactionId === check.id)!;
      expect(ofCheck.txnNumber, `${basis} GL check`).toBe('4402');
      if (basis === 'accrual') {
        expect(lines.find((l) => l.transactionId === bill.id)!.txnNumber).toBe('B-17');
      } else {
        expect(lines.find((l) => l.transactionId === pay.id)!.txnNumber).toBe('4403');
      }
      const tl = await reportService.buildTransactionList(tenantId, { startDate: '2026-10-01', endDate: '2026-10-31', basis });
      const row = (tl.data as any[]).find((r) => r.id === check.id)!;
      expect(row.txn_number, `${basis} transaction list`).toBe('4402');
    }
  });
});
