// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Regression: deleteTenant's dynamic "delete every table with a
// tenant_id column" sweep must target BASE TABLES only. A tenant_id-
// bearing VIEW (e.g. conditional_rule_stats, aggregate w/ GROUP BY)
// used to get matched, and `DELETE FROM <view>` fails with 55000
// ("cannot delete from view"), 500-ing the whole delete.
//
// Billing leak: deleteTenant deletes a tenant's plaid_account_mappings
// but plaid_items/plaid_accounts are system-scoped (no tenant_id, no FK
// cascade), so an Item this tenant was the SOLE consumer of used to
// survive — live and billable on Plaid forever. deleteTenant now calls
// Plaid itemRemove for orphaned Items before the sweep.

import { describe, it, expect, afterEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, companies, permissionTemplates, userPermissions,
  plaidItems, plaidAccounts, plaidAccountMappings,
} from '../db/schema/index.js';
import { encrypt } from '../utils/encryption.js';
import { deleteTenant } from './admin.service.js';

// Mock only the outbound Plaid SDK wrapper; everything else stays real so
// the deprovisioning path (dedup query, decrypt, soft-delete) is exercised
// end to end against the test DB.
const plaidMocks = vi.hoisted(() => ({ removeItem: vi.fn() }));
vi.mock('./plaid-client.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plaid-client.service.js')>();
  return { ...actual, removeItem: (...args: unknown[]) => plaidMocks.removeItem(...args) };
});

let doomed = '';
let fallback = '';
let plaidItemIds: string[] = [];

afterEach(async () => {
  // Plaid rows are system-scoped and survive tenant deletion — clean by id.
  for (const iid of plaidItemIds) {
    const accts = await db.select({ id: plaidAccounts.id }).from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, iid)).catch(() => []);
    for (const a of accts) {
      await db.delete(plaidAccountMappings).where(eq(plaidAccountMappings.plaidAccountId, a.id)).catch(() => {});
    }
    await db.delete(plaidAccounts).where(eq(plaidAccounts.plaidItemId, iid)).catch(() => {});
    await db.delete(plaidItems).where(eq(plaidItems.id, iid)).catch(() => {});
  }
  plaidItemIds = [];

  for (const id of [doomed, fallback]) {
    if (!id) continue;
    await db.delete(userPermissions).where(eq(userPermissions.tenantId, id)).catch(() => {});
    await db.delete(permissionTemplates).where(eq(permissionTemplates.tenantId, id)).catch(() => {});
    await db.delete(companies).where(eq(companies.tenantId, id)).catch(() => {});
    await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, id)).catch(() => {});
    await db.delete(users).where(eq(users.tenantId, id)).catch(() => {});
    await db.delete(tenants).where(eq(tenants.id, id)).catch(() => {});
  }
  doomed = ''; fallback = '';
  plaidMocks.removeItem.mockReset();
});

// A disabled home tenant + a fallback tenant the sole user can be re-homed
// to (deleteTenant refuses to strand a user with no other tenant access).
async function setupTenants() {
  const [a] = await db.insert(tenants).values({ name: 'Del', slug: 'del-' + randomUUID() }).returning();
  const [b] = await db.insert(tenants).values({ name: 'Keep', slug: 'keep-' + randomUUID() }).returning();
  doomed = a!.id; fallback = b!.id;
  const pw = await bcrypt.hash('x', 12);
  const [u] = await db.insert(users).values({ tenantId: doomed, email: `u-${randomUUID()}@ex.com`, passwordHash: pw, displayName: 'U', role: 'owner', isActive: false }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: doomed, role: 'owner', isActive: false });
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: fallback, role: 'owner', isActive: true });
  return { userId: u!.id };
}

async function insertPlaidItem(rawToken: string) {
  const [item] = await db.insert(plaidItems).values({
    plaidItemId: 'item-' + randomUUID(),
    accessTokenEncrypted: encrypt(rawToken),
    institutionName: 'Test Bank',
  }).returning();
  plaidItemIds.push(item!.id);
  return item!;
}

