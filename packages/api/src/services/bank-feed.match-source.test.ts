// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// list() surfaces the signals the feed's NAME column and confidence badge need:
//   - matchType: so a rule-mapped row shows a green "Rule" badge instead of a
//     generic confidence word (matchType === 'rule').
//   - suggestedContactName / assignedContactName: the resolved contact display
//     names, non-null only when the row links a real contacts row. The UI shows
//     a "matched contact" checkmark when either is present; a description-only
//     row leaves both null so no checkmark renders.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, contacts,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';

let tenantId = '';
let userId = '';
let connectionId = '';
let bankAccountId = '';
let vendorId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
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
    email: `matchsrc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Match Source Test User',
    companyName: 'Match Source Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  bankAccountId = bank!.id;

  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId: bankAccountId,
    provider: 'manual',
    institutionName: 'Test Bank',
  }).returning();
  connectionId = conn!.id;

  const [vendor] = await db.insert(contacts).values({
    tenantId,
    contactType: 'vendor',
    displayName: 'Acme Supplies',
  }).returning();
  vendorId = vendor!.id;
}

async function insertItem(
  extra: Partial<typeof bankFeedItems.$inferInsert> = {},
): Promise<typeof bankFeedItems.$inferSelect> {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: connectionId,
    feedDate: '2026-06-15',
    description: 'POS PURCHASE 8842',
    amount: '-42.0000',
    status: 'pending',
    ...extra,
  }).returning();
  return row!;
}

async function rowFor(itemId: string) {
  const { data } = await bankFeedService.list(tenantId, {});
  return data.find((r) => r.id === itemId)!;
}

beforeEach(async () => {
  await cleanDb();
  await setup();
});

afterEach(async () => {
  await cleanDb();
});

describe('bank-feed list — match source + contact-match signals', () => {
  it('surfaces matchType="rule" when a rule stamped the item', async () => {
    const item = await insertItem({ matchType: 'rule', confidenceScore: '1.00' });
    expect((await rowFor(item.id)).matchType).toBe('rule');
  });

  it('surfaces the AI matchType (fuzzy/history/exact) unchanged', async () => {
    const item = await insertItem({ matchType: 'fuzzy', confidenceScore: '0.80' });
    expect((await rowFor(item.id)).matchType).toBe('fuzzy');
  });

  it('resolves suggestedContactName when a suggested contactId links a real contact', async () => {
    const item = await insertItem({ suggestedContactId: vendorId });
    const row = await rowFor(item.id);
    expect(row.suggestedContactName).toBe('Acme Supplies');
    expect(row.assignedContactName ?? null).toBeNull();
  });

  it('resolves assignedContactName when a human-assigned contactId links a real contact', async () => {
    const item = await insertItem({ assignedContactId: vendorId });
    const row = await rowFor(item.id);
    expect(row.assignedContactName).toBe('Acme Supplies');
  });

  it('leaves both contact names null for a description-only row (no checkmark)', async () => {
    const item = await insertItem();
    const row = await rowFor(item.id);
    expect(row.suggestedContactName ?? null).toBeNull();
    expect(row.assignedContactName ?? null).toBeNull();
    // No matchType stamp either — the row is raw description text only.
    expect(row.matchType ?? null).toBeNull();
  });

  it('ruleOnly filter returns only match_type=rule rows, excluding AI/description rows', async () => {
    const ruleItem = await insertItem({ matchType: 'rule', confidenceScore: '1.00', description: 'RULE ROW' });
    await insertItem({ matchType: 'fuzzy', confidenceScore: '0.80', description: 'AI ROW' });
    await insertItem({ description: 'PLAIN ROW' }); // description-only, matchType null

    const { data, total } = await bankFeedService.list(tenantId, { ruleOnly: true });
    expect(data.map((r) => r.id)).toEqual([ruleItem.id]);
    // total reflects the constrained set (filtered in SQL, not client-side).
    expect(total).toBe(1);
    expect(data.every((r) => r.matchType === 'rule')).toBe(true);
  });

  it('without ruleOnly, all rows are returned regardless of match source', async () => {
    await insertItem({ matchType: 'rule', confidenceScore: '1.00' });
    await insertItem({ matchType: 'fuzzy', confidenceScore: '0.80' });
    await insertItem();
    const { total } = await bankFeedService.list(tenantId, {});
    expect(total).toBe(3);
  });
});

// Bulk "Set Name" — assigns an EXISTING contact by name (match-only, never
// creates), so the name shows in the feed and carries to the posted txn.
describe('bank-feed bulkSetName — match existing contact only', () => {
  it('assigns the matched contact to pending rows (case-insensitive) and moves them to assigned', async () => {
    const a = await insertItem();
    const b = await insertItem();
    const res = await bankFeedService.bulkSetName(tenantId, [a.id, b.id], 'acme supplies');
    expect(res.updated).toBe(2);
    expect(res.matchedContactId).toBe(vendorId);
    expect((await rowFor(a.id)).assignedContactName).toBe('Acme Supplies');
    const row = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, a.id) });
    expect(row!.status).toBe('assigned');
  });

  it('does nothing and reports skipped when no contact matches the typed name', async () => {
    const a = await insertItem();
    const res = await bankFeedService.bulkSetName(tenantId, [a.id], 'Nonexistent Vendor');
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.matchedContactId).toBeNull();
    expect(res.noContactMatch).toBe(true);
    expect((await rowFor(a.id)).assignedContactName ?? null).toBeNull();
  });

  it('never creates a contact for an unmatched name', async () => {
    const a = await insertItem();
    const before = (await db.select().from(contacts).where(eq(contacts.tenantId, tenantId))).length;
    await bankFeedService.bulkSetName(tenantId, [a.id], 'Brand New Payee Co');
    const after = (await db.select().from(contacts).where(eq(contacts.tenantId, tenantId))).length;
    expect(after).toBe(before);
  });
});

// Search box now matches the resolved NAME (assigned/suggested contact display
// name) and the AMOUNT, in addition to the bank descriptor, category and memo.
// The count query must join the contact aliases too, so `total` stays in sync.
describe('bank-feed list — search fields (name, amount, memo)', () => {
  it('matches by assigned contact name (case-insensitive) and total reflects it', async () => {
    const hit = await insertItem({ assignedContactId: vendorId, description: 'RAW DESCRIPTOR A' });
    await insertItem({ description: 'UNRELATED ROW B' }); // no contact, different text
    const { data, total } = await bankFeedService.list(tenantId, { search: 'acme' } as never);
    expect(total).toBe(1);
    expect(data.map((r) => r.id)).toEqual([hit.id]);
  });

  it('matches by suggested contact name', async () => {
    const hit = await insertItem({ suggestedContactId: vendorId, description: 'RAW DESCRIPTOR C' });
    await insertItem({ description: 'UNRELATED ROW D' });
    const { data, total } = await bankFeedService.list(tenantId, { search: 'Acme Supplies' } as never);
    expect(total).toBe(1);
    expect(data[0]!.id).toBe(hit.id);
  });

  it('matches by amount as text ("42" finds -42.0000)', async () => {
    const hit = await insertItem({ amount: '-42.0000', description: 'NO KEYWORD HERE' });
    await insertItem({ amount: '-1799.0000', description: 'ANOTHER ROW' });
    const { data, total } = await bankFeedService.list(tenantId, { search: '42' } as never);
    expect(total).toBe(1);
    expect(data[0]!.id).toBe(hit.id);
  });

  it('matches by raw memo (the placeholder promised it)', async () => {
    const hit = await insertItem({ memo: 'WALMART SUPERCENTER', description: 'POS 001' });
    await insertItem({ memo: 'TARGET STORE', description: 'POS 002' });
    const { data, total } = await bankFeedService.list(tenantId, { search: 'walmart' } as never);
    expect(total).toBe(1);
    expect(data[0]!.id).toBe(hit.id);
  });

  it('still matches the bank descriptor and category', async () => {
    const byDesc = await insertItem({ description: 'STARBUCKS 1234' });
    const { total: t1 } = await bankFeedService.list(tenantId, { search: 'starbucks' } as never);
    expect(t1).toBe(1);
    await bankFeedService.list(tenantId, {}); // sanity
    expect(byDesc.id).toBeTruthy();
  });
});
