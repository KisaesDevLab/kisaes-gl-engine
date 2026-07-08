// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// list() surfaces matchCandidateCount so the feed can flag a PENDING item that
// already exists in the ledger (e.g. a check written in-system) instead of
// letting the user post a duplicate. Mirrors findMatchCandidates():
//   - same bank account, ±5 days, matching absolute amount, matchable txn_type,
//     not already matched to another feed item.
//   - guarded so only pending/unmatched/non-zero rows pay for the subquery.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, transactions, journalLines,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let connectionId = '';
let bankAccountId = '';
let expenseAccountId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
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
    email: `matchind-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Match Indicator Test User',
    companyName: 'Match Indicator Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;

  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  bankAccountId = bank!.id;

  const expenseRows = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')))
    .limit(1);
  expenseAccountId = expenseRows[0]!.id;

  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId: bankAccountId,
    provider: 'manual',
    institutionName: 'Test Bank',
  }).returning();
  connectionId = conn!.id;
}

// A posted expense (e.g. a check written in-system) hitting the bank account.
async function postExpense(opts: { total: string; date: string; accountId?: string }): Promise<string> {
  const [txn] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'expense', txnDate: opts.date,
    status: 'posted', total: opts.total, memo: 'Check to vendor',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, companyId, transactionId: txn!.id, accountId: opts.accountId ?? expenseAccountId, debit: opts.total, credit: '0' },
    { tenantId, companyId, transactionId: txn!.id, accountId: bankAccountId, debit: '0', credit: opts.total },
  ]);
  return txn!.id;
}

async function insertPendingItem(
  extra: Partial<typeof bankFeedItems.$inferInsert> = {},
): Promise<typeof bankFeedItems.$inferSelect> {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: connectionId,
    feedDate: '2026-06-15',
    description: 'CHECK #1042',
    // Signed: money leaving the account. matchCandidateCount compares on ABS.
    amount: '-250.0000',
    status: 'pending',
    ...extra,
  }).returning();
  return row!;
}

async function countFor(itemId: string): Promise<number> {
  const { data } = await bankFeedService.list(tenantId, {});
  return data.find((r) => r.id === itemId)!.matchCandidateCount ?? -1;
}

beforeEach(async () => {
  await cleanDb();
  await setup();
});

afterEach(async () => {
  await cleanDb();
});

describe('bank-feed list — matchCandidateCount', () => {
  it('flags a pending item when a posted ledger txn matches amount + account within ±5 days', async () => {
    await postExpense({ total: '250.00', date: '2026-06-13' });
    const item = await insertPendingItem();
    expect(await countFor(item.id)).toBe(1);
  });

  it('is 0 when the amount differs', async () => {
    await postExpense({ total: '999.00', date: '2026-06-15' });
    const item = await insertPendingItem();
    expect(await countFor(item.id)).toBe(0);
  });

  it('is 0 when the posted txn is outside the ±5-day window', async () => {
    await postExpense({ total: '250.00', date: '2026-06-25' });
    const item = await insertPendingItem();
    expect(await countFor(item.id)).toBe(0);
  });

  it('is 0 when the posted txn does not touch the connection bank account', async () => {
    // Expense hits a different (expense-only) posting — no bank leg on this account.
    const [txn] = await db.insert(transactions).values({
      tenantId, companyId, txnType: 'expense', txnDate: '2026-06-15',
      status: 'posted', total: '250.00', memo: 'Cash expense',
    }).returning();
    await db.insert(journalLines).values([
      { tenantId, companyId, transactionId: txn!.id, accountId: expenseAccountId, debit: '250.00', credit: '0' },
      { tenantId, companyId, transactionId: txn!.id, accountId: expenseAccountId, debit: '0', credit: '250.00' },
    ]);
    const item = await insertPendingItem();
    expect(await countFor(item.id)).toBe(0);
  });

  it('does not count a txn already matched to another feed item', async () => {
    const txnId = await postExpense({ total: '250.00', date: '2026-06-14' });
    // Another feed item already claimed this transaction.
    await insertPendingItem({ status: 'matched', matchedTransactionId: txnId, description: 'PRIOR MATCH' });
    const item = await insertPendingItem();
    expect(await countFor(item.id)).toBe(0);
  });

  it('is 0 for a non-pending (already matched) item — the CASE guard skips it', async () => {
    const txnId = await postExpense({ total: '250.00', date: '2026-06-14' });
    const item = await insertPendingItem({ status: 'matched', matchedTransactionId: txnId });
    expect(await countFor(item.id)).toBe(0);
  });
});
