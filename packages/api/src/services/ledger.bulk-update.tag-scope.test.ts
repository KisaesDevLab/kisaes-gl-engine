// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// bulkUpdateTransactions tag scoping: a setTagId change (set or clear) can be
// restricted to the viewed account's line via tagAccountId. Without it the tag
// still applies to every line (legacy behavior). This fixes bulk-tagging a
// journal entry stamping the tag on ALL lines instead of just the account the
// operator is filtered to.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  transactions, journalLines, transactionTags, tags,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let bankAccountId = '';
let expenseAId = '';
let expenseBId = '';
let tag1 = '';

async function cleanDb() {
  if (!tenantId) return;
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
    email: `tagscope-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Tag Scope Test User',
    companyName: 'Tag Scope Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  bankAccountId = bank!.id;
  const expA = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1);
  expenseAId = expA[0]!.id;
  const [expB] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Supplies', accountType: 'expense', accountNumber: '6200',
  }).returning();
  expenseBId = expB!.id;

  const [t1] = await db.insert(tags).values({ tenantId, name: 'Project-X' }).returning();
  tag1 = t1!.id;
}

// A journal entry touching two expense accounts + the bank (a split).
async function postJE(): Promise<string> {
  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry',
    txnDate: '2026-05-01',
    lines: [
      { accountId: expenseAId, debit: '30.00', credit: '0' },
      { accountId: expenseBId, debit: '20.00', credit: '0' },
      { accountId: bankAccountId, debit: '0', credit: '50.00' },
    ],
  });
  return txn.id;
}

async function tagByAccount(txnId: string): Promise<Record<string, string | null>> {
  const lines = await db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
  const out: Record<string, string | null> = {};
  for (const l of lines) out[l.accountId] = l.tagId;
  return out;
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('bulkUpdateTransactions — tag scoping', () => {
  it('tags only the viewed account line when tagAccountId is given', async () => {
    const txnId = await postJE();
    const res = await ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txnId], setTagId: tag1, tagAccountId: expenseAId,
    }, userId);
    expect(res.updated).toBe(1);

    const byAcct = await tagByAccount(txnId);
    expect(byAcct[expenseAId]).toBe(tag1);
    expect(byAcct[expenseBId]).toBeNull();
    expect(byAcct[bankAccountId]).toBeNull();
  });

  it('clears only the viewed account line when tagAccountId is given', async () => {
    const txnId = await postJE();
    // First tag every line, then clear just expense A.
    await ledger.bulkUpdateTransactions(tenantId, { txnIds: [txnId], setTagId: tag1 }, userId);
    await ledger.bulkUpdateTransactions(tenantId, { txnIds: [txnId], setTagId: null, tagAccountId: expenseAId }, userId);

    const byAcct = await tagByAccount(txnId);
    expect(byAcct[expenseAId]).toBeNull();
    expect(byAcct[expenseBId]).toBe(tag1);
    expect(byAcct[bankAccountId]).toBe(tag1);
  });

  it('tags every line when tagAccountId is omitted (legacy behavior preserved)', async () => {
    const txnId = await postJE();
    await ledger.bulkUpdateTransactions(tenantId, { txnIds: [txnId], setTagId: tag1 }, userId);

    const byAcct = await tagByAccount(txnId);
    expect(byAcct[expenseAId]).toBe(tag1);
    expect(byAcct[expenseBId]).toBe(tag1);
    expect(byAcct[bankAccountId]).toBe(tag1);
  });

  it('reports no change when tagAccountId matches no line on the transaction', async () => {
    const txnId = await postJE();
    // expenseBId is on the txn; use a fresh account with no line instead.
    const [orphan] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Unused', accountType: 'expense', accountNumber: '6300',
    }).returning();
    const res = await ledger.bulkUpdateTransactions(tenantId, {
      txnIds: [txnId], setTagId: tag1, tagAccountId: orphan!.id,
    }, userId);
    expect(res.updated).toBe(0);
    expect(res.skipped).toEqual([{ id: txnId, reason: 'no_change' }]);
  });
});
