// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Staff approval of client-suggested categories. Two branches matter and are
// genuinely different: approving against an UNPOSTED bank line creates a
// transaction, while approving against an amount already IN SUSPENSE moves
// money in place and creates nothing.
//
// The drift guard is the other load-bearing case. Plaid rewrites amounts as a
// row goes pending -> posted, so an answer given against $42.50 must not be
// swept through a bulk approve once the row reads $58.10.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  transactions, journalLines, transactionTags, tags, contacts,
  bankConnections, bankFeedItems, transactionClassificationState,
  clientCategorySuggestions, portalContacts, portalContactCompanies,
  reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';
import * as review from './client-suggestion-review.service.js';
import { getSuspenseAccountId } from './system-accounts.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let contactId = '';
let bankGlAccountId = '';
let rentAccountId = '';
let travelAccountId = '';
let bankConnectionId = '';

async function cleanDb() {
  if (!tenantId) return;
  const recs = await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  for (const r of recs) await db.delete(reconciliationLines).where(eq(reconciliationLines.reconciliationId, r.id));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(clientCategorySuggestions).where(eq(clientCategorySuggestions.tenantId, tenantId));
  const cs = await db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  for (const c of cs) await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, c.id));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
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
    email: `sugg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Suggestion Review User',
    companyName: 'Suggestion Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  companyId = (await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) }))!.id;

  const [bank] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '10999',
  }).returning();
  bankGlAccountId = bank!.id;
  const [rent] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Rent', accountType: 'expense', accountNumber: '61030',
  }).returning();
  rentAccountId = rent!.id;
  const [travel] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Travel', accountType: 'expense', accountNumber: '61040',
  }).returning();
  travelAccountId = travel!.id;

  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: bankGlAccountId, institutionName: 'Test Bank',
  }).returning();
  bankConnectionId = conn!.id;

  const [c] = await db.insert(portalContacts).values({
    tenantId, email: `contact-${Date.now()}@ex.com`, status: 'active', firstName: 'Dana',
  }).returning();
  contactId = c!.id;
  await db.insert(portalContactCompanies).values({ contactId, companyId, categorizeAccess: true });
}

async function mkFeedItem(amount = '42.5000') {
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId, companyId,
    feedDate: '2026-05-01', description: 'MYSTERY VENDOR', amount, status: 'pending',
  }).returning();
  return item!.id;
}

async function mkSuggestion(v: {
  targetKind: 'bank_feed_item' | 'transaction';
  targetId: string;
  accountId?: string | null;
  amount: string;
  date?: string;
  isPersonal?: boolean;
  note?: string;
}) {
  const [row] = await db.insert(clientCategorySuggestions).values({
    tenantId, companyId,
    targetKind: v.targetKind,
    bankFeedItemId: v.targetKind === 'bank_feed_item' ? v.targetId : null,
    transactionId: v.targetKind === 'transaction' ? v.targetId : null,
    suggestedAccountId: v.accountId ?? null,
    suggestedLabel: v.accountId ? 'Rent' : 'Not sure',
    clientNote: v.note ?? null,
    isPersonal: v.isPersonal ?? false,
    status: 'pending',
    submittedByContactId: contactId,
    snapshotAmount: v.amount,
    snapshotDate: v.date ?? '2026-05-01',
    snapshotDescription: 'MYSTERY VENDOR',
  }).returning();
  return row!.id;
}

async function balanceOf(accountId: string): Promise<number> {
  const [a] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)));
  return parseFloat(a!.balance ?? '0');
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('approving a suggestion on an UNPOSTED bank line', () => {
  it('posts the transaction and records what happened', async () => {
    const feedItemId = await mkFeedItem('42.5000');
    const sid = await mkSuggestion({ targetKind: 'bank_feed_item', targetId: feedItemId, accountId: rentAccountId, amount: '42.50' });

    const res = await review.approveSuggestions(tenantId, [sid], {}, userId);
    expect(res.approved).toEqual([sid]);
    expect(res.failed).toEqual([]);

    const [item] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.id, feedItemId));
    expect(item!.status).toBe('categorized');
    expect(item!.matchedTransactionId).toBeTruthy();

    const [row] = await db.select().from(clientCategorySuggestions).where(eq(clientCategorySuggestions.id, sid));
    expect(row!.status).toBe('approved');
    expect(row!.resolution).toBe('accepted_as_suggested');
    expect(row!.resolvedAccountId).toBe(rentAccountId);
    expect(row!.reviewedAt).not.toBeNull();
    expect(row!.reviewedBy).toBe(userId);

    expect(await balanceOf(rentAccountId)).toBe(42.5);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });

  it('records an override when staff pick a different account', async () => {
    const feedItemId = await mkFeedItem();
    const sid = await mkSuggestion({ targetKind: 'bank_feed_item', targetId: feedItemId, accountId: rentAccountId, amount: '42.50' });

    await review.approveSuggestions(tenantId, [sid], { overrideAccountId: travelAccountId }, userId);
    const [row] = await db.select().from(clientCategorySuggestions).where(eq(clientCategorySuggestions.id, sid));
    expect(row!.resolution).toBe('overridden');
    expect(row!.resolvedAccountId).toBe(travelAccountId);
    expect(await balanceOf(travelAccountId)).toBe(42.5);
    expect(await balanceOf(rentAccountId)).toBe(0);
  });

  it('is idempotent — a second approve reports not_pending, it does not double-post', async () => {
    const feedItemId = await mkFeedItem();
    const sid = await mkSuggestion({ targetKind: 'bank_feed_item', targetId: feedItemId, accountId: rentAccountId, amount: '42.50' });

    await review.approveSuggestions(tenantId, [sid], {}, userId);
    const again = await review.approveSuggestions(tenantId, [sid], {}, userId);
    expect(again.approved).toEqual([]);
    expect(again.failed[0]!.reason).toBe('not_pending_or_not_found');
    expect(await balanceOf(rentAccountId)).toBe(42.5);
  });
});

describe('approving a suggestion on an amount ALREADY IN SUSPENSE', () => {
  it('moves the money in place without creating a transaction', async () => {
    const suspenseId = await getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-05-01',
      lines: [
        { accountId: suspenseId, debit: '75.00', credit: '0' },
        { accountId: bankGlAccountId, debit: '0', credit: '75.00' },
      ],
    }, userId, companyId);

    const before = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
    const sid = await mkSuggestion({ targetKind: 'transaction', targetId: txn.id, accountId: rentAccountId, amount: '75.00' });

    const res = await review.approveSuggestions(tenantId, [sid], {}, userId);
    expect(res.approved).toEqual([sid]);

    const after = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
    expect(after).toHaveLength(before.length);

    const [row] = await db.select().from(clientCategorySuggestions).where(eq(clientCategorySuggestions.id, sid));
    expect(row!.postedTransactionId).toBe(txn.id);

    expect(await balanceOf(suspenseId)).toBe(0);
    expect(await balanceOf(rentAccountId)).toBe(75);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });

  it('retires as stale when someone already moved it out of suspense', async () => {
    const suspenseId = await getSuspenseAccountId(tenantId, companyId, userId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-05-01',
      lines: [
        { accountId: suspenseId, debit: '30.00', credit: '0' },
        { accountId: bankGlAccountId, debit: '0', credit: '30.00' },
      ],
    }, userId, companyId);
    const sid = await mkSuggestion({ targetKind: 'transaction', targetId: txn.id, accountId: rentAccountId, amount: '30.00' });

    // A bookkeeper clears it by hand first.
    await ledger.bulkUpdateTransactions(tenantId,
      { txnIds: [txn.id], moveFromAccountId: suspenseId, moveToAccountId: travelAccountId }, userId, companyId);

    const res = await review.approveSuggestions(tenantId, [sid], {}, userId);
    expect(res.failed[0]!.reason).toBe('stale');
    const [row] = await db.select().from(clientCategorySuggestions).where(eq(clientCategorySuggestions.id, sid));
    expect(row!.status).toBe('stale');
    // The hand-clearing stands.
    expect(await balanceOf(travelAccountId)).toBe(30);
  });
});

describe('guards', () => {
  it('refuses to bulk-approve a row whose amount moved since the client answered', async () => {
    const feedItemId = await mkFeedItem('42.5000');
    const sid = await mkSuggestion({ targetKind: 'bank_feed_item', targetId: feedItemId, accountId: rentAccountId, amount: '42.50' });

    // Plaid rewrites the amount as the transaction settles.
    await db.update(bankFeedItems).set({ amount: '58.1000' }).where(eq(bankFeedItems.id, feedItemId));

    const blocked = await review.approveSuggestions(tenantId, [sid], {}, userId);
    expect(blocked.approved).toEqual([]);
    expect(blocked.failed[0]!.reason).toBe('drifted');
    // Still actionable, not retired.
    const [mid] = await db.select().from(clientCategorySuggestions).where(eq(clientCategorySuggestions.id, sid));
    expect(mid!.status).toBe('pending');
    expect(await balanceOf(rentAccountId)).toBe(0);

    // Staff can look at it and confirm explicitly.
    const confirmed = await review.approveSuggestions(tenantId, [sid], { confirmDrift: true }, userId);
    expect(confirmed.approved).toEqual([sid]);
    expect(await balanceOf(rentAccountId)).toBe(58.1);
  });

  it('surfaces drift on the listing so the UI can flag it', async () => {
    const feedItemId = await mkFeedItem('42.5000');
    await mkSuggestion({ targetKind: 'bank_feed_item', targetId: feedItemId, accountId: rentAccountId, amount: '42.50' });
    await db.update(bankFeedItems).set({ amount: '58.1000' }).where(eq(bankFeedItems.id, feedItemId));

    const listed = await review.listSuggestions(tenantId, { companyId });
    expect(listed.rows[0]!.driftedFields).toContain('amount');
    expect(listed.rows[0]!.contactName).toBe('Dana');
  });

  it('cannot be approved when the client said "not sure"', async () => {
    const feedItemId = await mkFeedItem();
    const sid = await mkSuggestion({
      targetKind: 'bank_feed_item', targetId: feedItemId, accountId: null,
      amount: '42.50', note: 'no idea what this was',
    });
    const res = await review.approveSuggestions(tenantId, [sid], {}, userId);
    expect(res.failed[0]!.reason).toBe('no_category');
    // Overriding with a real account is how staff resolve it.
    const fixed = await review.approveSuggestions(tenantId, [sid], { overrideAccountId: rentAccountId }, userId);
    expect(fixed.approved).toEqual([sid]);
  });

  it('refuses a system account as an override target', async () => {
    const suspenseId = await getSuspenseAccountId(tenantId, companyId, userId);
    const feedItemId = await mkFeedItem();
    const sid = await mkSuggestion({ targetKind: 'bank_feed_item', targetId: feedItemId, accountId: rentAccountId, amount: '42.50' });
    await expect(
      review.approveSuggestions(tenantId, [sid], { overrideAccountId: suspenseId }, userId),
    ).rejects.toThrow(/system account/i);
  });

  it('rejects with a reason the client can read, and requires one', async () => {
    const feedItemId = await mkFeedItem();
    const sid = await mkSuggestion({ targetKind: 'bank_feed_item', targetId: feedItemId, accountId: rentAccountId, amount: '42.50' });

    await expect(review.rejectSuggestions(tenantId, [sid], '   ', userId)).rejects.toThrow(/reason/i);

    const res = await review.rejectSuggestions(tenantId, [sid], 'That was the other landlord.', userId);
    expect(res.rejected).toEqual([sid]);
    const [row] = await db.select().from(clientCategorySuggestions).where(eq(clientCategorySuggestions.id, sid));
    expect(row!.status).toBe('rejected');
    expect(row!.rejectionReason).toBe('That was the other landlord.');
    // Nothing posted.
    expect(await balanceOf(rentAccountId)).toBe(0);
  });
});

describe('the unread badge', () => {
  it('counts pending unreviewed answers and clears without posting', async () => {
    const f1 = await mkFeedItem('10.0000');
    const f2 = await mkFeedItem('20.0000');
    await mkSuggestion({ targetKind: 'bank_feed_item', targetId: f1, accountId: rentAccountId, amount: '10.00' });
    await mkSuggestion({ targetKind: 'bank_feed_item', targetId: f2, accountId: rentAccountId, amount: '20.00' });

    expect(await review.countUnread(tenantId, companyId)).toBe(2);

    const marked = await review.markReviewed(tenantId, null, companyId, userId);
    expect(marked.marked).toBe(2);
    expect(await review.countUnread(tenantId, companyId)).toBe(0);

    // Marking reviewed is not approving: still pending, nothing posted.
    const listed = await review.listSuggestions(tenantId, { companyId, status: 'pending' });
    expect(listed.total).toBe(2);
    expect(await balanceOf(rentAccountId)).toBe(0);
  });
});
