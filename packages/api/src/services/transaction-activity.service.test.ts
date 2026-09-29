// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Transaction Activity card: the timeline stitched from the audit log, the
// bank-feed item the transaction came from, review marks and attachments.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, contacts, attachments,
  bankConnections, bankFeedItems, transactions, journalLines,
  categorizationHistory, transactionClassificationState, transactionTags,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';
import * as closeFeedReview from './close-feed-review.service.js';
import { getTransactionActivity, decodeAudit } from './transaction-activity.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let feedItemId = '';
let txnId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  const { user } = await authService.register({
    email: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Activity Tester',
    companyName: 'Activity Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;
  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  const [expense] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1);
  const [conn] = await db.insert(bankConnections).values({
    tenantId, companyId, accountId: bank!.id, provider: 'plaid', institutionName: 'Test Bank', mask: '1234',
  }).returning();
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-08-10',
    description: 'SLACK', originalDescription: 'SLACK T07DA', amount: '8.7500', status: 'pending',
    matchType: 'ai', suggestedAccountId: expense!.id,
  }).returning();
  feedItemId = item!.id;
  await bankFeedService.categorize(tenantId, feedItemId, { accountId: expense!.id }, userId, companyId);
  const posted = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, feedItemId) });
  txnId = posted!.matchedTransactionId!;
});
afterEach(cleanDb);

describe('decodeAudit', () => {
  it('reads both stringified and plain jsonb payloads', () => {
    expect(decodeAudit(JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeAudit({ a: 1 })).toEqual({ a: 1 });
    expect(decodeAudit('not json')).toBeNull();
    expect(decodeAudit(null)).toBeNull();
  });
});

describe('getTransactionActivity', () => {
  it('tells the story: downloaded, suggested, posted, edited, reviewed, attachment', async () => {
    const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Slack Inc' }).returning();
    await closeFeedReview.recategorize(tenantId, userId, { feedItemIds: [feedItemId], contactId: vendor!.id }, companyId);
    await closeFeedReview.setReviewed(tenantId, userId, [feedItemId], false, companyId);
    await closeFeedReview.setReviewed(tenantId, userId, [feedItemId], true, companyId);
    // A portal upload leaves no audit row — it still shows, credited to nobody.
    await db.insert(attachments).values({
      tenantId, companyId, fileName: 'receipt.pdf', filePath: 'x/receipt.pdf', fileSize: 10,
      mimeType: 'application/pdf', attachableType: 'expense', attachableId: txnId,
    });

    const events = await getTransactionActivity(tenantId, txnId, companyId);
    const titles = events.map((e) => e.title);
    expect(titles[0]).toBe('Downloaded from the bank');
    expect(events[0]!.detail).toContain('Test Bank ••1234');
    expect(titles).toContain('Category suggested by AI');
    expect(titles).toContain('Posted from the bank feed');
    const posted = events.find((e) => e.title === 'Posted from the bank feed')!;
    expect(posted.actor).toBe('Activity Tester');

    const edit = events.find((e) => e.kind === 'edited')!;
    expect(edit.title).toBe('Edited (bulk change)');
    expect(edit.detail).toBe('payee → Slack Inc');

    // recategorize → reviewed (via recategorize), undo, reviewed again.
    const marks = events.filter((e) => e.kind === 'reviewed' || e.kind === 'unreviewed');
    expect(marks.map((m) => m.kind)).toEqual(['reviewed', 'unreviewed', 'reviewed']);
    expect(marks[0]!.detail).toBe('Recategorized from Close Review');
    expect(marks.every((m) => m.actor === 'Activity Tester')).toBe(true);

    const att = events.find((e) => e.kind === 'attachment_added')!;
    expect(att.detail).toBe('receipt.pdf');
    expect(att.actor).toBeNull();

    // Oldest first.
    const times = events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });

  it('writes one audit row per reviewed item', async () => {
    await closeFeedReview.setReviewed(tenantId, userId, [feedItemId], true, companyId);
    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'close_feed_review')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(feedItemId);
  });

  it("does not show another tenant's transaction", async () => {
    await expect(getTransactionActivity(crypto.randomUUID(), txnId)).rejects.toThrow(/not found/i);
  });
});
