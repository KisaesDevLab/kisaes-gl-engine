-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0245 (billable costs, U-128). The code that reads these must
-- be rolled back with it. journal_lines.billed_status is left alone, so a
-- cost billed before the downgrade stays 'billed' (fail-safe: it can't be
-- billed twice); it unbills only after re-upgrading and voiding or editing
-- its invoice. Lost: the links (which invoice billed which cost, markups),
-- the cost / markup line marks on invoices, client markup defaults and the
-- company markup account.

DROP TABLE IF EXISTS billable_cost_links;
--> statement-breakpoint
ALTER TABLE IF EXISTS "journal_lines" DROP COLUMN IF EXISTS "billable_source_line_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "contacts" DROP CONSTRAINT IF EXISTS "contacts_default_markup_percent_chk";
--> statement-breakpoint
ALTER TABLE IF EXISTS "contacts" DROP COLUMN IF EXISTS "default_markup_percent";
--> statement-breakpoint
ALTER TABLE IF EXISTS "companies" DROP COLUMN IF EXISTS "billable_markup_account_id";
