-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0218. The tenant-archive export projection of
-- audit_log.before_data / after_data calls this function and must be
-- rolled back with it.
DROP FUNCTION IF EXISTS mybooks_strip_secret_keys(jsonb, text);
