// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The audit trail keeps a FULL before-image of a transaction on update and
// void: the header and every journal line as they stood before the change.
// An update deletes and re-inserts the lines, so without the lines in the
// before-image the old amounts and accounts were lost from the trail.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, accounts, companies, auditLog, transactions, journalLines, reconciliations, reconciliationLines } from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as accountsService from './accounts.service.js';

let tenantId = '';
let bankId = '';
let expenseId = '';
let otherExpenseId = '';

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Audit Image', slug: 'audit-image-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  expenseId = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;
  otherExpenseId = (await accountsService.create(tenantId, { name: 'Postage', accountType: 'expense', accountNumber: '6100' })).id;
});

afterEach(async () => {
  const recs = await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  for (const r of recs) await db.delete(reconciliationLines).where(eq(reconciliationLines.reconciliationId, r.id));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

function decode(v: unknown): any {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function lastAudit(action: 'update' | 'void', txnId: string) {
  const rows = await db.select().from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityId, txnId), eq(auditLog.action, action)))
    .orderBy(asc(auditLog.createdAt));
  return decode(rows[rows.length - 1]!.beforeData);
}

const expense = (amount: string, account = expenseId, date = '2026-03-02') => ({
  txnType: 'expense' as const, txnDate: date, memo: 'paper',
  lines: [
    { accountId: account, debit: amount, credit: '0' },
    { accountId: bankId, debit: '0', credit: amount },
  ],
});

describe('audit before-image with lines', () => {
  it('update records the header and the original lines', async () => {
    const txn = await ledger.postTransaction(tenantId, expense('40.1234'));
    await ledger.updateTransaction(tenantId, txn.id, expense('55.0000', otherExpenseId, '2026-03-05'));

    const before = await lastAudit('update', txn.id);
    expect(before.txnDate).toBe('2026-03-02');
    expect(before.memo).toBe('paper');
    const lines = (before.lines as any[]).map((l) => [l.accountId, l.debit, l.credit]).sort();
    expect(lines).toEqual([
      [bankId, '0.0000', '40.1234'],
      [expenseId, '40.1234', '0.0000'],
    ].sort());
  });

  it('a reconciled partial edit records the original lines too', async () => {
    const txn = await ledger.postTransaction(tenantId, expense('12.0000'));
    const bankLine = txn.lines.find((l) => l.accountId === bankId)!;
    const [rec] = await db.insert(reconciliations).values({
      tenantId, accountId: bankId, statementDate: '2026-03-31',
      statementEndingBalance: '-12', beginningBalance: '0', status: 'complete',
    }).returning();
    await db.insert(reconciliationLines).values({ reconciliationId: rec!.id, journalLineId: bankLine.id, isCleared: true });

    await ledger.updateTransaction(tenantId, txn.id, expense('12.0000', otherExpenseId));
    const before = await lastAudit('update', txn.id);
    expect((before.lines as any[]).map((l) => l.accountId).sort()).toEqual([bankId, expenseId].sort());
  });

  it('void records the header and the lines before the reversal', async () => {
    const txn = await ledger.postTransaction(tenantId, expense('7.5000'));
    await ledger.voidTransaction(tenantId, txn.id, 'duplicate');

    const before = await lastAudit('void', txn.id);
    expect(before.status).toBe('posted');
    expect(before.lines).toHaveLength(2);
    expect((before.lines as any[]).every((l) => l.isVoidReversal === false)).toBe(true);
    expect((before.lines as any[]).map((l) => l.debit).sort()).toEqual(['0.0000', '7.5000']);
  });
});
