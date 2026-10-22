-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0226 (batch save Idempotency-Key records, U-72). The batch
-- code that reads the table must be rolled back with it. Batches already
-- saved stay posted (ordinary transactions marked source 'batch'); only the
-- replay records go, so a retry of an old key after the rollback would post
-- its batch again.
DROP INDEX IF EXISTS idx_batch_save_requests_created;
DROP INDEX IF EXISTS uq_batch_save_requests_key;
DROP TABLE IF EXISTS batch_save_requests;
