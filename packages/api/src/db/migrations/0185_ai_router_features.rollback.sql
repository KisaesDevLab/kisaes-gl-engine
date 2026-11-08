-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Drops the per-feature router settings; routing falls back to VIBE_AI_MODE.

ALTER TABLE ai_config DROP COLUMN IF EXISTS router_statements_on_box;
ALTER TABLE ai_config DROP COLUMN IF EXISTS router_features;
ALTER TABLE ai_config DROP COLUMN IF EXISTS router_enabled;
