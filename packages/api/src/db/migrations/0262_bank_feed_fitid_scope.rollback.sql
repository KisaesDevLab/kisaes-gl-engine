-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0262 (U-163). Restores the unique index on
-- (tenant_id, provider_transaction_id). Since 0262 two bank connections of
-- one tenant may hold the same id; before the old index is rebuilt, every
-- such row except the oldest (created_at, id) loses its provider id.
-- LOST: the provider id of those later rows. The rows themselves stay; the
-- older code dedupes them by date, amount and description instead.
UPDATE bank_feed_items b
   SET provider_transaction_id = NULL
  FROM (
    SELECT id, row_number() OVER (
             PARTITION BY tenant_id, provider_transaction_id ORDER BY created_at, id
           ) AS n
      FROM bank_feed_items
     WHERE provider_transaction_id IS NOT NULL
  ) d
 WHERE b.id = d.id AND d.n > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_bfi_provider_txn
  ON bank_feed_items (tenant_id, provider_transaction_id);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bfi_tenant_provider_txn;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_bfi_connection_provider_txn;
