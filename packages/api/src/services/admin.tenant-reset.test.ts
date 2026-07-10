// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Admin tenant-reset tools:
//   - deleteAllTransactions: wipes transactions/journal lines and
//     dependents, resets bank-feed matches + account balances, keeps
//     COA/contacts/settings
//   - applyCoaTemplate: seeds a template onto an EMPTY chart of
//     accounts only

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog as auditLogTable, contacts,
  transactions, journalLines, tags, transactionTags, bankFeedItems, bankConnections,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import { deleteAllTransactions, applyCoaTemplate } from './admin.service.js';

let tenantId: string;

async function cleanDb() {
  await db.delete(bankFeedItems);
  await db.delete(bankConnections);
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLogTable);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Reset', slug: `reset-${Date.now()}` }).returning();
  tenantId = t!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('deleteAllTransactions', () => {
  it('wipes transactions, resets balances and feed matches, keeps accounts/contacts', async () => {
    const [cash] = await db.insert(accounts).values({ tenantId, name: 'Cash', accountNumber: '1000', accountType: 'asset' }).returning();
    const [rev] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountNumber: '4000', accountType: 'revenue' }).returning();
    const [vendor] = await db.insert(contacts).values({ tenantId, displayName: 'V', contactType: 'vendor' }).returning();

    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-03-01', memo: 'sale',
      lines: [
        { accountId: cash!.id, debit: '500', credit: '0' },
        { accountId: rev!.id, debit: '0', credit: '500' },
      ],
    });

    // Matched bank feed item referencing the transaction.
    const [conn] = await db.insert(bankConnections).values({
      tenantId, accountId: cash!.id, provider: 'manual', institutionName: 'Test Bank',
    } as any).returning();
    await db.insert(bankFeedItems).values({
      tenantId, bankConnectionId: conn!.id, feedDate: '2026-03-01', amount: '500',
      status: 'matched', matchedTransactionId: txn.id, matchType: 'exact',
    } as any);

    const result = await deleteAllTransactions(tenantId, undefined);
    expect(result.transactionsDeleted).toBe(1);

    // Ledger gone; balance reset; structure kept.
    expect((await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).length).toBe(0);
    expect((await db.select().from(journalLines).where(eq(journalLines.tenantId, tenantId))).length).toBe(0);
    const [cashAfter] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, cash!.id)));
    expect(parseFloat(cashAfter!.balance!)).toBe(0);
    expect((await db.select().from(contacts).where(eq(contacts.tenantId, tenantId))).length).toBe(1);
    expect((await db.select().from(accounts).where(eq(accounts.tenantId, tenantId))).length).toBe(2);

    // Feed item survives, back to pending, unmatched.
    const [feed] = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    expect(feed!.status).toBe('pending');
    expect(feed!.matchedTransactionId).toBeNull();

    // Audited.
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    expect(audits.some((a) => a.entityType === 'all_transactions')).toBe(true);
  });

  it('is a no-op on a tenant with no transactions', async () => {
    const result = await deleteAllTransactions(tenantId, undefined);
    expect(result.transactionsDeleted).toBe(0);
  });
});

describe('applyCoaTemplate', () => {
  it('seeds a template onto an empty COA and audits it', async () => {
    const result = await applyCoaTemplate(tenantId, 'default', undefined);
    expect(result.accountsCreated).toBeGreaterThan(10);
    const rows = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
    expect(rows.some((a) => a.systemTag === 'accounts_receivable')).toBe(true);
  });

  it('refuses when the tenant already has accounts', async () => {
    await db.insert(accounts).values({ tenantId, name: 'Cash', accountNumber: '1000', accountType: 'asset' });
    await expect(applyCoaTemplate(tenantId, 'default', undefined)).rejects.toThrow(/already has/i);
  });
});
