-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator Q44 dependents part (0204). The code reading these must be
-- rolled back with it.
ALTER TABLE IF EXISTS tax_est_years DROP COLUMN IF EXISTS care_expenses;
DROP TABLE IF EXISTS tax_est_dependents;
