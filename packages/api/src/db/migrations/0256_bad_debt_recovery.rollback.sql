-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0256 (bad-debt recoveries, U-154). Refused while any
-- recovery (txn_type 'bad_debt_recovery') exists, void or not: the code
-- before 0256 does not know the type. Delete those transactions first (or
-- restore a backup from before them), then roll back. SSUTA discount and
-- bad-debt tax rows (transaction_tax_lines, 0252) stay.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE txn_type = 'bad_debt_recovery') OR EXISTS (SELECT 1 FROM write_off_recoveries) THEN
    RAISE EXCEPTION '0256 rollback refused: bad-debt recoveries exist. Remove them first, then roll back.';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS write_off_recoveries;