// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// bulkUpdateTransactions source-account move (moveFromAccountId →
// moveToAccountId): re-points the line(s) posted to the FROM account onto the
// TO account. Unlike setCategoryAccountId this moves the money/source side,
// so split transactions work — their category lines are untouched. Lines
// cleared in a completed reconciliation are skipped; A/R and A/P control
// accounts are rejected outright.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  transactions, journalLines, transactionTags, tags, contacts,
  reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let clearingAccountId = '';
let loanAccountId = '';
let expenseAccountId = '';
let travelAccountId = '';

async function cleanDb() {
  if (!tenantId) return;
  // reconciliation_lines has no tenant_id — scope via the parent reconciliation.
  const recs = await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  for (const r of recs) await db.delete(reconciliationLines).where(eq(reconciliationLines.reconciliationId, r.id));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const { user } = await authService.register({
    email: `bulkmove-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Bulk Move Test User',
    companyName: 'Bulk Move Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;

  const expense = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1);
  expenseAccountId = expense[0]!.id;

  const [clearing] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Clearing', accountType: 'asset', detailType: 'other_current_asset', accountNumber: '1350',
  }).returning();
  clearingAccountId = clearing!.id;
  const [loan] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Vehicle Loan', accountType: 'liability', detailType: 'long_term_liability', accountNumber: '2500',
  }).returning();
  loanAccountId = loan!.id;
  const [travel] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Travel', accountType: 'expense', accountNumber: '6100',
  }).returning();
  travelAccountId = travel!.id;
}

async function linesOf(txnId: string) {
  return db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
}

async function balanceOf(accountId: string): Promise<number> {
  const [a] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)));
  return parseFloat(a!.balance ?? '0');
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('bulkUpdateTransactions — source-account move', () => {
  it('moves the clearing line of a SPLIT transaction to the loan account, leaving the splits intact', async () => {
    // Split expense paid out of clearing: two category lines, one source line.
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense',
      txnDate: '2026-05-01',
      lines: [
        { accountId: expenseAccountId, debit: '60.00', credit: '0' },
        { accountId: travelAccountId, debit: '40.00', credit: '0' },
        { accountId: clearingAccountId, debit: '0', credit: '100.00' },
      ],
    });

    const res = await ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txn.id], moveFromAccountId: clearingAccountId, moveToAccountId: loanAccountId,
    }, userId);
    expect(res.updated).toBe(1);
    expect(res.skipped).toHaveLength(0);

    const lines = await linesOf(txn.id);
    expect(lines.find((l) => l.accountId === loanAccountId)!.credit).toBe('100.0000');
    expect(lines.some((l) => l.accountId === clearingAccountId)).toBe(false);
    // Category splits untouched.
    expect(lines.find((l) => l.accountId === expenseAccountId)!.debit).toBe('60.0000');
    expect(lines.find((l) => l.accountId === travelAccountId)!.debit).toBe('40.0000');

    // Denormalised balances followed the line and the ledger still balances
    // (accounts.balance is debit-positive, so the credited loan reads -100).
    expect(await balanceOf(clearingAccountId)).toBe(0);
    expect(await balanceOf(loanAccountId)).toBe(-100);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });

  it('moves every from-account line when a journal entry touches the account twice', async () => {
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry',
      txnDate: '2026-05-02',
      lines: [
        { accountId: clearingAccountId, debit: '0', credit: '30.00' },
        { accountId: clearingAccountId, debit: '0', credit: '20.00' },
        { accountId: expenseAccountId, debit: '50.00', credit: '0' },
      ],
    });

    const res = await ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txn.id], moveFromAccountId: clearingAccountId, moveToAccountId: loanAccountId,
    }, userId);
    expect(res.updated).toBe(1);

    const lines = await linesOf(txn.id);
    expect(lines.filter((l) => l.accountId === loanAccountId)).toHaveLength(2);
    expect(lines.some((l) => l.accountId === clearingAccountId)).toBe(false);
    expect(await balanceOf(loanAccountId)).toBe(-50);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });

  it('skips a transaction whose from-account line is cleared in a completed reconciliation', async () => {
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense',
      txnDate: '2026-05-03',
      lines: [
        { accountId: expenseAccountId, debit: '25.00', credit: '0' },
        { accountId: clearingAccountId, debit: '0', credit: '25.00' },
      ],
    });
    const clearingLine = (await linesOf(txn.id)).find((l) => l.accountId === clearingAccountId)!;
    const [rec] = await db.insert(reconciliations).values({
      tenantId, companyId, accountId: clearingAccountId,
      statementDate: '2026-05-31', statementEndingBalance: '-25.00', beginningBalance: '0.00',
      status: 'complete',
    }).returning();
    await db.insert(reconciliationLines).values({
      reconciliationId: rec!.id, journalLineId: clearingLine.id, isCleared: true,
    });

    const res = await ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txn.id], moveFromAccountId: clearingAccountId, moveToAccountId: loanAccountId,
    }, userId);
    expect(res.updated).toBe(0);
    expect(res.skipped).toEqual([{ id: txn.id, reason: 'reconciled' }]);
    expect((await linesOf(txn.id)).find((l) => l.accountId === clearingAccountId)).toBeTruthy();
  });

  it('skips transactions with no line on the from account', async () => {
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense',
      txnDate: '2026-05-04',
      lines: [
        { accountId: expenseAccountId, debit: '10.00', credit: '0' },
        { accountId: loanAccountId, debit: '0', credit: '10.00' },
      ],
    });

    const res = await ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txn.id], moveFromAccountId: clearingAccountId, moveToAccountId: loanAccountId,
    }, userId);
    expect(res.updated).toBe(0);
    expect(res.skipped).toEqual([{ id: txn.id, reason: 'no_line_on_account' }]);
  });

  it('rejects moves involving A/R or A/P control accounts', async () => {
    const ar = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'accounts_receivable')),
    });
    expect(ar).toBeTruthy();
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry',
      txnDate: '2026-05-05',
      lines: [
        { accountId: clearingAccountId, debit: '5.00', credit: '0' },
        { accountId: loanAccountId, debit: '0', credit: '5.00' },
      ],
    });

    await expect(ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txn.id], moveFromAccountId: ar!.id, moveToAccountId: loanAccountId,
    }, userId)).rejects.toThrow(/cannot be bulk-moved/);
    await expect(ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txn.id], moveFromAccountId: clearingAccountId, moveToAccountId: ar!.id,
    }, userId)).rejects.toThrow(/cannot be bulk-moved/);
  });

  it('still applies a payee change when the move finds no line (move not sole change)', async () => {
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense',
      txnDate: '2026-05-06',
      lines: [
        { accountId: expenseAccountId, debit: '10.00', credit: '0' },
        { accountId: loanAccountId, debit: '0', credit: '10.00' },
      ],
    });
    const [vendor] = await db.insert(contacts).values({
      tenantId, displayName: 'Acme Vendor', contactType: 'vendor',
    }).returning();

    const res = await ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txn.id],
      setPayeeContactId: vendor!.id,
      moveFromAccountId: clearingAccountId,
      moveToAccountId: loanAccountId,
    }, userId);
    expect(res.updated).toBe(1);
    expect(res.skipped).toHaveLength(0);
  });
});
