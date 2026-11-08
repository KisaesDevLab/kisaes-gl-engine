-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0269 (U-180). Nothing is lost: deleting an entry still finds
-- its drafts, by a scan instead of the index.
DROP INDEX IF EXISTS idx_document_drafts_converted;