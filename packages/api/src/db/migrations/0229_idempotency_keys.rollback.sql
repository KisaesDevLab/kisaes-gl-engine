-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0229 (Idempotency-Key records, U-18). The middleware and
-- services that read the table must be rolled back with it. Postings stay;
-- only the replay records go, so a retry of a key used before the rollback
-- would post again.
DROP INDEX IF EXISTS idx_idempotency_keys_created;
DROP INDEX IF EXISTS uq_idempotency_keys_key;
DROP TABLE IF EXISTS idempotency_keys;
