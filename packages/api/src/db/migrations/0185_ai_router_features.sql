-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Per-feature Vibe AI Router switch, set from Admin -> AI instead of the
-- deployment-wide VIBE_AI_MODE env var. Additive. router_enabled stays NULL
-- until an admin saves it, so existing installs keep their env behaviour.

ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS router_enabled BOOLEAN;
ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS router_features JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS router_statements_on_box BOOLEAN NOT NULL DEFAULT FALSE;
