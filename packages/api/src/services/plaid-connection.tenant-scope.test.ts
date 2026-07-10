// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// getItemsForUser(userId, scopeTenantId) must show only the ACTIVE client's
// Plaid items — accounts mapped to that tenant, plus the item's unassigned
// accounts when the item is already used there. An item belonging entirely to
// another client (even one the user can access) must not appear, and its
// unassigned accounts must not bleed into this client's Bank Connections page.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, userTenantAccess, accounts, plaidItems, plaidAccounts, plaidAccountMappings } from '../db/schema/index.js';
import { getItemsForUser } from './plaid-connection.service.js';

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

  it('a teammate of the connecting user CAN see their unmapped item (mapping handoff)', async () => {
    // Colleague in tenant A (shares a tenant with the creator).
    const [mate] = await db.insert(users).values({
      tenantId: tenantA, email: `mate-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role: 'accountant', displayName: 'Mate',
    }).returning();
    await db.insert(userTenantAccess).values({ userId: mate!.id, tenantId: tenantA, role: 'accountant', isActive: true });

    const item3 = await seedItem('Fresh Bank');
    await seedPlaidAccount(item3, 'f1');

    const items = await getItemsForUser(mate!.id);
    const fresh = items.find((i) => i.institutionName === 'Fresh Bank');
    expect(fresh).toBeDefined();
    expect(acctNames(fresh!)).toEqual(['f1']);

    await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, item3));
    await db.delete(plaidItems).where(eq(plaidItems.id, item3));
    await db.delete(userTenantAccess).where(eq(userTenantAccess.userId, mate!.id));
    await db.delete(users).where(eq(users.id, mate!.id));
  });
});
