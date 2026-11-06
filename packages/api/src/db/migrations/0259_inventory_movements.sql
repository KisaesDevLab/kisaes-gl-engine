-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Average-cost inventory costing (U-157 inventory-costing-v1).
--
-- 1. inventory_movements: one row per (transaction, item), written in the
--    posting's database transaction. Signed quantity; value_mode given (the
--    document carries the value: receipts, vendor returns, adjustments with
--    a value) or derived (valued at average cost: sales, customer returns,
--    quantity-only adjustments); the written value, negative-stock
--    correction and zero-quantity residual (each signed by its effect on the
--    inventory asset account); the item's purchase cost when the line was
--    posted (fallback_cost); and the running figures after the row:
--    running_qty, running_value (what the GL holds), true_value and
--    last_cost (the true last positive average). Position: (movement_date,
--    sort_rank, txn_created_at, transaction_id); sort_rank 0 is a cost
--    restatement, 1 anything else; txn_created_at is the transaction's
--    created_at, kept on edits. A voided or deleted document's rows stay,
--    voided = true. Soft references (no FK), like transaction_tax_lines.
-- 2. journal_lines.inventory_movement_id: the movement an item line or a
--    derived line (line_role cogs | inventory_relief | cost_correction |
--    cost_residual, written only by the costing walk) belongs to.
-- 3. transactions.system_kind: NULL, or cost_restatement on the system
--    inventory_adjustment the walk posts at the first open date (E2b).
--
-- Additive only. Ordering: after 0258. Rollback:
-- 0259_inventory_movements.rollback.sql.

CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  item_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  movement_date date NOT NULL,
  sort_rank smallint NOT NULL DEFAULT 1 CONSTRAINT inventory_movements_sort_rank_ck CHECK (sort_rank IN (0, 1)),
  txn_created_at timestamptz NOT NULL,
  kind varchar(20) NOT NULL CONSTRAINT inventory_movements_kind_ck
    CHECK (kind IN ('receipt', 'sale', 'customer_return', 'vendor_return', 'adjust_qty', 'adjust_value', 'restatement')),
  quantity numeric(12,4) NOT NULL DEFAULT 0,
  value_mode varchar(10) NOT NULL CONSTRAINT inventory_movements_value_mode_ck CHECK (value_mode IN ('given', 'derived')),
  value numeric(19,4) NOT NULL DEFAULT 0,
  correction numeric(19,4) NOT NULL DEFAULT 0,
  residual numeric(19,4) NOT NULL DEFAULT 0,
  fallback_cost numeric(19,6),
  running_qty numeric(12,4) NOT NULL DEFAULT 0,
  running_value numeric(19,4) NOT NULL DEFAULT 0,
  true_value numeric(19,4) NOT NULL DEFAULT 0,
  last_cost numeric(19,6) NOT NULL DEFAULT 0,
  voided boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movements_txn_item ON inventory_movements (transaction_id, item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inventory_movements_position
  ON inventory_movements (company_id, item_id, movement_date, sort_rank, txn_created_at, transaction_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inventory_movements_tenant ON inventory_movements (tenant_id);
--> statement-breakpoint
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS inventory_movement_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_inventory_movement ON journal_lines (inventory_movement_id) WHERE inventory_movement_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS system_kind varchar(30);
