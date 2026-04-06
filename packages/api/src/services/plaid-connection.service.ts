import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidItems, plaidAccounts, plaidAccountMappings, plaidItemActivity, bankFeedItems } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as plaidClient from './plaid-client.service.js';

// ─── Existing Institution Detection ────────────────────────────

export async function checkExistingInstitution(institutionId: string) {
  if (!institutionId) return null;
  return db.query.plaidItems.findFirst({
    where: and(eq(plaidItems.plaidInstitutionId, institutionId), sql`removed_at IS NULL`),
  });
}

// ─── Visibility Filtering ──────────────────────────────────────

export async function getVisibleAccounts(userId: string, plaidItemId: string) {
  const userTenants = await getUserAdminTenants(userId);
  const allAccounts = await db.select().from(plaidAccounts).where(and(eq(plaidAccounts.plaidItemId, plaidItemId), eq(plaidAccounts.isActive, true)));

  const visible = [];
  let hiddenCount = 0;

  for (const acct of allAccounts) {
    const mapping = await db.query.plaidAccountMappings.findFirst({ where: eq(plaidAccountMappings.plaidAccountId, acct.id) });
    if (!mapping) {
      visible.push({ ...acct, mapping: null }); // unassigned → visible
    } else if (userTenants.includes(mapping.tenantId)) {
      visible.push({ ...acct, mapping }); // user's company → visible
    } else {
      hiddenCount++; // other company → hidden
    }
  }

  return { accounts: visible, hiddenAccountCount: hiddenCount };
}

async function getUserAdminTenants(userId: string): Promise<string[]> {
  const { users, userTenantAccess } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return [];

  // Primary tenant
  const tenants = [user.tenantId];

  // Additional tenants via access table
  const access = await db.select().from(userTenantAccess)
    .where(and(eq(userTenantAccess.userId, userId), eq(userTenantAccess.isActive, true)));
  for (const a of access) tenants.push(a.tenantId);

  return [...new Set(tenants)];
}

// ─── Connection Creation (System-Scoped) ───────────────────────

export async function createConnection(userId: string, publicToken: string, metadata: {
  institutionId?: string; institutionName?: string; accounts?: any[]; linkSessionId?: string; forceNew?: boolean;
}) {
  const { users } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

  // Check for existing institution (skip if forceNew)
  const existing = !metadata.forceNew && metadata.institutionId ? await checkExistingInstitution(metadata.institutionId) : null;

  if (existing) {
    // Same institution already connected — update access token + add any new accounts
    const accessToken = decrypt(existing.accessTokenEncrypted);
    const { accessToken: newToken, itemId: newItemId } = await plaidClient.exchangePublicToken(publicToken);

    if (newItemId === existing.plaidItemId) {
      // Same Item — just update the access token
      await db.update(plaidItems).set({ accessTokenEncrypted: encrypt(newToken), updatedAt: new Date() }).where(eq(plaidItems.id, existing.id));
    } else {
      // Different Item for same institution — replace and transfer
      await db.update(plaidItems).set({ accessTokenEncrypted: encrypt(newToken), plaidItemId: newItemId, updatedAt: new Date() }).where(eq(plaidItems.id, existing.id));
      // Remove the duplicate from Plaid
      try { await plaidClient.removeItem(accessToken); } catch { /* old token may already be invalid */ }
    }

    // Add any new accounts
    const plaidAccountList = await plaidClient.getAccounts(newToken);
    for (const pa of plaidAccountList) {
      const existingAcct = await db.query.plaidAccounts.findFirst({ where: eq(plaidAccounts.plaidAccountId, pa.account_id) });
      if (!existingAcct) {
        await db.insert(plaidAccounts).values({
          plaidItemId: existing.id,
          plaidAccountId: pa.account_id,
          persistentAccountId: pa.persistent_account_id || null,
          name: pa.name, officialName: pa.official_name || null,
          accountType: pa.type, accountSubtype: pa.subtype || null, mask: pa.mask || null,
          currentBalance: pa.balances.current?.toString() || null,
          availableBalance: pa.balances.available?.toString() || null,
          balanceCurrency: pa.balances.iso_currency_code || 'USD', balanceUpdatedAt: new Date(),
        });
      }
    }

    await logActivity(existing.id, null, 'item_reauthorized', userId, user?.displayName || null, { institutionName: metadata.institutionName });

    return { item: existing, isExisting: true };
  }

  // New connection
  const { accessToken, itemId } = await plaidClient.exchangePublicToken(publicToken);
  const plaidAccountList = await plaidClient.getAccounts(accessToken);

  const [item] = await db.insert(plaidItems).values({
    plaidItemId: itemId,
    plaidInstitutionId: metadata.institutionId || null,
    institutionName: metadata.institutionName || null,
    accessTokenEncrypted: encrypt(accessToken),
    createdBy: userId,
    createdByName: user?.displayName || null,
    createdByEmail: user?.email || null,
    linkSessionId: metadata.linkSessionId || null,
  }).returning();

  const accounts = [];
  for (const pa of plaidAccountList) {
    const [acct] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id,
      plaidAccountId: pa.account_id,
      persistentAccountId: pa.persistent_account_id || null,
      name: pa.name, officialName: pa.official_name || null,
      accountType: pa.type, accountSubtype: pa.subtype || null, mask: pa.mask || null,
      currentBalance: pa.balances.current?.toString() || null,
      availableBalance: pa.balances.available?.toString() || null,
      balanceCurrency: pa.balances.iso_currency_code || 'USD', balanceUpdatedAt: new Date(),
    }).returning();
    accounts.push(acct!);
  }

  await logActivity(item!.id, null, 'item_created', userId, user?.displayName || null, { institutionName: metadata.institutionName });

  return { item: item!, accounts, isExisting: false };
}

