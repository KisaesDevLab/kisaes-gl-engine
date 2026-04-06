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
});
