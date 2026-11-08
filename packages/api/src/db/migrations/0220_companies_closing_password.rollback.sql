-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the closing-date password (0220). The code reading this
-- column must be rolled back with it; the passwords are lost.
ALTER TABLE IF EXISTS companies DROP COLUMN IF EXISTS closing_password_hash;
