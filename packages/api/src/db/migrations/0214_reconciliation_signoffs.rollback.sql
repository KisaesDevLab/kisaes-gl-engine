-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0214 (reconciliation sign-offs). The code reading this table
-- must be rolled back with it; stored sign-offs are lost.
DROP TABLE IF EXISTS reconciliation_signoffs;
