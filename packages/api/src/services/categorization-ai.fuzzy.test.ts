// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// LOW: the fuzzy vendor match (`description LIKE '%name%'`) now requires the
// contact name to be at least 3 chars. A 1-2 char name matched almost every
// descriptor and stamped a bogus 0.80-confidence suggestion.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
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

async function cleanDb() {
  await db.delete(bankFeedItems);
  await db.delete(bankConnections);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
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
