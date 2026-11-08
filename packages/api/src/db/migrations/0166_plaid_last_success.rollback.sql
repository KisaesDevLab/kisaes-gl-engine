-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Drops the honest freshness signal. The staleness check reverts to reading
-- last_sync_at, which is bumped by the sync claim and the error path, so it
-- goes back to never firing.

DROP INDEX IF EXISTS idx_plaid_items_last_success;
--> statement-breakpoint
ALTER TABLE plaid_items DROP COLUMN IF EXISTS last_success_at;
