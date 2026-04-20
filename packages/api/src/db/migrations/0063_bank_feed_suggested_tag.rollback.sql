-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: ROLLBACK file for 0063_bank_feed_suggested_tag.sql. DROP INDEX
-- / DROP CONSTRAINT / DROP COLUMN are the whole point of a rollback. Not
-- registered in _journal.json; never auto-applied. Any AI-suggested tag
-- ids persisted on bank_feed_items are lost on apply.

DROP INDEX IF EXISTS idx_bank_feed_items_suggested_tag_id;
ALTER TABLE bank_feed_items DROP CONSTRAINT IF EXISTS fk_bank_feed_items_suggested_tag_id;
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS suggested_tag_id;
