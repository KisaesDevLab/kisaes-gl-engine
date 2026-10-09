-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Vibe AI Router connection set from Admin -> AI (a router on another
-- local server) instead of only VIBE_AI_ROUTER_URL / VIBE_AI_TOKEN in env.
-- When both are set they override env; NULL = use env. Token encrypted
-- like the provider API keys. Additive.

ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS router_url VARCHAR(500);
--> statement-breakpoint
ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS router_token_encrypted TEXT;
