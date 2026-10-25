-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0229 (Idempotency-Key records, U-18). The middleware and
-- services that read the table must be rolled back with it. Postings stay;
-- only the replay records go, so a retry of a key used before the rollback
-- would post again.
DROP INDEX IF EXISTS idx_idempotency_keys_created;
DROP INDEX IF EXISTS uq_idempotency_keys_key;
DROP TABLE IF EXISTS idempotency_keys;
