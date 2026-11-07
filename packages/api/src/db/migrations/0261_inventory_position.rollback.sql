-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0261 (U-162). Always allowed: the older code orders by the
-- shorter position key and never reads correction_share or the sale
-- position of a linked return. LOST: the corrected cost of sales sold
-- short (returns linked to them that the older code re-walks come back at
-- the sale's relief again) and the defined order of a credit memo's rows of
-- one part. The running figures the forward data step recomputed stay (they
-- are valid for any order the older code may pick until its next walk).

DROP INDEX IF EXISTS idx_inventory_movements_position;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inventory_movements_position
  ON inventory_movements (company_id, item_id, movement_date, txn_created_at, transaction_id);
--> statement-breakpoint
ALTER TABLE inventory_movements DROP COLUMN IF EXISTS source_txn_created_at;
--> statement-breakpoint
ALTER TABLE inventory_movements DROP COLUMN IF EXISTS source_movement_date;
--> statement-breakpoint
ALTER TABLE inventory_movements DROP COLUMN IF EXISTS correction_share;
