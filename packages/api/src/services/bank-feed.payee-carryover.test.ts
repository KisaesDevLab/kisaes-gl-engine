// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Payee carryover — what the Bank Feeds screen shows must survive posting.
//
// STATEMENT_CHECK_PAYEE_V1 fills bank_feed_items.payee_name_on_check from the
// statement's check images, and the feed's NAME column shows an AI/rule
// suggested contact. Before this suite, approve() dropped both: the memo fell
// through to the bank descriptor ("CHECK 3607", "Unknown") and the contact came
// only from assigned_contact_id, which assign() nulls when the caller sends
// none. Rows landed in suspense with no payee and a useless memo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, contacts,
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
let vendorId = '';

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
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const { user } = await authService.register({
    email: `payee-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Payee Test User',
    companyName: 'Payee Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;

  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  companyId = company!.id;

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  bankAccountId = bank!.id;

  const [expense] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')))
    .limit(1);
  expenseAccountId = expense!.id;

  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: bankAccountId, provider: 'manual', institutionName: 'Test Bank',
  }).returning();
  connectionId = conn!.id;

  const [vendor] = await db.insert(contacts).values({
    tenantId, contactType: 'vendor', displayName: 'Acme Supply Co',
  }).returning();
  vendorId = vendor!.id;
}

async function insertCheckItem(
  extra: Partial<typeof bankFeedItems.$inferInsert> = {},
): Promise<typeof bankFeedItems.$inferSelect> {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: connectionId,
    feedDate: '2026-06-15',
    // The bank's own descriptor for a cleared check: no payee in it at all.
    description: 'CHECK 3607',
    originalDescription: 'CHECK 3607',
    amount: '294.9100',
    status: 'pending',
    checkNumber: 3607,
    payeeNameOnCheck: 'Acme Supply Co',
    ...extra,
  }).returning();
  return row!;
}

async function postedFor(feedItemId: string) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, item!.matchedTransactionId!)),
  });
  const lines = await db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txn!.id)));
  return { item: item!, txn: txn!, lines };
}

beforeEach(setup);
afterEach(cleanDb);

describe('resolveFeedMemo — the memo precedence chain', () => {
  const base = { memo: null, description: 'CHECK 3607', payeeNameOnCheck: null, checkNumber: null };

  it('prefers the explicit (staged or typed) memo over everything', () => {
    expect(bankFeedService.resolveFeedMemo(
      { ...base, memo: 'feed memo', payeeNameOnCheck: 'Acme' }, '  Office rent  ',
    )).toBe('Office rent');
  });

  it('falls to the feed item memo before the check payee', () => {
    expect(bankFeedService.resolveFeedMemo(
      { ...base, memo: 'Plaid payee text', payeeNameOnCheck: 'Acme' },
    )).toBe('Plaid payee text');
  });

  it('uses the check payee with its number when there is no memo', () => {
    expect(bankFeedService.resolveFeedMemo(
      { ...base, payeeNameOnCheck: 'Acme Supply Co', checkNumber: 3607 },
    )).toBe('Check 3607 - Acme Supply Co');
  });

  it('uses the bare payee when no check number was parsed', () => {
    expect(bankFeedService.resolveFeedMemo(
      { ...base, payeeNameOnCheck: 'Acme Supply Co' },
    )).toBe('Acme Supply Co');
  });

  it('falls back to the bank descriptor, and to undefined when blank', () => {
    expect(bankFeedService.resolveFeedMemo(base)).toBe('CHECK 3607');
    expect(bankFeedService.resolveFeedMemo({ ...base, description: '   ' })).toBeUndefined();
  });

  it('treats a whitespace-only staged memo as absent', () => {
    expect(bankFeedService.resolveFeedMemo(
      { ...base, payeeNameOnCheck: 'Acme Supply Co' }, '   ',
    )).toBe('Acme Supply Co');
  });
});

describe('approve() carries the payee onto the ledger', () => {
  it('posts the check payee as the memo and the line description', async () => {
    const item = await insertCheckItem();
    await bankFeedService.assign(tenantId, item.id, { accountId: expenseAccountId }, userId);
    await bankFeedService.approve(tenantId, item.id, userId, companyId);

    const { txn, lines } = await postedFor(item.id);
    expect(txn.memo).toBe('Check 3607 - Acme Supply Co');
    // The metadata columns still carry the structured values.
    expect(txn.checkNumber).toBe(3607);
    expect(txn.payeeNameOnCheck).toBe('Acme Supply Co');
    // The expense line, not the cash leg, is the one reports read.
    const expenseLine = lines.find((l) => l.accountId === expenseAccountId);
    expect(expenseLine!.description).toBe('Check 3607 - Acme Supply Co');
  });

  it('keeps the suggested contact when assign staged none', async () => {
    const item = await insertCheckItem({ suggestedContactId: vendorId });
    // The user accepts the row as-is: assign() sends no contactId, so
    // assigned_contact_id is null and only the suggestion survives.
    await bankFeedService.assign(tenantId, item.id, { accountId: expenseAccountId }, userId);
    await bankFeedService.approve(tenantId, item.id, userId, companyId);

    const { txn } = await postedFor(item.id);
    expect(txn.contactId).toBe(vendorId);
  });

  it('lets a staged memo and contact win over the suggestions', async () => {
    const item = await insertCheckItem({ suggestedContactId: vendorId });
    const [other] = await db.insert(contacts).values({
      tenantId, contactType: 'vendor', displayName: 'Beta Hardware',
    }).returning();

    await bankFeedService.assign(tenantId, item.id, {
      accountId: expenseAccountId, contactId: other!.id, memo: 'Shop supplies',
    }, userId);
    await bankFeedService.approve(tenantId, item.id, userId, companyId);

    const { txn } = await postedFor(item.id);
    expect(txn.memo).toBe('Shop supplies');
    expect(txn.contactId).toBe(other!.id);
  });
});

describe('categorize() (direct post, used by post-to-suspense) carries it too', () => {
  it('stamps the payee memo when no memo is supplied', async () => {
    const item = await insertCheckItem();
    await bankFeedService.categorize(
      tenantId, item.id, { accountId: expenseAccountId }, userId, companyId,
    );

    const { txn } = await postedFor(item.id);
    expect(txn.memo).toBe('Check 3607 - Acme Supply Co');
    expect(txn.payeeNameOnCheck).toBe('Acme Supply Co');
  });

  it('leaves a plain (non-check) row on its bank descriptor', async () => {
    const item = await insertCheckItem({
      description: 'ZZQX COFFEE SHOP', checkNumber: null, payeeNameOnCheck: null,
    });
    await bankFeedService.categorize(
      tenantId, item.id, { accountId: expenseAccountId }, userId, companyId,
    );

    const { txn } = await postedFor(item.id);
    expect(txn.memo).toBe('ZZQX COFFEE SHOP');
  });
});
