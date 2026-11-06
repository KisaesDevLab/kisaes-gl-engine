-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Units of measure (U-161 units-of-measure-v1, Q-P24i).
--
-- 1. unit_sets: a named set with its base unit (name, abbreviation).
--    unit_set_units: the set's other units, each a fixed factor = base units
--    per unit (> 0, at most 6 places, at most 1,000,000). A unit named on a
--    posted line keeps its factor and set (409 UNIT_IN_USE, Q-P24w).
-- 2. items.unit_set_id and the default purchase / sale unit (NULL = the base
--    unit). An item's set changes only while no posted line names the item.
-- 3. journal_lines.unit_id (NULL = the base unit) and base_quantity =
--    round4(quantity x factor), half away from zero (Q-P24v), stored only
--    when the line names a unit. quantity and unit_price stay in the entered
--    unit, so the line amount never changes; costing, on hand and reports
--    read base_quantity, falling back to quantity.
-- Soft references (no FK), like inventory_movements. items.unit_label stays
-- as the display unit of an item without a unit set.
--
-- Additive only. Ordering: after 0259. Rollback:
-- 0260_units_of_measure.rollback.sql (refused while any line names a unit).

CREATE TABLE IF NOT EXISTS unit_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  base_unit_name varchar(30) NOT NULL,
  base_unit_abbreviation varchar(10),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_sets_name ON unit_sets (tenant_id, company_id, lower(name));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS unit_set_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  unit_set_id uuid NOT NULL,
  name varchar(30) NOT NULL,
  abbreviation varchar(10),
  factor numeric(19,6) NOT NULL CONSTRAINT unit_set_units_factor_ck CHECK (factor > 0 AND factor <= 1000000),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_set_units_name ON unit_set_units (unit_set_id, lower(name));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_unit_set_units_tenant ON unit_set_units (tenant_id);
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS unit_set_id uuid;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS default_purchase_unit_id uuid;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS default_sale_unit_id uuid;
--> statement-breakpoint
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS unit_id uuid;
--> statement-breakpoint
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS base_quantity numeric(12,4);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_unit ON journal_lines (unit_id) WHERE unit_id IS NOT NULL;
