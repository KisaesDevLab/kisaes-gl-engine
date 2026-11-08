-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator R7 verification part (runs FIRST).
ALTER TABLE IF EXISTS state_estimate_rule_overrides
  DROP COLUMN IF EXISTS verification_note,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verified_by;
ALTER TABLE IF EXISTS state_estimate_rules
  DROP COLUMN IF EXISTS verification_note,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verified_by;
ALTER TABLE IF EXISTS tax_parameter_overrides
  DROP COLUMN IF EXISTS verification_note,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verified_by;
ALTER TABLE IF EXISTS tax_parameters
  DROP COLUMN IF EXISTS verification_note,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verified_by;
