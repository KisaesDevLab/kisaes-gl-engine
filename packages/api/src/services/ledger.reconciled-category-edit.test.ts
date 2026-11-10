// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-198 (reconciled-category-edit-v1): an edit of an entry cleared in a
// completed reconciliation keeps every line on a reconciled account and the
// date; its other lines, balance-sheet ones included (A/R, owner's equity, a
// loan), can be recategorized. Before, every balance-sheet line was kept.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
  reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

let tenantId: string;
let companyId: string;

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(reconciliationLines).where(
    inArray(reconciliationLines.reconciliationId, db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId))),
  );
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
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

async function mkAccount(name: string, accountType: string, accountNumber: string, detailType?: string) {
  const [a] = await db.insert(accounts).values({
    tenantId, companyId, name, accountNumber, accountType, detailType: detailType ?? null,
  }).returning();
  return a!;
}

/** A reconciliation of `accountId` (complete or in progress) clearing `txnId`'s line on it. */
async function reconcile(accountId: string, txnId: string, status: 'complete' | 'in_progress' = 'complete') {
  const [rec] = await db.insert(reconciliations).values({
    tenantId, companyId, accountId, statementDate: '2026-01-31', statementEndingBalance: '0', beginningBalance: '0',
    status, completedAt: status === 'complete' ? new Date() : null,
  }).returning();
  const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txnId));
  const line = lines.find((l) => l.accountId === accountId)!;
  await db.insert(reconciliationLines).values({ reconciliationId: rec!.id, journalLineId: line.id, isCleared: true });
  return { rec: rec!, lineId: line.id };
}

async function balanceOf(accountId: string) {
  const [a] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, accountId));
  return a!.balance;
}

async function linesOf(txnId: string) {
  return db.select().from(journalLines).where(and(eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)));
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({ name: 'Reconciled Category Edit', slug: `reccat-${Date.now()}` }).returning();
  tenantId = tenant!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co', entityType: 'sole_prop', setupComplete: true }).returning();
  companyId = c!.id;
});

afterEach(async () => {
  await cleanDb();
});

const pair = (dr: string, cr: string, amount: string) => [
  { accountId: dr, debit: amount, credit: '0' },
  { accountId: cr, debit: '0', credit: amount },
];

describe('category edit of a reconciled entry (U-198)', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('reconciled-category-edit-v1');
  });

  it('moves a reconciled deposit from a balance-sheet account (A/R) to income; the bank line keeps its id', async () => {
    const bank = await mkAccount('Checking', 'asset', '1010', 'checking');
    const ar = await mkAccount('Receivable', 'asset', '1200', 'other_current_assets');
    const income = await mkAccount('Other income', 'revenue', '7100');
    const txn = await ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: '2026-01-05', lines: pair(bank.id, ar.id, '4688.74') }, undefined, companyId);
    const { lineId } = await reconcile(bank.id, txn.id);

    await ledger.updateTransaction(tenantId, txn.id, { txnType: 'journal_entry', txnDate: '2026-01-05', lines: pair(bank.id, income.id, '4688.74') }, undefined, companyId);

    const after = await linesOf(txn.id);
    expect(after.map((l) => l.accountId).sort()).toEqual([bank.id, income.id].sort());
    expect(after.find((l) => l.accountId === bank.id)!.id).toBe(lineId);
    expect(Number(await balanceOf(ar.id))).toBe(0);
  });

  it('moves a reconciled check from owner\'s draw (equity) to an expense', async () => {
    const bank = await mkAccount('Checking', 'asset', '1010', 'checking');
    const draw = await mkAccount('Owner draw', 'equity', '3200');
    const exp = await mkAccount('Supplies', 'expense', '6000');
    const txn = await ledger.postTransaction(tenantId, { txnType: 'expense', txnDate: '2026-01-05', lines: pair(draw.id, bank.id, '40.00') }, undefined, companyId);
    const { lineId } = await reconcile(bank.id, txn.id);

    await ledger.updateTransaction(tenantId, txn.id, { txnType: 'expense', txnDate: '2026-01-05', lines: pair(exp.id, bank.id, '40.00') }, undefined, companyId);

    const after = await linesOf(txn.id);
    expect(after.find((l) => l.accountId === bank.id)!.id).toBe(lineId);
    expect(after.some((l) => l.accountId === draw.id)).toBe(false);
    expect(Number(await balanceOf(draw.id))).toBe(0);
  });

  it('still refuses a change of the reconciled line, a new line on the reconciled account, and the date', async () => {
    const bank = await mkAccount('Checking', 'asset', '1010', 'checking');
    const ar = await mkAccount('Receivable', 'asset', '1200', 'other_current_assets');
    const income = await mkAccount('Other income', 'revenue', '7100');
    const txn = await ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: '2026-01-05', lines: pair(bank.id, ar.id, '100.00') }, undefined, companyId);
    await reconcile(bank.id, txn.id);
    const attempts = [
      { txnDate: '2026-01-05', lines: pair(bank.id, income.id, '101.00') },
      { txnDate: '2026-01-05', lines: [...pair(bank.id, ar.id, '100.00'), ...pair(bank.id, income.id, '1.00')] },
      { txnDate: '2026-01-06', lines: pair(bank.id, income.id, '100.00') },
    ];
    for (const a of attempts) {
      const err = await ledger.updateTransaction(tenantId, txn.id, { txnType: 'journal_entry', ...a }, undefined, companyId)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect([(err as AppError).statusCode, (err as AppError).code]).toEqual([409, 'RECONCILED_TRANSACTION']);
    }
    expect((await linesOf(txn.id)).map((l) => l.accountId).sort()).toEqual([bank.id, ar.id].sort());
  });

  it('a replaced line carries its in-progress worksheet tick to its successor (transfer, other side)', async () => {
    const bank = await mkAccount('Checking', 'asset', '1010', 'checking');
    const savings = await mkAccount('Savings', 'asset', '1020', 'savings');
    const savings2 = await mkAccount('Money market', 'asset', '1030', 'savings');
    const txn = await ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: '2026-01-05', lines: pair(savings.id, bank.id, '250.00') }, undefined, companyId);
    await reconcile(bank.id, txn.id);
    const open = await reconcile(savings.id, txn.id, 'in_progress');

    // Savings line moved to the money market account: the open savings
    // worksheet row has no successor on that account, so it goes.
    await ledger.updateTransaction(tenantId, txn.id, { txnType: 'journal_entry', txnDate: '2026-01-05', lines: pair(savings2.id, bank.id, '250.00') }, undefined, companyId);
    const rows = await db.select().from(reconciliationLines).where(eq(reconciliationLines.reconciliationId, open.rec.id));
    expect(rows).toEqual([]);
  });

  it('an unchanged non-reconciled balance-sheet line keeps its id', async () => {
    const bank = await mkAccount('Checking', 'asset', '1010', 'checking');
    const savings = await mkAccount('Savings', 'asset', '1020', 'savings');
    const txn = await ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: '2026-01-05', lines: pair(savings.id, bank.id, '250.00') }, undefined, companyId);
    await reconcile(bank.id, txn.id);
    const open = await reconcile(savings.id, txn.id, 'in_progress');

    await ledger.updateTransaction(tenantId, txn.id, { txnType: 'journal_entry', txnDate: '2026-01-05', memo: 'memo only', lines: pair(savings.id, bank.id, '250.00') }, undefined, companyId);
    const rows = await db.select().from(reconciliationLines).where(eq(reconciliationLines.reconciliationId, open.rec.id));
    expect(rows.map((r) => [r.journalLineId, r.isCleared])).toEqual([[open.lineId, true]]);
  });
});
