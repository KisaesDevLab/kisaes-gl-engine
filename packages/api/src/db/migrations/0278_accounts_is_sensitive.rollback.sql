-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0278 (sensitive accounts). Drops the flag; every account is
-- visible to everyone again, as before 0278.
ALTER TABLE accounts DROP COLUMN IF EXISTS is_sensitive;
