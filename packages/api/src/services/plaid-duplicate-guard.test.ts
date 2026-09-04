// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Blocking a re-link of a bank account the tenant already syncs.
//
// The case that made this necessary: a client re-linked the same bank, Plaid
// minted a new item id (it always does), every existing uniqueness check keyed
// on that id said "new", and 513 duplicate transactions arrived.
//
// So the assertions that matter are about what does NOT match as much as what
// does. A false block is worse than a missed one — it stops a firm connecting
// a genuinely different account.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, users, userTenantAccess,
  plaidItems, plaidAccounts, plaidAccountMappings,
} from '../db/schema/index.js';
import { findAccountAlreadyConnectedInTenant } from './plaid-connection.service.js';

const INSTITUTION = 'ins_test_freedom';

let tenantId = '';
let otherTenantId = '';
let userId = '';
let companyId = '';
let glAccountId = '';
let itemId = '';

const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

async function seedItem(tenant: string, opts: {
  persistent?: string | null; mask?: string; subtype?: string; institution?: string;
  mapped?: boolean; removed?: boolean;
}) {
  const [item] = await db.insert(plaidItems).values({
    plaidItemId: 'item-' + suffix(),
    plaidInstitutionId: opts.institution ?? INSTITUTION,
    institutionName: 'Freedom Bank of Southern Missouri',
    accessTokenEncrypted: 'x',
    createdBy: userId,
    removedAt: opts.removed ? new Date() : null,
  }).returning();

  const [acct] = await db.insert(plaidAccounts).values({
    plaidItemId: item!.id,
    plaidAccountId: 'acct-' + suffix(),
    persistentAccountId: opts.persistent ?? null,
    name: 'SMALL BUSINESS',
    accountType: 'depository',
    accountSubtype: opts.subtype ?? 'checking',
    mask: opts.mask ?? '6611',
  }).returning();

  if (opts.mapped) {
    await db.insert(plaidAccountMappings).values({
      plaidAccountId: acct!.id,
      tenantId: tenant,
      mappedAccountId: glAccountId,
      mappedBy: userId,
    });
  }
  return { itemRowId: item!.id, acctRowId: acct!.id };
}

/** What Plaid's /accounts/get returns for the account being linked now. */
const incoming = (o: { persistent?: string | null; mask?: string | null; subtype?: string | null }) => ([{
  persistent_account_id: o.persistent ?? null,
  mask: o.mask === undefined ? '6611' : o.mask,
  subtype: o.subtype === undefined ? 'checking' : o.subtype,
}]);

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Dup Guard', slug: 'dg-' + suffix() }).returning();
  tenantId = t!.id;
  const [t2] = await db.insert(tenants).values({ name: 'Dup Guard Other', slug: 'dgo-' + suffix() }).returning();
  otherTenantId = t2!.id;

  const [u] = await db.insert(users).values({
    tenantId, email: `dg-${suffix()}@example.com`, passwordHash: 'x', displayName: 'DG',
  }).returning();
  userId = u!.id;
  await db.insert(userTenantAccess).values({ userId, tenantId, role: 'owner' });

  const [c] = await db.insert(companies).values({ tenantId, businessName: 'DG Co' }).returning();
  companyId = c!.id;
  const [a] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Cash - Checking', accountType: 'asset', detailType: 'bank',
  }).returning();
  glAccountId = a!.id;
  itemId = '';
});

afterEach(async () => {
  for (const t of [tenantId, otherTenantId].filter(Boolean)) {
    const items = await db.select({ id: plaidItems.id }).from(plaidItems);
    for (const it of items) {
      const accts = await db.select({ id: plaidAccounts.id }).from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, it.id));
      for (const ac of accts) await db.delete(plaidAccountMappings).where(eq(plaidAccountMappings.plaidAccountId, ac.id));
    }
    await db.delete(plaidAccountMappings).where(eq(plaidAccountMappings.tenantId, t));
  }
  const allItems = await db.select({ id: plaidItems.id, createdBy: plaidItems.createdBy }).from(plaidItems);
  for (const it of allItems) {
    if (it.createdBy === userId) {
      await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, it.id));
      await db.delete(plaidItems).where(eq(plaidItems.id, it.id));
    }
  }
  for (const t of [tenantId, otherTenantId].filter(Boolean)) {
    await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, t));
    await db.delete(accounts).where(eq(accounts.tenantId, t));
    await db.delete(companies).where(eq(companies.tenantId, t));
    await db.delete(users).where(eq(users.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
  tenantId = ''; otherTenantId = '';
});

