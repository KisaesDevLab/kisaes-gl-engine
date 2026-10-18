-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the monthly AI token cap (0218). The code reading this column
-- must be rolled back with it.
ALTER TABLE IF EXISTS ai_config DROP COLUMN IF EXISTS monthly_token_limit;
