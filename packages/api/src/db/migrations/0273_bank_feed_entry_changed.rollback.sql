-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0273 (U-199). The entry-changed code must be rolled back with
-- it. A flagged row keeps its status and matched_transaction_id; one whose
-- line was cleared (an account move, or the 0273 backfill) then has no line
-- recorded, so the older engine treats it as a match made before 0265: it
-- holds the whole entry and is a reconcile pre-check source again.
-- LOST: the "Entry changed" flag (its audit rows stay).
DROP INDEX IF EXISTS idx_bfi_entry_changed;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS entry_changed_at;
