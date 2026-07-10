// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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

// `scopeTenantId` narrows the view to a single workspace (the active client):
// only accounts mapped to THAT tenant are shown, plus the item's still-
// unassigned accounts — but only when the item is already used by that tenant,
// so a client's Banking screen never surfaces an item belonging entirely to a
// different client. Omit it for the user-wide view (mapping discovery, MCP),
// which shows accounts across every tenant the user can access.
export async function getVisibleAccounts(userId: string, plaidItemId: string, scopeTenantId?: string) {
  const allAccounts = await db.select().from(plaidAccounts).where(and(eq(plaidAccounts.plaidItemId, plaidItemId), eq(plaidAccounts.isActive, true)));

  // One mapping lookup per account, reused below.
  const mappingByAccount = new Map<string, typeof plaidAccountMappings.$inferSelect>();
  for (const acct of allAccounts) {
    const m = await db.query.plaidAccountMappings.findFirst({ where: eq(plaidAccountMappings.plaidAccountId, acct.id) });
    if (m) mappingByAccount.set(acct.id, m);
  }

  const visible = [];
  let hiddenCount = 0;

  if (scopeTenantId) {
    const mappings = [...mappingByAccount.values()];
    // The item's unassigned accounts are mappable here only if this tenant
    // already uses the item...
    const itemUsedHere = mappings.some((m) => m.tenantId === scopeTenantId);
    // ...AND the item carries no mapping owned by a DIFFERENT tenant. SECURITY:
    // an item with mappings across more than one tenant spans multiple clients
    // (e.g. two separate bank logins that happen to share an institution and
    // were wrongly fused). Its unassigned accounts can't be safely attributed
    // to this tenant, so surfacing them leaked another client's accounts as
    // "mappable here". Mapped accounts owned by other tenants were already
    // hidden; this closes the unassigned-account bleed too.
    const hasOtherTenantMapping = mappings.some((m) => m.tenantId !== scopeTenantId);
    const canShowUnassigned = itemUsedHere && !hasOtherTenantMapping;
    for (const acct of allAccounts) {
      const mapping = mappingByAccount.get(acct.id) ?? null;
      if (mapping) {
        if (mapping.tenantId === scopeTenantId) visible.push({ ...acct, mapping });
        else hiddenCount++;
      } else if (canShowUnassigned) {
        visible.push({ ...acct, mapping: null });
      } else {
        hiddenCount++;
      }
    }
    return { accounts: visible, hiddenAccountCount: hiddenCount };
  }

  // User-wide view: accounts mapped to any of the user's tenants, plus the
  // item's unassigned accounts — but ONLY when the item belongs to the user's
  // orbit. SECURITY: unassigned accounts were previously visible to EVERY
  // user system-wide, so any tenant could see another tenant's
  // freshly-connected (not-yet-mapped) institution, its account names/masks/
  // balances, and the creator's name/email (reachable via MCP
  // get_bank_connections). An item's unassigned accounts are now shown only
  // when:
  //   - the caller created the item, OR shares a tenant with its creator
  //     (the connecting user's team can finish mapping), OR one of the
  //     caller's tenants already has a mapping on it (a sanctioned share),
  //   - AND no OTHER tenant holds a mapping on it (a cross-tenant item's
  //     unassigned accounts can't be attributed — super-admin maps those
  //     from the Plaid monitor).
  const userTenants = await getUserAdminTenants(userId);
  const mappings = [...mappingByAccount.values()];
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, plaidItemId) });
  const isCreator = !!item?.createdBy && item.createdBy === userId;
  const creatorTenants = item?.createdBy && !isCreator ? await getUserAdminTenants(item.createdBy) : [];
  const sharesTenantWithCreator = isCreator || creatorTenants.some((t) => userTenants.includes(t));
  const itemUsedByUser = mappings.some((m) => userTenants.includes(m.tenantId));
  const hasForeignMapping = mappings.some((m) => !userTenants.includes(m.tenantId));
  const showUnassigned = !hasForeignMapping && (sharesTenantWithCreator || itemUsedByUser);

  for (const acct of allAccounts) {
    const mapping = mappingByAccount.get(acct.id) ?? null;
    if (!mapping) {
      if (showUnassigned) visible.push({ ...acct, mapping: null });
      else hiddenCount++;
    } else if (userTenants.includes(mapping.tenantId)) {
      visible.push({ ...acct, mapping }); // user's company → visible
    } else {
      hiddenCount++; // other company → hidden
    }
  }

  return { accounts: visible, hiddenAccountCount: hiddenCount };
}

