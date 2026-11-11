-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0275 (U-203 budget versions). The budgets routes must be
-- rolled back with it. LOST: only the edit counters; budgets and their
-- lines are untouched.
ALTER TABLE "budgets" DROP CONSTRAINT IF EXISTS "budgets_version_positive";
--> statement-breakpoint
ALTER TABLE "budgets" DROP COLUMN IF EXISTS "version";
