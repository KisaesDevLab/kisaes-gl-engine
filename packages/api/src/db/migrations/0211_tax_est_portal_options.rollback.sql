-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator Q51 portal-options part (0211). The code reading the table
-- and the column must be rolled back with it.
ALTER TABLE IF EXISTS tax_est_scenarios DROP COLUMN IF EXISTS show_in_portal;
DROP TABLE IF EXISTS tax_est_portal_contact_options;
