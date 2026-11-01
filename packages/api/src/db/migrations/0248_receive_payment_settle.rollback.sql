-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0248 (write-offs, credits, refunds, discounts; U-133, U-134).
-- The code that reads the columns must be rolled back with it. Lost: which
-- part of each application was a write-off or a discount and where it posted
-- (the postings stay, balanced), when a credit was applied later and inside
-- which payment, which refunds drew on which credit, and the write-off and
-- sales discount preferences. Invoice balances are unchanged.

DROP INDEX IF EXISTS idx_pa_applied_in;
--> statement-breakpoint
ALTER TABLE payment_applications DROP COLUMN IF EXISTS write_off_amount;
--> statement-breakpoint
ALTER TABLE payment_applications DROP COLUMN IF EXISTS write_off_account_id;
--> statement-breakpoint
ALTER TABLE payment_applications DROP COLUMN IF EXISTS discount_amount;
--> statement-breakpoint
ALTER TABLE payment_applications DROP COLUMN IF EXISTS discount_account_id;
--> statement-breakpoint
ALTER TABLE payment_applications DROP COLUMN IF EXISTS applied_date;
--> statement-breakpoint
ALTER TABLE payment_applications DROP COLUMN IF EXISTS applied_in_txn_id;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_txn_source_payment;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS source_payment_id;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS write_off_account_id;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS write_off_threshold;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS sales_discount_account_id;
