-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0266 (U-168, U-174). The rule attribution and duplicate
-- decision code must be rolled back with it. Items removed as duplicates
-- stay excluded (Restore still works); the older engine's import Undo then
-- counts them as used again.
-- LOST: which rule staged each suggestion; why an item was excluded; legacy
-- rule attribution on classification rows.
DROP INDEX IF EXISTS idx_bfi_suggested_rule;
--> statement-breakpoint
ALTER TABLE transaction_classification_state DROP COLUMN IF EXISTS matched_bank_rule_id;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS exclusion_reason;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS suggested_rule_kind;
--> statement-breakpoint
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS suggested_rule_id;
