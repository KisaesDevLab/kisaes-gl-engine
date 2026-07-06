// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Bank-feed tagging on single-item categorize + tag visibility on the feed:
//   - categorize() with an explicit tagId stamps it on the user-side
//     journal line (the cash leg stays untagged).
//   - categorize() with NO tagId but a rule-staged suggestedTagId on the
//     item applies the suggested tag (the rule → categorize handoff).
//   - list() returns suggestedTagId + suggestedTagName for a PENDING item
//     that carries a suggested tag, and lineTags for a CATEGORIZED item.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, transactions, journalLines,
  categorizationHistory, tags, transactionTags,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';

let tenantId = '';
let userId = '';
let connectionId = '';
let bankAccountId = '';
let expenseAccountId = '';
let tagId = '';
let suggestedTagId = '';

async function cleanDb() {
  if (!tenantId) return;
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
    email: `cattags-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Cat Tags Test User',
    companyName: 'Cat Tags Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;

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

  const [t1] = await db.insert(tags).values({ tenantId, name: 'Marketing' }).returning();
  tagId = t1!.id;
  const [t2] = await db.insert(tags).values({ tenantId, name: 'Travel' }).returning();
  suggestedTagId = t2!.id;
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

async function userLineTagId(transactionId: string): Promise<string | null> {
  const lines = await db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, transactionId)));
  const userLine = lines.find((l) => l.accountId === expenseAccountId);
  return userLine?.tagId ?? null;
}

beforeEach(async () => {
  await cleanDb();
  await setup();
});

afterEach(async () => {
  await cleanDb();
});

describe('bank-feed categorize — tagging', () => {
  it('stamps an explicit tagId on the user journal line (cash leg untagged)', async () => {
    const item = await insertPendingItem();
    const txn = await bankFeedService.categorize(
      tenantId, item.id, { accountId: expenseAccountId, tagId }, userId,
    );

    expect(await userLineTagId(txn.id)).toBe(tagId);

    // The cash (bank) leg must stay untagged — it isn't segment-relevant.
    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txn.id)));
    const cashLine = lines.find((l) => l.accountId === bankAccountId);
    expect(cashLine!.tagId).toBeNull();
  });

  it('applies the item.suggestedTagId when the user provides no explicit tag (rule → categorize handoff)', async () => {
    const item = await insertPendingItem({ suggestedTagId });
    const txn = await bankFeedService.categorize(
      tenantId, item.id, { accountId: expenseAccountId }, userId,
    );
    expect(await userLineTagId(txn.id)).toBe(suggestedTagId);
  });

  it('an explicit tag wins over the staged suggested tag', async () => {
    const item = await insertPendingItem({ suggestedTagId });
    const txn = await bankFeedService.categorize(
      tenantId, item.id, { accountId: expenseAccountId, tagId }, userId,
    );
    expect(await userLineTagId(txn.id)).toBe(tagId);
  });
});

describe('bank-feed list — tag fields', () => {
  it('returns suggestedTagId + suggestedTagName for a pending item with a suggested tag', async () => {
    const item = await insertPendingItem({ suggestedTagId });
    const { data } = await bankFeedService.list(tenantId, {});
    const row = data.find((r) => r.id === item.id)!;
    expect(row.suggestedTagId).toBe(suggestedTagId);
    expect(row.suggestedTagName).toBe('Travel');
    // Not yet categorized → no applied line tags.
    expect(row.lineTags).toBeNull();
  });

  it('returns lineTags for a categorized item', async () => {
    const item = await insertPendingItem();
    await bankFeedService.categorize(
      tenantId, item.id, { accountId: expenseAccountId, tagId }, userId,
    );
    const { data } = await bankFeedService.list(tenantId, {});
    const row = data.find((r) => r.id === item.id)!;
    expect(row.status).toBe('categorized');
    expect(row.lineTags).toEqual(['Marketing']);
  });
});
