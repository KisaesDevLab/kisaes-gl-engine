-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0270 (U-183). Only the record of where relinked files came
-- from is lost: files stay where they are; a later entry delete moves back
-- only the draft's own file, found through the relink's audit row.
ALTER TABLE attachments DROP COLUMN IF EXISTS source_draft_key;
