-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Inventory part items, the inventory asset account and the company
-- inventory switch (U-39b item-types-v1, U-156 inventory-account-v1, U-25
-- company-inventory-flag-v1).
--
-- 1. items.item_type adds inventory_part. items_item_type_ck is widened
--    (dropped and re-added with the extra value in this file); every
--    existing row satisfies the new rule. The marker above is needed because
--    the policy check treats any constraint replacement as non-additive (the
--    0087 / 0235 / 0238 precedent).
-- 2. Purchase side on every item kind: purchase_description, purchase_cost
--    (19,4), expense_account_id, preferred_vendor_id. Parts add
--    asset_account_id and cogs_account_id (both required on a part:
--    items_inventory_accounts_ck), reorder_point / reorder_quantity (12,4,
--    NULL = none) and unit_label (a display label, at most 10 characters,
--    Q-P24i). Soft references (no FK), like items.tax_code_id.
-- 3. companies.inventory_enabled: NULL = off (existing and MyBooks Online
--    companies keep today's behaviour until the switch is turned on).
-- 4. accounts.system_tag takes 'inventory_asset' (U-156); the column has no
--    CHECK, so no DDL is needed for it.
--
-- Additive otherwise; PostgreSQL 11+ adds the nullable columns without a
-- rewrite. Ordering: after 0257. Rollback: 0258_inventory_items.rollback.sql.

ALTER TABLE items ADD COLUMN IF NOT EXISTS purchase_description text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS purchase_cost numeric(19,4);
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS expense_account_id uuid;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS asset_account_id uuid;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS cogs_account_id uuid;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS preferred_vendor_id uuid;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS reorder_point numeric(12,4);
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS reorder_quantity numeric(12,4);
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS unit_label varchar(10);
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS inventory_enabled boolean;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'items_item_type_ck' AND pg_get_constraintdef(oid) NOT LIKE '%inventory_part%'
  ) THEN
    ALTER TABLE items DROP CONSTRAINT items_item_type_ck;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_item_type_ck') THEN
    ALTER TABLE items ADD CONSTRAINT items_item_type_ck
      CHECK (item_type IN ('service', 'non_inventory', 'other_charge', 'discount', 'subtotal', 'inventory_part'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_inventory_accounts_ck') THEN
    ALTER TABLE items ADD CONSTRAINT items_inventory_accounts_ck
      CHECK (item_type <> 'inventory_part' OR (asset_account_id IS NOT NULL AND cogs_account_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_purchase_cost_ck') THEN
    ALTER TABLE items ADD CONSTRAINT items_purchase_cost_ck
      CHECK (purchase_cost IS NULL OR purchase_cost >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_reorder_ck') THEN
    ALTER TABLE items ADD CONSTRAINT items_reorder_ck
      CHECK ((reorder_point IS NULL OR reorder_point >= 0) AND (reorder_quantity IS NULL OR reorder_quantity > 0));
  END IF;
END $$;
