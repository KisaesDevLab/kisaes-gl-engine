-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0228 (tag numbers). The code that reads tag_number must be
-- rolled back with it. Tag numbers entered since 0228 are lost.

DROP INDEX IF EXISTS idx_tags_tenant_tag_number;
ALTER TABLE tags DROP COLUMN IF EXISTS tag_number;
