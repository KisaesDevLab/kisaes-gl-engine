-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Bank file import batches (U-06 follow-up): progress of the
-- post-processing and undo while it runs. Additive.
--
--   total_rows           the items the post-processing runs over (set when
--                        it starts; NULL before, and for batches made
--                        before this migration);
--   processed_rows       items done, raised after each chunk;
--   cancel_requested_at  an undo asked the running post-processing to stop
--                        after its current chunk. A batch undone while its
--                        post_processing is still 'scheduled' was stopped
--                        (the API reports it as 'cancelled').
ALTER TABLE bank_import_batches ADD COLUMN IF NOT EXISTS total_rows INTEGER;
--> statement-breakpoint
ALTER TABLE bank_import_batches ADD COLUMN IF NOT EXISTS processed_rows INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bank_import_batches ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
