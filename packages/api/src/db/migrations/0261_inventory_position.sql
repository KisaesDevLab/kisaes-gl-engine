-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Stock ledger position and corrected sale cost (U-162, ClientLedger PR-4).
--
-- 1. inventory_movements.source_movement_date / source_txn_created_at
--    (PR-4 B1, RB1): on a linked return row, its sale's position (the sale
--    row's movement_date and txn_created_at; null on every other row). A
--    credit memo can hold several rows of one part (one per linked sale, plus
--    the unlinked units); inside the document the unlinked row comes first,
--    then the linked rows by their sale's position. Both values survive a
--    tenant export / import unchanged, unlike the ids, so the order does too.
--    The costing service keeps them current when a sale moves date.
-- 2. idx_inventory_movements_position takes those two columns, then
--    source_transaction_id and id (the full position, services/inventory-position.ts).
-- 3. inventory_movements.correction_share (PR-4 S5): on a sale row, the
--    negative-stock corrections the walk attributed to the units it sold
--    short (first short, first cured; a linked return cures its own sale's
--    units first). A return linked to the sale comes back at relief +
--    correction_share. 0 on every other row. Written by the walk; rows posted
--    before this migration hold 0 until a walk passes over them (a tenant
--    import re-walks every item).
-- 4. Data step: the running figures (running_qty, running_value, last_cost)
--    of every item with a document holding more than one live row of it are
--    recomputed in the new order from the rows' stored figures (value,
--    correction, residual: unchanged, so no ledger line and no balance
--    moves). Before 0261 the rows of one document had no defined order, so
--    "the latest row" of such an item could carry a mid-document state.
--
-- Additive only. Ordering: after 0260. Rollback:
-- 0261_inventory_position.rollback.sql (always allowed; the older code does
-- not read the columns and orders by the shorter key).

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS correction_share numeric(19,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS source_movement_date date;
--> statement-breakpoint
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS source_txn_created_at timestamp with time zone;
--> statement-breakpoint
UPDATE inventory_movements r SET source_movement_date = s.movement_date, source_txn_created_at = s.txn_created_at
  FROM inventory_movements s
  WHERE r.source_transaction_id IS NOT NULL AND s.tenant_id = r.tenant_id AND s.transaction_id = r.source_transaction_id
    AND s.item_id = r.item_id AND s.source_transaction_id IS NULL
    AND (r.source_movement_date IS DISTINCT FROM s.movement_date OR r.source_txn_created_at IS DISTINCT FROM s.txn_created_at);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_inventory_movements_position;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inventory_movements_position
  ON inventory_movements (company_id, item_id, movement_date, txn_created_at, transaction_id,
    source_movement_date NULLS FIRST, source_txn_created_at NULLS FIRST, source_transaction_id NULLS FIRST, id);
--> statement-breakpoint
WITH affected AS (
  SELECT DISTINCT company_id, item_id FROM inventory_movements
  WHERE voided = false GROUP BY company_id, item_id, transaction_id HAVING count(*) > 1
), ordered AS (
  SELECT m.id,
    SUM(m.quantity) OVER w AS rq,
    SUM(m.value + m.correction + m.residual) OVER w AS rv,
    m.company_id, m.item_id, m.movement_date, m.txn_created_at, m.transaction_id, m.source_movement_date, m.source_txn_created_at, m.source_transaction_id
  FROM inventory_movements m JOIN affected a ON a.company_id = m.company_id AND a.item_id = m.item_id
  WHERE m.voided = false
  WINDOW w AS (PARTITION BY m.company_id, m.item_id ORDER BY m.movement_date, m.txn_created_at, m.transaction_id,
    m.source_movement_date NULLS FIRST, m.source_txn_created_at NULLS FIRST, m.source_transaction_id NULLS FIRST, m.id ROWS UNBOUNDED PRECEDING)
), grouped AS (
  -- L: the last positive average round6(V/Q) after the latest row that left Q > 0 and V > 0 (0 before any).
  SELECT o.*, CASE WHEN o.rq > 0 AND o.rv > 0 THEN round(o.rv::numeric(60,30) / o.rq, 6) END AS avg,
    count(CASE WHEN o.rq > 0 AND o.rv > 0 THEN 1 END) OVER (PARTITION BY o.company_id, o.item_id ORDER BY o.movement_date, o.txn_created_at,
      o.transaction_id, o.source_movement_date NULLS FIRST, o.source_txn_created_at NULLS FIRST, o.source_transaction_id NULLS FIRST, o.id
      ROWS UNBOUNDED PRECEDING) AS grp
  FROM ordered o
), running AS (
  SELECT g.id, g.rq, g.rv,
    COALESCE(first_value(g.avg) OVER (PARTITION BY g.company_id, g.item_id, g.grp ORDER BY g.movement_date, g.txn_created_at, g.transaction_id,
      g.source_movement_date NULLS FIRST, g.source_txn_created_at NULLS FIRST, g.source_transaction_id NULLS FIRST, g.id), 0) AS l
  FROM grouped g
)
UPDATE inventory_movements m SET running_qty = r.rq, running_value = r.rv, last_cost = r.l
  FROM running r
  WHERE m.id = r.id AND (m.running_qty <> r.rq OR m.running_value <> r.rv OR m.last_cost <> r.l);