// ─── Item Queries ──────────────────────────────────────────────

export async function getItemsForUser(userId: string) {
  const userTenants = await getUserAdminTenants(userId);
  // Find items that have at least one mapping to user's tenants, or were created by user, or have unassigned accounts
  const allItems = await db.select().from(plaidItems).where(sql`removed_at IS NULL`);

  const result = [];
  for (const item of allItems) {
    const { accounts, hiddenAccountCount } = await getVisibleAccounts(userId, item.id);
    // User can see this item if they have visible accounts or are the creator
    if (accounts.length > 0 || item.createdBy === userId) {
      result.push({ ...item, accounts, hiddenAccountCount, accessTokenEncrypted: undefined });
    }
  }
  return result;
}

export async function getItemDetail(userId: string, itemId: string) {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
  if (!item) throw AppError.notFound('Connection not found');

  const { accounts, hiddenAccountCount } = await getVisibleAccounts(userId, itemId);
  return { ...item, accounts, hiddenAccountCount, accessTokenEncrypted: undefined };
}

// ─── Tier 1: Unmap Company ─────────────────────────────────────

export async function unmapCompany(plaidItemId: string, tenantId: string, deletePendingItems: boolean, userId: string) {
  const { users } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

  // Get all mappings for this tenant from this item's accounts
  const itemAccounts = await db.select({ id: plaidAccounts.id }).from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, plaidItemId));
  const accountIds = itemAccounts.map((a) => a.id);

  const mappings = await db.select().from(plaidAccountMappings)
    .where(and(eq(plaidAccountMappings.tenantId, tenantId)));
  const relevantMappings = mappings.filter((m) => accountIds.includes(m.plaidAccountId));

  // Delete mappings
  for (const m of relevantMappings) {
    await db.delete(plaidAccountMappings).where(eq(plaidAccountMappings.id, m.id));
  }

  // Optionally delete pending feed items
  if (deletePendingItems) {
    await db.delete(bankFeedItems).where(
      and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.bankConnectionId, plaidItemId), eq(bankFeedItems.status, 'pending')),
    );
  }

  await logActivity(plaidItemId, tenantId, 'company_unmapped_all', userId, user?.displayName || null, {
    accountsUnmapped: relevantMappings.length, deletedPendingItems: deletePendingItems,
  });
  await auditLog(tenantId, 'delete', 'plaid_company_unmap', plaidItemId, null, null, userId);
}

// ─── Tier 2: Delete Entire Connection ──────────────────────────

