// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// bulkUpdateTransactions must NOT block ledger-neutral edits on a reconciled
// transaction. A completed reconciliation only clears the balance-sheet (bank)
// line; a bulk tag change is ledger-neutral and a bulk category move only
// relocates a P&L line — neither touches the cleared line. This mirrors the
// single-edit policy (updateTransaction). The previous blanket skip wrongly
// reported reconciled rows as skipped and never applied the tag.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  transactions, journalLines, transactionTags, tags,
  reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let bankAccountId = '';
let expenseAccountId = '';
let travelAccountId = '';
let tagId = '';

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
    email: `bulkrec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Bulk Rec Test User',
    companyName: 'Bulk Rec Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  bankAccountId = bank!.id;
  const expense = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1);
  expenseAccountId = expense[0]!.id;

  const travel = await db.insert(accounts).values({
    tenantId, companyId, name: 'Travel', accountType: 'expense', accountNumber: '6100',
  }).returning();
  travelAccountId = travel[0]!.id;

  const [t] = await db.insert(tags).values({ tenantId, name: 'Q3-Campaign' }).returning();
  tagId = t!.id;
}

// Post an expense (expense debit / bank credit) and mark the BANK line cleared
// inside a completed reconciliation, so the txn counts as reconciled.
async function postReconciledExpense(): Promise<string> {
  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'expense',
    txnDate: '2026-04-01',
    lines: [
      { accountId: expenseAccountId, debit: '50.00', credit: '0' },
      { accountId: bankAccountId, debit: '0', credit: '50.00' },
    ],
  });
  const lines = await db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txn.id)));
  const bankLine = lines.find((l) => l.accountId === bankAccountId)!;

  const [rec] = await db.insert(reconciliations).values({
    tenantId, companyId, accountId: bankAccountId,
    statementDate: '2026-04-30', statementEndingBalance: '-50.00', beginningBalance: '0.00',
    status: 'complete',
  }).returning();
  await db.insert(reconciliationLines).values({
    reconciliationId: rec!.id, journalLineId: bankLine.id, isCleared: true,
  });
  return txn.id;
}

async function tagsOnLines(txnId: string): Promise<Array<string | null>> {
  const lines = await db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
  return lines.map((l) => l.tagId);
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('bulkUpdateTransactions — reconciled transactions', () => {
  it('applies a bulk tag change to a reconciled transaction (not skipped)', async () => {
    const txnId = await postReconciledExpense();

    const res = await ledger.bulkUpdateTransactions(tenantId, { txnIds: [txnId], setTagId: tagId }, userId);
    expect(res.updated).toBe(1);
    expect(res.skipped).toHaveLength(0);

    // Tag landed on the lines and the ledger still balances.
    expect((await tagsOnLines(txnId)).every((t) => t === tagId)).toBe(true);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);

    // The reconciled bank line's amount is untouched.
    const bankLine = (await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId))))
      .find((l) => l.accountId === bankAccountId)!;
    expect(parseFloat(bankLine.credit)).toBe(50);
  });

  it('moves a P&L category on a reconciled transaction, leaving the reconciled bank line intact', async () => {
    const txnId = await postReconciledExpense();

    const res = await ledger.bulkUpdateTransactions(tenantId, { txnIds: [txnId], setCategoryAccountId: travelAccountId }, userId);
    expect(res.updated).toBe(1);
    expect(res.skipped).toHaveLength(0);

    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
    // P&L line moved to Travel; bank line unchanged; still balanced.
    expect(lines.some((l) => l.accountId === travelAccountId)).toBe(true);
    expect(lines.some((l) => l.accountId === expenseAccountId)).toBe(false);
    expect(lines.find((l) => l.accountId === bankAccountId)!.credit).toBe('50.0000');
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });
});