// ─── Cross-tenant duplicate detection ──────────────────────────
// Privacy-safe: returns only WHETHER the same real bank account is already
// connected + mapped under a tenant the user has no access to — never the
// other tenant's identity. Mirrors the sole-consumer probe in admin.service
// and the count-only disclosure of getVisibleAccounts. Used to WARN (not
// block) that re-linking may double Plaid billing / duplicate imports.
//
// The stable cross-Item key is persistent_account_id — a fresh Link mints new
// plaid_item_id / account_id, so those never match a prior connection of the
// same real account. When Plaid omits it we fall back to
// institution_id + mask + account_subtype.
export async function detectAccountsConnectedElsewhere(
  userId: string,
  institutionId: string | null | undefined,
  plaidAccountList: Array<{ persistent_account_id?: string | null; mask?: string | null; subtype?: string | null }>,
): Promise<boolean> {
  const userTenants = await getUserAdminTenants(userId);
  if (userTenants.length === 0) return false;
  const tenantList = sql.join(userTenants.map((t) => sql`${t}`), sql`, `);

  for (const acct of plaidAccountList) {
    const persistent = acct.persistent_account_id || null;
    const mask = acct.mask || null;
    const subtype = acct.subtype || null;
    // No usable key for this account → can't detect (don't false-positive).
    if (!persistent && !(institutionId && mask && subtype)) continue;

    const rows = await db.execute(sql`
      SELECT 1
      FROM plaid_accounts pa
      JOIN plaid_account_mappings pam ON pam.plaid_account_id = pa.id
      JOIN plaid_items pi ON pi.id = pa.plaid_item_id
      WHERE pam.tenant_id NOT IN (${tenantList})
        AND pi.removed_at IS NULL
        AND (
          (${persistent}::text IS NOT NULL AND pa.persistent_account_id = ${persistent})
          OR (${persistent}::text IS NULL
              AND ${institutionId ?? null}::text IS NOT NULL
              AND pi.plaid_institution_id = ${institutionId ?? null}
              AND pa.mask = ${mask}
              AND pa.account_subtype = ${subtype})
        )
      LIMIT 1
    `);
    if (rows.rows.length > 0) return true;
  }
  return false;
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

  // Exchange the (single-use) public token up front so we can dedup on the
  // real Plaid ITEM id — the login itself.
  //
  // SECURITY: we previously deduped on institution_id and, on a mismatched
  // item_id, "replaced and transferred" the token. That fused two DIFFERENT
  // logins at the same bank (e.g. two clients who both bank at U.S. Bank) into
  // one shared Item, exposing one tenant's accounts to the other. An Item is a
  // single login; only the SAME item_id (a genuine re-auth of that login) may
  // reuse an existing connection. A different login is always a NEW, separate
  // connection — never merged.
  const { accessToken, itemId } = await plaidClient.exchangePublicToken(publicToken);

  const existing = !metadata.forceNew
    ? await db.query.plaidItems.findFirst({ where: and(eq(plaidItems.plaidItemId, itemId), sql`removed_at IS NULL`) })
    : null;

  // ORPHAN GUARD: the public token is single-use and already spent. If
  // anything between here and a successful DB insert fails on a NEW
  // connection, the Item would exist at Plaid (billing) with no local row
  // holding its access token — invisible and unrevokable in-app. Compensate
  // by removing the Item at Plaid before rethrowing. Re-auth failures skip
  // this: the token belongs to an existing, still-tracked item.
  try {
    return await createConnectionInner();
  } catch (err) {
    if (!existing) {
      try { await plaidClient.removeItem(accessToken); } catch { /* best effort */ }
      console.error('[plaid] connect failed after token exchange — removed the orphaned Item at Plaid');
    }
    throw err;
  }

  async function createConnectionInner() {
  const plaidAccountList = await plaidClient.getAccounts(accessToken);

  if (existing) {
    // Same login re-authorized — refresh the token and add any genuinely new
    // accounts. Never touches other logins' items.
    await db.update(plaidItems).set({ accessTokenEncrypted: encrypt(accessToken), updatedAt: new Date() }).where(eq(plaidItems.id, existing.id));
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
    // Never return the encrypted access token (or rely on the client to drop it).
    return { item: { ...existing, accessTokenEncrypted: undefined }, isExisting: true };
  }

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

  // Warn (never block) if one of these accounts is already connected under a
  // tenant the user can't see — connecting it again double-bills Plaid and
  // duplicates the feed. Name-hidden by design (boolean only).
  const connectedElsewhere = await detectAccountsConnectedElsewhere(
    userId,
    metadata.institutionId,
    plaidAccountList,
  );

  return { item: { ...item!, accessTokenEncrypted: undefined }, accounts, isExisting: false, connectedElsewhere };
  } // end createConnectionInner
}

// ─── Item Queries ──────────────────────────────────────────────

