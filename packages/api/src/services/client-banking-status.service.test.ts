// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Bank-feed backlog + Plaid freshness per client, for the Clients screen.
// This is a deliberately cross-tenant query, so the tests that matter most are
// the ones proving it returns exactly the caller's own tenants and nothing else.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, bankConnections, bankFeedItems,
  plaidItems, plaidAccounts, plaidAccountMappings, userTenantAccess,
} from '../db/schema/index.js';
import * as service from './client-banking-status.service.js';

let tenantA = '';
let tenantB = '';
let outsiderTenant = '';
let userId = '';
let outsiderUserId = '';
const createdPlaidItemIds: string[] = [];

async function cleanup() {
  const tids = [tenantA, tenantB, outsiderTenant].filter(Boolean);
  if (tids.length === 0) return;
  await db.delete(plaidAccountMappings).where(inArray(plaidAccountMappings.tenantId, tids));
  if (createdPlaidItemIds.length > 0) {
    await db.delete(plaidAccounts).where(inArray(plaidAccounts.plaidItemId, createdPlaidItemIds));
    await db.delete(plaidItems).where(inArray(plaidItems.id, createdPlaidItemIds));
    createdPlaidItemIds.length = 0;
  }
  await db.delete(bankFeedItems).where(inArray(bankFeedItems.tenantId, tids));
  await db.delete(bankConnections).where(inArray(bankConnections.tenantId, tids));
  await db.delete(accounts).where(inArray(accounts.tenantId, tids));
  await db.delete(userTenantAccess).where(inArray(userTenantAccess.tenantId, tids));
  await db.delete(users).where(inArray(users.tenantId, tids));
  await db.delete(tenants).where(inArray(tenants.id, tids));
  tenantA = ''; tenantB = ''; outsiderTenant = ''; userId = ''; outsiderUserId = '';
}

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function mkTenant(name: string) {
  const [t] = await db.insert(tenants).values({ name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${uniq()}` }).returning();
  return t!.id;
}

async function mkUser(tenantId: string, email: string) {
  const [u] = await db.insert(users).values({
    tenantId, email, passwordHash: 'x', displayName: 'Test User',
  }).returning();
  return u!.id;
}

async function grant(uid: string, tenantId: string, isActive = true) {
  await db.insert(userTenantAccess).values({ userId: uid, tenantId, role: 'accountant', isActive });
}

/** A bank connection to hang feed items off — bank_connection_id is NOT NULL. */
async function mkConnection(tenantId: string) {
  const [acct] = await db.insert(accounts).values({
    tenantId, name: 'Checking', accountType: 'asset', detailType: 'checking', accountNumber: '1000', balance: '0',
  }).returning();
  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: acct!.id, institutionName: 'Test Bank',
  }).returning();
  return conn!.id;
}

async function mkFeedItem(tenantId: string, connectionId: string, status: string) {
  await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: connectionId, feedDate: '2026-08-01',
    description: 'Test txn', amount: '10.0000', status,
  });
}

/** A Plaid item mapped into `tenantId`. Items are appliance-global; the tenant
 *  link is the mapping row, so every fixture has to build the whole chain. */
async function mkPlaidItem(tenantId: string, opts: {
  lastSyncAt: Date | null;
  lastSyncStatus?: string;
  itemStatus?: string;
  removed?: boolean;
  syncEnabled?: boolean;
}) {
  const [item] = await db.insert(plaidItems).values({
    plaidItemId: `item-${uniq()}`,
    accessTokenEncrypted: 'enc',
    institutionName: 'Test Institution',
    lastSyncAt: opts.lastSyncAt,
    lastSyncStatus: opts.lastSyncStatus ?? 'success',
    itemStatus: opts.itemStatus ?? 'active',
    removedAt: opts.removed ? new Date() : null,
  }).returning();
  createdPlaidItemIds.push(item!.id);

  const [pa] = await db.insert(plaidAccounts).values({
    plaidItemId: item!.id, plaidAccountId: `acct-${uniq()}`, name: 'Checking',
  }).returning();

  const [mapped] = await db.insert(accounts).values({
    tenantId, name: `Mapped ${uniq()}`, accountType: 'asset', detailType: 'checking', balance: '0',
  }).returning();

  await db.insert(plaidAccountMappings).values({
    plaidAccountId: pa!.id, tenantId, mappedAccountId: mapped!.id,
    isSyncEnabled: opts.syncEnabled ?? true, mappedBy: userId,
  });
  return item!.id;
}

const rowFor = (rows: Awaited<ReturnType<typeof service.getForUser>>, tenantId: string) =>
  rows.find((r) => r.tenantId === tenantId);

beforeEach(async () => {
  await cleanup();
  tenantA = await mkTenant('Client A');
  tenantB = await mkTenant('Client B');
  outsiderTenant = await mkTenant('Someone Elses Client');
  userId = await mkUser(tenantA, `staff-${uniq()}@example.com`);
  outsiderUserId = await mkUser(outsiderTenant, `outsider-${uniq()}@example.com`);
  await grant(userId, tenantA);
  await grant(userId, tenantB);
  await grant(outsiderUserId, outsiderTenant);
});
afterEach(cleanup);

describe('getForUser — scope', () => {
  it('returns one row per accessible tenant and nothing else', async () => {
    const rows = await service.getForUser(userId);
    expect(rows.map((r) => r.tenantId).sort()).toEqual([tenantA, tenantB].sort());
  });

  it('never reports a tenant the caller has no access row for', async () => {
    // The outsider's tenant has real work in it — the only thing keeping it
    // out of the result is the user_tenant_access join.
    const conn = await mkConnection(outsiderTenant);
    await mkFeedItem(outsiderTenant, conn, 'pending');

    const rows = await service.getForUser(userId);
    expect(rowFor(rows, outsiderTenant)).toBeUndefined();
  });

  it('drops a tenant whose access row was deactivated', async () => {
    await db.update(userTenantAccess)
      .set({ isActive: false })
      .where(eq(userTenantAccess.tenantId, tenantB));

    const rows = await service.getForUser(userId);
    expect(rowFor(rows, tenantB)).toBeUndefined();
    expect(rowFor(rows, tenantA)).toBeDefined();
  });
});

describe('getForUser — unprocessed bank transactions', () => {
  it('counts pending and assigned, ignoring items already handled', async () => {
    const conn = await mkConnection(tenantA);
    await mkFeedItem(tenantA, conn, 'pending');
    await mkFeedItem(tenantA, conn, 'pending');
    // 'assigned' has a category staged but is NOT posted — still work to do,
    // and it is what the Bank Feed shows with "Hide processed" on.
    await mkFeedItem(tenantA, conn, 'assigned');
    await mkFeedItem(tenantA, conn, 'categorized');
    await mkFeedItem(tenantA, conn, 'matched');
    await mkFeedItem(tenantA, conn, 'excluded');

    const rows = await service.getForUser(userId);
    expect(rowFor(rows, tenantA)!.unprocessedBankTxns).toBe(3);
  });

  it("counts an item stranded mid-post, the way the Bank Feed still lists it", async () => {
    // categorize()/approve() claim a row into 'categorizing' before posting and
    // only revert on a caught error, so a crash or redeploy can strand one.
    // The Bank Feed's filter is an exclusion, so it still shows — an IN-list of
    // the states we expect would report this client as clean.
    const conn = await mkConnection(tenantA);
    await mkFeedItem(tenantA, conn, 'categorizing');

    const rows = await service.getForUser(userId);
    expect(rowFor(rows, tenantA)!.unprocessedBankTxns).toBe(1);
  });

  it('reports zero rather than omitting a client with an empty feed', async () => {
    const rows = await service.getForUser(userId);
    expect(rowFor(rows, tenantB)!.unprocessedBankTxns).toBe(0);
  });

  it("does not mix one client's backlog into another's", async () => {
    const connA = await mkConnection(tenantA);
    const connB = await mkConnection(tenantB);
    await mkFeedItem(tenantA, connA, 'pending');
    await mkFeedItem(tenantB, connB, 'pending');
    await mkFeedItem(tenantB, connB, 'pending');

    const rows = await service.getForUser(userId);
    expect(rowFor(rows, tenantA)!.unprocessedBankTxns).toBe(1);
    expect(rowFor(rows, tenantB)!.unprocessedBankTxns).toBe(2);
  });
});

describe('getForUser — Plaid sync', () => {
  it('reports the most recent sync across a client with several connections', async () => {
    const older = new Date('2026-08-20T10:00:00Z');
    const newer = new Date('2026-08-25T10:00:00Z');
    await mkPlaidItem(tenantA, { lastSyncAt: older });
    await mkPlaidItem(tenantA, { lastSyncAt: newer });

    const row = rowFor(await service.getForUser(userId), tenantA)!;
    expect(row.lastPlaidSyncAt).toBe(newer.toISOString());
    expect(row.plaidConnectionCount).toBe(2);
  });

  it('reports no connection at all when the client has none', async () => {
    const row = rowFor(await service.getForUser(userId), tenantA)!;
    expect(row.lastPlaidSyncAt).toBeNull();
    expect(row.plaidConnectionCount).toBe(0);
    expect(row.plaidNeedsAttention).toBe(false);
  });

  it('ignores removed and sync-disabled items so they cannot skew the time', async () => {
    const real = new Date('2026-08-20T10:00:00Z');
    const bogusRecent = new Date('2026-08-26T10:00:00Z');
    await mkPlaidItem(tenantA, { lastSyncAt: real });
    await mkPlaidItem(tenantA, { lastSyncAt: bogusRecent, removed: true });
    await mkPlaidItem(tenantA, { lastSyncAt: bogusRecent, syncEnabled: false });

    const row = rowFor(await service.getForUser(userId), tenantA)!;
    expect(row.lastPlaidSyncAt).toBe(real.toISOString());
    expect(row.plaidConnectionCount).toBe(1);
  });

  it('flags a login-required connection even while its last sync says success', async () => {
    // The real prod case: item_status flips to login_required but
    // last_sync_status is still 'success' from the last poll that worked, so
    // checking last_sync_status alone would call a broken feed healthy.
    await mkPlaidItem(tenantA, {
      lastSyncAt: new Date('2026-08-25T10:00:00Z'),
      lastSyncStatus: 'success',
      itemStatus: 'login_required',
    });

    expect(rowFor(await service.getForUser(userId), tenantA)!.plaidNeedsAttention).toBe(true);
  });

  it('flags a revoked connection, which no status allowlist would catch', async () => {
    // USER_PERMISSION_REVOKED sets item_status='revoked' and leaves removed_at
    // NULL, so the item is still counted here. Anything but 'active' has to
    // read as trouble, or a client who pulled consent looks perfectly healthy.
    await mkPlaidItem(tenantA, {
      lastSyncAt: new Date('2026-08-25T10:00:00Z'),
      lastSyncStatus: 'success',
      itemStatus: 'revoked',
    });

    expect(rowFor(await service.getForUser(userId), tenantA)!.plaidNeedsAttention).toBe(true);
  });

  it('flags an errored sync', async () => {
    await mkPlaidItem(tenantA, { lastSyncAt: new Date(), lastSyncStatus: 'error' });
    expect(rowFor(await service.getForUser(userId), tenantA)!.plaidNeedsAttention).toBe(true);
  });

  it('leaves a healthy client unflagged', async () => {
    await mkPlaidItem(tenantA, { lastSyncAt: new Date(), lastSyncStatus: 'success', itemStatus: 'active' });
    expect(rowFor(await service.getForUser(userId), tenantA)!.plaidNeedsAttention).toBe(false);
  });
});
