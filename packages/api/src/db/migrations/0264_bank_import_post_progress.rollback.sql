-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0264 (U-06 follow-up). The batched post-processing, the
-- progress fields and undo while preparing must be rolled back with it.
-- A batch undone while preparing stays 'scheduled': the older engine runs
-- it again on start over no rows and marks it done. A pending cancel
-- request (an undo in flight) is dropped and post-processing goes on.
-- LOST: the progress counts.
ALTER TABLE bank_import_batches DROP COLUMN IF EXISTS cancel_requested_at;
--> statement-breakpoint
ALTER TABLE bank_import_batches DROP COLUMN IF EXISTS processed_rows;
--> statement-breakpoint
ALTER TABLE bank_import_batches DROP COLUMN IF EXISTS total_rows;
