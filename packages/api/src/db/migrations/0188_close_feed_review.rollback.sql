-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Drops the Close Review bank-feed review marks.

ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS close_reviewed_by;
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS close_reviewed_at;