// `scopeTenantId` (the active client) restricts the list to Plaid items with
// at least one account visible to THAT tenant — so a client's Bank Connections
// screen shows only its own connections, not every client the user can access.
// Omitted for the user-wide view (MCP), which also includes items the user
// created even if not yet mapped anywhere.
export async function getItemsForUser(userId: string, scopeTenantId?: string) {
  const allItems = await db.select().from(plaidItems).where(sql`removed_at IS NULL`);

  const result = [];
  for (const item of allItems) {
    const { accounts, hiddenAccountCount } = await getVisibleAccounts(userId, item.id, scopeTenantId);
    const include = scopeTenantId
      ? accounts.length > 0
      : accounts.length > 0 || item.createdBy === userId;
    if (include) {
      result.push({ ...item, accounts, hiddenAccountCount, accessTokenEncrypted: undefined });
    }
  }
  return result;
}

export async function getItemDetail(userId: string, itemId: string) {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
  if (!item) throw AppError.notFound('Connection not found');

  const { accounts, hiddenAccountCount } = await getVisibleAccounts(userId, itemId);

  // Visibility check: the caller may only see this item if they created
  // it, or have a MAPPING to at least one of its accounts, or are a
  // super admin. Merely-visible unassigned accounts do NOT grant access —
  // they're visible to any user in the user-wide view, so counting them
  // would let any authenticated user enumerate items by UUID and pull
  // institution metadata + creator PII (see security review §2).
  const { users } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const isSuperAdmin = !!user?.isSuperAdmin;
  const isCreator = item.createdBy === userId;
  if (!isSuperAdmin && !isCreator && !accounts.some((a) => a.mapping)) {
    throw AppError.notFound('Connection not found');
  }

  return { ...item, accounts, hiddenAccountCount, accessTokenEncrypted: undefined };
}

/**
 * Throw unless `userId` has permission to operate on the given Plaid
 * item. Used to gate sync triggers, sync-history reads, and activity
 * log reads so they can't be driven by an unrelated authenticated
 * user who happens to know the item's UUID.
 *
 * "Permission" here means: the user is a super admin, OR they created
 * the item, OR at least one account under the item is currently
 * mapped into a tenant the user has active access to.
 */
