-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- last_sync_at cannot answer "is this feed fresh?".
--
-- The sync path bumps it TWICE for reasons unrelated to success: once as a
-- 30-second atomic claim before the sync runs (so two workers cannot both
-- sync an item), and again in the error handler. So an item whose sync has
-- failed every night for a month still has a last_sync_at of a few hours ago.
--
-- That silently disabled the staleness arm of the plaid_connection_health
-- review check, which asks whether last_sync_at is older than 7 days. For any
-- item the scheduler is still attempting — which is every item that matters —
-- the answer is permanently no. The check has been running and finding
-- nothing on that arm since it shipped.
--
-- A separate column, written ONLY on a successful sync, is the honest signal.
-- Nullable with no backfill: NULL means "has not succeeded since this
-- shipped", which readers treat as unknown rather than stale, so nobody wakes
-- up to 9 false alarms the morning after deploy.

ALTER TABLE plaid_items
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
--> statement-breakpoint

-- Seed from last_sync_at where the last attempt actually succeeded. Those are
-- true statements today, and it means the signal is useful immediately rather
-- than after every item has synced once more.
UPDATE plaid_items
   SET last_success_at = last_sync_at
 WHERE last_sync_status = 'success'
   AND last_sync_at IS NOT NULL
   AND last_success_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_plaid_items_last_success
  ON plaid_items (last_success_at)
  WHERE removed_at IS NULL;
