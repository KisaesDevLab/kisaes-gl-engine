-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator entities part (Phase 4).
DROP TABLE IF EXISTS tax_est_transaction_flags;
DROP TABLE IF EXISTS tax_est_account_treatments;
DROP TABLE IF EXISTS tax_est_entity_year_inputs;
DROP TABLE IF EXISTS tax_est_entity_settings;