export async function assertCanAccessItem(userId: string, itemId: string): Promise<void> {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
  if (!item) throw AppError.notFound('Connection not found');

  const { users } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (user?.isSuperAdmin) return;
  if (item.createdBy === userId) return;

  // SECURITY: access requires an account MAPPED into one of the user's
  // tenants — not merely a visible unassigned account (counting those let
  // any authenticated user pass this gate). One carve-out: a fully UNMAPPED
  // item is operable by the connecting user's teammates (they share a
  // tenant with the creator) so a colleague can finish mapping or delete an
  // abandoned link.
  const { accounts } = await getVisibleAccounts(userId, itemId);
  if (accounts.some((a) => a.mapping)) return;

  const allMappings = await getAllMappingsForItem(itemId);
  if (allMappings.length === 0 && item.createdBy) {
    const userTenants = await getUserAdminTenants(userId);
    const creatorTenants = await getUserAdminTenants(item.createdBy);
    if (creatorTenants.some((t) => userTenants.includes(t))) return;
  }
  throw AppError.notFound('Connection not found');
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

  // Delete mappings. Scoped to the caller's tenant for defense in
  // depth — `relevantMappings` is already filtered to this tenant's
  // rows, but an explicit tenantId in the WHERE keeps CLAUDE.md rule
  // #17 honest against a future refactor that forgets the filter.
  for (const m of relevantMappings) {
    await db.delete(plaidAccountMappings)
      .where(and(eq(plaidAccountMappings.tenantId, tenantId), eq(plaidAccountMappings.id, m.id)));
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

  // Permission check: super-admin, the connecting user, or an admin of ALL
  // tenants the item's accounts are mapped into. For an UNMAPPED item the
  // affected-tenant list is empty — `every()` over an empty list is
  // vacuously true, which previously let ANY authenticated user delete
  // another client's freshly-connected (not-yet-mapped) bank. An unmapped
  // item may only be deleted by its creator, a super-admin, or a user who
  // shares a tenant with the creator.
  const isSuperAdmin = user?.isSuperAdmin;
  const isCreator = item.createdBy === userId;
  if (!isSuperAdmin && !isCreator) {
    const userTenants = await getUserAdminTenants(userId);
    const allMappings = await getAllMappingsForItem(plaidItemId);
    const affectedTenants = [...new Set(allMappings.map((m) => m.tenantId))];
    if (affectedTenants.length === 0) {
      const creatorTenants = item.createdBy ? await getUserAdminTenants(item.createdBy) : [];
      const sharesTenantWithCreator = creatorTenants.some((t) => userTenants.includes(t));
      if (!sharesTenantWithCreator) {
        throw AppError.forbidden('Only the user who connected this bank (or their team) can delete an unmapped connection');
      }
    } else {
      const hasAccessToAll = affectedTenants.every((t) => userTenants.includes(t));
      if (!hasAccessToAll) throw AppError.forbidden('You must be admin of all affected companies to delete this connection');
    }
  }

  // 1. Revoke at PLAID FIRST and require confirmation before touching our
  // records: `itemRemove` resolving without error IS Plaid's confirmation
  // (HTTP 200 = item removed and billing stopped). Any Plaid failure aborts —
  // we never delete locally while the item may still be live (and billing)
  // at Plaid. The one exception: Plaid reporting the item already
  // gone (ITEM_NOT_FOUND / INVALID_ACCESS_TOKEN after a prior removal)
  // counts as confirmed-removed, otherwise a connection that died on
  // Plaid's side could never be cleaned up here.
  try {
    const accessToken = decrypt(item.accessTokenEncrypted);
    await plaidClient.removeItem(accessToken);
  } catch (err: any) {
    const plaidCode = err?.response?.data?.error_code;
    if (plaidCode !== 'ITEM_NOT_FOUND' && plaidCode !== 'INVALID_ACCESS_TOKEN') {
      throw AppError.internal(`Plaid did not confirm the removal — the connection was NOT deleted. (${err.message})`);
    }
    console.warn(`[plaid] item ${plaidItemId} already gone at Plaid (${plaidCode}) — proceeding with local removal`);
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

  // 4. Delete all mappings. This path runs in the "Delete Entire
  // Connection" flow, so it's allowed to touch mappings across every
  // tenant attached to this Plaid item. Scope each delete by the
  // mapping's own tenantId (already looked up above) so we never
  // accidentally delete mappings owned by an unrelated tenant whose
  // id collides in an ORM bug.
  for (const m of allMappings) {
    await db.delete(plaidAccountMappings)
      .where(and(eq(plaidAccountMappings.tenantId, m.tenantId), eq(plaidAccountMappings.id, m.id)));
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

// Super-admin escape hatch: remove the connection LOCALLY without calling
// Plaid. Exists for connections whose access token can no longer be used —
// e.g. after a cross-host restore with a different ENCRYPTION_KEY the token
// can't be decrypted, so the normal Plaid-first deletion can never succeed
// and the item becomes an undeletable zombie. The caller is warned that the
// Item may still be live (and billing) at Plaid and must be revoked from the
// Plaid dashboard.
export async function forceRemoveConnection(plaidItemId: string, userId: string) {
  const { users } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.isSuperAdmin) throw AppError.forbidden('Only a super-admin can force-remove a connection');

  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, plaidItemId) });
  if (!item) throw AppError.notFound('Connection not found');

  // Best-effort Plaid revoke — if the token still decrypts and Plaid answers,
  // take the clean path; otherwise proceed locally regardless.
  let plaidRevoked = false;
  try {
    const accessToken = decrypt(item.accessTokenEncrypted);
    await plaidClient.removeItem(accessToken);
    plaidRevoked = true;
  } catch {
    console.warn(`[plaid] force-remove ${plaidItemId}: could not revoke at Plaid — local removal only. Revoke the item from the Plaid dashboard.`);
  }

  const allMappings = await getAllMappingsForItem(plaidItemId);
  const affectedTenants = [...new Set(allMappings.map((m) => m.tenantId))];
  for (const m of allMappings) {
    await db.delete(plaidAccountMappings)
      .where(and(eq(plaidAccountMappings.tenantId, m.tenantId), eq(plaidAccountMappings.id, m.id)));
  }
  await db.update(plaidAccounts).set({ isActive: false }).where(eq(plaidAccounts.plaidItemId, plaidItemId));
  await db.update(plaidItems).set({
    itemStatus: 'removed', removedAt: new Date(), removedBy: userId, removedByName: user.displayName || null,
    accessTokenEncrypted: 'REMOVED', updatedAt: new Date(),
  }).where(eq(plaidItems.id, plaidItemId));

  await logActivity(plaidItemId, null, 'item_force_removed', userId, user.displayName || null, {
    plaidRevoked, affectedCompanies: affectedTenants.length,
  });
  for (const tenantId of affectedTenants) {
    await auditLog(tenantId, 'delete', 'plaid_connection_force_removed', plaidItemId, null, { institutionName: item.institutionName, plaidRevoked }, userId);
  }
  return { plaidRevoked };
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
  // Requires the caller to have actual access to the item — previously we
  // only checked existence, so any authenticated user knowing an itemId
  // could mint an update-link token and re-auth someone else's bank
  // connection.
  await assertCanAccessItem(userId, itemId);
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
