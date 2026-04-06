import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidItems, plaidAccounts, plaidAccountMappings, bankFeedItems } from '../db/schema/index.js';
import { decrypt } from '../utils/encryption.js';
import { retryWithBackoff } from '../utils/retry.js';
import * as plaidClient from './plaid-client.service.js';

interface RoutingEntry {
  tenantId: string;
  coaAccountId: string;
  syncStartDate: string | null;
}

export async function syncItem(itemId: string) {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
  if (!item || item.itemStatus === 'removed') return { added: 0, modified: 0, removed: 0 };

  const accessToken = decrypt(item.accessTokenEncrypted);

  // Build routing map: plaid_account_id → { tenant, coa, syncStartDate }
  const itemAccounts = await db.select().from(plaidAccounts).where(and(eq(plaidAccounts.plaidItemId, itemId), eq(plaidAccounts.isActive, true)));
  const routingMap = new Map<string, RoutingEntry>();

  for (const acct of itemAccounts) {
    const mapping = await db.query.plaidAccountMappings.findFirst({
      where: and(eq(plaidAccountMappings.plaidAccountId, acct.id), eq(plaidAccountMappings.isSyncEnabled, true)),
    });
    if (mapping) {
      routingMap.set(acct.plaidAccountId, {
        tenantId: mapping.tenantId,
        coaAccountId: mapping.mappedAccountId,
        syncStartDate: mapping.syncStartDate,
      });
    }
  }

  if (routingMap.size === 0) return { added: 0, modified: 0, removed: 0 };

  try {
    const { added, modified, removed, nextCursor } = await retryWithBackoff(
      () => plaidClient.syncTransactions(accessToken, item.syncCursor),
      { maxRetries: 3, baseDelayMs: 2000 },
    );

    let addedCount = 0, modifiedCount = 0, removedCount = 0;
    const addedByTenant = new Map<string, string[]>(); // tenantId → feedItemIds

    // Process added transactions — route to correct tenant
    for (const txn of added) {
      const route = routingMap.get(txn.account_id);
      if (!route) continue; // unmapped account

      // Sync start date filter
      if (route.syncStartDate && txn.date < route.syncStartDate) continue;

      // Dedup
      const existing = await db.select({ id: bankFeedItems.id }).from(bankFeedItems)
        .where(and(eq(bankFeedItems.tenantId, route.tenantId), eq(bankFeedItems.providerTransactionId, txn.transaction_id)));
      if (existing.length > 0) continue;

      const [inserted] = await db.insert(bankFeedItems).values({
        tenantId: route.tenantId,
        bankConnectionId: itemId,
        providerTransactionId: txn.transaction_id,
        feedDate: txn.date,
        description: txn.name || txn.merchant_name || '',
        amount: String(Math.abs(txn.amount)),
        category: txn.personal_finance_category?.primary || txn.category?.[0] || null,
        suggestedAccountId: route.coaAccountId,
        status: 'pending',
      }).returning();

      if (!addedByTenant.has(route.tenantId)) addedByTenant.set(route.tenantId, []);
      addedByTenant.get(route.tenantId)!.push(inserted!.id);
      addedCount++;
    }

    // Auto-categorize per tenant
    for (const [tenantId, feedItemIds] of addedByTenant) {
      try {
        const { getConfig } = await import('./ai-config.service.js');
        const aiConfig = await getConfig();
        if (aiConfig.isEnabled && aiConfig.autoCategorizeOnImport) {
          const { batchCategorize } = await import('./ai-categorization.service.js');
          await batchCategorize(tenantId, feedItemIds);
        }
      } catch { /* categorization is best-effort */ }
    }

    // Process modified transactions
    for (const txn of modified) {
      const route = routingMap.get(txn.account_id);
      if (!route) continue;

      const feedItem = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, route.tenantId), eq(bankFeedItems.providerTransactionId, txn.transaction_id)),
      });
      if (!feedItem || feedItem.status !== 'pending') continue;

      await db.update(bankFeedItems).set({
        feedDate: txn.date,
        description: txn.name || txn.merchant_name || '',
        amount: String(Math.abs(txn.amount)),
      }).where(eq(bankFeedItems.id, feedItem.id));
      modifiedCount++;
    }

    // Process removed transactions
    for (const txn of removed) {
      const tid = txn.transaction_id;
      if (!tid) continue;

      // Search across all tenants for this transaction
      const feedItems = await db.select().from(bankFeedItems).where(eq(bankFeedItems.providerTransactionId, tid));
      for (const feedItem of feedItems) {
        if (feedItem.status === 'pending') {
          await db.delete(bankFeedItems).where(eq(bankFeedItems.id, feedItem.id));
        } else {
          await db.update(bankFeedItems).set({
            category: `[REMOVED BY INSTITUTION] ${feedItem.category || ''}`.trim(),
          }).where(eq(bankFeedItems.id, feedItem.id));
        }
        removedCount++;
      }
    }

    // Update sync cursor and status
    await db.update(plaidItems).set({
      syncCursor: nextCursor,
      lastSyncAt: new Date(),
      lastSyncStatus: 'success',
      lastSyncError: null,
      updatedAt: new Date(),
    }).where(eq(plaidItems.id, itemId));

    // Update account balances
    try {
      const balances = await plaidClient.getBalances(accessToken);
      for (const b of balances) {
        await db.update(plaidAccounts).set({
          currentBalance: b.balances.current?.toString() || null,
          availableBalance: b.balances.available?.toString() || null,
          balanceUpdatedAt: new Date(),
        }).where(eq(plaidAccounts.plaidAccountId, b.account_id));
      }
    } catch { /* balance refresh is best-effort */ }

    return { added: addedCount, modified: modifiedCount, removed: removedCount };
  } catch (err: any) {
    await db.update(plaidItems).set({
      lastSyncAt: new Date(), lastSyncStatus: 'error', lastSyncError: err.message || 'Sync failed', updatedAt: new Date(),
    }).where(eq(plaidItems.id, itemId));
    throw err;
  }
}

export async function syncAllItems() {
  const items = await db.select().from(plaidItems)
    .where(and(eq(plaidItems.itemStatus, 'active'), sql`removed_at IS NULL`));

  const results = [];
  for (const item of items) {
    try {
      const result = await syncItem(item.id);
      results.push({ itemId: item.id, ...result });
    } catch (err: any) {
      results.push({ itemId: item.id, error: err.message });
    }
  }
  return results;
}

// Alias for backward compatibility
export { syncAllItems as syncAllTenants };
