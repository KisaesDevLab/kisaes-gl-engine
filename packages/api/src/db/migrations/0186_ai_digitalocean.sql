-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- DigitalOcean serverless inference as an AI provider (open-weight models,
-- e.g. gpt-oss-120b). Additive; the key is stored encrypted like the others.

ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS digitalocean_api_key_encrypted TEXT;
ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS digitalocean_model VARCHAR(120);
ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS digitalocean_base_url VARCHAR(255);
