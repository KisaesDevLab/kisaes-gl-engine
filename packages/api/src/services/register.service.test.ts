import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { tenants, users, sessions, accounts, companies, auditLog, contacts, transactions, journalLines, tags, transactionTags } from '../db/schema/index.js';
import * as registerService from './register.service.js';
import * as accountsService from './accounts.service.js';
import * as ledger from './ledger.service.js';

let tenantId: string;
let bankAccountId: string;
let revenueAccountId: string;
let expenseAccountId: string;
let liabilityAccountId: string;

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

async function setup() {
  const [tenant] = await db.insert(tenants).values({ name: 'Register Test', slug: 'reg-test-' + Date.now() }).returning();
  tenantId = tenant!.id;

  const bank = await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' });
  bankAccountId = bank.id;

  const rev = await accountsService.create(tenantId, { name: 'Revenue', accountType: 'revenue', accountNumber: '4000' });
  revenueAccountId = rev.id;

  const exp = await accountsService.create(tenantId, { name: 'Office Supplies', accountType: 'expense', accountNumber: '6000' });
  expenseAccountId = exp.id;

  const liab = await accountsService.create(tenantId, { name: 'Credit Card', accountType: 'liability', detailType: 'credit_card', accountNumber: '2100' });
  liabilityAccountId = liab.id;
}

describe('Register Service', () => {
  beforeEach(async () => { await cleanDb(); await setup(); });
  afterEach(async () => { await cleanDb(); });

  it('should return empty register for account with no transactions', async () => {
    const result = await registerService.getRegister(tenantId, bankAccountId, {});
    expect(result.account.name).toBe('Checking');
    expect(result.balanceForward).toBe(0);
    expect(result.lines).toHaveLength(0);
    expect(result.allowedEntryTypes).toContain('expense');
    expect(result.allowedEntryTypes).toContain('deposit');
  });

  it('should show correct running balance for asset account (debit-normal)', async () => {
    // Deposit $1000 into bank
    await ledger.postTransaction(tenantId, {
      txnType: 'deposit', txnDate: '2026-03-01',
      lines: [
        { accountId: bankAccountId, debit: '1000.00', credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: '1000.00' },
      ],
    });
    // Expense $250 from bank
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-03-15',
      lines: [
        { accountId: expenseAccountId, debit: '250.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '250.00' },
      ],
    });

    const result = await registerService.getRegister(tenantId, bankAccountId, { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(result.lines).toHaveLength(2);

    // First line: deposit $1000 → balance = 1000
    expect(result.lines[0]!.deposit).toBe(1000);
    expect(result.lines[0]!.payment).toBeNull();
    expect(result.lines[0]!.runningBalance).toBe(1000);

    // Second line: payment $250 → balance = 750
    expect(result.lines[1]!.payment).toBe(250);
    expect(result.lines[1]!.deposit).toBeNull();
    expect(result.lines[1]!.runningBalance).toBe(750);

    expect(result.endingBalance).toBe(750);
  });

  it('should show correct payment/deposit mapping for liability account (credit-normal)', async () => {
    // Charge $500 on credit card (debit expense, credit CC)
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-03-10',
      lines: [
        { accountId: expenseAccountId, debit: '500.00', credit: '0' },
        { accountId: liabilityAccountId, debit: '0', credit: '500.00' },
      ],
    });

    const result = await registerService.getRegister(tenantId, liabilityAccountId, { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(result.lines).toHaveLength(1);
    // Credit-normal: credit = increase (deposit), debit = decrease (payment)
    expect(result.lines[0]!.deposit).toBe(500); // CC balance increased
    expect(result.lines[0]!.runningBalance).toBe(500);
  });

  it('should compute balance_forward correctly', async () => {
    // Transaction in February
    await ledger.postTransaction(tenantId, {
      txnType: 'deposit', txnDate: '2026-02-15',
      lines: [
        { accountId: bankAccountId, debit: '2000.00', credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: '2000.00' },
      ],
    });
    // Transaction in April
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-04-01',
      lines: [
        { accountId: expenseAccountId, debit: '100.00', credit: '0' },
        { accountId: bankAccountId, debit: '0', credit: '100.00' },
      ],
    });

    // Query March–April: Feb txn should be in balance_forward
    const result = await registerService.getRegister(tenantId, bankAccountId, { startDate: '2026-03-01', endDate: '2026-04-30' });
    expect(result.balanceForward).toBe(2000);
    expect(result.lines).toHaveLength(1); // only the April txn
    expect(result.lines[0]!.runningBalance).toBe(1900); // 2000 - 100
  });

  it('should exclude void transactions by default', async () => {
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'deposit', txnDate: '2026-03-01',
      lines: [
        { accountId: bankAccountId, debit: '500.00', credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: '500.00' },
      ],
    });
    await ledger.voidTransaction(tenantId, txn.id, 'test void');

    const result = await registerService.getRegister(tenantId, bankAccountId, { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(result.lines).toHaveLength(0);

    // With includeVoid
    const withVoid = await registerService.getRegister(tenantId, bankAccountId, { startDate: '2026-01-01', endDate: '2026-12-31', includeVoid: true });
    expect(withVoid.lines.length).toBeGreaterThan(0);
  });

  it('should return correct allowed_entry_types per account type', async () => {
    const bankReg = await registerService.getRegister(tenantId, bankAccountId, {});
    expect(bankReg.allowedEntryTypes).toContain('expense');
    expect(bankReg.allowedEntryTypes).toContain('deposit');
    expect(bankReg.allowedEntryTypes).toContain('transfer');

    const ccReg = await registerService.getRegister(tenantId, liabilityAccountId, {});
    expect(ccReg.allowedEntryTypes).toContain('expense');
    expect(ccReg.allowedEntryTypes).not.toContain('deposit');
  });

  it('should return register summary', async () => {
    await ledger.postTransaction(tenantId, {
      txnType: 'deposit', txnDate: new Date().toISOString().split('T')[0]!,
      lines: [
        { accountId: bankAccountId, debit: '3000.00', credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: '3000.00' },
      ],
    });

    const summary = await registerService.getRegisterSummary(tenantId, bankAccountId);
    expect(summary.currentBalance).toBe(3000);
    expect(summary.transactionsThisPeriod).toBeGreaterThanOrEqual(1);
  });
});
