// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidItems, plaidAccounts, plaidAccountMappings, bankFeedItems } from '../db/schema/index.js';
import { decrypt } from '../utils/encryption.js';
import { retryWithBackoff } from '../utils/retry.js';
import { parseCheckNumber } from '../utils/check-number.js';
import * as plaidClient from './plaid-client.service.js';
import * as bankConnectionService from './bank-connection.service.js';
import type { CleansingAggregate } from './bank-feed.service.js';

interface RoutingEntry {
  tenantId: string;
  coaAccountId: string;
  syncStartDate: string | null;
  // The bankConnections row (provider 'plaid') that backs this Plaid account.
  // Feed display, categorization, and posting all resolve the bank account
  // through it — same model as file imports.
  connectionId: string;
}

export async function syncItem(itemId: string) {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, itemId) });
  if (!item || item.itemStatus === 'removed') return { added: 0, modified: 0, removed: 0 };

  // Claim the item for sync by atomically bumping its last_sync_at,
  // but only if it hasn't been synced in the last 30 seconds. Two
  // workers (scheduled + manual trigger, two cron pods, retry+original)
  // racing on the same item would otherwise both fetch the same
  // cursor and both try to advance it, either duplicating feed items
  // (caught by the dedupe below) or losing transactions (cursor races
  // on `UPDATE plaid_items SET sync_cursor = ?`). The 30-second
  // debounce is long enough to cover typical sync runtimes and short
  // enough that a genuinely stuck sync doesn't permanently block new
  // syncs.
  const [claimed] = await db.update(plaidItems)
    .set({ lastSyncAt: new Date() })
    .where(and(
      eq(plaidItems.id, itemId),
      sql`(last_sync_at IS NULL OR last_sync_at < NOW() - INTERVAL '30 seconds')`,
    ))
    .returning();
  if (!claimed) {
    // Another worker is syncing this item (or just finished).
    return { added: 0, modified: 0, removed: 0, skipped: true };
  }

  const accessToken = decrypt(item.accessTokenEncrypted);

  // Build routing map: plaid_account_id → { tenant, coa, syncStartDate }
  const itemAccounts = await db.select().from(plaidAccounts).where(and(eq(plaidAccounts.plaidItemId, itemId), eq(plaidAccounts.isActive, true)));
  const routingMap = new Map<string, RoutingEntry>();

  for (const acct of itemAccounts) {
    const mapping = await db.query.plaidAccountMappings.findFirst({
      where: and(eq(plaidAccountMappings.plaidAccountId, acct.id), eq(plaidAccountMappings.isSyncEnabled, true)),
    });
    if (mapping) {
      const connectionId = await bankConnectionService.getOrCreatePlaidConnection(
        mapping.tenantId,
        mapping.mappedAccountId,
        acct.plaidAccountId,
        {
          institutionName: [item.institutionName, acct.name].filter(Boolean).join(' — ') || 'Plaid',
          providerItemId: item.plaidItemId,
          mask: acct.mask,
        },
      );
      routingMap.set(acct.plaidAccountId, {
        tenantId: mapping.tenantId,
        coaAccountId: mapping.mappedAccountId,
        syncStartDate: mapping.syncStartDate,
        connectionId,
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
    const addedRowsByTenant = new Map<string, Array<typeof bankFeedItems.$inferSelect>>(); // tenantId → inserted rows

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
        // The bank connection that maps to the GL bank account — NOT the Plaid
        // item id. This is what lets the feed show the account, the
        // categorization pipeline suggest an expense account, and posting
        // resolve the bank account to debit/credit.
        bankConnectionId: route.connectionId,
        providerTransactionId: txn.transaction_id,
        feedDate: txn.date,
        description: txn.name || txn.merchant_name || '',
        // Sign mapping: Plaid's convention is positive = money OUT
        // (debit/spend), negative = money IN (deposit/refund) — exactly the
        // signed convention bank_feed_items uses everywhere else (CSV
        // debit−credit, OFX negated, statement credit→negative; see
        // bank-feed.service categorize(): amount > 0 ⇒ expense, < 0 ⇒
        // deposit). So Plaid's signed value maps through DIRECTLY. Never
        // Math.abs() it — that turned every deposit into a spend.
        amount: String(txn.amount),
        // Raw provider descriptor — dedup and categorization learning key
        // off originalDescription, and the cleansing pipeline preserves it
        // while rewriting `description`. Plaid's original_description is
        // the bank's truly-raw text (requires include_original_description
        // on the sync request); `name` is Plaid-cleaned.
        originalDescription: txn.original_description || txn.name || txn.merchant_name || null,
        // The bank's raw payee text (checks/ACH). Displays in the review
        // panel's memo and flows onto the posted transaction.
        memo: txn.payment_meta?.payee || null,
        // Plaid's own category is a search hint only; the CATEGORY column shows
        // the suggested GL account, which the categorization pipeline fills.
        category: txn.personal_finance_category?.primary || txn.category?.[0] || null,
        // Plaid supplies the check number as a string; the column is an
        // integer. Non-numeric values (rare bank quirks) are dropped
        // rather than imported as NaN. When Plaid omits it, parse the
        // descriptor ("CHECK 1234") like every other import method.
        checkNumber: (txn.check_number ? Number.parseInt(txn.check_number, 10) || null : null)
          ?? parseCheckNumber(txn.original_description || txn.name),
        status: 'pending',
      }).returning();

      if (!addedRowsByTenant.has(route.tenantId)) addedRowsByTenant.set(route.tenantId, []);
      addedRowsByTenant.get(route.tenantId)!.push(inserted!);
      addedCount++;
    }

    // Run the SAME cleansing + categorization pipelines as file imports, so
    // Plaid items get a cleaned description, a suggested EXPENSE account
    // (the CATEGORY column / rules / AI), and a matchable classification state.
    // The per-tenant cleansing aggregates are summed and carried on the sync
    // result so callers/logs can see when the AI cleanup step degraded.
    const cleansing: CleansingAggregate = { processed: 0, aiCleansed: 0, aiFailed: 0, disabled: 0 };
    for (const [tid, rows] of addedRowsByTenant) {
      try {
        const { runCleansingPipeline, runCategorizationPipeline } = await import('./bank-feed.service.js');
        const agg = await runCleansingPipeline(tid, rows);
        cleansing.processed += agg.processed;
        cleansing.aiCleansed += agg.aiCleansed;
        cleansing.aiFailed += agg.aiFailed;
        cleansing.disabled += agg.disabled;
        if (!cleansing.firstError && agg.firstError) cleansing.firstError = agg.firstError;
        await runCategorizationPipeline(tid, rows);
      } catch (err) {
        // Pipelines are best-effort — the feed items are already inserted —
        // but a failure must be visible to operators, not swallowed.
        // eslint-disable-next-line no-console
        console.warn(
          `[plaid-sync] cleansing/categorization pipeline failed for tenant ${tid}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (cleansing.aiFailed > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[plaid-sync] AI cleanup unavailable for ${cleansing.aiFailed} of ${cleansing.processed} item(s)` +
        ` (item ${itemId}): ${cleansing.firstError ?? 'unknown error'}`,
      );
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
        originalDescription: txn.original_description || txn.name || txn.merchant_name || null,
        // Same signed convention as the insert path — never Math.abs().
        amount: String(txn.amount),
        checkNumber: (txn.check_number ? Number.parseInt(txn.check_number, 10) || null : null)
          ?? parseCheckNumber(txn.original_description || txn.name),
        memo: txn.payment_meta?.payee || null,
      }).where(eq(bankFeedItems.id, feedItem.id));
      modifiedCount++;
    }

    // Process removed transactions.
    //
    // A plaid_item belongs to one tenant (routed via plaidAccountMappings),
    // so `removed` transactions from Plaid should only affect bank feed
    // items for the tenants in routingMap. We scope the delete/update to
    // the tenant that owns each feed item row so an accidental
    // providerTransactionId collision across tenants can't touch rows
    // we don't control.
    for (const txn of removed) {
      const tid = txn.transaction_id;
      if (!tid) continue;

      const feedItems = await db.select().from(bankFeedItems).where(eq(bankFeedItems.providerTransactionId, tid));
      for (const feedItem of feedItems) {
        if (feedItem.status === 'pending') {
          await db.delete(bankFeedItems)
            .where(and(eq(bankFeedItems.tenantId, feedItem.tenantId), eq(bankFeedItems.id, feedItem.id)));
        } else {
          await db.update(bankFeedItems).set({
            category: `[REMOVED BY INSTITUTION] ${feedItem.category || ''}`.trim(),
          }).where(and(eq(bankFeedItems.tenantId, feedItem.tenantId), eq(bankFeedItems.id, feedItem.id)));
        }
        removedCount++;
      }
    }

    // Update sync cursor and status. A successful transactionsSync proves the
    // credentials work, so also self-heal any error status — webhook-less
    // installs never receive Plaid's LOGIN_REPAIRED webhook and would
    // otherwise show "login required" forever after a Fix Now repair.
    await db.update(plaidItems).set({
      syncCursor: nextCursor,
      lastSyncAt: new Date(),
      lastSyncStatus: 'success',
      lastSyncError: null,
      itemStatus: 'active',
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    }).where(eq(plaidItems.id, itemId));

    // Update account balances. Scope by (plaidItemId, plaidAccountId)
    // so a theoretical collision of the Plaid-supplied account_id
    // string between two unrelated items can't cross-contaminate
    // balances.
    try {
      const balances = await plaidClient.getBalances(accessToken);
      for (const b of balances) {
        await db.update(plaidAccounts).set({
          currentBalance: b.balances.current?.toString() || null,
          availableBalance: b.balances.available?.toString() || null,
          balanceUpdatedAt: new Date(),
        }).where(and(
          eq(plaidAccounts.plaidItemId, itemId),
          eq(plaidAccounts.plaidAccountId, b.account_id),
        ));
      }
    } catch { /* balance refresh is best-effort */ }

    return { added: addedCount, modified: modifiedCount, removed: removedCount, cleansing };
  } catch (err: any) {
    await db.update(plaidItems).set({
      lastSyncAt: new Date(), lastSyncStatus: 'error', lastSyncError: err.message || 'Sync failed', updatedAt: new Date(),
    }).where(eq(plaidItems.id, itemId));

    // Credential/consent failures flip the item into an error status and
    // notify the mapped tenants' owners — once, on the transition. Webhook-
    // less installs (the auto-sync scheduler path) otherwise never learn the
    // login broke.
    const plaidCode: string | undefined = err?.response?.data?.error_code;
    const credentialCodes = ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'USER_PERMISSION_REVOKED', 'ITEM_NOT_FOUND', 'ACCESS_NOT_GRANTED'];
    if (plaidCode && credentialCodes.includes(plaidCode)) {
      const wasHealthy = !item.itemStatus || item.itemStatus === 'active';
      await db.update(plaidItems).set({
        itemStatus: plaidCode === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error',
        errorCode: plaidCode,
        errorMessage: err?.response?.data?.error_message || err.message || null,
        updatedAt: new Date(),
      }).where(eq(plaidItems.id, itemId));
      if (wasHealthy) {
        const { sendConnectionErrorNotice } = await import('./email.service.js');
        sendConnectionErrorNotice(itemId, item.institutionName, err?.response?.data?.error_message || plaidCode)
          .catch((e) => console.warn('[plaid-sync] error notice failed:', e instanceof Error ? e.message : e));
      }
    }
    throw err;
  }
}

