-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0260 (units of measure, U-161). The code that reads these
-- must be rolled back with it. Refused while any journal line names a unit:
-- the older code would read such a line's quantity (in the entered unit) as
-- base units and re-cost the item wrongly on its next edit. Void or re-enter
-- those lines in the base unit first. Otherwise LOST: the unit sets and the
-- items' unit set and default units (nothing posted depends on them).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'journal_lines' AND column_name = 'unit_id')
     AND EXISTS (SELECT 1 FROM journal_lines WHERE unit_id IS NOT NULL LIMIT 1) THEN
    RAISE EXCEPTION 'Rollback of 0260 stopped: journal lines name units of measure. Re-enter those lines in the base unit (or void them) first.';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_jl_unit;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN IF EXISTS base_quantity;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN IF EXISTS unit_id;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS default_sale_unit_id;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS default_purchase_unit_id;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS unit_set_id;
--> statement-breakpoint
DROP TABLE IF EXISTS unit_set_units;
--> statement-breakpoint
DROP TABLE IF EXISTS unit_sets;
