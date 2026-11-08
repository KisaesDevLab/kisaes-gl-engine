-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- migration-policy: non-additive-exception
-- Drops idx_bfi_provider_txn, replaced by the two indexes built below under
-- other names (an index drop loses no data; DROPPED_INDEXES in
-- tenant-portability/compat.ts records it for the import policy).
--
-- A bank's transaction id (OFX FITID, Plaid transaction_id) is unique per
-- bank account, not per tenant (U-163). The old unique index on
-- (tenant_id, provider_transaction_id) made a second account's transaction
-- with an id another account already used look like a duplicate. The id
-- is now unique per bank connection (partial: rows without one are not
-- constrained), and a plain index keeps the tenant-wide lookups of the
-- Plaid sync fast. Every existing row satisfies the new index: a
-- connection belongs to one tenant, so ids unique per tenant are unique
-- per connection. The indexes are built inside the migration transaction
-- (not CONCURRENTLY); bank_feed_items is locked against writes while they
-- build.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bfi_connection_provider_txn
  ON bank_feed_items (bank_connection_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfi_tenant_provider_txn
  ON bank_feed_items (tenant_id, provider_transaction_id);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bfi_provider_txn;
