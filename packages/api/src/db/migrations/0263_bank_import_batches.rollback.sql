-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0263 (U-06). The import-batch route, its undo and the
-- connection lookup must be rolled back with it. Imported feed rows stay
-- (the older code sees ordinary manual-import rows). LOST: the batches
-- (undo is no longer possible), the rows' dedupe and row keys and their
-- possible-duplicate flags (a re-import
-- through the older /feed/import dedupes by date, amount and description
-- only) and the saved account identities and the companies' link keys (the next import asks for the
-- account again).
DROP INDEX IF EXISTS uq_bank_link_keys_company;
--> statement-breakpoint
DROP TABLE IF EXISTS bank_link_keys;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bank_connection_identities_connection;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_bank_connection_identities_hash;
--> statement-breakpoint
DROP TABLE IF EXISTS bank_connection_identities;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bfi_import_batch;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bfi_connection_row_key;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_bfi_connection_dedupe_key;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS possible_duplicate_of;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS possible_duplicate;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS source_line;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS dedupe_version;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS row_key;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS dedupe_key;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS import_batch_id;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bank_import_batches_scheduled;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bank_import_batches_account;
--> statement-breakpoint
DROP TABLE IF EXISTS bank_import_batches;
