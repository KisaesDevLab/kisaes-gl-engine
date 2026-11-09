-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0271 (U-189). Entries already posted for a service charge or
-- interest stay in the books (they are ordinary expenses / deposits); only
-- the reconciliation's record of them and any not-yet-posted charge figures
-- are lost.
ALTER TABLE reconciliations DROP COLUMN IF EXISTS include_later_lines;
--> statement-breakpoint
ALTER TABLE reconciliations DROP COLUMN IF EXISTS interest_txn_id;
--> statement-breakpoint
ALTER TABLE reconciliations DROP COLUMN IF EXISTS interest_account_id;
--> statement-breakpoint
ALTER TABLE reconciliations DROP COLUMN IF EXISTS interest_date;
--> statement-breakpoint
ALTER TABLE reconciliations DROP COLUMN IF EXISTS interest_amount;
--> statement-breakpoint
ALTER TABLE reconciliations DROP COLUMN IF EXISTS service_charge_txn_id;
--> statement-breakpoint
ALTER TABLE reconciliations DROP COLUMN IF EXISTS service_charge_account_id;
--> statement-breakpoint
ALTER TABLE reconciliations DROP COLUMN IF EXISTS service_charge_date;
--> statement-breakpoint
ALTER TABLE reconciliations DROP COLUMN IF EXISTS service_charge_amount;
