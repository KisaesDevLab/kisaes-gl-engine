// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// A bank feed must not be mapped into a system account.
//
// The detail-type check that already existed was not enough. Payments Clearing
// is seeded as other_current_asset, but on two tenants it had drifted to
// 'bank', which made it look like an ordinary bank account in the picker — and
// a live client feed was wired to it. cash_on_hand is the one system role that
// IS the right destination, and 14 healthy connections use it, so the rule has
// to permit exactly that one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, users, userTenantAccess,
  plaidItems, plaidAccounts, plaidAccountMappings,
} from '../db/schema/index.js';
import { assignAccountToCompany } from './plaid-mapping.service.js';

let tenantId = '';
let userId = '';
let companyId = '';
let plaidAcctId = '';
let plaidItemRowId = '';

const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

async function mkAccount(name: string, detailType: string, systemTag: string | null) {
  const [a] = await db.insert(accounts).values({
    tenantId, companyId, name, accountType: 'asset', detailType,
    isSystem: systemTag !== null, systemTag,
  }).returning();
  return a!.id;
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Sys Map', slug: 'sm-' + suffix() }).returning();
  tenantId = t!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `sm-${suffix()}@example.com`, passwordHash: 'x', displayName: 'SM',
  }).returning();
  userId = u!.id;
  await db.insert(userTenantAccess).values({ userId, tenantId, role: 'owner' });
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'SM Co' }).returning();
  companyId = c!.id;

  const [item] = await db.insert(plaidItems).values({
    plaidItemId: 'item-' + suffix(), plaidInstitutionId: 'ins_x',
    institutionName: 'Test Bank', accessTokenEncrypted: 'x', createdBy: userId,
  }).returning();
  plaidItemRowId = item!.id;
  const [acct] = await db.insert(plaidAccounts).values({
    plaidItemId: item!.id, plaidAccountId: 'acct-' + suffix(),
    name: 'CHECKING', accountType: 'depository', accountSubtype: 'checking', mask: '1234',
  }).returning();
  plaidAcctId = acct!.id;
});

afterEach(async () => {
  if (!tenantId) return;
  await db.delete(plaidAccountMappings).where(eq(plaidAccountMappings.tenantId, tenantId));
  await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, plaidItemRowId));
  await db.delete(plaidItems).where(eq(plaidItems.id, plaidItemRowId));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
});

describe('assignAccountToCompany — system account guard', () => {
  it('refuses Payments Clearing even when its detail_type says bank', async () => {
    // Exactly the drifted shape found on two production tenants.
    const clearing = await mkAccount('Payments Clearing', 'bank', 'payments_clearing');
    await expect(
      assignAccountToCompany(plaidAcctId, tenantId, clearing, null, userId),
    ).rejects.toThrow(/system account/i);
  });

  it('refuses the suspense account', async () => {
    const suspense = await mkAccount('Uncategorized', 'other_current_asset', 'suspense');
    await expect(
      assignAccountToCompany(plaidAcctId, tenantId, suspense, null, userId),
    ).rejects.toThrow(/system account/i);
  });

  it('allows the real bank account, which carries cash_on_hand', async () => {
    const cash = await mkAccount('Cash - Checking', 'bank', 'cash_on_hand');
    const result = await assignAccountToCompany(plaidAcctId, tenantId, cash, null, userId);
    expect(result).toBeTruthy();

    const [mapping] = await db.select().from(plaidAccountMappings)
      .where(eq(plaidAccountMappings.tenantId, tenantId));
    expect(mapping!.mappedAccountId).toBe(cash);
  });

  it('allows an ordinary untagged bank account', async () => {
    const plain = await mkAccount('Operating Checking', 'bank', null);
    const result = await assignAccountToCompany(plaidAcctId, tenantId, plain, null, userId);
    expect(result).toBeTruthy();
  });
});

// "This bank account is already assigned to a company. Unmap it first." was
// the whole message, and a user looking at an empty ledger account read it as
// plainly wrong — the thing already assigned is the BANK account. When the
// mapping belonged to another tenant the instruction was impossible to follow
// as well, since there was nothing here to unmap.
describe('assignAccountToCompany — already-mapped message', () => {
  it('names the account the bank already feeds', async () => {
    const first = await mkAccount('Cash - Checking', 'bank', 'cash_on_hand');
    await assignAccountToCompany(plaidAcctId, tenantId, first, null, userId);

    const second = await mkAccount('Second Checking', 'bank', null);
    await expect(
      assignAccountToCompany(plaidAcctId, tenantId, second, null, userId),
    ).rejects.toThrow(/already feeds "Cash - Checking"/);
  });

  it('sends a non-super-admin to the Plaid monitor for a shared connection', async () => {
    // A mapping owned by another tenant is caught by the share guard EARLIER
    // in this function, which is the better message of the two because it says
    // where to go. The branch below it only ever runs for a super-admin, who
    // skips that guard. Asserted so nobody "simplifies" the earlier guard away
    // and silently changes what a normal user sees.
    const [otherTenant] = await db.insert(tenants).values({
      name: 'Other Client', slug: 'oc-' + suffix(),
    }).returning();
    const [otherCompany] = await db.insert(companies).values({
      tenantId: otherTenant!.id, businessName: 'OC',
    }).returning();
    const [otherAcct] = await db.insert(accounts).values({
      tenantId: otherTenant!.id, companyId: otherCompany!.id,
      name: 'Their Checking', accountType: 'asset', detailType: 'bank',
    }).returning();
    await db.insert(plaidAccountMappings).values({
      plaidAccountId: plaidAcctId,
      tenantId: otherTenant!.id,
      mappedAccountId: otherAcct!.id,
      mappedBy: userId,
    });

    const mine = await mkAccount('Cash - Checking', 'bank', 'cash_on_hand');
    await expect(
      assignAccountToCompany(plaidAcctId, tenantId, mine, null, userId),
    ).rejects.toThrow(/shared with another client/);
    // Never names whose.
    await expect(
      assignAccountToCompany(plaidAcctId, tenantId, mine, null, userId),
    ).rejects.not.toThrow(/Their Checking|Other Client/);

    await db.delete(plaidAccountMappings).where(eq(plaidAccountMappings.tenantId, otherTenant!.id));
    await db.delete(accounts).where(eq(accounts.tenantId, otherTenant!.id));
    await db.delete(companies).where(eq(companies.tenantId, otherTenant!.id));
    await db.delete(tenants).where(eq(tenants.id, otherTenant!.id));
  });
});
