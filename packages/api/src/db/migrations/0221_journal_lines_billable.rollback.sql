-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for billable expense lines (0221). The code writing these
-- columns must be rolled back with it; billable marks are lost.
DROP INDEX IF EXISTS "idx_jl_unbilled";
--> statement-breakpoint
ALTER TABLE IF EXISTS "journal_lines" DROP CONSTRAINT IF EXISTS "journal_lines_billed_status_chk";
--> statement-breakpoint
ALTER TABLE IF EXISTS "journal_lines" DROP COLUMN IF EXISTS "billed_status";
--> statement-breakpoint
ALTER TABLE IF EXISTS "journal_lines" DROP COLUMN IF EXISTS "is_billable";
