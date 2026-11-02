-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0254 (Pay Sales Tax, U-150). Refused while any Pay Sales Tax
-- transaction (txn_type 'sales_tax_payment') exists, void or not: the code
-- before 0254 does not know the type. Delete those transactions first (or
-- restore a backup from before them), then roll back. Linked paid lines on
-- other transactions stay (0252's table). Opening lines of a "mark paid
-- through" run stay too (0252's table) but lose their run id: they can no
-- longer be undone after a rollback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE txn_type = 'sales_tax_payment') OR EXISTS (SELECT 1 FROM sales_tax_payments) THEN
    RAISE EXCEPTION '0254 rollback refused: Pay Sales Tax payments exist. Remove them first, then roll back.';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS sales_tax_payments;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_st_payment_lines_run;
--> statement-breakpoint
ALTER TABLE sales_tax_payment_lines DROP COLUMN IF EXISTS run_id;
--> statement-breakpoint
DROP TABLE IF EXISTS sales_tax_mark_paid_runs;
