-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0279 (recovery key, must-change flag). Drops both columns:
-- recovery keys stop working and nobody is asked to change a password.
ALTER TABLE users DROP COLUMN IF EXISTS password_change_required;
ALTER TABLE users DROP COLUMN IF EXISTS recovery_key_hash;
