-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0214 (reconciliation sign-offs). The code reading this table
-- must be rolled back with it; stored sign-offs are lost.
DROP TABLE IF EXISTS reconciliation_signoffs;
