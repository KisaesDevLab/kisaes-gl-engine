-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator Q46 projection-method part (0207). The code reading the column
-- must be rolled back with it.
ALTER TABLE IF EXISTS tax_est_entity_year_inputs DROP COLUMN IF EXISTS projection_method;
