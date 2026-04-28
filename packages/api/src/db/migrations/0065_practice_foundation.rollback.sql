-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: ROLLBACK file for 0065_practice_foundation.sql. DROP +
-- DROP COLUMN are the point of a rollback. Not registered in
-- _journal.json; never auto-applied. Any configured flag state
-- and any non-'staff' user_type values are lost on apply.

DROP TABLE IF EXISTS tenant_feature_flags;
ALTER TABLE users DROP COLUMN IF EXISTS user_type;
