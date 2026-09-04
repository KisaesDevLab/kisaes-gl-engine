// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// "Also delete pending feed items" deleted nothing, always.
//
// bank_feed_items.bank_connection_id is a BANK_CONNECTIONS id; the code
// compared it against the plaid_items uuid. Those can never be equal, so the
// option silently did nothing for as long as it has existed — and a user who
// ticked it to clear a bad import got no error and no result.
//
// The counterpart matters just as much: a manual Statement Import connection
// very often points at the SAME ledger account as the Plaid feed (four tenants
// here do exactly that), and its rows must survive.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, users, userTenantAccess,
  plaidItems, plaidAccounts, plaidAccountMappings,
  bankConnections, bankFeedItems,
} from '../db/schema/index.js';
import { unmapCompany } from './plaid-connection.service.js';

const PLAID_ITEM_ID = 'plaid-item-string-id';

let tenantId = '';
let userId = '';
let companyId = '';
let glAccountId = '';
let itemRowId = '';
let plaidConnId = '';
let manualConnId = '';

const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Unmap Pending', slug: 'up-' + suffix() }).returning();
  tenantId = t!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `up-${suffix()}@example.com`, passwordHash: 'x', displayName: 'UP',
  }).returning();
  userId = u!.id;
  await db.insert(userTenantAccess).values({ userId, tenantId, role: 'owner' });
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'UP Co' }).returning();
  companyId = c!.id;
  const [a] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Cash - Checking', accountType: 'asset', detailType: 'bank',
  }).returning();
  glAccountId = a!.id;

  const [item] = await db.insert(plaidItems).values({
    plaidItemId: PLAID_ITEM_ID + '-' + suffix(),
    plaidInstitutionId: 'ins_x', institutionName: 'Test Bank',
    accessTokenEncrypted: 'x', createdBy: userId,
  }).returning();
  itemRowId = item!.id;

  const [pa] = await db.insert(plaidAccounts).values({
    plaidItemId: item!.id, plaidAccountId: 'acct-' + suffix(),
    name: 'CHECKING', accountType: 'depository', accountSubtype: 'checking', mask: '1234',
  }).returning();
  await db.insert(plaidAccountMappings).values({
    plaidAccountId: pa!.id, tenantId, mappedAccountId: glAccountId, mappedBy: userId,
  });

  // The Plaid-side connection, stamped with the item id the way
  // getOrCreatePlaidConnection does it.
  const [pc] = await db.insert(bankConnections).values({
    tenantId, accountId: glAccountId, provider: 'plaid',
    institutionName: 'Test Bank', providerItemId: item!.plaidItemId, mask: '1234',
  }).returning();
  plaidConnId = pc!.id;

  // A Statement Import connection on the SAME ledger account.
  const [mc] = await db.insert(bankConnections).values({
    tenantId, accountId: glAccountId, provider: 'manual', institutionName: 'Statement Import',
  }).returning();
  manualConnId = mc!.id;

  const row = (connId: string, status: string, amount: string) => ({
    tenantId, bankConnectionId: connId, feedDate: '2026-07-01',
    description: 'Row', amount, status,
  });
  await db.insert(bankFeedItems).values([
    row(plaidConnId, 'pending', '10.0000'),
    row(plaidConnId, 'pending', '20.0000'),
    row(plaidConnId, 'categorized', '30.0000'),
    row(manualConnId, 'pending', '40.0000'),
  ]);
});

afterEach(async () => {
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(plaidAccountMappings).where(eq(plaidAccountMappings.tenantId, tenantId));
  await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, itemRowId));
  await db.delete(plaidItems).where(eq(plaidItems.id, itemRowId));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
});

const countOn = async (connId: string, status?: string) => {
  const rows = await db.select({ id: bankFeedItems.id }).from(bankFeedItems)
    .where(status
      ? and(eq(bankFeedItems.bankConnectionId, connId), eq(bankFeedItems.status, status))
      : eq(bankFeedItems.bankConnectionId, connId));
  return rows.length;
};

describe('unmapCompany — deletePendingItems', () => {
  it('actually deletes the pending rows when asked', async () => {
    await unmapCompany(itemRowId, tenantId, true, userId);
    expect(await countOn(plaidConnId, 'pending')).toBe(0);
  });

  it('leaves posted rows alone', async () => {
    await unmapCompany(itemRowId, tenantId, true, userId);
    // A categorized row has a transaction behind it; deleting it would strand
    // the ledger entry.
    expect(await countOn(plaidConnId, 'categorized')).toBe(1);
  });

  it('never touches a Statement Import connection on the same ledger account', async () => {
    await unmapCompany(itemRowId, tenantId, true, userId);
    expect(await countOn(manualConnId)).toBe(1);
  });

  it('deletes nothing when not asked', async () => {
    await unmapCompany(itemRowId, tenantId, false, userId);
    expect(await countOn(plaidConnId)).toBe(3);
    expect(await countOn(manualConnId)).toBe(1);
  });
});

// The regression that made this whole area worth a second look.
//
// A first pass resolved the connection by bank_connections.provider_item_id,
// which reads as the obvious join and is wrong: that column is written only
// when the row is inserted, so a re-link leaves it naming the REMOVED item on
// a live, working connection. Nine of ten Plaid connections in production were
// in that state, so the "fix" would have gone on deleting nothing.
describe('unmapCompany — resolves connections after a re-link', () => {
  it('still finds the connection when provider_item_id is stale', async () => {
    // Simulate the re-link: the connection now names an item that no longer
    // exists, while the mapping still points at the same ledger account.
    await db.update(bankConnections)
      .set({ providerItemId: 'a-removed-item-' + suffix() })
      .where(eq(bankConnections.id, plaidConnId));

    await unmapCompany(itemRowId, tenantId, true, userId);

    expect(await countOn(plaidConnId, 'pending')).toBe(0);
    expect(await countOn(plaidConnId, 'categorized')).toBe(1);
    expect(await countOn(manualConnId)).toBe(1);
  });
});

