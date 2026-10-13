-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for Tax Estimator Q54 (0215). The code reading this column must be rolled back with it.
ALTER TABLE IF EXISTS tax_est_taxpayers DROP COLUMN IF EXISTS show_on_company_dashboard;
