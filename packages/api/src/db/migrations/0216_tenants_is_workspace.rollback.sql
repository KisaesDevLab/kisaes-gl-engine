-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the desktop workspace flag (0216). The code reading this column
-- must be rolled back with it.
DROP INDEX IF EXISTS uniq_tenants_workspace;
ALTER TABLE IF EXISTS tenants DROP COLUMN IF EXISTS is_workspace;
