// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// LOW: the fuzzy vendor match (`description LIKE '%name%'`) now requires the
// contact name to be at least 3 chars. A 1-2 char name matched almost every
// descriptor and stamped a bogus 0.80-confidence suggestion.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, contacts,
  transactions, journalLines, bankConnections, bankFeedItems,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import { suggestCategorization } from './categorization-ai.service.js';

let tenantId: string;
let connectionId: string;
let expenseAccountId: string;

// Tenant-SCOPED cleanup — unscoped deletes nuke concurrently-running
// suites' data and die on their FKs. Only ever touch our own tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  // sessions has no tenant_id — scope through this tenant's users.
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function seedVendorWithHistory(displayName: string, memoDesc: string) {
  const [contact] = await db.insert(contacts).values({
    tenantId, displayName, contactType: 'vendor',
  }).returning();
  const [txn] = await db.insert(transactions).values({
    tenantId, txnType: 'expense', txnDate: '2026-06-01', status: 'posted',
    contactId: contact!.id, memo: memoDesc,
  }).returning();
  await db.insert(journalLines).values({
    tenantId, transactionId: txn!.id, accountId: expenseAccountId, debit: '10.0000', credit: '0',
  });
  return contact!.id;
}

async function insertFeedItem(description: string): Promise<string> {
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: connectionId, feedDate: '2026-06-02',
    description, originalDescription: description, amount: '10.0000', status: 'pending',
  }).returning();
  return item!.id;
}

describe('suggestCategorization fuzzy — minimum name length', () => {
  beforeEach(async () => {
    await cleanDb();
    const { user } = await authService.register({
      email: `fuzzy-${Date.now()}@example.com`,
      password: 'password123',
      displayName: 'Fuzzy Test',
      companyName: 'Fuzzy Co',
    });
    tenantId = user.tenantId;
    const expense = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')),
    });
    expenseAccountId = expense!.id;
    const bankAcct = await db.query.accounts.findFirst({ where: eq(accounts.tenantId, tenantId) });
    const [conn] = await db.insert(bankConnections).values({
      tenantId, accountId: bankAcct!.id, provider: 'manual', institutionName: 'Test Bank',
    }).returning();
    connectionId = conn!.id;
  });
  afterEach(async () => { await cleanDb(); });

  it('does NOT fuzzy-match a 2-char vendor name against a descriptor that contains it', async () => {
    await seedVendorWithHistory('Al', 'unrelated memo one');
    // "al" is a substring of "alimony" — the old code matched the 2-char "Al".
    const id = await insertFeedItem('MONTHLY ALIMONY 0001 XYZ');
    const result = await suggestCategorization(tenantId, id);
    expect(result === null || result.matchType !== 'fuzzy').toBe(true);
  });

  it('DOES fuzzy-match a 6-char vendor name whose descriptor contains it', async () => {
    await seedVendorWithHistory('Zephyr', 'unrelated memo two');
    const id = await insertFeedItem('PAYMENT ZEPHYR CORP 0002');
    const result = await suggestCategorization(tenantId, id);
    expect(result?.matchType).toBe('fuzzy');
  });
});