async function mapAccount(plaidItemId: string, tenantId: string, mappedBy: string) {
  const [acct] = await db.insert(plaidAccounts).values({
    plaidItemId, plaidAccountId: 'acct-' + randomUUID(), accountType: 'depository', mask: '0000',
  }).returning();
  await db.insert(plaidAccountMappings).values({
    plaidAccountId: acct!.id, tenantId, mappedAccountId: randomUUID(), mappedBy,
  });
  return acct!;
}

describe('deleteTenant', () => {
  it('deletes a disabled tenant without choking on tenant_id views', async () => {
    const { userId } = await setupTenants();
    await db.insert(companies).values({ tenantId: doomed, businessName: 'Co', entityType: 'sole_prop', setupComplete: true });

    const result = await deleteTenant(doomed, userId);
    expect(result.deleted).toBe(true);
    const gone = await db.query.tenants.findFirst({ where: eq(tenants.id, doomed) });
    expect(gone).toBeUndefined();
    doomed = ''; // already deleted; skip cleanup
  });

  it('deprovisions a Plaid Item the deleted tenant was the SOLE consumer of', async () => {
    const { userId } = await setupTenants();
    const item = await insertPlaidItem('tok-sole-123');
    await mapAccount(item.id, doomed, userId);
    plaidMocks.removeItem.mockResolvedValue(undefined);

    await deleteTenant(doomed, userId);

    // itemRemove called exactly once, with the DECRYPTED token.
    expect(plaidMocks.removeItem).toHaveBeenCalledTimes(1);
    expect(plaidMocks.removeItem).toHaveBeenCalledWith('tok-sole-123');

    // Item marked removed + token wiped (mirrors deleteConnection).
    const after = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, item.id) });
    expect(after!.itemStatus).toBe('removed');
    expect(after!.accessTokenEncrypted).toBe('REMOVED');
    expect(after!.removedAt).not.toBeNull();
    const accts = await db.select().from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, item.id));
    expect(accts.every((a) => a.isActive === false)).toBe(true);

    doomed = '';
  });

  it('leaves a Plaid Item alone when another tenant still consumes it', async () => {
    const { userId } = await setupTenants();
    const item = await insertPlaidItem('tok-shared-456');
    await mapAccount(item.id, doomed, userId);
    // A second account under the SAME item mapped into the surviving tenant.
    await mapAccount(item.id, fallback, userId);
    plaidMocks.removeItem.mockResolvedValue(undefined);

    await deleteTenant(doomed, userId);

    // Still billable-but-legitimately-used → must NOT be removed.
    expect(plaidMocks.removeItem).not.toHaveBeenCalled();
    const after = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, item.id) });
    expect(after).toBeDefined();
    expect(after!.itemStatus).not.toBe('removed');
    expect(after!.accessTokenEncrypted).not.toBe('REMOVED');

    doomed = '';
  });

  it('completes tenant deletion even when Plaid itemRemove fails, leaving the Item NOT-removed', async () => {
    const { userId } = await setupTenants();
    const item = await insertPlaidItem('tok-fail-789');
    await mapAccount(item.id, doomed, userId);
    plaidMocks.removeItem.mockRejectedValue(new Error('plaid 500'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Tenant delete must still succeed despite the Plaid failure.
    const result = await deleteTenant(doomed, userId);
    expect(result.deleted).toBe(true);
    const gone = await db.query.tenants.findFirst({ where: eq(tenants.id, doomed) });
    expect(gone).toBeUndefined();

    // Item left INTACT and NOT removed (still live → must stay visible).
    const after = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, item.id) });
    expect(after).toBeDefined();
    expect(after!.itemStatus).not.toBe('removed');
    expect(after!.accessTokenEncrypted).not.toBe('REMOVED');
    expect(after!.removedAt).toBeNull();

    // Loud-logged for manual cleanup.
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('MANUAL DEPROVISION NEEDED'))).toBe(true);
    errSpy.mockRestore();

    doomed = '';
  });
});
