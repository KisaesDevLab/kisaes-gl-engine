// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Per-client bank-feed and Plaid state for the Clients screen — one row per
 * tenant the caller can reach. Kept off GET /auth/me deliberately: that
 * endpoint runs on every app boot, and these are aggregate queries.
 */
export interface ClientBankingStatus {
  tenantId: string;
  /**
   * Bank-feed items still waiting on someone — everything not matched,
   * categorized or excluded. This is the Bank Feed page's own "Hide processed"
   * predicate, so the number here equals the row count the user sees after
   * clicking through. Note the dashboard's banner counts only 'pending' and so
   * reads lower.
   */
  unprocessedBankTxns: number;
  /**
   * Most recent Plaid sync ATTEMPT across the client's connected items, ISO
   * 8601, or null when nothing has ever run. plaid_items.last_sync_at is
   * stamped on claim, success and failure alike and there is no
   * last-successful-sync column, so a fresh timestamp does not by itself mean
   * transactions arrived — read it together with `plaidNeedsAttention`.
   */
  lastPlaidSyncAt: string | null;
  /**
   * Non-removed, sync-enabled Plaid items mapped into this client. 0 means no
   * PLAID connection — a client fed by CSV/OFX import still has bank feed items
   * with zero here, so don't render this as "no bank".
   */
  plaidConnectionCount: number;
  /** Some connection is erroring or needs the client to re-authenticate. */
  plaidNeedsAttention: boolean;
}
