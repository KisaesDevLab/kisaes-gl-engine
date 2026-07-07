// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { tenants, users, sessions, accounts, companies, auditLog, contacts, transactions, journalLines, tags, transactionTags } from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';

let tenantId: string;
let cashAccountId: string;
let revenueAccountId: string;
let expenseAccountId: string;
let arAccountId: string;

async function cleanDb() {
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

async function setupAccounts() {
  const [tenant] = await db.insert(tenants).values({
    name: 'Ledger Test',
    slug: 'ledger-test-' + Date.now(),
  }).returning();
  tenantId = tenant!.id;

  const cash = await accountsService.create(tenantId, { name: 'Cash', accountType: 'asset', accountNumber: '1000' });
  cashAccountId = cash.id;

  const revenue = await accountsService.create(tenantId, { name: 'Revenue', accountType: 'revenue', accountNumber: '4000' });
  revenueAccountId = revenue.id;

  const expense = await accountsService.create(tenantId, { name: 'Office Supplies', accountType: 'expense', accountNumber: '6000' });
  expenseAccountId = expense.id;

  const ar = await accountsService.create(tenantId, { name: 'Accounts Receivable', accountType: 'asset', accountNumber: '1100' });
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
    });
  });
});
