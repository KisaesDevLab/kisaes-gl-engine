// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Manual check-number override on Write Check: the physical checkbook
// is the source of truth for hand-written checks, so the operator can
// type the number instead of taking the auto counter. Duplicates on
// the same bank account are refused, and the counter advances past
// manual numbers so auto-assignment can't collide later. Also covers
// the expense "Ref no." (txn_number) round-trip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, accounts, auditLog, transactions, journalLines, transactionTags } from '../db/schema/index.js';
import * as checkService from './check.service.js';
import * as expenseService from './expense.service.js';

let tenantId = '';
let companyId = '';
let bankId = '';
let expenseId = '';

async function cleanup() {
  if (!tenantId) return;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({
    name: 'Check No Test',
    slug: 'check-no-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Check Co' }).returning();
  companyId = c!.id;
  const [b] = await db.insert(accounts).values({ tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'checking', accountNumber: '1000', balance: '0' }).returning();
  bankId = b!.id;
  const [e] = await db.insert(accounts).values({ tenantId, companyId, name: 'Repairs', accountType: 'expense', accountNumber: '6300', balance: '0' }).returning();
  expenseId = e!.id;
});
afterEach(cleanup);

const checkInput = (over: Record<string, unknown> = {}) => ({
  bankAccountId: bankId,
  payeeNameOnCheck: 'Acme Plumbing',
  txnDate: '2026-07-10',
  amount: '150.0000',
  printLater: false,
  lines: [{ accountId: expenseId, amount: '150.0000' }],
  ...over,
});

describe('manual check-number override', () => {
  it('uses the typed number and advances the auto counter past it', async () => {
    const check = await checkService.createCheck(tenantId, checkInput({ checkNumber: 5001 }), undefined, companyId);
    expect(check.checkNumber).toBe(5001);

    // The next auto-assigned check continues AFTER the manual number.
    const next = await checkService.createCheck(tenantId, checkInput({ amount: '75.0000', lines: [{ accountId: expenseId, amount: '75.0000' }] }), undefined, companyId);
    expect(next.checkNumber).toBe(5002);
  });

  it('refuses a duplicate number on the same bank account', async () => {
    await checkService.createCheck(tenantId, checkInput({ checkNumber: 7001 }), undefined, companyId);
    await expect(
      checkService.createCheck(tenantId, checkInput({ checkNumber: 7001 }), undefined, companyId),
    ).rejects.toThrow(/already exists/);
  });

  it('still auto-assigns when no number is supplied', async () => {
    const check = await checkService.createCheck(tenantId, checkInput(), undefined, companyId);
    expect(check.checkNumber).toBeGreaterThanOrEqual(1001);
  });
});

describe('expense Ref no. (txn_number)', () => {
  it('persists the reference on the transaction', async () => {
    const txn = await expenseService.createExpense(tenantId, {
      txnDate: '2026-07-10',
      txnNumber: 'CHK 998',
      payFromAccountId: bankId,
      lines: [{ expenseAccountId: expenseId, amount: '42.0000' }],
      memo: 'Handwritten check recorded as expense',
    }, undefined, companyId);
    const row = await db.query.transactions.findFirst({ where: eq(transactions.id, txn.id) });
    expect(row?.txnNumber).toBe('CHK 998');
  });
});

describe('per-bank-account check numbering', () => {
  it('keeps an independent auto counter for each bank account', async () => {
    const [b2] = await db.insert(accounts).values({ tenantId, companyId, name: 'Savings Checking', accountType: 'asset', detailType: 'checking', accountNumber: '1001', balance: '0' }).returning();
    const bank2 = b2!.id;

    // Two auto checks on bank 1 → 1001, 1002.
    const c1 = await checkService.createCheck(tenantId, checkInput(), undefined, companyId);
    const c2 = await checkService.createCheck(tenantId, checkInput(), undefined, companyId);
    expect([c1.checkNumber, c2.checkNumber]).toEqual([1001, 1002]);

    // First auto check on bank 2 starts its OWN sequence at 1001 (not 1003).
    const d1 = await checkService.createCheck(tenantId, checkInput({ bankAccountId: bank2 }), undefined, companyId);
    expect(d1.checkNumber).toBe(1001);

    // Bank 1 continues where it left off.
    const c3 = await checkService.createCheck(tenantId, checkInput(), undefined, companyId);
    expect(c3.checkNumber).toBe(1003);
  });

  it('printChecks advances only the printed bank account', async () => {
    const [b2] = await db.insert(accounts).values({ tenantId, companyId, name: 'Payroll Checking', accountType: 'asset', detailType: 'checking', accountNumber: '1002', balance: '0' }).returning();
    const bank2 = b2!.id;

    const q = await checkService.createCheck(tenantId, checkInput({ printLater: true }), undefined, companyId);
    await checkService.printChecks(tenantId, bankId, [q.id], 2500, 'voucher', undefined);

    // bank 1 counter advanced to 2501; bank 2 still starts fresh at 1001.
    const comp = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    const nums = (comp!.checkSettings as any).nextCheckNumbers as Record<string, number>;
    expect(nums[bankId]).toBe(2501);
    expect(nums[bank2]).toBeUndefined();
    const d1 = await checkService.createCheck(tenantId, checkInput({ bankAccountId: bank2 }), undefined, companyId);
    expect(d1.checkNumber).toBe(1001);
  });
});
