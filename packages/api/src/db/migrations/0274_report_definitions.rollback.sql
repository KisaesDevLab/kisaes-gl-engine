-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0274 (U-118 report definitions). The report-builder
-- definitions routes must be rolled back with it.
-- LOST: every saved report definition and definition group (memorized
-- reports); their audit rows stay. Export them first (a tenant archive or
-- backup taken before the rollback still holds them).
DROP TABLE IF EXISTS "report_definitions";
--> statement-breakpoint
DROP TABLE IF EXISTS "report_definition_groups";
