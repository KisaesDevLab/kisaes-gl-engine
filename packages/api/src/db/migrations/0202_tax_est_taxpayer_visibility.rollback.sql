-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator D17 taxpayer-visibility part (0202).
DROP TABLE IF EXISTS tax_est_taxpayer_staff;
ALTER TABLE IF EXISTS tax_est_firm_settings DROP COLUMN IF EXISTS restrict_taxpayers_to_linked_tenants;
