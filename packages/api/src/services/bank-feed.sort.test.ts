// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// list()'s server-side sort whitelist. The feed paginates, so every order
// the UI offers must be produced in SQL; these pin the three keys the Bank
// Feed "Sort by" dropdown added — name (assigned → suggested contact →
// cleaned descriptor, the NAME column's own precedence), the raw bank
// description, and the numeric confidence score — plus the fallback for an
// unknown key.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, contacts,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';
import type { BankFeedFilters } from '@kis-books/shared';

let tenantId = '';
let userId = '';
let connectionId = '';

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

async function contact(displayName: string) {
  const [row] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName }).returning();
  return row!.id;
}

async function insertItem(extra: Partial<typeof bankFeedItems.$inferInsert> = {}) {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: connectionId,
    feedDate: '2026-06-15',
    description: 'POS PURCHASE',
    amount: '-10.0000',
    status: 'pending',
    ...extra,
  }).returning();
  return row!;
}

async function order(filters: Omit<BankFeedFilters, 'limit' | 'offset'>): Promise<string[]> {
  const { data } = await bankFeedService.list(tenantId, { ...filters, limit: 50, offset: 0 });
  return data.map((r) => r.description ?? '');
}

beforeEach(async () => {
  await cleanDb();
  const { user } = await authService.register({
    email: `feedsort-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Feed Sort Test User',
    companyName: 'Feed Sort Test Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: bank!.id, provider: 'manual', institutionName: 'Test Bank',
  }).returning();
  connectionId = conn!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('bank-feed list — sort whitelist', () => {
  it('sorts by name with the NAME column precedence: assigned contact, then suggested, then descriptor', async () => {
    const zed = await contact('Zed Hardware');
    const bea = await contact('Bea Bakery');
    // Descriptor says "AAA" but the assigned contact "Zed" is what the column shows.
    await insertItem({ description: 'AAA STORE', assignedContactId: zed, status: 'assigned', assignedAccountId: null });
    // Suggested contact "Bea" beats its descriptor "YYY".
    await insertItem({ description: 'YYY MART', suggestedContactId: bea });
    // No contact: the cleaned descriptor is the name.
    await insertItem({ description: 'MMM GAS' });

    expect(await order({ sortBy: 'name', sortDir: 'asc' })).toEqual(['YYY MART', 'MMM GAS', 'AAA STORE']);
    expect(await order({ sortBy: 'name', sortDir: 'desc' })).toEqual(['AAA STORE', 'MMM GAS', 'YYY MART']);
  });

  it('sorts by the raw bank description, not the cleaned one', async () => {
    await insertItem({ description: 'B CLEAN', originalDescription: 'ZZZ RAW 1' });
    await insertItem({ description: 'A CLEAN', originalDescription: 'MMM RAW 2' });
    await insertItem({ description: 'C CLEAN', originalDescription: 'AAA RAW 3' });

    expect(await order({ sortBy: 'originalDescription', sortDir: 'asc' })).toEqual(['C CLEAN', 'A CLEAN', 'B CLEAN']);
    expect(await order({ sortBy: 'originalDescription', sortDir: 'desc' })).toEqual(['B CLEAN', 'A CLEAN', 'C CLEAN']);
  });

  it('sorts by confidence numerically, unscored rows last either way', async () => {
    await insertItem({ description: 'NINETY', confidenceScore: '0.90' });
    await insertItem({ description: 'NONE', confidenceScore: null });
    await insertItem({ description: 'TEN', confidenceScore: '0.10' });
    await insertItem({ description: 'FULL', confidenceScore: '1.00' });

    expect(await order({ sortBy: 'confidence', sortDir: 'desc' })).toEqual(['FULL', 'NINETY', 'TEN', 'NONE']);
    expect(await order({ sortBy: 'confidence', sortDir: 'asc' })).toEqual(['TEN', 'NINETY', 'FULL', 'NONE']);
  });

  it('falls back to newest-first for a key it does not know', async () => {
    await insertItem({ description: 'OLD', feedDate: '2026-01-01' });
    await insertItem({ description: 'NEW', feedDate: '2026-03-01' });
    // Cast: the zod schema refuses this at the route; the service must still
    // not throw or order arbitrarily if it ever arrives.
    expect(await order({ sortBy: 'bogus' as BankFeedFilters['sortBy'] })).toEqual(['NEW', 'OLD']);
  });
});
