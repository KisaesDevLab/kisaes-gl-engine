-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0276 (Report Builder definitions, U-118 / U-119). The code
-- that writes kind 'builder' must be rolled back with it. Nothing is lost:
-- while any report_definitions row (live or deleted) has kind 'builder' this
-- rollback stops with a clear message instead of deleting saved reports.
-- Export them (a tenant archive or backup) and delete them first.
-- An engine older than 0276 can't import an archive holding builder rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM report_definitions WHERE kind = 'builder' LIMIT 1) THEN
    RAISE EXCEPTION 'Rollback of 0276 stopped: report_definitions holds Report Builder definitions (kind builder). Export and delete them first.';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE report_definitions DROP CONSTRAINT IF EXISTS report_definitions_kind_check;
--> statement-breakpoint
ALTER TABLE report_definitions ADD CONSTRAINT report_definitions_kind_check CHECK (kind IN ('standard'));
