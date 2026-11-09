-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Service charge and interest entered when a reconciliation begins
-- (U-189, reconcile-begin-v1). Additive: nullable columns plus one boolean
-- with a default; existing rows read as "no charges, statement-date lines
-- only", exactly the behavior before this migration.
--
--   reconciliations.service_charge_{amount,date,account_id}
--   reconciliations.interest_{amount,date,account_id}
--       What the owner typed at Begin. While *_txn_id is NULL the amount
--       counts in the cleared balance (interest - service charge) without
--       being in the books.
--   reconciliations.service_charge_txn_id / interest_txn_id
--       The entry posted for it by Finish (an expense / a deposit through
--       the normal posting path). Set once; never posted again after an
--       Undo. No FK, like the other transaction references here.
--   reconciliations.include_later_lines
--       The worksheet also holds uncleared lines dated after the statement
--       date (flagged afterStatementDate in responses).
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS service_charge_amount numeric(19,4);
--> statement-breakpoint
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS service_charge_date date;
--> statement-breakpoint
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS service_charge_account_id uuid;
--> statement-breakpoint
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS service_charge_txn_id uuid;
--> statement-breakpoint
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS interest_amount numeric(19,4);
--> statement-breakpoint
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS interest_date date;
--> statement-breakpoint
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS interest_account_id uuid;
--> statement-breakpoint
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS interest_txn_id uuid;
--> statement-breakpoint
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS include_later_lines boolean NOT NULL DEFAULT false;
