-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0264 (U-06 follow-up). The batched post-processing, the
-- progress fields and undo while preparing must be rolled back with it.
-- A batch undone while preparing stays 'scheduled' under 0264; the older
-- engine runs every 'scheduled' batch again on start, undone or not, over
-- the rows it still has (a pendingOnly undo keeps the used ones), with the
-- slow per-row pipeline. So such batches are marked 'done' first (after
-- re-applying 0264 they report 'done', not 'cancelled'). A batch still
-- preparing stays 'scheduled' and the older engine runs it again from the
-- start. A pending cancel request (an undo in flight) is dropped and
-- post-processing goes on.
-- LOST: the progress counts; 'cancelled' (reported 'done').
UPDATE bank_import_batches SET post_processing = 'done'
  WHERE post_processing = 'scheduled' AND undone_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE bank_import_batches DROP COLUMN IF EXISTS cancel_requested_at;
--> statement-breakpoint
ALTER TABLE bank_import_batches DROP COLUMN IF EXISTS processed_rows;
--> statement-breakpoint
ALTER TABLE bank_import_batches DROP COLUMN IF EXISTS total_rows;
