-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Stock ledger position and corrected sale cost (U-162, ClientLedger PR-4).
--
-- 1. idx_inventory_movements_position takes source_transaction_id and id
--    (PR-4 B1): a credit memo can hold several rows of one part (one per
--    linked sale, plus the unlinked units), and every ordered read now breaks
--    that tie by (source_transaction_id NULLS FIRST, id), so the walk, the
--    seed and "the latest row" (on hand, valuation, count sheet) agree.
-- 2. inventory_movements.correction_share (PR-4 S5): on a sale row, the
--    negative-stock corrections the walk attributed to the units it sold
--    short (first short, first cured). A return linked to the sale comes back
--    at relief + correction_share. 0 on every other row. Written by the walk;
--    rows posted before this migration hold 0 until a walk passes over them.
--
-- Additive only. Ordering: after 0260. Rollback:
-- 0261_inventory_position.rollback.sql (always allowed; the older code does
-- not read the column and orders by the shorter key).

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS correction_share numeric(19,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_inventory_movements_position;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inventory_movements_position
  ON inventory_movements (company_id, item_id, movement_date, txn_created_at, transaction_id, source_transaction_id NULLS FIRST, id);
