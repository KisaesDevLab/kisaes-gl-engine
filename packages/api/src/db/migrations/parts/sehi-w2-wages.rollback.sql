-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator Q41 SEHI-in-W-2-wages part (runs FIRST, before the R6 lifecycle part).
ALTER TABLE IF EXISTS tax_est_entity_year_inputs DROP COLUMN IF EXISTS include_sehi_in_w2_wages;