export async function deleteConnection(plaidItemId: string, deletePendingItems: boolean, userId: string) {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, plaidItemId) });
  if (!item) throw AppError.notFound('Connection not found');

  const { users } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

  // Permission check
  const isSuperAdmin = user?.isSuperAdmin;
  const isCreator = item.createdBy === userId;
  if (!isSuperAdmin && !isCreator) {
    // Check if user is admin of ALL affected companies
    const userTenants = await getUserAdminTenants(userId);
    const allMappings = await getAllMappingsForItem(plaidItemId);
    const affectedTenants = [...new Set(allMappings.map((m) => m.tenantId))];
    const hasAccessToAll = affectedTenants.every((t) => userTenants.includes(t));
    if (!hasAccessToAll) throw AppError.forbidden('You must be admin of all affected companies to delete this connection');
  }

  // 1. Call Plaid /item/remove
  try {
    const accessToken = decrypt(item.accessTokenEncrypted);
    await plaidClient.removeItem(accessToken);
  } catch (err: any) {
    throw AppError.internal(`Could not reach Plaid to revoke connection: ${err.message}`);
  }

  // 2. Get all affected tenants for notifications
  const allMappings = await getAllMappingsForItem(plaidItemId);
  const affectedTenants = [...new Set(allMappings.map((m) => m.tenantId))];

  // 3. Delete pending feed items if opted in
  if (deletePendingItems) {
    for (const tenantId of affectedTenants) {
      await db.delete(bankFeedItems).where(
        and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.bankConnectionId, plaidItemId), eq(bankFeedItems.status, 'pending')),
      );
    }
  }

  // 4. Delete all mappings
  for (const m of allMappings) {
    await db.delete(plaidAccountMappings).where(eq(plaidAccountMappings.id, m.id));
  }

  // 5. Soft-delete accounts
  await db.update(plaidAccounts).set({ isActive: false }).where(eq(plaidAccounts.plaidItemId, plaidItemId));

  // 6. Soft-delete item (wipe access token)
  await db.update(plaidItems).set({
    itemStatus: 'removed', removedAt: new Date(), removedBy: userId, removedByName: user?.displayName || null,
    accessTokenEncrypted: 'REMOVED', updatedAt: new Date(),
  }).where(eq(plaidItems.id, plaidItemId));

  // 7. Activity + audit
  await logActivity(plaidItemId, null, 'item_removed', userId, user?.displayName || null, {
    affectedCompanies: affectedTenants.length, accountsRemoved: allMappings.length,
  });
  for (const tenantId of affectedTenants) {
    await auditLog(tenantId, 'delete', 'plaid_connection_deleted', plaidItemId, null, { institutionName: item.institutionName }, userId);
  }
}

// ─── Connection Management ─────────────────────────────────────

export async function refreshItemStatus(itemId: string) {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
  if (!item) throw AppError.notFound('Connection not found');

  const accessToken = decrypt(item.accessTokenEncrypted);
  const plaidItem = await plaidClient.getItem(accessToken);

  const updates: any = { updatedAt: new Date() };
  if (plaidItem.error) {
    updates.itemStatus = 'error';
    updates.errorCode = plaidItem.error.error_code;
    updates.errorMessage = plaidItem.error.error_message;
  } else {
    updates.itemStatus = 'active';
    updates.errorCode = null;
    updates.errorMessage = null;
  }
  if (plaidItem.consent_expiration_time) {
    updates.consentExpirationAt = new Date(plaidItem.consent_expiration_time);
  }
  await db.update(plaidItems).set(updates).where(eq(plaidItems.id, itemId));
}

export async function getUpdateLinkToken(itemId: string, userId: string) {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
  if (!item) throw AppError.notFound('Connection not found');
  const accessToken = decrypt(item.accessTokenEncrypted);
  return plaidClient.createUpdateLinkToken('system', userId, accessToken);
}

export async function rotateItemToken(itemId: string) {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
  if (!item || item.itemStatus === 'removed') return;
  const oldToken = decrypt(item.accessTokenEncrypted);
  const newToken = await plaidClient.rotateAccessToken(oldToken);
  await db.update(plaidItems).set({ accessTokenEncrypted: encrypt(newToken), updatedAt: new Date() }).where(eq(plaidItems.id, itemId));
}

// ─── Helpers ───────────────────────────────────────────────────

async function getAllMappingsForItem(plaidItemId: string) {
  const itemAccounts = await db.select({ id: plaidAccounts.id }).from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, plaidItemId));
  const allMappings = [];
  for (const acct of itemAccounts) {
    const mapping = await db.query.plaidAccountMappings.findFirst({ where: eq(plaidAccountMappings.plaidAccountId, acct.id) });
    if (mapping) allMappings.push(mapping);
  }
  return allMappings;
}

async function logActivity(plaidItemId: string, tenantId: string | null, action: string, userId: string, userName: string | null, details?: any) {
  await db.insert(plaidItemActivity).values({
    plaidItemId, tenantId, action, performedBy: userId, performedByName: userName, details,
  });
}

export { getUserAdminTenants };