// Full re-import: reset the sync cursor so Plaid's transactionsSync
// replays the account's ENTIRE available history, then sync immediately.
// The normal sync cursor advances past delivered transactions and Plaid
// never resends them — so after deleting feed items/transactions locally
// (e.g. the admin date-range delete), a plain re-sync imports nothing.
// This is the escape hatch: dedup on providerTransactionId still prevents
// duplicates for rows that survived, while previously-deleted rows come
// back. Tenant-scoped: the item must have a mapping owned by the tenant.
export async function resetAndResyncItem(itemId: string, tenantId: string) {
  const owned = await db
    .select({ id: plaidAccountMappings.id })
    .from(plaidAccountMappings)
    .innerJoin(plaidAccounts, eq(plaidAccounts.id, plaidAccountMappings.plaidAccountId))
    .where(and(
      eq(plaidAccountMappings.tenantId, tenantId),
      eq(plaidAccounts.plaidItemId, itemId),
    ))
    .limit(1);
  if (owned.length === 0) {
    const { AppError } = await import('../utils/errors.js');
    throw AppError.notFound('Plaid connection not found for this tenant');
  }

  // Clear the cursor (full replay) and last_sync_at (so the immediate
  // syncItem below isn't turned away by the 30-second debounce claim).
  await db.update(plaidItems)
    .set({ syncCursor: null, lastSyncAt: null, updatedAt: new Date() })
    .where(eq(plaidItems.id, itemId));

  return syncItem(itemId);
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
