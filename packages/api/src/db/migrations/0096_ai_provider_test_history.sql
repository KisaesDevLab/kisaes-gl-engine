-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Persist the most recent /admin/test/:provider result per provider so
-- the admin UI can show "Last verified <time> ago" next to each card.
-- Stored as JSON keyed by provider name; default '{}' so existing
-- ai_config rows light up without a backfill.

ALTER TABLE ai_config
  ADD COLUMN provider_test_history jsonb NOT NULL DEFAULT '{}'::jsonb;
