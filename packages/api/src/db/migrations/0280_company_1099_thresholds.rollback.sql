-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0280 (per-company 1099 thresholds, U-215). Drops the table:
-- every company goes back to the year table thresholds.
DROP TABLE IF EXISTS company_1099_thresholds;
