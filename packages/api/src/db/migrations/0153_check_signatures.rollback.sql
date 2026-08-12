-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0153_check_signatures.

ALTER TABLE transactions DROP COLUMN IF EXISTS print_signature_id;
DROP TABLE IF EXISTS check_signature_users;
DROP TABLE IF EXISTS check_signatures;
