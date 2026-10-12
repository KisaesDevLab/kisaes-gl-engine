-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator R6 lifecycle part (runs FIRST, before the R7 verification part).
ALTER TABLE IF EXISTS tax_parameter_overrides DROP COLUMN IF EXISTS citation;
