-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.

ALTER TABLE ai_config DROP COLUMN IF EXISTS router_token_encrypted;
--> statement-breakpoint
ALTER TABLE ai_config DROP COLUMN IF EXISTS router_url;
