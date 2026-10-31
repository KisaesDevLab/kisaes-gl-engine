-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0243 (item kinds and pricing: U-39a, U-40, U-129). The code
-- that reads the columns and tables must be rolled back with it. Lost: item
-- kinds (discount and subtotal items read as ordinary items again), discount
-- percents, price levels and their item prices, clients' price levels, and
-- the percent and price source of posted invoice lines (their amounts and
-- the ledger are untouched).

DROP TABLE IF EXISTS price_level_items;
--> statement-breakpoint
DROP TABLE IF EXISTS price_levels;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN IF EXISTS unit_price_source;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN IF EXISTS discount_percent;
--> statement-breakpoint
ALTER TABLE contacts DROP COLUMN IF EXISTS price_level_id;
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_discount_percent_ck;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS discount_percent;
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_item_type_ck;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS item_type;