describe('findAccountAlreadyConnectedInTenant', () => {
  it('catches a re-link by persistent_account_id, the only stable key', async () => {
    await seedItem(tenantId, { persistent: 'PERSIST-1', mapped: true });
    // A fresh Link: different item id, different account id, same real account.
    const hit = await findAccountAlreadyConnectedInTenant(
      tenantId, INSTITUTION, incoming({ persistent: 'PERSIST-1' }),
    );
    expect(hit).not.toBeNull();
    expect(hit!.matchedOn).toBe('persistent_account_id');
    expect(hit!.mappedAccountName).toBe('Cash - Checking');
  });

  it('falls back to institution + mask + subtype when Plaid omits the persistent id', async () => {
    // Three quarters of accounts in this install have no persistent id, so
    // the fallback is the path that actually runs most of the time.
    await seedItem(tenantId, { persistent: null, mask: '6611', subtype: 'checking', mapped: true });
    const hit = await findAccountAlreadyConnectedInTenant(
      tenantId, INSTITUTION, incoming({ persistent: null, mask: '6611', subtype: 'checking' }),
    );
    expect(hit).not.toBeNull();
    expect(hit!.matchedOn).toBe('institution_mask_subtype');
    expect(hit!.mask).toBe('6611');
  });

  it('catches a duplicate that was never mapped', async () => {
    // The cross-tenant detector requires a mapping and would miss this.
    await seedItem(tenantId, { persistent: 'PERSIST-2', mapped: false });
    const hit = await findAccountAlreadyConnectedInTenant(
      tenantId, INSTITUTION, incoming({ persistent: 'PERSIST-2' }),
    );
    expect(hit).not.toBeNull();
    expect(hit!.mappedAccountName).toBeNull();
  });

  it('allows a DIFFERENT account at the same bank', async () => {
    // Two logins at one institution is legitimate and must stay frictionless.
    await seedItem(tenantId, { persistent: null, mask: '6611', mapped: true });
    const hit = await findAccountAlreadyConnectedInTenant(
      tenantId, INSTITUTION, incoming({ persistent: null, mask: '9999' }),
    );
    expect(hit).toBeNull();
  });

  it('allows the same mask at a DIFFERENT bank', async () => {
    await seedItem(tenantId, { persistent: null, mask: '6611', mapped: true });
    const hit = await findAccountAlreadyConnectedInTenant(
      tenantId, 'ins_someone_else', incoming({ persistent: null, mask: '6611' }),
    );
    expect(hit).toBeNull();
  });

  it('ignores an item the user removed', async () => {
    // Removing the old connection is exactly how you legitimately re-link.
    await seedItem(tenantId, { persistent: 'PERSIST-3', mapped: false, removed: true });
    const hit = await findAccountAlreadyConnectedInTenant(
      tenantId, INSTITUTION, incoming({ persistent: 'PERSIST-3' }),
    );
    expect(hit).toBeNull();
  });

  it('does not reach into another tenant', async () => {
    await seedItem(tenantId, { persistent: 'PERSIST-4', mapped: true });
    const hit = await findAccountAlreadyConnectedInTenant(
      otherTenantId, INSTITUTION, incoming({ persistent: 'PERSIST-4' }),
    );
    expect(hit).toBeNull();
  });

  it('does not guess when there is no usable key', async () => {
    await seedItem(tenantId, { persistent: null, mask: '6611', mapped: true });
    const hit = await findAccountAlreadyConnectedInTenant(
      tenantId, INSTITUTION, incoming({ persistent: null, mask: null, subtype: null }),
    );
    expect(hit).toBeNull();
  });
});
