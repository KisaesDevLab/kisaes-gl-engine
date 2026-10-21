-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0225 (templates, occurrences). The code reading these must
-- be rolled back with it.
--
-- Refused while any schedule has no template_transaction_id: such a
-- schedule belongs to a template made without posting (desktop "Save as
-- Template"), and the code before 0225 needs a posted source transaction,
-- so the template and its schedule would be lost. Delete those templates
-- (or their schedules) first, then roll back.
--
-- Transactions the runner posted stay (they are ordinary postings, marked
-- source 'recurring'); only the template tables, the occurrence log and the
-- new recurring_schedules columns go.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "recurring_schedules" WHERE "template_transaction_id" IS NULL) THEN
    RAISE EXCEPTION '0225 rollback refused: some recurring schedules belong to templates without a posted source transaction. Delete those templates first, then roll back.';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_recurring_schedules_due";
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_recurring_schedules_template";
--> statement-breakpoint
ALTER TABLE IF EXISTS "recurring_schedules" DROP CONSTRAINT IF EXISTS "recurring_schedules_remaining_count_check";
--> statement-breakpoint
ALTER TABLE IF EXISTS "recurring_schedules" DROP CONSTRAINT IF EXISTS "recurring_schedules_template_check";
--> statement-breakpoint
ALTER TABLE IF EXISTS "recurring_schedules" DROP COLUMN IF EXISTS "anchor_date";
--> statement-breakpoint
ALTER TABLE IF EXISTS "recurring_schedules" DROP COLUMN IF EXISTS "remaining_count";
--> statement-breakpoint
ALTER TABLE IF EXISTS "recurring_schedules" DROP COLUMN IF EXISTS "template_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "recurring_schedules" ALTER COLUMN "template_transaction_id" SET NOT NULL;
--> statement-breakpoint
DROP TABLE IF EXISTS "template_occurrences";
--> statement-breakpoint
DROP TABLE IF EXISTS "template_transaction_tags";
--> statement-breakpoint
DROP TABLE IF EXISTS "template_transaction_lines";
--> statement-breakpoint
DROP TABLE IF EXISTS "template_transactions";
--> statement-breakpoint
DROP TABLE IF EXISTS "template_groups";
