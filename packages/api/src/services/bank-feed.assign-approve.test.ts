// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Two-phase bank-feed workflow: ASSIGN (stage, no ledger post) then
// APPROVE (post).
//   - assign() stages assigned_* + flips pending → 'assigned' and creates NO
//     transaction / journal_lines / matchedTransactionId.
//   - approve() posts the STAGED values: transaction created on the staged
//     account, status → 'categorized', matchedTransactionId set, balances move.
//   - approve() requires status 'assigned' with an assigned_account_id.
//   - re-assign overwrites the staged values.
//   - bulkApprove posts only 'assigned' items and skips the rest.
//   - bulkAssign stages the same assignment across many items.
//   - list() surfaces 'assigned' as actionable with assignedAccountName.
//   - a legacy autoConfirm bank rule still POSTS immediately (unchanged).
//   - a lock date rejects approve (the staged item survives, retryable).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, bankRules, transactions, journalLines,
  categorizationHistory, tags, transactionTags,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let connectionId = '';
let bankAccountId = '';
let expenseAccountId = '';
let otherExpenseAccountId = '';
let contactlessTagId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(bankRules).where(eq(bankRules.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
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
    email: `assign-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Assign Test User',
    companyName: 'Assign Test Co',
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
    .limit(2);
  expenseAccountId = expenseRows[0]!.id;
  otherExpenseAccountId = expenseRows[1]!.id;

  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId: bankAccountId,
    provider: 'manual',
    institutionName: 'Test Bank',
  }).returning();
  connectionId = conn!.id;

  const [t1] = await db.insert(tags).values({ tenantId, name: 'Marketing' }).returning();
  contactlessTagId = t1!.id;
}

async function insertPendingItem(
  extra: Partial<typeof bankFeedItems.$inferInsert> = {},
): Promise<typeof bankFeedItems.$inferSelect> {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: connectionId,
    feedDate: '2026-06-15',
    description: 'ZZQX COFFEE SHOP',
    originalDescription: 'ZZQX COFFEE SHOP',
    amount: '25.0000',
    status: 'pending',
    ...extra,
  }).returning();
  return row!;
}

async function txnCountForItem(feedItemId: string): Promise<number> {
  const rows = await db.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.source, 'bank_feed'), eq(transactions.sourceId, feedItemId)));
  return rows.length;
}

beforeEach(async () => {
  await cleanDb();
  await setup();
});

afterEach(async () => {
  await cleanDb();
});

describe('bank-feed assign() — stages without posting', () => {
  it('stages assigned_* + flips to assigned, creating NO transaction', async () => {
    const item = await insertPendingItem();
    const updated = await bankFeedService.assign(
      tenantId, item.id, { accountId: expenseAccountId, tagId: contactlessTagId, memo: 'coffee run' }, userId,
    );

    expect(updated.status).toBe('assigned');
    expect(updated.assignedAccountId).toBe(expenseAccountId);
    expect(updated.assignedTagId).toBe(contactlessTagId);
    expect(updated.assignedMemo).toBe('coffee run');
    expect(updated.assignedBy).toBe(userId);
    expect(updated.assignedAt).toBeTruthy();

    // The critical invariant: assign creates NO ledger side effects.
    expect(updated.matchedTransactionId).toBeNull();
    expect(await txnCountForItem(item.id)).toBe(0);
    const lines = await db.select().from(journalLines)
      .where(eq(journalLines.tenantId, tenantId));
    expect(lines.length).toBe(0);

    // Audit trail records the staging as an update.
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_feed')));
    expect(audits.length).toBeGreaterThan(0);
  });

  it('rejects an account outside the tenant', async () => {
    const item = await insertPendingItem();
    await expect(
      bankFeedService.assign(tenantId, item.id, { accountId: crypto.randomUUID() }, userId),
    ).rejects.toThrow(/account not found/i);
  });

  it('re-assign overwrites the staged values', async () => {
    const item = await insertPendingItem();
    await bankFeedService.assign(tenantId, item.id, { accountId: expenseAccountId }, userId);
    const reassigned = await bankFeedService.assign(
      tenantId, item.id, { accountId: otherExpenseAccountId, memo: 'changed' }, userId,
    );
    expect(reassigned.status).toBe('assigned');
    expect(reassigned.assignedAccountId).toBe(otherExpenseAccountId);
    expect(reassigned.assignedMemo).toBe('changed');
    expect(await txnCountForItem(item.id)).toBe(0);
  });

  it('rejects assigning an already-posted (categorized) item', async () => {
    const item = await insertPendingItem();
    await bankFeedService.assign(tenantId, item.id, { accountId: expenseAccountId }, userId);
    await bankFeedService.approve(tenantId, item.id, userId, companyId);
    await expect(
      bankFeedService.assign(tenantId, item.id, { accountId: expenseAccountId }, userId),
    ).rejects.toThrow(/cannot be assigned/i);
  });
});

describe('bank-feed approve() — posts the staged assignment', () => {
  it('posts on the staged account, sets categorized + matchedTransactionId, moves balances', async () => {
    const item = await insertPendingItem();
    await bankFeedService.assign(tenantId, item.id, { accountId: expenseAccountId, tagId: contactlessTagId }, userId);

    const bankBefore = await db.query.accounts.findFirst({ where: eq(accounts.id, bankAccountId) });

    const txn = await bankFeedService.approve(tenantId, item.id, userId, companyId);
    expect(txn).toBeDefined();

    const after = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, item.id) });
    expect(after!.status).toBe('categorized');
    expect(after!.matchedTransactionId).toBe(txn.id);

    // Transaction posted on the STAGED expense account (+ the cash leg).
    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txn.id)));
    expect(lines.some((l) => l.accountId === expenseAccountId)).toBe(true);
    expect(lines.some((l) => l.accountId === bankAccountId)).toBe(true);
    // Staged tag stamped on the user (expense) line.
    const userLine = lines.find((l) => l.accountId === expenseAccountId);
    expect(userLine!.tagId).toBe(contactlessTagId);

    // Balance moved on the bank account.
    const bankAfter = await db.query.accounts.findFirst({ where: eq(accounts.id, bankAccountId) });
    expect(bankAfter!.balance).not.toBe(bankBefore!.balance);
  });

  it('rejects approving a pending (never-assigned) item', async () => {
    const item = await insertPendingItem();
    await expect(
      bankFeedService.approve(tenantId, item.id, userId, companyId),
    ).rejects.toThrow(/not assigned/i);
    // Still pending, nothing posted.
    const after = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, item.id) });
    expect(after!.status).toBe('pending');
    expect(await txnCountForItem(item.id)).toBe(0);
  });

  it('a lock date rejects approve; the staged item survives and is retryable', async () => {
    const item = await insertPendingItem();
    await bankFeedService.assign(tenantId, item.id, { accountId: expenseAccountId }, userId);
    // Lock everything on/before a date after the feed item's date.
    await db.update(companies).set({ lockDate: '2026-12-31' }).where(eq(companies.id, companyId));

    await expect(
      bankFeedService.approve(tenantId, item.id, userId, companyId),
    ).rejects.toThrow(/lock date/i);

    // The claim reverted back to 'assigned' with the staged values intact.
    const after = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, item.id) });
    expect(after!.status).toBe('assigned');
    expect(after!.assignedAccountId).toBe(expenseAccountId);
    expect(after!.matchedTransactionId).toBeNull();
    expect(await txnCountForItem(item.id)).toBe(0);
  });
});

describe('bank-feed bulkApprove() — posts only staged items', () => {
  it('approves assigned items and skips pending/others', async () => {
    const staged = await insertPendingItem({ description: 'ZZQX STAGED' });
    await bankFeedService.assign(tenantId, staged.id, { accountId: expenseAccountId }, userId);
    const pending = await insertPendingItem({ description: 'ZZQX PENDING' });

    const result = await bankFeedService.bulkApprove(tenantId, [staged.id, pending.id], userId, companyId);
    expect(result.approved).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);

    const stagedAfter = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, staged.id) });
    expect(stagedAfter!.status).toBe('categorized');
    expect(stagedAfter!.matchedTransactionId).toBeTruthy();

    const pendingAfter = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, pending.id) });
    expect(pendingAfter!.status).toBe('pending');
    expect(await txnCountForItem(pending.id)).toBe(0);
  });
});

describe('bank-feed bulkAssign() — stages many', () => {
  it('stages the same assignment across pending items without posting', async () => {
    const a = await insertPendingItem({ description: 'ZZQX A' });
    const b = await insertPendingItem({ description: 'ZZQX B' });

    const result = await bankFeedService.bulkAssign(
      tenantId, [a.id, b.id], { accountId: expenseAccountId, memo: 'batch' }, userId,
    );
    expect(result.assigned).toBe(2);

    for (const id of [a.id, b.id]) {
      const row = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) });
      expect(row!.status).toBe('assigned');
      expect(row!.assignedAccountId).toBe(expenseAccountId);
      expect(row!.assignedMemo).toBe('batch');
      expect(await txnCountForItem(id)).toBe(0);
    }
  });
});

describe('bank-feed list() — assigned is actionable with a staged account name', () => {
  it('surfaces assignedAccountName and keeps assigned in the actionable view', async () => {
    const item = await insertPendingItem();
    await bankFeedService.assign(tenantId, item.id, { accountId: expenseAccountId }, userId);

    // actionableOnly excludes matched/categorized/excluded — 'assigned' stays.
    const { data } = await bankFeedService.list(tenantId, { actionableOnly: true });
    const row = data.find((r) => r.id === item.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('assigned');
    expect(row!.assignedAccountId).toBe(expenseAccountId);
    expect(row!.assignedAccountName).toBeTruthy();
  });
});

describe('bank-feed autoConfirm rule — still posts immediately (unchanged)', () => {
  it('a legacy autoConfirm bank rule posts via categorize(), not staging', async () => {
    await db.insert(bankRules).values({
      tenantId,
      name: 'Auto-post utility',
      isActive: true,
      isGlobal: false,
      applyTo: 'both',
      descriptionContains: 'ZZQX UTILITY',
      assignAccountId: otherExpenseAccountId,
      autoConfirm: true,
      priority: 10,
    });
    const item = await insertPendingItem({ description: 'ZZQX UTILITY BILL', originalDescription: 'ZZQX UTILITY BILL' });

    await bankFeedService.reprocessRules(tenantId, { feedItemIds: [item.id] }, userId, companyId);

    // autoConfirm posts on match — it does NOT leave the item merely 'assigned'.
    const after = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, item.id) });
    expect(after!.status).toBe('categorized');
    expect(after!.matchedTransactionId).toBeTruthy();
    expect(await txnCountForItem(item.id)).toBe(1);
  });
});
