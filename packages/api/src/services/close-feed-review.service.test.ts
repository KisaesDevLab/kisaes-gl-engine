// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Close Review → Bank feed reviewer pass: the period's done items, how each
// was coded, the "Looks right" mark, and recategorize-from-review.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, contacts,
  bankConnections, bankFeedItems, transactions, journalLines,
  categorizationHistory, transactionClassificationState, transactionTags,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';
import * as closeFeedReview from './close-feed-review.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let connectionId = '';
let bankAccountId = '';
let exp1 = '';
let exp2 = '';

const AUG = { periodStart: '2026-08-01', periodEnd: '2026-09-01' };

async function cleanDb() {
  if (!tenantId) return;
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

async function item(extra: Partial<typeof bankFeedItems.$inferInsert>) {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: connectionId,
    feedDate: '2026-08-10', description: 'VENDOR', amount: '100.0000', status: 'pending',
    ...extra,
  }).returning();
  return row!;
}

async function categorize(feedItemId: string, accountId: string) {
  await bankFeedService.categorize(tenantId, feedItemId, { accountId }, userId, companyId);
}

let ids: Record<'rule' | 'manual' | 'excluded' | 'open' | 'july' | 'sept', string>;

async function setup() {
  const { user } = await authService.register({
    email: `cfr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Close Review Test',
    companyName: 'Close Review Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;
  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  bankAccountId = bank!.id;
  const exps = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')))
    .limit(2);
  exp1 = exps[0]!.id;
  exp2 = exps[1]!.id;
  const [conn] = await db.insert(bankConnections).values({
    tenantId, companyId, accountId: bankAccountId, provider: 'manual', institutionName: 'Test Bank',
  }).returning();
  connectionId = conn!.id;

  // Rule-suggested, posted as suggested → 'rule'.
  const rule = await item({ description: 'RULE VENDOR', matchType: 'rule', suggestedAccountId: exp1 });
  await categorize(rule.id, exp1);
  // AI-suggested, but a person posted a different account → 'manual'.
  const manual = await item({ description: 'AI VENDOR', matchType: 'ai', suggestedAccountId: exp1, feedDate: '2026-08-20' });
  await categorize(manual.id, exp2);
  const excluded = await item({ description: 'TRANSFER', status: 'excluded' });
  const open = await item({ description: 'STILL OPEN' });
  const july = await item({ description: 'JULY OPEN', feedDate: '2026-07-15' });
  const sept = await item({ description: 'SEPT DONE', feedDate: '2026-09-02', suggestedAccountId: exp1, matchType: 'ai' });
  await categorize(sept.id, exp1);
  ids = { rule: rule.id, manual: manual.id, excluded: excluded.id, open: open.id, july: july.id, sept: sept.id };
}

beforeEach(setup);
afterEach(cleanDb);

describe('close-feed-review summarize', () => {
  it('counts the period by how each item was coded', async () => {
    const s = await closeFeedReview.summarize(tenantId, { companyId, ...AUG });
    expect(s.hasBankFeed).toBe(true);
    expect(s.periodTotal).toBe(4);
    expect(s.periodOpen).toBe(1);
    expect(s.doneTotal).toBe(3);
    expect(s.reviewed).toBe(0);
    expect(s.byMethod.rule.total).toBe(1);
    expect(s.byMethod.manual.total).toBe(1);
    expect(s.byMethod.excluded.total).toBe(1);
    expect(s.byMethod.ai.total).toBe(0);
    expect(s.otherMonthsOpen).toEqual([{ month: '2026-07', count: 1 }]);
  });

  it('reports no bank feed for a client without one', async () => {
    const otherCompany = crypto.randomUUID();
    const s = await closeFeedReview.summarize(tenantId, { companyId: otherCompany, ...AUG });
    expect(s.hasBankFeed).toBe(false);
    expect(s.periodTotal).toBe(0);
  });
});

describe('close-feed-review list', () => {
  it('lists done items with posted category and the overridden suggestion', async () => {
    const { rows, total } = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'all' });
    expect(total).toBe(3);
    const manual = rows.find((r) => r.feedItemId === ids.manual)!;
    expect(manual.method).toBe('manual');
    expect(manual.categoryAccountId).toBe(exp2);
    expect(manual.categoryCount).toBe(1);
    expect(manual.suggestedAccountName).toBeTruthy();
    const rule = rows.find((r) => r.feedItemId === ids.rule)!;
    expect(rule.method).toBe('rule');
    expect(rule.categoryAccountId).toBe(exp1);
    expect(rule.suggestedAccountName).toBeNull();
    expect(rule.transactionId).toBeTruthy();
    const excluded = rows.find((r) => r.feedItemId === ids.excluded)!;
    expect(excluded.method).toBe('excluded');
    expect(excluded.categoryCount).toBe(0);
    // Newest first.
    expect(rows[0]!.feedItemId).toBe(ids.manual);
  });

  it('filters by method', async () => {
    const { rows } = await closeFeedReview.list(tenantId, { companyId, ...AUG, method: 'rule', status: 'all' });
    expect(rows.map((r) => r.feedItemId)).toEqual([ids.rule]);
  });
});

describe('close-feed-review sort', () => {
  it('sorts server-side by the chosen column, both directions, across pages', async () => {
    const asc = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'all', sortBy: 'description', sortDir: 'asc' });
    expect(asc.rows.map((r) => r.description)).toEqual(['AI VENDOR', 'RULE VENDOR', 'TRANSFER']);
    const desc = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'all', sortBy: 'description', sortDir: 'desc' });
    expect(desc.rows.map((r) => r.description)).toEqual(['TRANSFER', 'RULE VENDOR', 'AI VENDOR']);
    const page2 = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'all', sortBy: 'description', sortDir: 'asc', limit: 1, offset: 1 });
    expect(page2.rows.map((r) => r.description)).toEqual(['RULE VENDOR']);
    expect(page2.total).toBe(3);
  });

  it('sorts amount by the displayed sign (money in first when descending)', async () => {
    await db.update(bankFeedItems).set({ amount: '-250.0000' }).where(eq(bankFeedItems.id, ids.excluded));
    const desc = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'all', sortBy: 'amount', sortDir: 'desc' });
    expect(desc.rows[0]!.feedItemId).toBe(ids.excluded);
  });
});

describe('close-feed-review marks', () => {
  it('marks done items reviewed, ignores uncategorized ones, and undoes', async () => {
    const res = await closeFeedReview.setReviewed(tenantId, userId, [ids.rule, ids.excluded, ids.open], true, companyId);
    expect(res.updated).toBe(2);

    const todo = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'todo' });
    expect(todo.rows.map((r) => r.feedItemId)).toEqual([ids.manual]);
    const reviewed = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'reviewed' });
    expect(reviewed.total).toBe(2);
    const s = await closeFeedReview.summarize(tenantId, { companyId, ...AUG });
    expect(s.reviewed).toBe(2);

    await closeFeedReview.setReviewed(tenantId, userId, [ids.rule], false, companyId);
    const after = await closeFeedReview.summarize(tenantId, { companyId, ...AUG });
    expect(after.reviewed).toBe(1);
  });

  it("cannot mark another tenant's items", async () => {
    const res = await closeFeedReview.setReviewed(crypto.randomUUID(), userId, [ids.rule], true, null);
    expect(res.updated).toBe(0);
  });
});

describe('close-feed-review recategorize', () => {
  it('moves the posted category, learns it, and marks the item reviewed', async () => {
    const res = await closeFeedReview.recategorize(
      tenantId, userId, { feedItemIds: [ids.rule, ids.excluded], accountId: exp2 }, companyId,
    );
    expect(res.updated).toBe(1);
    expect(res.skipped).toEqual([{ feedItemId: ids.excluded, reason: 'excluded' }]);

    const feed = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, ids.rule) });
    expect(feed!.closeReviewedAt).not.toBeNull();
    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, feed!.matchedTransactionId!)));
    expect(lines.map((l) => l.accountId).sort()).toEqual([bankAccountId, exp2].sort());

    const { rows } = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'all' });
    const moved = rows.find((r) => r.feedItemId === ids.rule)!;
    expect(moved.categoryAccountId).toBe(exp2);
    expect(moved.reviewedAt).not.toBeNull();
  });

  it('changes only the payee when no category is given', async () => {
    const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Bulk Payee Co' }).returning();
    const res = await closeFeedReview.recategorize(
      tenantId, userId, { feedItemIds: [ids.rule, ids.manual], contactId: vendor!.id }, companyId,
    );
    expect(res).toEqual({ updated: 2, skipped: [] });
    const { rows } = await closeFeedReview.list(tenantId, { companyId, ...AUG, status: 'all' });
    for (const id of [ids.rule, ids.manual]) {
      const r = rows.find((x) => x.feedItemId === id)!;
      expect(r.payeeContactId).toBe(vendor!.id);
      expect(r.payeeName).toBe('Bulk Payee Co');
      expect(r.reviewedAt).not.toBeNull();
    }
    // Categories untouched.
    expect(rows.find((x) => x.feedItemId === ids.rule)!.categoryAccountId).toBe(exp1);
    expect(rows.find((x) => x.feedItemId === ids.manual)!.categoryAccountId).toBe(exp2);
  });

  it('requires a category or payee', async () => {
    await expect(closeFeedReview.recategorize(tenantId, userId, { feedItemIds: [ids.rule] }, companyId))
      .rejects.toThrow(/category or a payee/);
  });
});
