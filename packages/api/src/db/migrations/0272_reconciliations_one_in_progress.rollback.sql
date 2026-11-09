-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0272 (U-188). Drops the index only: duplicate in-progress
-- reconciliations deleted by the forward migration are not restored (they
-- held ticks only, nothing posted; the pre-upgrade backup has them).
DROP INDEX IF EXISTS uq_reconciliations_one_in_progress;
