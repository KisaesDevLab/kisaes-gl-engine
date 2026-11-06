-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0258 (inventory part items, U-39b / U-156 / U-25). The code
-- that reads these must be rolled back with it. Roll back 0259
-- (inventory_movements) first: while that table exists and holds any
-- movement, this rollback stops with a clear message instead of losing
-- stock and cost history. Otherwise inventory parts become non_inventory
-- items (their posted lines and the ledger are untouched); LOST: purchase
-- descriptions and costs, expense / asset / COGS accounts, preferred
-- vendors, reorder points and quantities, unit labels, the company
-- inventory switch and the inventory_asset account tag (the account stays).

DO $$
BEGIN
  IF to_regclass('public.inventory_movements') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM inventory_movements LIMIT 1) THEN
      RAISE EXCEPTION 'Rollback of 0258 stopped: inventory_movements holds stock movements. Roll back 0259 first (it keeps the posted documents) or export the company.';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
UPDATE items SET item_type = 'non_inventory' WHERE item_type = 'inventory_part';
--> statement-breakpoint
UPDATE accounts SET system_tag = NULL WHERE system_tag = 'inventory_asset';
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_reorder_ck;
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_purchase_cost_ck;
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_inventory_accounts_ck;
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_item_type_ck;
--> statement-breakpoint
ALTER TABLE items ADD CONSTRAINT items_item_type_ck
  CHECK (item_type IN ('service', 'non_inventory', 'other_charge', 'discount', 'subtotal'));
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS inventory_enabled;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS unit_label;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS reorder_quantity;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS reorder_point;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS preferred_vendor_id;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS cogs_account_id;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS asset_account_id;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS expense_account_id;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS purchase_cost;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS purchase_description;
