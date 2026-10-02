// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// getItemsForUser(userId, scopeTenantId) must show only the ACTIVE client's
// Plaid items — accounts mapped to that tenant, plus the item's unassigned
// accounts when the item is already used there. An item belonging entirely to
// another client (even one the user can access) must not appear, and its
// unassigned accounts must not bleed into this client's Bank Connections page.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, userTenantAccess, accounts, plaidItems, plaidAccounts, plaidAccountMappings, plaidItemActivity, bankConnectInvites } from '../db/schema/index.js';
import { getItemsForUser, getItemHomeTenants } from './plaid-connection.service.js';

const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let tenantA = '', tenantB = '', userId = '';
let acctA = '', acctB = '', acctB2 = '';
let item1 = '', item2 = '';

async function seedTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({ name, slug: `${name}-${sfx()}` }).returning();
  return t!.id;
}
async function seedGlAccount(tenantId: string): Promise<string> {
  const [a] = await db.insert(accounts).values({ tenantId, name: 'Bank', accountType: 'asset' }).returning();
  return a!.id;
}
async function seedItem(name: string): Promise<string> {
  const [i] = await db.insert(plaidItems).values({
    plaidItemId: `pi-${sfx()}`, institutionName: name, accessTokenEncrypted: 'enc', createdBy: userId,
  }).returning();
  return i!.id;
}
async function seedPlaidAccount(itemId: string, label: string): Promise<string> {
  const [a] = await db.insert(plaidAccounts).values({
    plaidItemId: itemId, plaidAccountId: `pa-${label}-${sfx()}`, name: label, isActive: true,
  }).returning();
  return a!.id;
}
// Record the client an item was connected FOR (what createConnection now
// writes on its item_created activity).
async function connectedFor(itemId: string, tenantId: string) {
  await db.insert(plaidItemActivity).values({ plaidItemId: itemId, tenantId, action: 'item_created', performedBy: userId });
}
async function dropItem(itemId: string) {
  await db.delete(plaidItemActivity).where(eq(plaidItemActivity.plaidItemId, itemId));
  await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, itemId));
  await db.delete(plaidItems).where(eq(plaidItems.id, itemId));
}
async function map(plaidAccountId: string, tenantId: string, mappedAccountId: string) {
  await db.insert(plaidAccountMappings).values({ plaidAccountId, tenantId, mappedAccountId, mappedBy: userId });
}

async function cleanDb() {
  const itemIds = [item1, item2].filter(Boolean);
  if (itemIds.length) {
    const pas = await db.select({ id: plaidAccounts.id }).from(plaidAccounts).where(inArray(plaidAccounts.plaidItemId, itemIds));
    const paIds = pas.map((p) => p.id);
    if (paIds.length) await db.delete(plaidAccountMappings).where(inArray(plaidAccountMappings.plaidAccountId, paIds));
    await db.delete(plaidAccounts).where(inArray(plaidAccounts.plaidItemId, itemIds));
    await db.delete(plaidItems).where(inArray(plaidItems.id, itemIds));
  }
  if (userId) await db.delete(userTenantAccess).where(eq(userTenantAccess.userId, userId));
  const tids = [tenantA, tenantB].filter(Boolean);
  if (tids.length) await db.delete(accounts).where(inArray(accounts.tenantId, tids));
  if (userId) await db.delete(users).where(eq(users.id, userId));
  if (tids.length) await db.delete(tenants).where(inArray(tenants.id, tids));
  tenantA = tenantB = userId = acctA = acctB = item1 = item2 = '';
}

