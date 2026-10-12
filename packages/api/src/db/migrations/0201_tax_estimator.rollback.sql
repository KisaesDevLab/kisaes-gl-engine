-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0201_tax_estimator, children first (Q41 switch, R6 lifecycle, R7 verification, phases 13, 12, 10b, 5, 4, 3, 2, then 1 and 0).

-- Q41: include >2% shareholder health in §199A W-2 wages (per entity year)
--
-- Rollback for the Tax Estimator Q41 SEHI-in-W-2-wages part (runs FIRST, before the R6 lifecycle part).
ALTER TABLE IF EXISTS tax_est_entity_year_inputs DROP COLUMN IF EXISTS include_sehi_in_w2_wages;

-- R6: parameter lifecycle review (citation on created years)
--
-- Rollback for the Tax Estimator R6 lifecycle part (runs FIRST, before the R7 verification part).
ALTER TABLE IF EXISTS tax_parameter_overrides DROP COLUMN IF EXISTS citation;

-- R7: in-app Verify (super-admin sign-off)
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

-- Phase 13: Report Pack tax-estimate section
--
-- Rollback for the Tax Estimator Phase 13 Report Pack part (runs BEFORE the snapshots part).
ALTER TABLE IF EXISTS report_pack_runs
  DROP COLUMN IF EXISTS allow_tax_estimate,
  DROP COLUMN IF EXISTS requested_by;

-- Phase 12: immutable estimate snapshots
--
-- Rollback for the Tax Estimator Phase 12 snapshots part (runs BEFORE the estimate part).
DROP TABLE IF EXISTS tax_est_snapshots;
DROP FUNCTION IF EXISTS tax_est_snapshots_immutable();

-- Phase 10b: estimate inputs, payment ledger, Schedule AI snapshots
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

-- Phase 5: annual settings, scenarios, adjustments, state rows, firm settings
--
-- Rollback for the Tax Estimator years part (children first).
DROP TABLE IF EXISTS tax_est_state_rows;
DROP TABLE IF EXISTS tax_est_adjustments;
DROP TABLE IF EXISTS tax_est_adjustment_types;
DROP TABLE IF EXISTS tax_est_scenarios;
DROP TABLE IF EXISTS tax_est_years;
DROP TABLE IF EXISTS tax_est_firm_settings;

-- Phase 4: entity settings, account treatments, transaction flags
--
-- Rollback for the Tax Estimator entities part (Phase 4).
DROP TABLE IF EXISTS tax_est_transaction_flags;
DROP TABLE IF EXISTS tax_est_account_treatments;
DROP TABLE IF EXISTS tax_est_entity_year_inputs;
DROP TABLE IF EXISTS tax_est_entity_settings;

-- Phase 3: taxpayers, persons, links, portal access
--
-- Rollback for the Tax Estimator taxpayers part (children first).
ALTER TABLE portal_contact_companies DROP COLUMN IF EXISTS tax_estimates_access;
DROP TABLE IF EXISTS tax_est_taxpayer_contacts;
DROP TABLE IF EXISTS tax_est_links;
DROP TABLE IF EXISTS tax_est_persons;
DROP TABLE IF EXISTS tax_est_taxpayers;

-- Phase 2: state estimate rules (global)
--
-- Rollback for the state-rules part (children first).
DROP TABLE IF EXISTS state_estimate_rule_overrides;
DROP TABLE IF EXISTS state_estimate_rules;

-- Phase 0/1
--
-- Rollback for 0201_tax_estimator (phases append their DROPs here, children first).
DELETE FROM tenant_feature_flags WHERE flag_key = 'TAX_ESTIMATOR_V1';
DROP TABLE IF EXISTS tax_parameter_overrides;
DROP TABLE IF EXISTS tax_parameters;
