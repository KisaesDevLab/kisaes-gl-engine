-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the closing-date password (0219). The code reading this
-- column must be rolled back with it; the passwords are lost.
ALTER TABLE IF EXISTS companies DROP COLUMN IF EXISTS closing_password_hash;
