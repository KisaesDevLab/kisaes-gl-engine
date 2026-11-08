-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0265 (U-166). The line-level match code must be rolled back
-- with it. Items keep matched_transaction_id, so the older engine still sees
-- them as matched (to the whole transaction). An item whose entry was voided
-- keeps pointing at the void entry, as the older engine left it.
-- LOST: which line of a transaction an item matched; the "Entry voided" flag.
DROP INDEX IF EXISTS idx_bfi_entry_voided;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bfi_matched_txn;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_bfi_matched_journal_line;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS entry_voided_at;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS matched_journal_line_id;
