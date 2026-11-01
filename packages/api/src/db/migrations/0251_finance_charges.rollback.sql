-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0251 (finance charges, U-141). The code that reads these
-- must be rolled back with it. LOST: the finance-charge settings, which
-- invoices are finance charges, and the run / assessment / charged-through
-- rows that stop a client being charged twice for a month or a day. The
-- posted finance-charge invoices stay as ordinary invoices. WARNING: after
-- re-upgrading, past periods can be charged again.

DROP TABLE IF EXISTS finance_charge_sources;
--> statement-breakpoint
DROP TABLE IF EXISTS finance_charge_assessments;
--> statement-breakpoint
DROP TABLE IF EXISTS finance_charge_runs;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS is_finance_charge;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS finance_charge_print_later;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS finance_charge_income_account_id;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS finance_charge_on_finance_charges;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS finance_charge_grace_days;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS finance_charge_minimum;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS finance_charge_annual_rate;
