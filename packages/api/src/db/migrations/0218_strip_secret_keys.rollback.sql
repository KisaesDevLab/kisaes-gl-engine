-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0218. The tenant-archive export projection of
-- audit_log.before_data / after_data calls this function and must be
-- rolled back with it.
DROP FUNCTION IF EXISTS mybooks_strip_secret_keys(jsonb, text);
