-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0252 (sales tax setup, U-147 / U-148 / U-25). The code that
-- reads these must be rolled back with it. LOST: agencies, sales tax items
-- and groups, codes, the per-document tax rows, opening paid lines and the
-- company / client / item sales tax defaults and switches. The posted
-- documents and their journal lines stay. Rates go back to 4 places: a
-- rate stored with 5 or 6 places (8.875 %) is rounded to 4 (0.0888) on
-- the way back; the posted tax amounts do not change. A later re-upgrade
-- backfills legacy items and rows again from the stored lines.

DROP FUNCTION IF EXISTS sales_tax_backfill_company(uuid, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS sales_tax_legacy_name(numeric);
--> statement-breakpoint
DROP TABLE IF EXISTS sales_tax_payment_lines;
--> statement-breakpoint
DROP TABLE IF EXISTS transaction_tax_lines;
--> statement-breakpoint
DROP TABLE IF EXISTS sales_tax_codes;
--> statement-breakpoint
DROP TABLE IF EXISTS sales_tax_group_members;
--> statement-breakpoint
DROP TABLE IF EXISTS sales_tax_items;
--> statement-breakpoint
DROP TABLE IF EXISTS sales_tax_agencies;
--> statement-breakpoint
ALTER TABLE items DROP COLUMN IF EXISTS tax_code_id;
--> statement-breakpoint
ALTER TABLE contacts DROP COLUMN IF EXISTS tax_code_id;
--> statement-breakpoint
ALTER TABLE contacts DROP COLUMN IF EXISTS default_sales_tax_id;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN IF EXISTS tax_code_id;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS sales_tax_id;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS sales_tax_ssuta;
--> statement-breakpoint
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_sales_tax_basis_check;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS sales_tax_basis;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS sales_tax_enabled;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS default_sales_tax_id;
--> statement-breakpoint
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_tax_rate_scale;
--> statement-breakpoint
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_default_sales_tax_rate_scale;
--> statement-breakpoint
ALTER TABLE journal_lines ALTER COLUMN tax_rate TYPE numeric(5,4);
--> statement-breakpoint
ALTER TABLE companies ALTER COLUMN default_sales_tax_rate TYPE numeric(5,4);
