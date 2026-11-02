-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0254 (Pay Sales Tax, U-150). Refused while any Pay Sales Tax
-- transaction (txn_type 'sales_tax_payment') exists, void or not: the code
-- before 0254 does not know the type. Delete those transactions first (or
-- restore a backup from before them), then roll back. Linked paid lines on
-- other transactions stay (0252's table).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE txn_type = 'sales_tax_payment') OR EXISTS (SELECT 1 FROM sales_tax_payments) THEN
    RAISE EXCEPTION '0254 rollback refused: Pay Sales Tax payments exist. Remove them first, then roll back.';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS sales_tax_payments;