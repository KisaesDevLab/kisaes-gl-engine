-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Drops the Close Review bank-feed review marks.

ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS close_reviewed_by;
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS close_reviewed_at;
