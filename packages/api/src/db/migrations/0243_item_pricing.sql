-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Item kinds and pricing (U-39a item-kinds-sales-v1, U-40 price-levels-v1,
-- U-129 invoice-pricing-v1).
--
-- U-39a: items.item_type (service | non_inventory | other_charge | discount
-- | subtotal; existing rows read as service) and items.discount_percent (a
-- discount item's percent off, 0 < p <= 100; a discount item without one
-- takes unit_price as the amount off).
--
-- U-40: price_levels (a name and a signed percent: -7.5 is 7.5 % down) and
-- price_level_items (a fixed price for chosen items, one per level and
-- item); contacts.price_level_id (one level per client). Soft references
-- (no FK), like document_send_events.
--
-- U-129: journal_lines.discount_percent (the percent a discount line used,
-- so the invoice reads back as entered) and journal_lines.unit_price_source
-- (where a line's price came from: input | item | price_level |
-- price_level_percent | none).
--
-- Additive only; PostgreSQL 11+ adds the columns without a rewrite (the
-- item_type default is a constant). Ordering: after 0242.
-- Rollback: 0243_item_pricing.rollback.sql.

ALTER TABLE items ADD COLUMN IF NOT EXISTS item_type varchar(20) NOT NULL DEFAULT 'service';
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS discount_percent numeric(7,4);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_item_type_ck') THEN
    ALTER TABLE items ADD CONSTRAINT items_item_type_ck
      CHECK (item_type IN ('service', 'non_inventory', 'other_charge', 'discount', 'subtotal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_discount_percent_ck') THEN
    ALTER TABLE items ADD CONSTRAINT items_discount_percent_ck
      CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS price_level_id uuid;
--> statement-breakpoint
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS discount_percent numeric(7,4);
--> statement-breakpoint
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS unit_price_source varchar(30);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS price_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  name varchar(100) NOT NULL,
  percent numeric(8,4) NOT NULL DEFAULT 0
    CONSTRAINT price_levels_percent_ck CHECK (percent >= -100 AND percent <= 1000),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_price_levels_tenant ON price_levels (tenant_id, company_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS price_level_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  price_level_id uuid NOT NULL,
  item_id uuid NOT NULL,
  unit_price numeric(19,4) NOT NULL CONSTRAINT price_level_items_price_ck CHECK (unit_price >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_level_items_level_item ON price_level_items (price_level_id, item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_price_level_items_tenant ON price_level_items (tenant_id);
