-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0259 (inventory costing, U-157). The code that reads these
-- must be rolled back with it. The posted documents and every journal line
-- stay, derived COGS lines included, so balances and reports are unchanged;
-- LOST: the stock ledger (quantities on hand, average costs and the link
-- from lines to movements) and the system_kind mark of cost restatements
-- (they read as ordinary inventory adjustments). Derived lines keep their
-- line_role, which the older code does not hide from document readers.

DROP INDEX IF EXISTS idx_jl_inventory_movement;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN IF EXISTS inventory_movement_id;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS system_kind;
--> statement-breakpoint
DROP TABLE IF EXISTS inventory_movements;
