// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, accounts, companies, auditLog, contacts, transactions, journalLines, tags, transactionTags } from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';

let tenantId: string;
let cashAccountId: string;
let revenueAccountId: string;
let expenseAccountId: string;
let arAccountId: string;

// Tenant-scoped cleanup — unscoped deletes would nuke concurrently-
// running suites' data (and trip over their FKs). Only touch our tenant.
async function cleanDb() {
  if (!tenantId) return;
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

async function setupAccounts() {
  const [tenant] = await db.insert(tenants).values({
    name: 'Ledger Test',
    slug: 'ledger-test-' + Date.now(),
  }).returning();
  tenantId = tenant!.id;

  // detailType mirrors the COA template: the "category" test excludes the
  // money/control side by bank / A/R detail type, so these must be set (as
  // they always are in a real chart of accounts).
  const cash = await accountsService.create(tenantId, { name: 'Cash', accountType: 'asset', detailType: 'bank', accountNumber: '1000' });
  cashAccountId = cash.id;

  const revenue = await accountsService.create(tenantId, { name: 'Revenue', accountType: 'revenue', accountNumber: '4000' });
  revenueAccountId = revenue.id;

  const expense = await accountsService.create(tenantId, { name: 'Office Supplies', accountType: 'expense', accountNumber: '6000' });
  expenseAccountId = expense.id;

  const ar = await accountsService.create(tenantId, { name: 'Accounts Receivable', accountType: 'asset', detailType: 'accounts_receivable', accountNumber: '1100' });
  arAccountId = ar.id;
}

describe('Ledger Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await setupAccounts();
  });

  afterEach(async () => {
    await cleanDb();
  });

  describe('postTransaction', () => {
    it('should post a simple 2-line journal entry', async () => {
      const result = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry',
        txnDate: '2026-04-01',
        memo: 'Test JE',
        lines: [
          { accountId: cashAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '100.00' },
        ],
      });

      expect(result.txnType).toBe('journal_entry');
      expect(result.status).toBe('posted');
      expect(result.lines.length).toBe(2);

      // Check account balances updated
      const cashAccount = await accountsService.getById(tenantId, cashAccountId);
      expect(parseFloat(cashAccount.balance ?? '0')).toBe(100);

      const revenueAccount = await accountsService.getById(tenantId, revenueAccountId);
      expect(parseFloat(revenueAccount.balance ?? '0')).toBe(-100); // credits are negative in balance
    });

    it('should post a multi-line journal entry', async () => {
      const result = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry',
        txnDate: '2026-04-01',
        lines: [
          { accountId: cashAccountId, debit: '500.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '300.00' },
          { accountId: arAccountId, debit: '0', credit: '200.00' },
        ],
      });

      expect(result.lines.length).toBe(3);

      const validation = await ledger.validateBalance(tenantId);
      expect(validation.valid).toBe(true);
    });

    it('should reject unbalanced transaction', async () => {
      await expect(
        ledger.postTransaction(tenantId, {
          txnType: 'journal_entry',
          txnDate: '2026-04-01',
          lines: [
            { accountId: cashAccountId, debit: '100.00', credit: '0' },
            { accountId: revenueAccountId, debit: '0', credit: '50.00' },
          ],
        }),
      ).rejects.toThrow('does not balance');
    });

    it('should reject zero-amount transaction', async () => {
      await expect(
        ledger.postTransaction(tenantId, {
          txnType: 'journal_entry',
          txnDate: '2026-04-01',
          lines: [
            { accountId: cashAccountId, debit: '0', credit: '0' },
            { accountId: revenueAccountId, debit: '0', credit: '0' },
          ],
        }),
      ).rejects.toThrow('non-zero');
    });
  });

  describe('voidTransaction', () => {
    it('should void and create correct reversing entries', async () => {
      // Post original
      const txn = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry',
        txnDate: '2026-04-01',
        lines: [
          { accountId: cashAccountId, debit: '250.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '250.00' },
        ],
      });

      // Verify balances before void
      let cash = await accountsService.getById(tenantId, cashAccountId);
      expect(parseFloat(cash.balance ?? '0')).toBe(250);

      // Void
      await ledger.voidTransaction(tenantId, txn.id, 'Entered in error');

      // Verify transaction is void
      const voided = await ledger.getTransaction(tenantId, txn.id);
      expect(voided.status).toBe('void');
      expect(voided.voidReason).toBe('Entered in error');

      // Verify balances reversed
      cash = await accountsService.getById(tenantId, cashAccountId);
      expect(parseFloat(cash.balance ?? '0')).toBe(0);

      const revenue = await accountsService.getById(tenantId, revenueAccountId);
      expect(parseFloat(revenue.balance ?? '0')).toBe(0);
    });

    it('should reject voiding already void transaction', async () => {
      const txn = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry',
        txnDate: '2026-04-01',
        lines: [
          { accountId: cashAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '100.00' },
        ],
      });

      await ledger.voidTransaction(tenantId, txn.id, 'test');
      await expect(ledger.voidTransaction(tenantId, txn.id, 'again')).rejects.toThrow('already void');
    });
  });

  describe('updateTransaction', () => {
    it('should update lines and recalculate balances', async () => {
      const txn = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry',
        txnDate: '2026-04-01',
        lines: [
          { accountId: cashAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '100.00' },
        ],
      });

      // Update to different amounts
      await ledger.updateTransaction(tenantId, txn.id, {
        txnType: 'journal_entry',
        txnDate: '2026-04-01',
        lines: [
          { accountId: cashAccountId, debit: '200.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '200.00' },
        ],
      });

      const cash = await accountsService.getById(tenantId, cashAccountId);
      expect(parseFloat(cash.balance ?? '0')).toBe(200);

      const validation = await ledger.validateBalance(tenantId);
      expect(validation.valid).toBe(true);
    });
  });

  describe('validateBalance', () => {
    it('should validate total debits = credits', async () => {
      await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry',
        txnDate: '2026-04-01',
        lines: [
          { accountId: cashAccountId, debit: '1000.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '1000.00' },
        ],
      });

      await ledger.postTransaction(tenantId, {
        txnType: 'expense',
        txnDate: '2026-04-02',
        lines: [
          { accountId: expenseAccountId, debit: '50.00', credit: '0' },
          { accountId: cashAccountId, debit: '0', credit: '50.00' },
        ],
      });

      const validation = await ledger.validateBalance(tenantId);
      expect(validation.valid).toBe(true);
      expect(validation.totalDebits).toBe(1050);
      expect(validation.totalCredits).toBe(1050);
    });
  });

  describe('bulkUpdateTransactions', () => {
    it('moves the single category line to a new account and shifts balances', async () => {
      const travel = await accountsService.create(tenantId, { name: 'Travel', accountType: 'expense', accountNumber: '6100' });
      const txn = await ledger.postTransaction(tenantId, {
        txnType: 'expense',
        txnDate: '2026-04-01',
        lines: [
          { accountId: expenseAccountId, debit: '50.00', credit: '0' },
          { accountId: cashAccountId, debit: '0', credit: '50.00' },
        ],
      });

      const res = await ledger.bulkUpdateTransactions(tenantId, { txnIds: [txn.id], setCategoryAccountId: travel.id });
      expect(res.updated).toBe(1);
      expect(res.skipped).toHaveLength(0);

      // Old category zeroed, new category holds the amount, bank untouched.
      expect(parseFloat((await accountsService.getById(tenantId, expenseAccountId)).balance ?? '0')).toBe(0);
      expect(parseFloat((await accountsService.getById(tenantId, travel.id)).balance ?? '0')).toBe(50);
      expect(parseFloat((await accountsService.getById(tenantId, cashAccountId)).balance ?? '0')).toBe(-50);

      const reread = await ledger.getTransaction(tenantId, txn.id);
      expect(reread.lines.some((l) => l.accountId === travel.id)).toBe(true);
      expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
    });

    it('recategorizes a deposit whose offset is a non-P&L account (equity)', async () => {
      // Deposit: Cash (bank) debit, Owner's Capital (equity) credit. The
      // equity line is the single category line — it must be recategorizable
      // even though it isn't a P&L account.
      const equity = await accountsService.create(tenantId, { name: "Owner's Capital", accountType: 'equity', detailType: 'owners_equity', accountNumber: '3010' });
      const txn = await ledger.postTransaction(tenantId, {
        txnType: 'deposit',
        txnDate: '2026-05-01',
        lines: [
          { accountId: cashAccountId, debit: '1300.00', credit: '0' },
          { accountId: equity.id, debit: '0', credit: '1300.00' },
        ],
      });

      const res = await ledger.bulkUpdateTransactions(tenantId, { txnIds: [txn.id], setCategoryAccountId: revenueAccountId });
      expect(res.updated).toBe(1);
      expect(res.skipped).toHaveLength(0);

      const reread = await ledger.getTransaction(tenantId, txn.id);
      expect(reread.lines.some((l) => l.accountId === revenueAccountId)).toBe(true);
      expect(reread.lines.some((l) => l.accountId === equity.id)).toBe(false);
      expect(reread.lines.some((l) => l.accountId === cashAccountId)).toBe(true); // bank untouched
      expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
    });

    it('skips a split transaction when only a category change is requested', async () => {
      const travel = await accountsService.create(tenantId, { name: 'Travel2', accountType: 'expense', accountNumber: '6200' });
      const txn = await ledger.postTransaction(tenantId, {
        txnType: 'expense',
        txnDate: '2026-04-01',
        lines: [
          { accountId: expenseAccountId, debit: '30.00', credit: '0' },
          { accountId: travel.id, debit: '70.00', credit: '0' },
          { accountId: cashAccountId, debit: '0', credit: '100.00' },
        ],
      });

      const res = await ledger.bulkUpdateTransactions(tenantId, { txnIds: [txn.id], setCategoryAccountId: revenueAccountId });
      expect(res.updated).toBe(0);
      expect(res.skipped).toEqual([{ id: txn.id, reason: 'split' }]);

      // Nothing moved.
      expect(parseFloat((await accountsService.getById(tenantId, expenseAccountId)).balance ?? '0')).toBe(30);
      expect(parseFloat((await accountsService.getById(tenantId, travel.id)).balance ?? '0')).toBe(70);
      expect(parseFloat((await accountsService.getById(tenantId, revenueAccountId)).balance ?? '0')).toBe(0);
    });
  });

  describe('getAccountBalance', () => {
    it('should calculate balance from journal lines', async () => {
      await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry',
        txnDate: '2026-04-01',
        lines: [
          { accountId: cashAccountId, debit: '500.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '500.00' },
        ],
      });

      const balance = await ledger.getAccountBalance(tenantId, cashAccountId);
      expect(balance.debit).toBe(500);
      expect(balance.credit).toBe(0);
      expect(balance.balance).toBe(500);
    });
  });

  describe('listTransactions account filter (Debit/Credit split)', () => {
    it('returns per-account debit and credit only when filtered by an account', async () => {
      // Deposit: $100 DEBIT to Cash. Payment: $40 CREDIT to Cash.
      const deposit = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-04-01', memo: 'Deposit',
        lines: [
          { accountId: cashAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '100.00' },
        ],
      });
      const payment = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-04-02', memo: 'Payment',
        lines: [
          { accountId: expenseAccountId, debit: '40.00', credit: '0' },
          { accountId: cashAccountId, debit: '0', credit: '40.00' },
        ],
      });

      // Filtered by Cash → each row carries Cash's debit/credit.
      const filtered = await ledger.listTransactions(tenantId, { accountId: cashAccountId });
      const rows = filtered.data as Array<{ id: string; accountDebit: string | null; accountCredit: string | null }>;
      const dep = rows.find((r) => r.id === deposit.id)!;
      const pay = rows.find((r) => r.id === payment.id)!;
      expect(parseFloat(dep.accountDebit ?? '0')).toBe(100);
      expect(parseFloat(dep.accountCredit ?? '0')).toBe(0);
      expect(parseFloat(pay.accountDebit ?? '0')).toBe(0);
      expect(parseFloat(pay.accountCredit ?? '0')).toBe(40);

      // Unfiltered → the split columns are null (UI shows the magnitude).
      const unfiltered = await ledger.listTransactions(tenantId, {});
      const anyRow = (unfiltered.data as Array<{ accountDebit: string | null; accountCredit: string | null }>)[0]!;
      expect(anyRow.accountDebit).toBeNull();
      expect(anyRow.accountCredit).toBeNull();

      // Grand totals. Unfiltered amount = 100 + 40 magnitudes.
      expect(parseFloat(unfiltered.totals.amount)).toBe(140);
      // Filtered by Cash: total debit 100, total credit 40.
      expect(parseFloat(filtered.totals.debit)).toBe(100);
      expect(parseFloat(filtered.totals.credit)).toBe(40);
    });

    it('excludes void transactions from the grand totals', async () => {
      const keep = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-04-01', memo: 'Keep',
        lines: [
          { accountId: cashAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '100.00' },
        ],
      });
      const gone = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2026-04-02', memo: 'To void',
        lines: [
          { accountId: cashAccountId, debit: '250.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '250.00' },
        ],
      });
      await ledger.voidTransaction(tenantId, gone.id, 'test void');

      // Amount total counts only the non-void $100 (the voided $250 is out).
      const unfiltered = await ledger.listTransactions(tenantId, {});
      expect(parseFloat(unfiltered.totals.amount)).toBe(100);
      // Cash-filtered debit total also excludes the void.
      const filtered = await ledger.listTransactions(tenantId, { accountId: cashAccountId });
      expect(parseFloat(filtered.totals.debit)).toBe(100);
      void keep;
    });
  });
});
