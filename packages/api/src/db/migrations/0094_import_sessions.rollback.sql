-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Rollback for 0094_import_sessions.sql.

DROP INDEX IF EXISTS idx_imp_sess_hash;
DROP INDEX IF EXISTS idx_imp_sess_tck;
DROP TABLE IF EXISTS import_sessions;
