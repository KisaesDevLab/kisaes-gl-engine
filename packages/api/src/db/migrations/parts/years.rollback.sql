-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator years part (children first).
DROP TABLE IF EXISTS tax_est_state_rows;
DROP TABLE IF EXISTS tax_est_adjustments;
DROP TABLE IF EXISTS tax_est_adjustment_types;
DROP TABLE IF EXISTS tax_est_scenarios;
DROP TABLE IF EXISTS tax_est_years;
DROP TABLE IF EXISTS tax_est_firm_settings;
