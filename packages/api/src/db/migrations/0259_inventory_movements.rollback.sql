-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0259 (inventory costing, U-157). The code that reads these
-- must be rolled back with it. Refused while the stock ledger has any row
-- (live or voided): dropping it would lose the quantities on hand and
-- average costs, and the older code would show the derived COGS lines as
-- form lines and let edits post over them (the 0258 rollback guard counts
-- on this one). Restore a backup taken before inventory was used instead.
-- Otherwise (no inventory was ever posted) nothing is lost.

DO $$
BEGIN
  IF to_regclass('public.inventory_movements') IS NOT NULL
     AND EXISTS (SELECT 1 FROM inventory_movements LIMIT 1) THEN
    RAISE EXCEPTION 'Rollback of 0259 stopped: inventory has been posted (inventory_movements has rows). Restore a backup taken before inventory was used instead.';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_jl_inventory_movement;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN IF EXISTS inventory_movement_id;
--> statement-breakpoint
DROP TABLE IF EXISTS inventory_movements;
