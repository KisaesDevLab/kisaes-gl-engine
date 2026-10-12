-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator Phase 10b estimate part (runs BEFORE the years part).
DROP TABLE IF EXISTS tax_est_sch_ai_snapshots;
DROP TABLE IF EXISTS tax_est_payments;
ALTER TABLE IF EXISTS tax_est_state_rows
  DROP COLUMN IF EXISTS prior_year_agi_encrypted,
  DROP COLUMN IF EXISTS prior_year_tax_encrypted,
  DROP COLUMN IF EXISTS state_deductions,
  DROP COLUMN IF EXISTS exemptions,
  DROP COLUMN IF EXISTS non_withheld_income,
  DROP COLUMN IF EXISTS prior_year_gross_income,
  DROP COLUMN IF EXISTS gross_income,
  DROP COLUMN IF EXISTS other_credits,
  DROP COLUMN IF EXISTS withholding;
ALTER TABLE IF EXISTS tax_est_years
  DROP COLUMN IF EXISTS is_fisherman,
  DROP COLUMN IF EXISTS farmer_gross,
  DROP COLUMN IF EXISTS nii_allocable_deductions,
  DROP COLUMN IF EXISTS mfs_lived_apart_all_year,
  DROP COLUMN IF EXISTS person_inputs;
