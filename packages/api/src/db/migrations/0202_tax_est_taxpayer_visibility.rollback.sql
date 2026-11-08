-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator D17 taxpayer-visibility part (0202).
DROP TABLE IF EXISTS tax_est_taxpayer_staff;
ALTER TABLE IF EXISTS tax_est_firm_settings DROP COLUMN IF EXISTS restrict_taxpayers_to_linked_tenants;
