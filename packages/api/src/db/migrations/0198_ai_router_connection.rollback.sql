-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE ai_config DROP COLUMN IF EXISTS router_token_encrypted;
--> statement-breakpoint
ALTER TABLE ai_config DROP COLUMN IF EXISTS router_url;
