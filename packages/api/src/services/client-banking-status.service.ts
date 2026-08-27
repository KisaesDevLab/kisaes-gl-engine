// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { ClientBankingStatus } from '@kis-books/shared';
import { db } from '../db/index.js';

/**
 * Bank-feed backlog and Plaid freshness for every client the caller can reach,
 * for the Clients screen.
 *
 * This query deliberately crosses tenants, so it is the one place the usual
 * `WHERE tenant_id = <request tenant>` rule (CLAUDE.md #17) does not apply. The
 * tenant set comes from `user_tenant_access` for the calling user and NEVER
 * from client input — the same table `getAccessibleTenants` reads and
 * `switchTenant` re-checks, so this exposes nothing the caller could not
 * already see by switching into each client.
 *
 * One statement, two grouped subqueries — no per-tenant round trip. A firm with
 * hundreds of clients still costs a single query.
 */
export async function getForUser(userId: string): Promise<ClientBankingStatus[]> {
  const rows = await db.execute(sql`
    WITH my_tenants AS (
      SELECT uta.tenant_id
      FROM user_tenant_access uta
      WHERE uta.user_id = ${userId} AND uta.is_active = true
    ),
    feed AS (
      -- Character-for-character the Bank Feed's own actionableOnly predicate
      -- (bank-feed.service.list). Exclusion, not an IN-list of the states we
      -- expect: 'categorizing' is a transient claim that a crash mid-post can
      -- strand, and such a row still shows on the Bank Feed — an IN-list would
      -- report the client as clean while work sits there. Tenant-only scoping
      -- is intentional: Plaid-sourced rows carry a NULL company_id, so a
      -- company filter would return zero.
      SELECT bfi.tenant_id, COUNT(*) AS unprocessed
      FROM bank_feed_items bfi
      WHERE bfi.tenant_id IN (SELECT tenant_id FROM my_tenants)
        AND bfi.status NOT IN ('matched', 'categorized', 'excluded')
      GROUP BY bfi.tenant_id
    ),
    plaid AS (
      -- plaid_items are appliance-global (no tenant_id); a tenant reaches them
      -- only through its account mappings, and one client commonly maps
      -- accounts from several institutions — hence MAX/BOOL_OR rather than a
      -- single row. Removed or sync-disabled items must not drag the
      -- timestamp, so they are excluded here rather than in the caller.
      SELECT pam.tenant_id,
             MAX(pi.last_sync_at) AS last_sync_at,
             COUNT(DISTINCT pi.id) AS item_count,
             -- "anything but healthy", matching the plaid-connection-health
             -- check rather than listing the statuses we happen to know about:
             -- 'revoked' (set by the USER_PERMISSION_REVOKED webhook, and it
             -- leaves removed_at NULL so the item is still counted here) would
             -- fall through an IN-list and render as an unremarkable timestamp,
             -- which is the one case this column exists to catch.
             BOOL_OR(
               COALESCE(pi.item_status, 'active') <> 'active'
               OR pi.error_code IS NOT NULL
               OR pi.last_sync_status = 'error'
             ) AS needs_attention
      FROM plaid_account_mappings pam
      JOIN plaid_accounts pa ON pa.id = pam.plaid_account_id
      JOIN plaid_items pi ON pi.id = pa.plaid_item_id
      WHERE pam.tenant_id IN (SELECT tenant_id FROM my_tenants)
        AND pam.is_sync_enabled = true
        AND pi.removed_at IS NULL
      GROUP BY pam.tenant_id
    )
    SELECT mt.tenant_id,
           COALESCE(f.unprocessed, 0)::int AS unprocessed,
           p.last_sync_at,
           COALESCE(p.item_count, 0)::int AS item_count,
           COALESCE(p.needs_attention, false) AS needs_attention
    FROM my_tenants mt
    LEFT JOIN feed f ON f.tenant_id = mt.tenant_id
    LEFT JOIN plaid p ON p.tenant_id = mt.tenant_id
  `);

  return (rows.rows as Array<{
    tenant_id: string;
    unprocessed: number;
    last_sync_at: string | Date | null;
    item_count: number;
    needs_attention: boolean;
  }>).map((r) => ({
    tenantId: r.tenant_id,
    unprocessedBankTxns: Number(r.unprocessed),
    lastPlaidSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    plaidConnectionCount: Number(r.item_count),
    plaidNeedsAttention: !!r.needs_attention,
  }));
}
