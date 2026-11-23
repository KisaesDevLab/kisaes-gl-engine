-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0290 (U-12). LOST: the stored Verify Data runs (the next
-- check makes a new one).
DROP TABLE IF EXISTS integrity_runs;