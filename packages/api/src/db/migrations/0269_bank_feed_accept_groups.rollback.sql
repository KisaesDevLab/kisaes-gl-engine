-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0269 (U-169). The feed accept/undo code must be rolled back
-- with it. Accepted items keep their entries and links (the older engine
-- shows them as categorized or matched, as before).
-- LOST: Undo for earlier accepts (the records and each item's prior state).
DROP TABLE IF EXISTS bank_feed_accept_group_items;
--> statement-breakpoint
DROP TABLE IF EXISTS bank_feed_accept_groups;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_bfi_waiting_amount;
