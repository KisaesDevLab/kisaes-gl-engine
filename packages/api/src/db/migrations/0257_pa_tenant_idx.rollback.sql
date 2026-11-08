-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0257 (U-155): drop the index; reports stay correct, only slower.
DROP INDEX IF EXISTS "idx_pa_tenant";
