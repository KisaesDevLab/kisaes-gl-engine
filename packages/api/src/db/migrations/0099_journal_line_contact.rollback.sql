-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
DROP INDEX IF EXISTS "idx_jl_contact";
--> statement-breakpoint
ALTER TABLE "journal_lines" DROP COLUMN IF EXISTS "contact_id";