async function setup() {
  tenantA = await seedTenant('client-a');
  tenantB = await seedTenant('client-b');
  const [u] = await db.insert(users).values({
    tenantId: tenantA, email: `u-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role: 'accountant', displayName: 'U',
  }).returning();
  userId = u!.id;
  // The user can access BOTH clients.
  await db.insert(userTenantAccess).values([
    { userId, tenantId: tenantA, role: 'owner', isActive: true },
    { userId, tenantId: tenantB, role: 'accountant', isActive: true },
  ]);
  acctA = await seedGlAccount(tenantA);
  acctB = await seedGlAccount(tenantB);
  acctB2 = await seedGlAccount(tenantB); // distinct GL account (tenant_id, mapped_account_id) is unique

  // Shared item: a1→A, a2→B, a3 unassigned.
  item1 = await seedItem('U.S. Bank');
  const a1 = await seedPlaidAccount(item1, 'a1');
  const a2 = await seedPlaidAccount(item1, 'a2');
  await seedPlaidAccount(item1, 'a3'); // unassigned
  await map(a1, tenantA, acctA);
  await map(a2, tenantB, acctB);

  // Other client's item: b1→B, b2 unassigned. Nothing mapped to A.
  item2 = await seedItem('Other Bank');
  const b1 = await seedPlaidAccount(item2, 'b1');
  await seedPlaidAccount(item2, 'b2'); // unassigned
  await map(b1, tenantB, acctB2);
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

const names = (items: Awaited<ReturnType<typeof getItemsForUser>>) => items.map((i) => i.institutionName).sort();
const acctNames = (item: { accounts: Array<{ name: string | null }> }) => item.accounts.map((a) => a.name).sort();

describe('getItemsForUser tenant scoping', () => {
  it('does not surface a cross-tenant item’s unassigned accounts to client A', async () => {
    const items = await getItemsForUser(userId, tenantA);
    expect(names(items)).toEqual(['U.S. Bank']); // Other Bank (client B only) is hidden

    const us = items.find((i) => i.institutionName === 'U.S. Bank')!;
    // SECURITY: the U.S. Bank item also carries a mapping owned by tenant B
    // (a2→B), so it spans two clients. a2 (mapped to B) AND a3 (unassigned)
    // are both hidden — an unassigned account on a multi-tenant item can't be
    // safely attributed to A, so it must not appear as mappable here.
    expect(acctNames(us)).toEqual(['a1']);
    expect(us.hiddenAccountCount).toBe(2);
  });

  it('client B sees only its mapped account on the shared item; its own item stays whole', async () => {
    const items = await getItemsForUser(userId, tenantB);
    expect(names(items)).toEqual(['Other Bank', 'U.S. Bank']);
    // U.S. Bank is shared with A (a1→A) → its unassigned a3 is hidden from B too.
    expect(acctNames(items.find((i) => i.institutionName === 'U.S. Bank')!)).toEqual(['a2']);
    // Other Bank belongs to B alone → its unassigned b2 remains mappable.
    expect(acctNames(items.find((i) => i.institutionName === 'Other Bank')!)).toEqual(['b1', 'b2']);
  });

  it('another client’s unassigned accounts never bleed into this client', async () => {
    const items = await getItemsForUser(userId, tenantA);
    // Other Bank's b2 (unassigned) must not appear anywhere in client A's view.
    expect(items.some((i) => i.institutionName === 'Other Bank')).toBe(false);
    expect(items.flatMap((i) => i.accounts.map((a) => a.name))).not.toContain('b2');
  });

  it('unscoped (user-wide) view still returns everything the user can access', async () => {
    const items = await getItemsForUser(userId);
    expect(names(items)).toEqual(['Other Bank', 'U.S. Bank']);
    expect(acctNames(items.find((i) => i.institutionName === 'U.S. Bank')!)).toEqual(['a1', 'a2', 'a3']);
  });

  it('a foreign user sees NOTHING of another tenant\'s items in the user-wide view (SECURITY)', async () => {
    // Outsider: belongs only to a fresh tenant C — no access to A or B, did
    // not create any item.
    const tenantC = await seedTenant('client-c');
    const [outsider] = await db.insert(users).values({
      tenantId: tenantC, email: `out-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role: 'owner', displayName: 'Out',
    }).returning();
    await db.insert(userTenantAccess).values({ userId: outsider!.id, tenantId: tenantC, role: 'owner', isActive: true });

    // A fully UNMAPPED item created by the A/B user — previously its
    // unassigned accounts were visible to EVERY user system-wide.
    const item3 = await seedItem('Fresh Bank');
    await seedPlaidAccount(item3, 'f1');

    const items = await getItemsForUser(outsider!.id);
    // No mapped access, not the creator, shares no tenant with the creator:
    // the outsider sees no items at all — not the partially-mapped U.S. Bank,
    // not Other Bank, and not the fresh unmapped connection.
    expect(items).toHaveLength(0);

    // Cleanup the extra rows this test created.
    await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, item3));
    await db.delete(plaidItems).where(eq(plaidItems.id, item3));
    await db.delete(userTenantAccess).where(eq(userTenantAccess.userId, outsider!.id));
    await db.delete(users).where(eq(users.id, outsider!.id));
    await db.delete(tenants).where(eq(tenants.id, tenantC));
  });

  it('a teammate in the client the bank was connected for CAN see the unmapped item (mapping handoff)', async () => {
    // Colleague in tenant A — the client the item was connected for.
    const [mate] = await db.insert(users).values({
      tenantId: tenantA, email: `mate-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role: 'accountant', displayName: 'Mate',
    }).returning();
    await db.insert(userTenantAccess).values({ userId: mate!.id, tenantId: tenantA, role: 'accountant', isActive: true });

    const item3 = await seedItem('Fresh Bank');
    await seedPlaidAccount(item3, 'f1');
    await connectedFor(item3, tenantA);
    // Connected for tenant B: tenant A's teammate must NOT see it, even
    // though the creator administers both (2026-10-02 incident).
    const item4 = await seedItem('B Fresh Bank');
    await seedPlaidAccount(item4, 'g1');
    await connectedFor(item4, tenantB);

    const items = await getItemsForUser(mate!.id);
    const fresh = items.find((i) => i.institutionName === 'Fresh Bank');
    expect(fresh).toBeDefined();
    expect(acctNames(fresh!)).toEqual(['f1']);
    expect(items.some((i) => i.institutionName === 'B Fresh Bank')).toBe(false);

    await dropItem(item3);
    await dropItem(item4);
    await db.delete(userTenantAccess).where(eq(userTenantAccess.userId, mate!.id));
    await db.delete(users).where(eq(users.id, mate!.id));
  });

  it('a fully unmapped item IS mappable from the creator\'s tenant-scoped Bank Connections (invite handoff)', async () => {
    // Regression: a client-invite connection is attributed to the inviting
    // user but starts with ZERO mappings. Tenant-scoped visibility required
    // the item to already be used by the tenant, so it appeared nowhere and
    // could never be mapped.
    const item3 = await seedItem('Fresh Bank');
    await seedPlaidAccount(item3, 'f1');
    await connectedFor(item3, tenantA);

    const itemsA = await getItemsForUser(userId, tenantA);
    const fresh = itemsA.find((i) => i.institutionName === 'Fresh Bank');
    expect(fresh).toBeDefined();
    expect(acctNames(fresh!)).toEqual(['f1']); // unassigned account is offered for mapping

    // SECURITY (2026-10-02 incident): NOT in the creator's other clients.
    // It used to show in every tenant the creator administers — for a firm
    // admin, every client's Bank Connections.
    const itemsB = await getItemsForUser(userId, tenantB);
    expect(itemsB.some((i) => i.institutionName === 'Fresh Bank')).toBe(false);

    await dropItem(item3);
  });

  it('an invite-created item is attributed to the invite\'s client', async () => {
    const item3 = await seedItem('Invite Bank');
    await seedPlaidAccount(item3, 'v1');
    const [inv] = await db.insert(bankConnectInvites).values({
      tenantId: tenantB, recipientName: 'Client', recipientEmail: 'c@example.com', tokenHash: 'h'.repeat(64),
      sentVia: 'email', expiresAt: new Date(Date.now() + 86400000), createdBy: userId,
      status: 'connected', connectedPlaidItemId: item3,
    }).returning();

    expect(await getItemHomeTenants(item3)).toEqual([tenantB]);
    expect((await getItemsForUser(userId, tenantB)).some((i) => i.institutionName === 'Invite Bank')).toBe(true);
    expect((await getItemsForUser(userId, tenantA)).some((i) => i.institutionName === 'Invite Bank')).toBe(false);

    await db.delete(bankConnectInvites).where(eq(bankConnectInvites.id, inv!.id));
    await dropItem(item3);
  });

  it('an unattributed unmapped item shows in no client screen (only the creator\'s user-wide view)', async () => {
    const item3 = await seedItem('Orphan Bank');
    await seedPlaidAccount(item3, 'o1');
    expect((await getItemsForUser(userId, tenantA)).some((i) => i.institutionName === 'Orphan Bank')).toBe(false);
    expect((await getItemsForUser(userId, tenantB)).some((i) => i.institutionName === 'Orphan Bank')).toBe(false);
    expect((await getItemsForUser(userId)).some((i) => i.institutionName === 'Orphan Bank')).toBe(true);
    await dropItem(item3);
  });

  it('a fully unmapped FOREIGN item stays hidden from tenant-scoped views (SECURITY)', async () => {
    // Creator belongs only to tenant C; their fresh item must not surface in
    // tenant A's or B's Bank Connections even for a user who could see the
    // page — the carve-out is limited to tenants the CREATOR administers.
    const tenantC = await seedTenant('client-c');
    const [stranger] = await db.insert(users).values({
      tenantId: tenantC, email: `str-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role: 'owner', displayName: 'Str',
    }).returning();
    await db.insert(userTenantAccess).values({ userId: stranger!.id, tenantId: tenantC, role: 'owner', isActive: true });
    const [i] = await db.insert(plaidItems).values({
      plaidItemId: `pi-${sfx()}`, institutionName: 'Stranger Bank', accessTokenEncrypted: 'enc', createdBy: stranger!.id,
    }).returning();
    await seedPlaidAccount(i!.id, 's1');

    const itemsA = await getItemsForUser(userId, tenantA);
    expect(itemsA.some((it) => it.institutionName === 'Stranger Bank')).toBe(false);
    const itemsB = await getItemsForUser(userId, tenantB);
    expect(itemsB.some((it) => it.institutionName === 'Stranger Bank')).toBe(false);

    await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, i!.id));
    await db.delete(plaidItems).where(eq(plaidItems.id, i!.id));
    await db.delete(userTenantAccess).where(eq(userTenantAccess.userId, stranger!.id));
    await db.delete(users).where(eq(users.id, stranger!.id));
    await db.delete(tenants).where(eq(tenants.id, tenantC));
  });
});
