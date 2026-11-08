-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator Q50 treatment-splits part (0210). The code reading the table /
-- column must be rolled back with it; split accounts then revert to their FIRST row's target (100%).
DROP TABLE IF EXISTS tax_est_account_treatment_splits;
ALTER TABLE IF EXISTS tax_est_account_treatments DROP COLUMN IF EXISTS split_mode;
