-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0257 (U-155): drop the index; reports stay correct, only slower.
DROP INDEX IF EXISTS "idx_pa_tenant";
