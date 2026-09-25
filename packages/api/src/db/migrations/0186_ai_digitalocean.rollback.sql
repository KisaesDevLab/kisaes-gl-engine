-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Drops the DigitalOcean provider settings (and its stored key). Point any
-- function assigned to 'digitalocean' at another provider first.

ALTER TABLE ai_config DROP COLUMN IF EXISTS digitalocean_base_url;
ALTER TABLE ai_config DROP COLUMN IF EXISTS digitalocean_model;
ALTER TABLE ai_config DROP COLUMN IF EXISTS digitalocean_api_key_encrypted;
