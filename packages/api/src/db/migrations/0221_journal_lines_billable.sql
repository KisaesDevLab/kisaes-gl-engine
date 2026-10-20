-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Billable expense lines (U-50). A check or expense line can be marked
-- billable to its line customer (journal_lines.contact_id). billed_status is
-- NULL when the line is not billable and 'unbilled' when it is; invoicing
-- the cost later sets 'billed'. Additive only: both columns default to the
-- "not billable" state, so every existing line keeps its meaning and no
-- existing write path has to change.
ALTER TABLE "journal_lines" ADD COLUMN IF NOT EXISTS "is_billable" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN IF NOT EXISTS "billed_status" text;
--> statement-breakpoint
-- The two columns move together: not billable -> no status, billable -> a
-- known status. NOT VALID + VALIDATE keeps the scan off the ACCESS
-- EXCLUSIVE lock; every existing row already satisfies it (false / NULL).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_billed_status_chk') THEN
    ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_billed_status_chk" CHECK (
      ("is_billable" = false AND "billed_status" IS NULL)
      OR ("is_billable" = true AND "billed_status" IS NOT NULL AND "billed_status" IN ('unbilled', 'billed'))
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "journal_lines" VALIDATE CONSTRAINT "journal_lines_billed_status_chk";
--> statement-breakpoint
-- Unbilled costs by customer (future "add billable costs to invoice").
CREATE INDEX IF NOT EXISTS "idx_jl_unbilled" ON "journal_lines" USING btree ("tenant_id", "contact_id") WHERE "billed_status" = 'unbilled';
