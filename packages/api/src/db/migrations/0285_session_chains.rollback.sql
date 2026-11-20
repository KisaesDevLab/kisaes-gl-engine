-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0285 (U-290). LOST: the session chains and device bindings;
-- sessions themselves stay valid (desktop LAN mode cannot run without them).
DROP INDEX IF EXISTS idx_sessions_chain;
ALTER TABLE sessions DROP COLUMN IF EXISTS device_id;
ALTER TABLE sessions DROP COLUMN IF EXISTS chain_id;